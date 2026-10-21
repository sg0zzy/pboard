//! Google verifies identity only. Board roots sign email policies and device
//! manifests; this bounded, volatile directory cannot mint a membership grant.
use crate::{App, PublicKey, now_ms};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{Signature, signature::Verifier};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

const MAX_BOARDS: usize = 64;
const MAX_BOARDS_PER_OWNER: usize = 16;
const MAX_MEMBERS: usize = 16;
const MAX_PENDING: usize = 16;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    version: u8,
    board_id: String,
    authority: PublicKey,
    owner_email: String,
    members: Vec<EmailRole>,
    issued_at: u64,
    expires_at: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmailRole {
    email: String,
    role: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignedPolicy {
    policy: Policy,
    signature: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRequest {
    format: String,
    board_id: String,
    authority_key_id: String,
    public_key: PublicKey,
    device_key_id: String,
    expires_at: u64,
    nonce: String,
    signature: String,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Sync {
        publication: Option<SignedPolicy>,
    },
    Request {
        request: DeviceRequest,
    },
    /// Google service admission is independent of board membership.
    Admit {
        challenge: String,
        session: String,
        room: String,
    },
}
#[derive(Clone)]
pub(crate) struct ServiceAdmission {
    pub challenge: String,
    pub session: String,
    pub room: String,
    pub device: String,
    pub consume_before: u64,
    pub expires_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Exchange {
    version: u8,
    challenge: String,
    public_key: PublicKey,
    operation: Operation,
    signature: String,
}
#[derive(Clone, Serialize)]
struct Pending {
    email: String,
    request: DeviceRequest,
}
struct Entry {
    signed: SignedPolicy,
    pending: HashMap<String, Pending>,
}
#[derive(Default)]
pub(crate) struct Directory {
    entries: HashMap<String, Entry>,
    challenges: HashMap<String, u64>,
    admissions: HashMap<String, ServiceAdmission>,
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn email(s: &str) -> bool {
    s.len() <= 254
        && s.is_ascii()
        && s == s.trim().to_lowercase()
        && s.contains('@')
        && !s
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
}
fn verify(key: &PublicKey, signature: &str, bytes: &[u8]) -> Result<(), &'static str> {
    let raw = B64.decode(signature).map_err(|_| "invalid_signature")?;
    let sig = Signature::from_slice(&raw).map_err(|_| "invalid_signature")?;
    key.key()?
        .verify(bytes, &sig)
        .map_err(|_| "invalid_signature")
}
fn encoded(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap()
}
impl Directory {
    fn clean(&mut self) {
        self.challenges.retain(|_, expiry| *expiry > now_ms());
        self.admissions
            .retain(|_, admission| admission.consume_before > now_ms());
        self.entries
            .retain(|_, entry| entry.signed.policy.expires_at.saturating_add(390_000) > now_ms());
        for entry in self.entries.values_mut() {
            entry.pending.retain(|_, p| p.request.expires_at > now_ms());
        }
    }
    fn apply(&mut self, email: &str, operation: Operation) -> Result<Value, &'static str> {
        self.clean();
        match operation {
            Operation::Admit { .. } => return Err("service_admission_requires_device_proof"),
            Operation::Sync {
                publication: Some(signed),
            } => {
                let p = &signed.policy;
                if p.version != 1
                    || !identifier(&p.board_id)
                    || !crate::identity_enrollment::email(&p.owner_email)
                    || p.owner_email != email
                    || p.issued_at > now_ms() + 30_000
                    || p.expires_at <= now_ms()
                    || p.expires_at <= p.issued_at
                    || p.expires_at - p.issued_at > 600_000
                    || p.members.len() > MAX_MEMBERS
                    || p.members.iter().any(|m| {
                        !crate::identity_enrollment::email(&m.email)
                            || m.email == p.owner_email
                            || !matches!(m.role.as_str(), "editor" | "viewer")
                    })
                    || p.members
                        .iter()
                        .map(|m| &m.email)
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != p.members.len()
                {
                    return Err("invalid_policy");
                }
                verify(
                    &p.authority,
                    &signed.signature,
                    &encoded(json!(["pboard-identity-policy-v1", p])),
                )?;
                let scope = crate::board_grants::scope(&p.authority.fingerprint(), &p.board_id);
                if let Some(previous) = self.entries.get(&scope) {
                    if previous.signed.policy.owner_email != email
                        || previous.signed.policy.issued_at > p.issued_at
                        || (previous.signed.policy.issued_at == p.issued_at
                            && encoded(json!(previous.signed)) != encoded(json!(signed)))
                    {
                        return Err("policy_conflict");
                    }
                } else if self.entries.len() >= MAX_BOARDS
                    || self
                        .entries
                        .values()
                        .filter(|entry| entry.signed.policy.owner_email == email)
                        .count()
                        >= MAX_BOARDS_PER_OWNER
                {
                    return Err("directory_capacity");
                }
                let entry = self.entries.entry(scope).or_insert_with(|| Entry {
                    signed: signed.clone(),
                    pending: HashMap::new(),
                });
                entry.signed = signed;
                entry
                    .pending
                    .retain(|_, pending| role(&entry.signed.policy, &pending.email).is_some());
            }
            Operation::Sync { publication: None } => (),
            Operation::Request { request } => {
                if request.format != "pboard-board-device-v1"
                    || !identifier(&request.board_id)
                    || !identifier(&request.nonce)
                    || request.expires_at <= now_ms()
                    || request.expires_at > now_ms() + 3_600_000
                    || request.public_key.fingerprint() != request.device_key_id
                {
                    return Err("invalid_request");
                }
                let mut payload = serde_json::to_value(&request).unwrap();
                payload.as_object_mut().unwrap().remove("signature");
                let bytes = encoded(payload);
                let mut envelope = b"pboard-board-device-v1".to_vec();
                envelope.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                envelope.extend_from_slice(&bytes);
                verify(&request.public_key, &request.signature, &envelope)?;
                let scope =
                    crate::board_grants::scope(&request.authority_key_id, &request.board_id);
                let entry = self.entries.get_mut(&scope).ok_or("board_not_available")?;
                if entry.signed.policy.expires_at <= now_ms()
                    || role(&entry.signed.policy, email).is_none()
                {
                    return Err("board_not_authorized");
                }
                if let Some(previous) = entry.pending.get(&request.device_key_id) {
                    if previous.email != email {
                        return Err("device_identity_conflict");
                    }
                } else if entry.pending.len() >= MAX_PENDING {
                    return Err("pending_capacity");
                }
                entry.pending.insert(
                    request.device_key_id.clone(),
                    Pending {
                        email: email.into(),
                        request,
                    },
                );
            }
        }
        let boards: Vec<_> = self.entries.values().filter(|e| e.signed.policy.expires_at > now_ms() && role(&e.signed.policy, email).is_some()).map(|e| {
            // Invitations are visible only to participants. Requests are visible
            // only to the verified owner, and never constitute room admission.
            json!({"publication":e.signed,"pending":if e.signed.policy.owner_email == email {e.pending.values().cloned().collect::<Vec<_>>()} else {vec![]}})
        }).collect();
        Ok(json!({"version":1,"email":email,"boards":boards}))
    }
}
impl Directory {
    pub(crate) fn admit(
        &mut self,
        challenge: String,
        session: String,
        room: String,
        device: String,
        capacity: usize,
    ) -> Result<Value, &'static str> {
        self.clean();
        if challenge.len() != 43
            || session.len() != 43
            || !identifier(&challenge)
            || !identifier(&session)
            || !crate::valid_room(&room)
        {
            return Err("invalid_service_binding");
        }
        if self.admissions.len() >= capacity {
            return Err("service_capacity");
        }
        let ticket = crate::nonce();
        let expires_at = now_ms() + 300_000;
        self.admissions.insert(
            ticket.clone(),
            ServiceAdmission {
                challenge,
                session,
                room,
                device,
                consume_before: now_ms() + 30_000,
                expires_at,
            },
        );
        Ok(json!({"version":1,"admission":ticket,"expiresAt":expires_at}))
    }
    pub(crate) fn consume(
        &mut self,
        ticket: &str,
        challenge: &str,
        session: &str,
        room: &str,
        device: &str,
    ) -> Result<u64, &'static str> {
        self.clean();
        let proof = self
            .admissions
            .remove(ticket)
            .ok_or("service_auth_required")?;
        if proof.challenge != challenge
            || proof.session != session
            || proof.room != room
            || proof.device != device
            || proof.expires_at <= now_ms()
        {
            return Err("service_binding_invalid");
        }
        Ok(proof.expires_at)
    }
}
fn role<'a>(p: &'a Policy, email: &str) -> Option<&'a str> {
    if p.owner_email == email {
        Some("editor")
    } else {
        p.members
            .iter()
            .find(|m| m.email == email)
            .map(|m| m.role.as_str())
    }
}
fn response(result: Result<Value, &'static str>) -> Response {
    match result {
        Ok(value) => ([("Cache-Control", "no-store")], Json(value)).into_response(),
        Err(code) => {
            tracing::warn!(
                event = "identity_enrollment_rejected",
                reason = code,
                "identity enrollment rejected"
            );
            (
                StatusCode::FORBIDDEN,
                [("Cache-Control", "no-store")],
                Json(json!({"code":code})),
            )
                .into_response()
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest {
    version: u8,
}
pub async fn challenge(State(app): State<App>, Json(request): Json<ChallengeRequest>) -> Response {
    if request.version != 1 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !app.identity_enrollment || !app.board_grants || app.google_enrollment.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !app.permit_automatic_auth() {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let mut directory = app.identity_directory.lock().unwrap();
    directory.clean();
    if directory.challenges.len() >= 128 {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let challenge = crate::nonce();
    directory
        .challenges
        .insert(challenge.clone(), now_ms() + 30_000);
    response(Ok(json!({"version":1,"challenge":challenge})))
}
pub async fn exchange(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<Exchange>,
) -> Response {
    if !app.identity_enrollment || !app.board_grants {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(google) = app.google_enrollment.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !app.permit_automatic_auth() {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let result = async {
        if req.version != 1
            || !app
                .identity_directory
                .lock()
                .unwrap()
                .challenges
                .remove(&req.challenge)
                .is_some_and(|expiry| expiry > now_ms())
        {
            return Err("challenge_invalid");
        }
        verify(
            &req.public_key,
            &req.signature,
            &encoded(json!([
                "pboard-identity-v1",
                req.challenge,
                req.public_key.fingerprint(),
                req.operation
            ])),
        )?;
        if let Operation::Request { request } = &req.operation
            && request.device_key_id != req.public_key.fingerprint()
        {
            return Err("device_identity_conflict");
        }
        let token = headers
            .get("Authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|s| !s.is_empty() && s.len() <= 8192)
            .ok_or("google_token_missing")?;
        let email = google.verify_identity(token).await?;
        if let Operation::Admit {
            challenge,
            session,
            room,
        } = req.operation
        {
            return app.identity_directory.lock().unwrap().admit(
                challenge,
                session,
                room,
                req.public_key.fingerprint(),
                app.limits.replay_entries,
            );
        }
        app.identity_directory
            .lock()
            .unwrap()
            .apply(&email, req.operation)
    }
    .await;
    if result.is_ok() {
        tracing::info!(
            event = "identity_enrollment_verified",
            "verified identity; board policy evaluated"
        );
    }
    response(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};
    use rand_core::OsRng;
    fn public(key: &SigningKey) -> PublicKey {
        let point = key.verifying_key().to_encoded_point(false);
        PublicKey {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: B64.encode(point.x().unwrap()),
            y: B64.encode(point.y().unwrap()),
        }
    }
    fn sign(key: &SigningKey, bytes: &[u8]) -> String {
        let signature: Signature = key.sign(bytes);
        B64.encode(signature.to_bytes())
    }
    fn policy(key: &SigningKey, members: Vec<EmailRole>) -> SignedPolicy {
        let issued_at = now_ms();
        let policy = Policy {
            version: 1,
            board_id: "board".into(),
            authority: public(key),
            owner_email: "owner@example.test".into(),
            members,
            issued_at,
            expires_at: issued_at + 600_000,
        };
        let signature = sign(key, &encoded(json!(["pboard-identity-policy-v1", policy])));
        SignedPolicy { policy, signature }
    }
    fn request(root: &SigningKey, device: &SigningKey) -> DeviceRequest {
        let mut request = DeviceRequest {
            format: "pboard-board-device-v1".into(),
            board_id: "board".into(),
            authority_key_id: public(root).fingerprint(),
            public_key: public(device),
            device_key_id: public(device).fingerprint(),
            expires_at: now_ms() + 60_000,
            nonce: crate::nonce(),
            signature: String::new(),
        };
        let mut value = serde_json::to_value(&request).unwrap();
        value.as_object_mut().unwrap().remove("signature");
        let payload = encoded(value);
        let mut bytes = b"pboard-board-device-v1".to_vec();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        request.signature = sign(device, &bytes);
        request
    }
    #[test]
    fn only_owner_policies_authorize_same_account_and_explicitly_invited_accounts() {
        let root = SigningKey::random(&mut OsRng);
        let mut directory = Directory::default();
        let signed = policy(
            &root,
            vec![EmailRole {
                email: "invited@example.test".into(),
                role: "viewer".into(),
            }],
        );
        assert!(
            directory
                .apply(
                    "other@example.test",
                    Operation::Sync {
                        publication: Some(signed.clone())
                    }
                )
                .is_err()
        );
        directory
            .apply(
                "owner@example.test",
                Operation::Sync {
                    publication: Some(signed),
                },
            )
            .unwrap();
        for email in ["owner@example.test", "invited@example.test"] {
            let device = SigningKey::random(&mut OsRng);
            let response = directory
                .apply(
                    email,
                    Operation::Request {
                        request: request(&root, &device),
                    },
                )
                .unwrap();
            assert_eq!(response["boards"].as_array().unwrap().len(), 1);
            if email.starts_with("invited") {
                assert!(
                    response["boards"][0]["pending"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
            }
        }
        assert_eq!(
            directory
                .apply("other@example.test", Operation::Sync { publication: None })
                .unwrap()["boards"],
            json!([])
        );
        assert!(
            directory
                .apply(
                    "other@example.test",
                    Operation::Request {
                        request: request(&root, &SigningKey::random(&mut OsRng))
                    }
                )
                .is_err()
        );
    }
    #[test]
    fn allows_sixteen_boards_per_owner_and_keeps_global_directory_bounded() {
        let root = SigningKey::random(&mut OsRng);
        let mut directory = Directory::default();
        let publication = |owner: usize, board: usize| {
            let mut signed = policy(&root, vec![]);
            signed.policy.board_id = format!("board-{owner}-{board}");
            signed.policy.owner_email = format!("owner{owner}@example.test");
            signed.signature = sign(
                &root,
                &encoded(json!(["pboard-identity-policy-v1", signed.policy])),
            );
            signed
        };
        for owner in 0..4 {
            for board in 0..MAX_BOARDS_PER_OWNER {
                let signed = publication(owner, board);
                directory
                    .apply(
                        &signed.policy.owner_email.clone(),
                        Operation::Sync {
                            publication: Some(signed),
                        },
                    )
                    .unwrap();
            }
            let rejected = publication(owner, MAX_BOARDS_PER_OWNER);
            assert_eq!(
                directory
                    .apply(
                        &rejected.policy.owner_email.clone(),
                        Operation::Sync {
                            publication: Some(rejected)
                        }
                    )
                    .unwrap_err(),
                "directory_capacity"
            );
        }
        assert_eq!(directory.entries.len(), MAX_BOARDS);
        let rejected = publication(4, 0);
        assert_eq!(
            directory
                .apply(
                    &rejected.policy.owner_email.clone(),
                    Operation::Sync {
                        publication: Some(rejected)
                    }
                )
                .unwrap_err(),
            "directory_capacity"
        );
        // At capacity, renewing an existing board remains possible.
        let existing = publication(0, 0);
        directory
            .apply(
                &existing.policy.owner_email.clone(),
                Operation::Sync {
                    publication: Some(existing),
                },
            )
            .unwrap();
    }
    #[test]
    fn rejects_forged_expired_rollback_cross_board_requests_and_quota_floods() {
        let root = SigningKey::random(&mut OsRng);
        let mut directory = Directory::default();
        let mut forged = policy(&root, vec![]);
        forged.policy.owner_email = "attacker@example.test".into();
        assert!(
            directory
                .apply(
                    "attacker@example.test",
                    Operation::Sync {
                        publication: Some(forged)
                    }
                )
                .is_err()
        );
        let signed = policy(&root, vec![]);
        directory
            .apply(
                "owner@example.test",
                Operation::Sync {
                    publication: Some(signed.clone()),
                },
            )
            .unwrap();
        let mut older = signed.clone();
        older.policy.issued_at -= 1;
        older.signature = sign(
            &root,
            &encoded(json!(["pboard-identity-policy-v1", older.policy])),
        );
        assert!(
            directory
                .apply(
                    "owner@example.test",
                    Operation::Sync {
                        publication: Some(older)
                    }
                )
                .is_err()
        );
        let mut expired = signed.clone();
        expired.policy.expires_at = now_ms() - 1;
        assert!(
            directory
                .apply(
                    "owner@example.test",
                    Operation::Sync {
                        publication: Some(expired)
                    }
                )
                .is_err()
        );
        let mut bad = request(&root, &SigningKey::random(&mut OsRng));
        bad.board_id = "other".into();
        assert!(
            directory
                .apply("owner@example.test", Operation::Request { request: bad })
                .is_err()
        );
        for _ in 0..MAX_PENDING {
            directory
                .apply(
                    "owner@example.test",
                    Operation::Request {
                        request: request(&root, &SigningKey::random(&mut OsRng)),
                    },
                )
                .unwrap();
        }
        assert!(
            directory
                .apply(
                    "owner@example.test",
                    Operation::Request {
                        request: request(&root, &SigningKey::random(&mut OsRng))
                    }
                )
                .is_err()
        );
        // A restarted directory grants no discovery or admission by old board ID.
        assert_eq!(
            Directory::default()
                .apply("owner@example.test", Operation::Sync { publication: None })
                .unwrap()["boards"],
            json!([])
        );
    }
    #[test]
    fn malformed_operations_unknown_fields_and_payload_relay_are_rejected() {
        for value in [
            json!({"type":"proxy","url":"https://example.test"}),
            json!({"type":"sync","publication":null,"documents":[]}),
            json!({"type":"request","request":{"boardId":"board","content":"secret"}}),
        ] {
            assert!(serde_json::from_value::<Operation>(value).is_err());
        }
    }
    #[test]
    fn service_admission_is_one_use_scoped_expiring_and_capacity_bounded() {
        let mut directory = Directory::default();
        let challenge = "a".repeat(43);
        let session = "b".repeat(43);
        let issue = |directory: &mut Directory| {
            directory.admit(
                challenge.clone(),
                session.clone(),
                "room".into(),
                "device".into(),
                1,
            )
        };
        let ticket = issue(&mut directory).unwrap()["admission"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(issue(&mut directory).unwrap_err(), "service_capacity");
        assert_eq!(
            directory
                .consume(&ticket, &challenge, &session, "other-board", "device")
                .unwrap_err(),
            "service_binding_invalid"
        );
        assert!(
            directory
                .consume(&ticket, &challenge, &session, "room", "device")
                .is_err()
        );
        for (c, s, r, d) in [
            ("wrong", session.as_str(), "room", "device"),
            (challenge.as_str(), "wrong", "room", "device"),
            (challenge.as_str(), session.as_str(), "room", "other-device"),
        ] {
            let ticket = issue(&mut directory).unwrap()["admission"]
                .as_str()
                .unwrap()
                .to_owned();
            assert!(directory.consume(&ticket, c, s, r, d).is_err());
        }
        let ticket = issue(&mut directory).unwrap()["admission"]
            .as_str()
            .unwrap()
            .to_owned();
        directory
            .admissions
            .get_mut(&ticket)
            .unwrap()
            .consume_before = now_ms() - 1;
        assert!(
            directory
                .consume(&ticket, &challenge, &session, "room", "device")
                .is_err()
        );
        let ticket = issue(&mut directory).unwrap()["admission"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            directory
                .consume(&ticket, &challenge, &session, "room", "device")
                .unwrap()
                > now_ms()
        );
        assert!(
            directory
                .consume(&ticket, &challenge, &session, "room", "device")
                .is_err()
        );
        assert!(
            directory
                .admit("invalid".into(), session, "room".into(), "device".into(), 1)
                .is_err()
        );
    }
    #[tokio::test]
    async fn http_verifies_google_identity_and_key_possession_consumes_nonce_and_requires_explicit_feature()
     {
        use axum::{Router, routing::get};
        let google = Router::new().route(
            "/about",
            get(|headers: HeaderMap| async move {
                if headers.get("Authorization").and_then(|h| h.to_str().ok())
                    == Some("Bearer owner-token")
                {
                    (
                        StatusCode::OK,
                        Json(json!({"user":{"emailAddress":"owner@example.test"}})),
                    )
                } else {
                    (StatusCode::UNAUTHORIZED, Json(json!({})))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let google_task = tokio::spawn(async move {
            axum::serve(listener, google).await.unwrap();
        });
        let path = std::env::temp_dir().join(format!("pboard-identity-{}.json", crate::nonce()));
        let enrollment = crate::google_enrollment::GoogleEnrollment::new(
            SigningKey::random(&mut OsRng),
            std::collections::BTreeSet::from(["owner@example.test".into()]),
            path,
        )
        .unwrap()
        .with_test_google_base(base)
        .unwrap();
        let app = App::new(
            crate::Config {
                rooms: HashMap::new(),
            },
            crate::Limits::default(),
        )
        .unwrap()
        .with_board_grants(true)
        .with_google_enrollment(enrollment)
        .with_identity_enrollment(true);
        let public_app = app
            .clone()
            .with_transport_policy(crate::policy::TransportPolicy {
                require_tls_proxy: true,
                ..Default::default()
            });
        assert!(public_app.validate_service_policy().is_ok());
        let mut incomplete = public_app.clone();
        incomplete.identity_enrollment = false;
        assert!(incomplete.validate_service_policy().is_err());
        incomplete.google_enrollment = None;
        assert!(incomplete.validate_service_policy().is_err());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let http = reqwest::Client::new();
        let key = SigningKey::random(&mut OsRng);
        for token in ["bad-token", "owner-token"] {
            let challenge: Value = http
                .post(format!("{base}/identity/challenge"))
                .json(&json!({"version":1}))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let operation = json!({"type":"sync","publication":null});
            let signed = sign(
                &key,
                &encoded(json!([
                    "pboard-identity-v1",
                    challenge["challenge"],
                    public(&key).fingerprint(),
                    operation
                ])),
            );
            let body = json!({"version":1,"challenge":challenge["challenge"],"publicKey":public(&key),"operation":operation,"signature":signed});
            let result = http
                .post(format!("{base}/identity/exchange"))
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(
                result.status(),
                if token == "owner-token" {
                    StatusCode::OK
                } else {
                    StatusCode::FORBIDDEN
                }
            );
            assert_eq!(
                http.post(format!("{base}/identity/exchange"))
                    .bearer_auth("owner-token")
                    .json(&body)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        // The HTTP proof uses the actual WebSocket challenge/connection and
        // its device key. Google alone still cannot authorize a room.
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        for token in [None, Some("bad-token"), Some("owner-token")] {
            let (mut socket, _) = connect_async(base.replace("http:", "ws:") + "/ws")
                .await
                .unwrap();
            let welcome: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(welcome["requiresServiceAdmission"], true);
            let mut ticket = None;
            if let Some(token) = token {
                let hello: Value = http
                    .post(format!("{base}/identity/challenge"))
                    .json(&json!({"version":1}))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                let operation = json!({"type":"admit","challenge":welcome["challenge"],"session":welcome["session"],"room":"unknown-board"});
                let signature = sign(
                    &key,
                    &encoded(json!([
                        "pboard-identity-v1",
                        hello["challenge"],
                        public(&key).fingerprint(),
                        operation
                    ])),
                );
                let result = http.post(format!("{base}/identity/exchange")).bearer_auth(token).json(&json!({"version":1,"challenge":hello["challenge"],"publicKey":public(&key),"operation":operation,"signature":signature})).send().await.unwrap();
                if token == "owner-token" {
                    assert_eq!(result.status(), StatusCode::OK);
                    ticket = Some(result.json::<Value>().await.unwrap()["admission"].clone());
                } else {
                    assert_eq!(result.status(), StatusCode::FORBIDDEN);
                }
            }
            socket.send(Message::Text(json!({"type":"authenticate","version":2,"room":"unknown-board","deviceKeyId":public(&key).fingerprint(),"signature":"invalid","serviceAdmission":ticket}).to_string().into())).await.unwrap();
            let error: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(
                error["code"],
                if token == Some("owner-token") {
                    "unauthorized"
                } else {
                    "service_auth_required"
                }
            );
        }
        let mut disabled = app.clone();
        disabled.identity_enrollment = false;
        assert_eq!(
            challenge(State(disabled), Json(ChallengeRequest { version: 1 }))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        // Expired challenges cannot be replayed even with an otherwise valid key.
        app.identity_directory
            .lock()
            .unwrap()
            .challenges
            .insert("expired".into(), now_ms() - 1);
        let req = Exchange {
            version: 1,
            challenge: "expired".into(),
            public_key: public(&key),
            operation: Operation::Sync { publication: None },
            signature: String::new(),
        };
        assert_eq!(
            exchange(State(app), HeaderMap::new(), Json(req))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        task.abort();
        google_task.abort();
    }
}
