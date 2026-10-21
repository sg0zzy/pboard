//! Bounded, disposable cache of public, authority-signed authorization metadata.
//! No Google, board documents, invitation secrets, or private keys are accepted.
use crate::{
    App, PublicKey,
    admission::{AdmissionProof, room_name},
    now_ms,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{Signature, signature::Verifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub const MAX_BUNDLE: usize = 4 * 1024 * 1024;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedEntry {
    payload: String,
    signature: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    version: u8,
    authority: PublicKey,
    history: Vec<SignedEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publication {
    version: u8,
    bundle: Bundle,
    device_key_id: String,
    signature: String,
    challenge: String,
    authority_signature: String,
}
struct Cached {
    bundle: Bundle,
    expires_at: u64,
    bytes: usize,
}
#[derive(Default)]
pub(crate) struct GrantCache {
    scopes: HashMap<String, Cached>,
}
impl GrantCache {
    pub(crate) fn is_current(
        &self,
        authority: &str,
        board: &str,
        payload: &str,
        signature: &str,
    ) -> bool {
        self.scopes
            .get(&scope(authority, board))
            .filter(|entry| entry.expires_at > now_ms())
            .and_then(|entry| entry.bundle.history.last())
            .is_some_and(|last| last.payload == payload && last.signature == signature)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest {
    version: u8,
}
pub async fn challenge(
    State(app): State<App>,
    body: Result<Json<ChallengeRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !app.board_grants {
        return error("disabled", StatusCode::NOT_FOUND);
    }
    let Ok(Json(request)) = body else {
        return error("invalid_challenge", StatusCode::BAD_REQUEST);
    };
    if request.version != 2 {
        return error("unsupported_version", StatusCode::BAD_REQUEST);
    }
    let mut challenges = app.publication_challenges.lock().unwrap();
    challenges.retain(|_, expiry| *expiry > now_ms());
    if challenges.len() >= 128 {
        return error("server_busy", StatusCode::TOO_MANY_REQUESTS);
    }
    let challenge = crate::nonce();
    let expires = now_ms() + 30_000;
    challenges.insert(challenge.clone(), expires);
    (
        [("Cache-Control", "no-store")],
        Json(serde_json::json!({"version":2,"challenge":challenge,"expiresAt":expires})),
    )
        .into_response()
}
pub fn scope(authority: &str, board: &str) -> String {
    B64.encode(Sha256::digest(
        serde_json::to_vec(&["pboard-board-grants-v1", authority, board]).unwrap(),
    ))
}
fn error(code: &'static str, status: StatusCode) -> Response {
    (
        status,
        [("Cache-Control", "no-store")],
        Json(serde_json::json!({"code":code})),
    )
        .into_response()
}
pub async fn publish(
    State(app): State<App>,
    body: Result<Json<Publication>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !app.board_grants {
        return error("disabled", StatusCode::NOT_FOUND);
    }
    if !app.permit_automatic_auth() {
        return error("rate_limit", StatusCode::TOO_MANY_REQUESTS);
    }
    let Ok(Json(publication)) = body else {
        return error("invalid_grant", StatusCode::BAD_REQUEST);
    };
    if publication.version != 2 {
        return error("unsupported_version", StatusCode::BAD_REQUEST);
    }
    if !app
        .publication_challenges
        .lock()
        .unwrap()
        .remove(&publication.challenge)
        .is_some_and(|expiry| expiry > now_ms())
    {
        return error("challenge_invalid", StatusCode::FORBIDDEN);
    }
    let Ok(permit) = app.grant_permits.clone().try_acquire_owned() else {
        return error("server_busy", StatusCode::TOO_MANY_REQUESTS);
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        publish_inner(&app, publication)
    })
    .await;
    match result.unwrap_or(Err("server_busy")) {
        Ok(()) => (StatusCode::NO_CONTENT, [("Cache-Control", "no-store")]).into_response(),
        Err(code) => error(code, StatusCode::FORBIDDEN),
    }
}
fn publish_inner(app: &App, publication: Publication) -> Result<(), &'static str> {
    let bundle = publication.bundle;
    if bundle.version != 1
        || bundle.history.is_empty()
        || bundle.history.len() > app.limits.grant_history
    {
        return Err("history_capacity");
    }
    let last = bundle.history.last().ok_or("invalid_grant")?;
    let mut proof = AdmissionProof {
        topic: String::new(),
        authority: bundle.authority.clone(),
        manifest_payload: last.payload.clone(),
        manifest_signature: last.signature.clone(),
    };
    let (board, _) = proof.history_identity()?;
    proof.topic = format!("pboard-collab-{board}-cards");
    let room = room_name(&bundle.authority.fingerprint(), &proof.topic, "", "");
    let verified = proof.verify(
        &room,
        &publication.device_key_id,
        "publish",
        "publish",
        &publication.signature,
        now_ms(),
    )?;
    // Only the board authority can publish/restore current membership. A revoked
    // member holding a still-unexpired old device grant cannot reseed an empty
    // cache after restart or replay a captured static publication.
    let bytes = serde_json::to_vec(&[
        "pboard-grant-publish-v2",
        &publication.challenge,
        &bundle.authority.fingerprint(),
        &board,
        &verified.digest,
    ])
    .map_err(|_| "invalid_grant")?;
    let raw = B64
        .decode(&publication.authority_signature)
        .map_err(|_| "invalid_grant")?;
    let signature = Signature::from_slice(&raw).map_err(|_| "invalid_grant")?;
    bundle
        .authority
        .key()?
        .verify(&bytes, &signature)
        .map_err(|_| "invalid_grant")?;
    // Authenticate the authority before doing potentially thousands of history
    // verifications. Public metadata cannot be reused as a CPU-amplification job.
    let mut epoch = None;
    for entry in &bundle.history {
        let entry_proof = AdmissionProof {
            topic: String::new(),
            authority: bundle.authority.clone(),
            manifest_payload: entry.payload.clone(),
            manifest_signature: entry.signature.clone(),
        };
        let (id, current_epoch) = entry_proof.history_identity()?;
        if id != board || epoch.is_some_and(|previous| current_epoch <= previous) {
            return Err("history_fork");
        }
        epoch = Some(current_epoch);
    }
    let key = scope(&bundle.authority.fingerprint(), &board);
    let mut cache = app.grant_cache.lock().unwrap();
    cache
        .scopes
        .retain(|_, entry| entry.expires_at.saturating_add(390_000) > now_ms());
    if let Some(previous) = cache.scopes.get(&key)
        && (bundle.history.len() < previous.bundle.history.len()
            || previous
                .bundle
                .history
                .iter()
                .zip(&bundle.history)
                .any(|(old, next)| old.payload != next.payload || old.signature != next.signature))
    {
        return Err("history_fork");
    }
    let bytes = serde_json::to_vec(&bundle)
        .map_err(|_| "invalid_grant")?
        .len();
    let retained: usize = cache
        .scopes
        .iter()
        .filter(|(id, _)| **id != key)
        .map(|(_, entry)| entry.bytes)
        .sum();
    if bytes > app.limits.grant_bundle_bytes
        || retained.saturating_add(bytes) > app.limits.grant_cache_bytes
        || (!cache.scopes.contains_key(&key)
            && cache.scopes.len() >= app.limits.authorization_scopes)
    {
        return Err("server_busy");
    }
    // Publish advances the same revocation watch used by both WebRTC rooms.
    let expires_at = verified.expires_at;
    app.accept_admission(verified)?;
    cache.scopes.insert(
        key,
        Cached {
            bundle,
            expires_at,
            bytes,
        },
    );
    tracing::info!(
        event = "board_grant_published",
        epoch = epoch.unwrap_or(0),
        "signed board authorization cached"
    );
    Ok(())
}
pub async fn read(State(app): State<App>, Path(key): Path<String>) -> Response {
    if !app.board_grants {
        return error("disabled", StatusCode::NOT_FOUND);
    }
    if !app.permit_automatic_auth() {
        return error("rate_limit", StatusCode::TOO_MANY_REQUESTS);
    }
    if key.len() != 43 {
        return error("not_found", StatusCode::NOT_FOUND);
    }
    let cache = app.grant_cache.lock().unwrap();
    match cache
        .scopes
        .get(&key)
        .filter(|entry| entry.expires_at > now_ms())
    {
        Some(entry) => ([("Cache-Control", "no-store")], Json(&entry.bundle)).into_response(),
        None => error("not_found", StatusCode::NOT_FOUND),
    }
}
