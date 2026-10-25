//! HTTP surface for the durable op buffer and persistence leader (Sync v2).
//!
//! Authorization reuses the proven board-grant admission pattern: every call
//! carries a fresh single-use challenge plus the authority-signed manifest and
//! a device signature over `auth_bytes(challenge, session, room, peer,
//! digest)` — the same proof the WebRTC path uses, so buffer writes require a
//! *current, authority-signed* device grant, and viewers are rejected. Only
//! manifests without Drive bindings (independent-grant mode) are accepted
//! here; Google-shared boards keep using Drive ACLs and the snapshot path.
//!
//! Op payloads are client-encrypted; this module never parses them beyond
//! size/character limits (see [`crate::op_buffer`]).
use crate::{
    App, PublicKey,
    admission::{AdmissionProof, Role, room_name},
    now_ms,
    op_buffer::OpInput,
};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{Response, IntoResponse},
};
use serde::Deserialize;
use serde_json::json;

const CHALLENGE_TTL_MS: u64 = 30_000;
const MAX_CHALLENGES: usize = 128;

fn error(code: &str, status: StatusCode) -> Response {
    (
        status,
        [("Cache-Control", "no-store")],
        Json(json!({ "code": code })),
    )
        .into_response()
}

fn disabled() -> Response {
    error("disabled", StatusCode::NOT_FOUND)
}

pub async fn challenge(State(app): State<App>) -> Response {
    if app.op_buffer().is_none() {
        return disabled();
    }
    if !app.permit_automatic_auth() {
        return error("rate_limit", StatusCode::TOO_MANY_REQUESTS);
    }
    let mut challenges = app.buffer_challenges();
    challenges.retain(|_, expiry| *expiry > now_ms());
    if challenges.len() >= MAX_CHALLENGES {
        return error("server_busy", StatusCode::TOO_MANY_REQUESTS);
    }
    let challenge = crate::nonce();
    let expires = now_ms() + CHALLENGE_TTL_MS;
    challenges.insert(challenge.clone(), expires);
    (
        [("Cache-Control", "no-store")],
        Json(json!({ "challenge": challenge, "expiresAt": expires })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiRequest {
    pub board: String,
    pub device_key_id: String,
    pub challenge: String,
    pub session: String,
    pub signature: String,
    pub authority: PublicKey,
    pub manifest_payload: String,
    pub manifest_signature: String,
    #[serde(default)]
    pub ops: Vec<OpInput>,
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub epoch: Option<u64>,
    #[serde(default)]
    pub snapshot_seq: Option<u64>,
    #[serde(default)]
    pub drive_etag: Option<String>,
}

struct Authenticated {
    #[allow(dead_code)]
    scope: String,
    editor: bool,
}

/// Verifies the grant-bound device signature and consumes the challenge.
/// CPU cost mirrors grant publication: one serialized permit.
fn authenticate(app: &App, request: &ApiRequest) -> Result<Authenticated, (&'static str, StatusCode)> {
    if app.buffer_challenges().remove(&request.challenge).filter(|expiry| *expiry > now_ms()).is_none() {
        return Err(("challenge_invalid", StatusCode::FORBIDDEN));
    }
    let proof = AdmissionProof {
        topic: format!("pboard-collab-{}-cards", request.board),
        authority: request.authority.clone(),
        manifest_payload: request.manifest_payload.clone(),
        manifest_signature: request.manifest_signature.clone(),
    };
    if let Err(error) = proof.history_identity() {
        return Err((error, StatusCode::FORBIDDEN));
    }
    let room = room_name(&request.authority.fingerprint(), &proof.topic, "", "");
    match proof.verify(
        &room,
        &request.device_key_id,
        &request.challenge,
        &request.session,
        &request.signature,
        now_ms(),
    ) {
        Ok(verified) => Ok(Authenticated {
            editor: matches!(verified.role, Role::Owner | Role::Editor),
            scope: verified.scope,
        }),
        Err(error) => Err((error, StatusCode::FORBIDDEN)),
    }
}

async fn guarded<T>(
    app: &App,
    request: Result<Json<ApiRequest>, axum::extract::rejection::JsonRejection>,
    require_editor: bool,
    run: impl FnOnce(&App, ApiRequest, bool) -> Result<T, (&'static str, StatusCode)> + Send + 'static,
) -> Response
where
    T: Into<serde_json::Value> + Send + 'static,
{
    if app.op_buffer().is_none() {
        return disabled();
    }
    let Ok(Json(request)) = request else {
        return error("invalid_request", StatusCode::BAD_REQUEST);
    };
    let Ok(permit) = app.grant_permits().try_acquire_owned() else {
        return error("server_busy", StatusCode::TOO_MANY_REQUESTS);
    };
    let app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let identity = match authenticate(&app, &request) {
            Ok(identity) => identity,
            Err(failure) => return Err(failure),
        };
        if require_editor && !identity.editor {
            return Err(("forbidden", StatusCode::FORBIDDEN));
        }
        run(&app, request, identity.editor).map(Into::into)
    })
    .await;
    match result.unwrap_or(Err(("server_busy", StatusCode::TOO_MANY_REQUESTS))) {
        Ok(value) => (StatusCode::OK, [("Cache-Control", "no-store")], Json(value)).into_response(),
        Err((code, status)) => error(code, status),
    }
}

fn buffer_error(error: crate::op_buffer::BufferError) -> (&'static str, StatusCode) {
    use crate::op_buffer::BufferError;
    match error {
        BufferError::Full => ("buffer_full", StatusCode::TOO_MANY_REQUESTS),
        BufferError::TooLarge => ("op_too_large", StatusCode::PAYLOAD_TOO_LARGE),
        BufferError::Invalid(_) => ("invalid_request", StatusCode::BAD_REQUEST),
        BufferError::Io(_) => ("server_error", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub async fn insert_ops(
    State(app): State<App>,
    body: Result<Json<ApiRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    guarded(&app, body, true, |app, request, _| {
        let mut buffer = app.op_buffer_lock().lock().unwrap();
        let accepted = buffer.insert(&request.board, &request.ops).map_err(buffer_error)?;
        Ok(json!({ "accepted": accepted }))
    })
    .await
}

pub async fn list_ops(
    State(app): State<App>,
    body: Result<Json<ApiRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    guarded(&app, body, false, |app, request, _| {
        let buffer = app.op_buffer_lock().lock().unwrap();
        let ops: Vec<_> = buffer
            .list(&request.board)
            .into_iter()
            .map(|entry| {
                json!({
                    "opId": entry.op.op_id,
                    "keyId": entry.op.key_id,
                    "iv": entry.op.iv,
                    "ct": entry.op.ct,
                    "seq": entry.seq,
                    "bufferedAt": entry.buffered_at,
                })
            })
            .collect();
        Ok(json!({ "ops": ops }))
    })
    .await
}

pub async fn commit_ops(
    State(app): State<App>,
    body: Result<Json<ApiRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    guarded(&app, body, true, |app, request, _| {
        let epoch = request.epoch.ok_or(("invalid_request", StatusCode::BAD_REQUEST))?;
        let mut buffer = app.op_buffer_lock().lock().unwrap();
        let committed = buffer
            .commit(&request.board, epoch, &request.ids)
            .map_err(buffer_error)?;
        Ok(json!({ "committed": committed }))
    })
    .await
}

fn leader_error(error: crate::leader::LeaderError) -> (&'static str, StatusCode) {
    use crate::leader::LeaderError;
    match error {
        LeaderError::Busy { .. } => ("lease_busy", StatusCode::CONFLICT),
        LeaderError::NotLeader => ("not_leader", StatusCode::CONFLICT),
        LeaderError::EpochStale => ("epoch_stale", StatusCode::CONFLICT),
        LeaderError::Invalid => ("invalid_request", StatusCode::BAD_REQUEST),
    }
}

pub async fn leader_claim(
    State(app): State<App>,
    body: Result<Json<ApiRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    guarded(&app, body, true, |app, request, _| {
        let (epoch, expires_at) = app
            .leader_registry()
            .lock()
            .unwrap()
            .claim(&request.board, &request.device_key_id, now_ms())
            .map_err(leader_error)?;
        Ok(json!({ "epoch": epoch, "expiresAt": expires_at }))
    })
    .await
}

pub async fn leader_observe(
    State(app): State<App>,
    body: Result<Json<ApiRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    guarded(&app, body, true, |app, request, _| {
        let (epoch, drive_etag) = match (request.epoch, request.drive_etag) {
            (Some(epoch), Some(drive_etag)) => (epoch, drive_etag),
            _ => return Err(("invalid_request", StatusCode::BAD_REQUEST)),
        };
        if drive_etag.len() > 1024 {
            return Err(("invalid_request", StatusCode::BAD_REQUEST));
        }
        app.leader_registry()
            .lock()
            .unwrap()
            .observe(&request.board, &request.device_key_id, epoch, &drive_etag, now_ms())
            .map_err(leader_error)?;
        Ok(json!({ "ok": true }))
    })
    .await
}

pub async fn leader_commit(
    State(app): State<App>,
    body: Result<Json<ApiRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    guarded(&app, body, true, |app, request, _| {
        let (epoch, snapshot_seq, drive_etag) = match (request.epoch, request.snapshot_seq, request.drive_etag) {
            (Some(epoch), Some(snapshot_seq), Some(drive_etag)) if drive_etag.len() <= 1024 => (epoch, snapshot_seq, drive_etag),
            _ => return Err(("invalid_request", StatusCode::BAD_REQUEST)),
        };
        let stale = app
            .leader_registry()
            .lock()
            .unwrap()
            .commit(&request.board, &request.device_key_id, epoch, snapshot_seq, &drive_etag, now_ms())
            .map_err(leader_error)?;
        if stale {
            tracing::warn!(
                event = "leader_stale_commit",
                board = %request.board,
                epoch,
                snapshot_seq,
                "out-of-order snapshot sequence; repair merge required"
            );
        }
        Ok(json!({ "stale": stale }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{App, Config, Limits};
    use axum::body::to_bytes;
    
    fn app(with_buffer: bool) -> App {
        let app = App::new(
            Config { rooms: Default::default() },
            Limits::default(),
        )
        .unwrap();
        if with_buffer {
            let dir = std::env::temp_dir().join(format!("pboard-buffer-api-{}", crate::nonce()));
            std::fs::create_dir_all(&dir).unwrap();
            app.with_op_buffer(&dir).unwrap()
        } else {
            app
        }
    }

    fn request_body(challenge: &str) -> serde_json::Value {
        serde_json::json!({
            "board": "board-1",
            "deviceKeyId": "device-1",
            "challenge": challenge,
            "session": "session-1",
            "signature": "AAAA",
            "authority": {"kty": "EC", "crv": "P-256", "x": "QQ", "y": "RQ"},
            "manifestPayload": "not-base64",
            "manifestSignature": "AAAA",
            "ops": [{"opId": "device-1:1", "keyId": "k", "iv": "aaa", "ct": "v"}]
        })
    }

    fn json_body(challenge: &str) -> Json<ApiRequest> {
        Json(serde_json::from_value(request_body(challenge)).unwrap())
    }

    async fn status_and_code(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        (status, body.get("code").and_then(|c| c.as_str()).unwrap_or_default().to_string())
    }

    #[tokio::test]
    async fn endpoints_are_inert_until_a_buffer_directory_is_configured() {
        let app = app(false);
        let response = insert_ops(State(app), Ok(json_body("x"))).await;
        let (status, code) = status_and_code(response).await;
        assert_eq!((status.as_u16(), code.as_str()), (404, "disabled"));
    }

    #[tokio::test]
    async fn challenge_is_issued_and_single_use() {
        let app = app(true);
        let response = challenge(State(app.clone())).await;
        let (status, _) = status_and_code_copy(response).await;
        assert_eq!(status, StatusCode::OK);

        let response = insert_ops(State(app.clone()), Ok(json_body("unknown"))).await;
        let (status, code) = status_and_code(response).await;
        assert_eq!((status.as_u16(), code.as_str()), (403, "challenge_invalid"));

        // A real challenge is consumed even when the signature later fails,
        // so replaying it hits the challenge gate, not the verifier.
        let issued = {
            let response = challenge(State(app.clone())).await;
            let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["challenge"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let response = insert_ops(State(app.clone()), Ok(json_body(&issued))).await;
        let (status, _) = status_and_code(response).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let response = insert_ops(State(app), Ok(json_body(&issued))).await;
        let (status, code) = status_and_code(response).await;
        assert_eq!((status.as_u16(), code.as_str()), (403, "challenge_invalid"));
    }

    async fn status_and_code_copy(response: Response) -> (StatusCode, String) {
        status_and_code(response).await
    }
}
