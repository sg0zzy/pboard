//! Google OpenID Connect ID-token verification. This verifier does not grant a
//! board role; Drive authorization and session binding are separate steps.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{RsaPublicKeyComponents, RSA_PKCS1_2048_8192_SHA256};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use std::collections::HashMap;
use tokio::sync::Mutex;
use axum::{Json, extract::State, http::{header::CACHE_CONTROL, StatusCode}, response::{IntoResponse, Response}};
use serde::Deserialize;
use serde_json::json;

const JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_URL: &str = "https://www.googleapis.com/drive/v3/files/";
const JWKS_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveRole { Owner, Editor, Viewer }

/// Verified user and board identity, never the delegated credential.
pub struct VerifiedBoardAccess {
    pub subject: String,
    /// The verified ID-token expiry, in Unix seconds. The eventual session must
    /// also impose a shorter Drive permission-revalidation deadline.
    pub identity_expires_at: u64,
    pub board_id: String,
    pub folder_id: String,
    pub role: DriveRole,
    pub room: String,
}

/// A one-use ticket binds a Google/Drive decision to one WebSocket welcome.
/// It holds no credential and is discarded if the service restarts. The
/// decision expires after at most two minutes, bounding access without a fresh
/// Drive permission check. The socket must enforce this deadline on its room.
pub struct DriveTicket {
    pub access: VerifiedBoardAccess,
    pub expires_at: u64,
    challenge: String,
    session: String,
    consume_before: u64,
}

#[derive(Default)]
pub struct DriveTickets { entries: HashMap<String, DriveTicket> }

impl DriveTickets {
    pub fn issue(&mut self, access: VerifiedBoardAccess, challenge: &str, session: &str, now: u64, capacity: usize) -> Result<(String, u64), &'static str> {
        let valid_binding = |s: &str| s.len() == 43 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
        if !valid_binding(challenge) || !valid_binding(session) || !crate::valid_room(&access.room) {
            return Err("invalid_service_binding");
        }
        self.entries.retain(|_, ticket| ticket.consume_before > now && ticket.expires_at > now);
        if self.entries.len() >= capacity { return Err("service_capacity"); }
        let expires_at = access.identity_expires_at.min(now.saturating_add(120));
        if expires_at <= now { return Err("invalid_identity"); }
        let ticket = crate::nonce();
        self.entries.insert(ticket.clone(), DriveTicket { access, expires_at, challenge: challenge.into(), session: session.into(), consume_before: now.saturating_add(30) });
        Ok((ticket, expires_at))
    }

    pub fn consume(&mut self, ticket: &str, challenge: &str, session: &str, room: &str, now: u64) -> Result<DriveTicket, &'static str> {
        let record = self.entries.remove(ticket).ok_or("service_auth_required")?;
        if record.challenge != challenge || record.session != session || record.access.room != room
            || record.consume_before <= now || record.expires_at <= now {
            return Err("service_binding_invalid");
        }
        Ok(record)
    }
}

// Deliberately no Debug: this request contains bearer credentials.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriveAdmissionRequest {
    id_token: String,
    access_token: String,
    board_id: String,
    folder_id: String,
    challenge: String,
    session: String,
}

/// The existing HTTP guard supplies TLS policy, concurrency and rate limits.
/// The response contains no OAuth credential and is never cacheable.
pub async fn admit(State(app): State<crate::App>, Json(request): Json<DriveAdmissionRequest>) -> Response {
    let Some(verifier) = app.google_drive_verifier.as_ref() else { return StatusCode::NOT_FOUND.into_response() };
    let valid_binding = |s: &str| s.len() == 43 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    if !valid_binding(&request.challenge) || !valid_binding(&request.session) { return StatusCode::BAD_REQUEST.into_response(); }
    let now = crate::now_ms() / 1000;
    // An empty board/folder pair requests the caller's own account room.
    // Its identity comes solely from Google's verified immutable subject.
    let result = if request.board_id.is_empty() && request.folder_id.is_empty() {
        verifier.account_access(&request.id_token, &request.access_token, now).await
    } else {
        verifier.board_access(&request.id_token, &request.access_token, &request.board_id, &request.folder_id, now).await
    };
    let access = match result {
        Ok(access) => access,
        Err("google_unavailable") => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Err(_) => return StatusCode::FORBIDDEN.into_response(),
    };
    let room = access.room.clone();
    let result = app.google_drive_tickets.lock().unwrap().issue(access, &request.challenge, &request.session, now, 4096);
    match result {
        Ok((ticket, expires_at)) => (StatusCode::OK, [(CACHE_CONTROL, "no-store")], Json(json!({"ticket": ticket, "room": room, "expiresAt": expires_at}))).into_response(),
        Err("service_capacity") => StatusCode::TOO_MANY_REQUESTS.into_response(),
        Err(_) => StatusCode::FORBIDDEN.into_response(),
    }
}

pub struct GoogleDriveVerifier {
    client: reqwest::Client,
    audiences: Vec<String>,
    keys: Mutex<Option<(Instant, Value)>>,
    jwks_url: String,
    userinfo_url: String,
    drive_url: String,
}

impl GoogleDriveVerifier {
    pub fn new(audiences: Vec<String>) -> Result<Self, &'static str> {
        if audiences.is_empty() || audiences.len() > 16 || audiences.iter().any(|id| id.len() > 256 || !id.ends_with(".apps.googleusercontent.com")) {
            return Err("invalid_oauth_audiences");
        }
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "google_client_unavailable")?;
        Ok(Self { client, audiences, keys: Mutex::new(None), jwks_url: JWKS_URL.into(), userinfo_url: USERINFO_URL.into(), drive_url: DRIVE_URL.into() })
    }

    /// Local synthetic Google fixture only; production always uses fixed HTTPS endpoints.
    #[cfg(any(test, feature = "test-google-fixture"))]
    pub fn with_test_base(mut self, base: &str) -> Result<Self, &'static str> {
        let url = reqwest::Url::parse(base).map_err(|_| "invalid_test_google_base")?;
        if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) || url.query().is_some() || url.fragment().is_some() {
            return Err("invalid_test_google_base");
        }
        self.jwks_url = url.join("/certs").map_err(|_| "invalid_test_google_base")?.to_string();
        self.userinfo_url = url.join("/userinfo").map_err(|_| "invalid_test_google_base")?.to_string();
        self.drive_url = url.join("/files/").map_err(|_| "invalid_test_google_base")?.to_string();
        Ok(self)
    }

    async fn json(&self, request: reqwest::RequestBuilder) -> Result<Value, &'static str> {
        let mut response = request.send().await.map_err(|_| "google_unavailable")?;
        let status = response.status();
        if status.as_u16() == 429 || status.is_server_error() { return Err("google_unavailable"); }
        if response.content_length().is_some_and(|size| size > 128 * 1024) { return Err("google_response_invalid"); }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "google_unavailable")? {
            if body.len() + chunk.len() > 128 * 1024 { return Err("google_response_invalid"); }
            body.extend_from_slice(&chunk);
        }
        let text = std::str::from_utf8(&body).map_err(|_| "google_response_invalid")?;
        let parsed = crate::strict_json::parse(text).map_err(|_| "google_response_invalid");
        if !status.is_success() {
            let quota = parsed.as_ref().ok().and_then(|body| body["error"]["errors"].as_array()).is_some_and(|errors| errors.iter().any(|error|
                matches!(error["reason"].as_str(), Some("rateLimitExceeded" | "userRateLimitExceeded" | "quotaExceeded"))));
            return Err(if quota { "google_unavailable" } else { "google_rejected" });
        }
        parsed
    }

    async fn jwks(&self) -> Result<Value, &'static str> {
        // One in-flight fetch per service, including a cold-start burst.
        let mut keys = self.keys.lock().await;
        if let Some((until, value)) = keys.as_ref() && Instant::now() < *until { return Ok(value.clone()); }
        let value = self.json(self.client.get(&self.jwks_url)).await?;
        if !value["keys"].is_array() { return Err("google_response_invalid"); }
        *keys = Some((Instant::now() + JWKS_TTL, value.clone()));
        Ok(value)
    }

    /// Account preferences belong to the Google subject, independently of any
    /// board ACL or browser-held authority. Bind both credentials before issuing
    /// a room that no other subject can address.
    pub async fn account_access(&self, id_token: &str, access_token: &str, now: u64) -> Result<VerifiedBoardAccess, &'static str> {
        if id_token.len() > 16_384 || access_token.is_empty() || access_token.len() > 8192 { return Err("invalid_request"); }
        let identity = verify_id_token(id_token, &self.jwks().await?, &self.audiences, now)?;
        let user = self.json(self.client.get(&self.userinfo_url).bearer_auth(access_token)).await?;
        if user["sub"].as_str() != Some(identity.subject.as_str()) { return Err("credential_identity_mismatch"); }
        // Drive about is queried with the very token whose subject matched the
        // signed ID token. The verified address is used only as a hashed inbox
        // routing key; it never authenticates the account or its room.
        let about_url = reqwest::Url::parse(&self.drive_url).map_err(|_| "google_client_unavailable")?
            .join("../about").map_err(|_| "google_client_unavailable")?;
        let about = self.json(self.client.get(about_url).query(&[("fields", "user(emailAddress)")]).bearer_auth(access_token)).await?;
        let email = about["user"]["emailAddress"].as_str().map(str::trim)
            .filter(|email| !email.is_empty() && email.len() <= 320 && email.is_ascii() && email.contains('@'))
            .ok_or("invalid_identity")?.to_ascii_lowercase();
        let inbox = Sha256::digest(email.as_bytes());
        let account_hash: String = inbox.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut hash = Sha256::new();
        hash.update(b"pboard-google-account-room-v1\0");
        hash.update(identity.subject.as_bytes());
        let room = format!("pboard-drive-{}", URL_SAFE_NO_PAD.encode(hash.finalize()));
        Ok(VerifiedBoardAccess { subject: identity.subject.clone(), identity_expires_at: identity.expires_at,
            board_id: format!("account:{account_hash}"), folder_id: String::new(), role: DriveRole::Editor, room })
    }

    /// Google ID token authenticates the subject; Google userinfo binds the
    /// transient delegated Drive access token to that same subject. Drive's
    /// computed capabilities include inherited permissions. No token is kept.
    pub async fn board_access(&self, id_token: &str, access_token: &str, board_id: &str, folder_id: &str, now: u64) -> Result<VerifiedBoardAccess, &'static str> {
        if id_token.len() > 16_384 || access_token.is_empty() || access_token.len() > 8192
            || !crate::sync_log::valid_id(board_id, 100) || !crate::sync_log::valid_id(folder_id, 256) {
            return Err("invalid_request");
        }
        let identity = verify_id_token(id_token, &self.jwks().await?, &self.audiences, now)?;
        let user = self.json(self.client.get(&self.userinfo_url).bearer_auth(access_token)).await?;
        if user["sub"].as_str() != Some(identity.subject.as_str()) { return Err("credential_identity_mismatch"); }
        let mut url = reqwest::Url::parse(&self.drive_url).map_err(|_| "google_client_unavailable")?;
        url.path_segments_mut().map_err(|_| "google_client_unavailable")?.pop_if_empty().push(folder_id);
        let folder = self.json(self.client.get(url).query(&[("fields", "id,name,mimeType,trashed,ownedByMe,capabilities(canListChildren,canAddChildren)")]).bearer_auth(access_token)).await?;
        let role = folder_role(&folder, board_id, folder_id)?;
        // Include the Drive folder identity in the room name: creating an
        // unrelated folder with the same board name cannot address this room.
        let mut hash = Sha256::new();
        hash.update(b"pboard-drive-room-v1\0");
        hash.update((board_id.len() as u32).to_be_bytes()); hash.update(board_id.as_bytes());
        hash.update((folder_id.len() as u32).to_be_bytes()); hash.update(folder_id.as_bytes());
        let room = format!("pboard-drive-{}", URL_SAFE_NO_PAD.encode(hash.finalize()));
        Ok(VerifiedBoardAccess { subject: identity.subject, identity_expires_at: identity.expires_at,
            board_id: board_id.into(), folder_id: folder_id.into(), role, room })
    }
}

fn folder_role(folder: &Value, board: &str, id: &str) -> Result<DriveRole, &'static str> {
    if folder["id"] != id || folder["name"] != board || folder["mimeType"] != "application/vnd.google-apps.folder"
        || folder["trashed"] != false || folder["capabilities"]["canListChildren"] != true {
        return Err("board_access_denied");
    }
    if folder["ownedByMe"] == true { Ok(DriveRole::Owner) }
    else if folder["capabilities"]["canAddChildren"] == true { Ok(DriveRole::Editor) }
    else { Ok(DriveRole::Viewer) }
}

/// Verify Google's RS256 signature and the identity claims against a caller's
/// trusted Google JWKS and explicit OAuth audience list. The caller must fetch
/// JWKS from Google's fixed HTTPS endpoint and bound the cache lifetime.
/// Never log token material or include it in an error.
#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedIdentity { pub subject: String, pub expires_at: u64 }

pub fn verify_id_token(token: &str, jwks: &Value, audiences: &[String], now: u64) -> Result<VerifiedIdentity, &'static str> {
    if token.len() > 16_384 || audiences.is_empty() { return Err("invalid_identity"); }
    let mut parts = token.split('.');
    let (Some(header), Some(claims), Some(signature), None) = (parts.next(), parts.next(), parts.next(), parts.next())
        else { return Err("invalid_identity") };
    let parse = |part: &str| -> Result<Value, &'static str> {
        let bytes = URL_SAFE_NO_PAD.decode(part).map_err(|_| "invalid_identity")?;
        let text = std::str::from_utf8(&bytes).map_err(|_| "invalid_identity")?;
        crate::strict_json::parse(text).map_err(|_| "invalid_identity")
    };
    let header_value = parse(header)?;
    if header_value["alg"] != "RS256" { return Err("invalid_identity"); }
    let kid = header_value["kid"].as_str().filter(|id| !id.is_empty() && id.len() <= 256).ok_or("invalid_identity")?;
    let keys = jwks["keys"].as_array().filter(|keys| keys.len() <= 64).ok_or("invalid_identity")?;
    let mut matching = keys.iter().filter(|key| key["kid"] == kid && key["kty"] == "RSA"
        && key["alg"] == "RS256" && key["use"] == "sig");
    let key = matching.next().ok_or("invalid_identity")?;
    if matching.next().is_some() { return Err("invalid_identity"); }
    let decode = |field: &str| -> Result<Vec<u8>, &'static str> {
        URL_SAFE_NO_PAD.decode(key[field].as_str().ok_or("invalid_identity")?).map_err(|_| "invalid_identity")
    };
    let modulus = decode("n")?;
    let exponent = decode("e")?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| "invalid_identity")?;
    let signed = format!("{header}.{claims}");
    RsaPublicKeyComponents { n: &modulus, e: &exponent }.verify(&RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &signature)
        .map_err(|_| "invalid_identity")?;
    let claims = parse(claims)?;
    let issuer = claims["iss"].as_str().ok_or("invalid_identity")?;
    if issuer != "https://accounts.google.com" && issuer != "accounts.google.com" { return Err("invalid_identity"); }
    let audience = claims["aud"].as_str().ok_or("invalid_identity")?;
    if !audiences.iter().any(|allowed| allowed == audience) { return Err("invalid_identity"); }
    if let Some(azp) = claims.get("azp")
        && azp.as_str().is_none_or(|value| !audiences.iter().any(|allowed| allowed == value)) { return Err("invalid_identity"); }
    let exp = claims["exp"].as_u64().ok_or("invalid_identity")?;
    let iat = claims["iat"].as_u64().ok_or("invalid_identity")?;
    if exp <= now || iat > now.saturating_add(30) || iat >= exp { return Err("invalid_identity"); }
    if let Some(nbf) = claims.get("nbf")
        && nbf.as_u64().is_none_or(|value| value > now.saturating_add(30)) { return Err("invalid_identity"); }
    let sub = claims["sub"].as_str().filter(|sub| !sub.is_empty() && sub.len() <= 255
        && sub.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')).ok_or("invalid_identity")?;
    Ok(VerifiedIdentity { subject: sub.to_owned(), expires_at: exp })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Synthetic signature and public key; no Google credential or private key.
    const VALID: &str = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5In0.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJhdWQiOiJjbGllbnQtYSIsInN1YiI6IjEyMzQ1Njc4OSIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.AE_b7uzPkW8AlKzio6gUMlBmrWx6IzyAEMaDdWFkdh6bF4KpKJ9oYNz7zCgxFfjcBpznmKqlEZSr9ykzWfa7JcT0ItRC2jhT0bn3JZ79VJO8Klx3NqqLztxPjVvkgTDvoCt9ZVx89UJb7sMwn-dHZd0Ax61OKZBbsRcpxwLhSZGzER-zoMMbs4v6hj40gizyUZjpQjpsnfNPOfIb4o_nBgHLDAB3q_ES6yhnZekVqXBlxA5pF0vRQhLLNEWyPlDCBXmpUBWmgKbX1MckbTVMJ-BfeC4E_cZQ67wgYsH2RzwmDXd6BQ4lz0oVMUj1Bys6Uz8jQiWifd23m4lCRn0SUg";
    const BAD_ISSUER: &str = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5In0.eyJpc3MiOiJodHRwczovL2ludmFsaWQuZXhhbXBsZSIsImF1ZCI6ImNsaWVudC1hIiwic3ViIjoiMTIzNDU2Nzg5IiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjQxMDI0NDQ4MDB9.MRk9undGHocW9CySp7h_0t6n5J5Zpv0qfr8ch2kdXvecV9CBNHUnRn4z9hrh7BOI6hoAtE8tqyoXr5bShyeKBT-5AsUcEuTAkyX7x5ec4TfLA_sJj80ArFZe62wLSpFbi1djSD2PFSfeD8cW0zdrB-09XD_bmKSQGjamjGFFsljXNFpWWfU4PI4B5q9gBdEuQEJtOL0Zukkl-1HKKKrH97fUyPJekugzXbzTDWyt9mAVMhKJLIcDdTTvUyq5E3kPeUjFj35-ahGQEtGJGIAWUQoqDWJMNGcyftWabF16ImRhgBJpJcwruTIgJW3XpRuo2A8ftiN9LBNwSCihHzJKCA";
    fn keys() -> Value { json!({"keys":[{"kty":"RSA","kid":"test-key","use":"sig","alg":"RS256","n":"vOY-Xthk1pq8f2E1pvvRNXpbvlMqiutEsF8HAXzrrC65rZPchJhDhwdociqiAu3fMXjJ0E_VQSJPHIJIJcyrlQCChyp13HoDMWiSYweaGM8uCZLIJEwwb-bNxn2meXbB67PveFchgYWtg3AnwRsFeYeZc9pGc7Df99KOevplDL2slwg_ARThzDMaxx3J5IiSPbJPLuVj7jchI_vcolXoHu_uFsLSsO4d7Wrf7CCl-DjfdXhs0Ubfn0Ikvwd35xdXl-C98kHYFc3n5CMd2O9s2soBJPViU1Fk0qux1cQybAF0xId1JYn0xFQXal6KE7UiGw683pAsMLM0qKGIrTJ5aQ","e":"AQAB"}]}) }

    #[test]
    fn verifies_signature_issuer_audience_and_expiry() {
        let allowed = vec!["client-b".into(), "client-a".into()];
        assert_eq!(verify_id_token(VALID, &keys(), &allowed, 2_000_000_000), Ok(VerifiedIdentity { subject: "123456789".into(), expires_at: 4_102_444_800 }));
        assert!(verify_id_token(VALID, &keys(), &["other".into()], 2_000_000_000).is_err());
        assert!(verify_id_token(VALID, &keys(), &allowed, 4_102_444_800).is_err());
        assert!(verify_id_token(BAD_ISSUER, &keys(), &allowed, 2_000_000_000).is_err());
        let mut forged = VALID.to_string(); forged.push('x');
        assert!(verify_id_token(&forged, &keys(), &allowed, 2_000_000_000).is_err());
        assert!(verify_id_token(VALID, &json!({"keys":[]}), &allowed, 2_000_000_000).is_err());
    }

    #[test]
    fn maps_effective_folder_capabilities_and_rejects_mismatched_bindings() {
        let mut folder = json!({"id":"folder", "name":"board", "mimeType":"application/vnd.google-apps.folder",
            "trashed":false, "ownedByMe":false, "capabilities":{"canListChildren":true,"canAddChildren":false}});
        assert_eq!(folder_role(&folder, "board", "folder"), Ok(DriveRole::Viewer));
        folder["capabilities"]["canAddChildren"] = json!(true);
        assert_eq!(folder_role(&folder, "board", "folder"), Ok(DriveRole::Editor));
        folder["ownedByMe"] = json!(true);
        assert_eq!(folder_role(&folder, "board", "folder"), Ok(DriveRole::Owner));
        assert!(folder_role(&folder, "other", "folder").is_err());
        assert!(folder_role(&folder, "board", "other").is_err());
        folder["capabilities"]["canListChildren"] = json!(false);
        assert!(folder_role(&folder, "board", "folder").is_err());
    }

    fn access(expiry: u64) -> VerifiedBoardAccess {
        VerifiedBoardAccess { subject: "123".into(), identity_expires_at: expiry, board_id: "board".into(),
            folder_id: "folder".into(), role: DriveRole::Editor, room: "pboard-drive-room".into() }
    }

    #[test]
    fn drive_tickets_are_one_use_bound_and_expire_without_credentials() {
        let mut tickets = DriveTickets::default();
        let challenge = "c".repeat(43); let session = "s".repeat(43);
        let (ticket, expiry) = tickets.issue(access(9_000), &challenge, &session, 1_000, 1).unwrap();
        assert_eq!(expiry, 1_120);
        assert!(matches!(tickets.issue(access(9_000), &challenge, &session, 1_000, 1), Err("service_capacity")));
        let record = tickets.consume(&ticket, &challenge, &session, "pboard-drive-room", 1_001).unwrap();
        assert_eq!(record.access.subject, "123"); assert_eq!(record.access.role, DriveRole::Editor);
        assert!(tickets.consume(&ticket, &challenge, &session, "pboard-drive-room", 1_001).is_err());
        for mismatch in ["session", "challenge", "room", "expired"] {
            let (ticket, _) = tickets.issue(access(9_000), &challenge, &session, 1_000, 1).unwrap();
            let (c, s, room, now) = match mismatch {
                "session" => (challenge.as_str(), "wrong", "pboard-drive-room", 1_001),
                "challenge" => ("wrong", session.as_str(), "pboard-drive-room", 1_001),
                "room" => (challenge.as_str(), session.as_str(), "other", 1_001),
                _ => (challenge.as_str(), session.as_str(), "pboard-drive-room", 1_030),
            };
            assert!(tickets.consume(&ticket, c, s, room, now).is_err());
            assert!(tickets.consume(&ticket, &challenge, &session, "pboard-drive-room", 1_001).is_err());
        }
        assert!(tickets.issue(access(1_000), &challenge, &session, 1_000, 1).is_err());
    }

    #[tokio::test]
    async fn delegated_google_fixture_checks_identity_folder_role_and_bound_ticket() {
        use axum::{routing::get, http::HeaderMap, Router};
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        let jwks_requests = Arc::new(AtomicUsize::new(0));
        let counter = jwks_requests.clone();
        let google = Router::new()
            .route("/certs", get(move || { let counter = counter.clone(); async move { counter.fetch_add(1, Ordering::SeqCst); Json(keys()) } }))
            .route("/about", get(|| async { Json(json!({"user":{"emailAddress":"test@example.com"}})) }))
            .route("/userinfo", get(|headers: HeaderMap| async move {
                if headers.get("authorization").and_then(|h| h.to_str().ok()) == Some("Bearer matching-test-token") {
                    Json(json!({"sub":"123456789"}))
                } else { Json(json!({"sub":"another-user"})) }
            }))
            .route("/files/{id}", get(|| async { Json(json!({"id":"folder", "name":"board", "mimeType":"application/vnd.google-apps.folder", "trashed":false,
                "ownedByMe":false, "capabilities":{"canListChildren":true,"canAddChildren":true}})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(axum::serve(listener, google).into_future());
        let mut verifier = GoogleDriveVerifier::new(vec!["configured.apps.googleusercontent.com".into()]).unwrap().with_test_base(&base).unwrap();
        verifier.audiences = vec!["client-a".into()];
        let account = verifier.account_access(VALID, "matching-test-token", 2_000_000_000).await.unwrap();
        assert_eq!(account.subject, "123456789");
        assert!(account.board_id.starts_with("account:"));
        assert!(verifier.account_access(VALID, "wrong-test-token", 2_000_000_000).await.is_err());
        let access = verifier.board_access(VALID, "matching-test-token", "board", "folder", 2_000_000_000).await.unwrap();
        assert_ne!(account.room, access.room);
        assert_eq!(access.subject, "123456789");
        assert_eq!(access.role, DriveRole::Editor);
        assert!(verifier.board_access(VALID, "wrong-test-token", "board", "folder", 2_000_000_000).await.is_err());
        assert!(verifier.board_access(VALID, "matching-test-token", "wrong-board", "folder", 2_000_000_000).await.is_err());
        assert_eq!(jwks_requests.load(Ordering::SeqCst), 1);
        let app = crate::App::new(crate::Config { rooms: HashMap::new() }, crate::Limits::default()).unwrap().with_google_drive_verifier(verifier);
        let challenge = "c".repeat(43); let session = "s".repeat(43); let room = access.room.clone();
        let now = crate::now_ms() / 1000;
        let (ticket, _) = app.google_drive_tickets.lock().unwrap().issue(access, &challenge, &session, now, 10).unwrap();
        let attached = app.admit_google_room(&ticket, &challenge, &session, &room, "actor-id").unwrap();
        assert!(attached.editor); assert!(!attached.owner);
        assert_eq!(attached.google_subject.as_deref(), Some("123456789"));
        assert!(app.admit_google_room(&ticket, &challenge, &session, &room, "actor-id").is_err());
        server.abort();
    }

    #[tokio::test]
    async fn verified_ticket_authenticates_a_socket_without_a_manifest() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        let directory = std::env::temp_dir().join(format!("pboard-drive-auth-test-{}", crate::nonce()));
        std::fs::create_dir(&directory).unwrap();
        let verifier = GoogleDriveVerifier::new(vec!["configured.apps.googleusercontent.com".into()]).unwrap();
        let app = crate::App::new(crate::Config { rooms: HashMap::new() }, crate::Limits::default()).unwrap()
            .with_google_drive_verifier(verifier).with_sync(&directory).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, app.clone().router()).into_future());
        let (mut socket, _) = connect_async(format!("ws://{address}/ws")).await.unwrap();
        let welcome: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        let challenge = welcome["challenge"].as_str().unwrap(); let session = welcome["session"].as_str().unwrap();
        let now = crate::now_ms() / 1000;
        let (ticket, _) = app.google_drive_tickets.lock().unwrap().issue(access(now + 300), challenge, session, now, 10).unwrap();
        socket.send(Message::Text(json!({"type":"authenticate", "version":3, "room":"pboard-drive-room", "deviceKeyId":"actor-id", "signature":"", "serviceAdmission":ticket}).to_string().into())).await.unwrap();
        let reply: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(reply["type"], "authenticated");
        socket.send(Message::Text(json!({"type":"join"}).to_string().into())).await.unwrap();
        let joined: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(joined["type"], "joined");
        let old_expiry = app.rooms.lock().unwrap()["pboard-drive-room"]["actor-id"].expires_at;
        let mut other = access(now + 300); other.subject = "other-google-user".into(); other.room = "pboard-drive-other".into();
        let (other_ticket, _) = app.google_drive_tickets.lock().unwrap().issue(other, challenge, session, now, 10).unwrap();
        socket.send(Message::Text(json!({"type":"attach", "room":"pboard-drive-other", "deviceKeyId":"actor-two", "signature":"", "serviceAdmission":other_ticket}).to_string().into())).await.unwrap();
        let refusal: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(refusal["code"], "identity_mismatch");
        // A shorter, valid renewed decision must also shorten the RTC roster
        // lifetime; retaining the original expiry would extend revoked access.
        let mut downgraded = access(now + 30); downgraded.role = DriveRole::Viewer;
        let (renewal, _) = app.google_drive_tickets.lock().unwrap().issue(downgraded, challenge, session, now, 10).unwrap();
        socket.send(Message::Text(json!({"type":"renewGoogle", "room":"pboard-drive-room", "serviceAdmission":renewal}).to_string().into())).await.unwrap();
        let renewed: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(renewed["type"], "renewedGoogle"); assert_eq!(renewed["role"], "viewer");
        let renewed_expiry = app.rooms.lock().unwrap()["pboard-drive-room"]["actor-id"].expires_at;
        assert!(renewed_expiry < old_expiry);
        assert_eq!(renewed_expiry, (now + 30) * 1000);
        socket.send(Message::Text(json!({"type":"sync", "request":{"action":"submit", "board":"pboard-drive-room",
            "operations":[{"opId":"op-1", "protocolVersion":1, "logicalClock":1, "payload":"test"}]}}).to_string().into())).await.unwrap();
        let denied: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(denied["code"], "read_only");
        let (extended, _) = app.google_drive_tickets.lock().unwrap().issue(access(now + 300), challenge, session, now, 10).unwrap();
        socket.send(Message::Text(json!({"type":"renewGoogle", "room":"pboard-drive-room", "serviceAdmission":extended}).to_string().into())).await.unwrap();
        let extended_reply: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(extended_reply["type"], "renewedGoogle");
        assert!(app.rooms.lock().unwrap()["pboard-drive-room"]["actor-id"].expires_at > renewed_expiry);
        let current = crate::now_ms() / 1000;
        let (short, _) = app.google_drive_tickets.lock().unwrap().issue(access(current + 2), challenge, session, current, 10).unwrap();
        socket.send(Message::Text(json!({"type":"renewGoogle", "room":"pboard-drive-room", "serviceAdmission":short}).to_string().into())).await.unwrap();
        let renewed: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(renewed["type"], "renewedGoogle");
        let ended = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
        let detached: Value = serde_json::from_str(ended.to_text().unwrap()).unwrap();
        assert_eq!(detached["type"], "detached"); assert_eq!(detached["code"], "grant_expired");
        socket.close(None).await.unwrap(); app.shutdown(); server.abort(); drop(app);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn google_sockets_receive_a_burst_and_continue_to_receive() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        let directory = std::env::temp_dir().join(format!("pboard-drive-burst-test-{}", crate::nonce()));
        std::fs::create_dir(&directory).unwrap();
        let verifier = GoogleDriveVerifier::new(vec!["configured.apps.googleusercontent.com".into()]).unwrap();
        let app = crate::App::new(crate::Config { rooms: HashMap::new() }, crate::Limits::default()).unwrap()
            .with_google_drive_verifier(verifier).with_sync(&directory).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let relay = tokio::spawn(axum::serve(listener, app.clone().router()).into_future());
        let mut sockets = Vec::new();
        for actor in ["actor-a", "actor-b"] {
            let (mut socket, _) = connect_async(format!("ws://{address}/ws")).await.unwrap();
            let welcome: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            let now = crate::now_ms() / 1000;
            let (ticket, _) = app.google_drive_tickets.lock().unwrap().issue(access(now + 300), welcome["challenge"].as_str().unwrap(), welcome["session"].as_str().unwrap(), now, 10).unwrap();
            socket.send(Message::Text(json!({"type":"authenticate", "version":3, "room":"pboard-drive-room", "deviceKeyId":actor, "signature":"", "serviceAdmission":ticket}).to_string().into())).await.unwrap();
            let reply: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(reply["type"], "authenticated");
            sockets.push(socket);
        }
        let mut writer = sockets.remove(0);
        let mut reader = sockets.remove(0);
        let operations: Vec<Value> = (1..=18).map(|i| json!({"opId":format!("op-{i}"), "protocolVersion":1, "logicalClock":i, "payload":"test"})).collect();
        writer.send(Message::Text(json!({"type":"sync", "request":{"action":"submit", "board":"pboard-drive-room", "operations":operations}}).to_string().into())).await.unwrap();
        let ack: Value = serde_json::from_str(writer.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(ack["action"], "accepted");
        for seq in 1..=18 {
            let frame = tokio::time::timeout(Duration::from_secs(2), reader.next()).await.unwrap().unwrap().unwrap();
            let frame: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(frame["seq"], seq);
        }
        writer.send(Message::Text(json!({"type":"sync", "request":{"action":"submit", "board":"pboard-drive-room", "operations":[{"opId":"op-19", "protocolVersion":1, "logicalClock":19, "payload":"test"}]}}).to_string().into())).await.unwrap();
        let next = tokio::time::timeout(Duration::from_secs(2), reader.next()).await.unwrap().unwrap().unwrap();
        let next: Value = serde_json::from_str(next.to_text().unwrap()).unwrap();
        assert_eq!(next["seq"], 19);
        writer.close(None).await.unwrap(); reader.close(None).await.unwrap(); app.shutdown(); relay.abort(); drop(app);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn http_admission_authenticates_and_renews_socket_against_google_fixture() {
        use axum::{routing::get, http::HeaderMap, Router};
        use futures_util::{SinkExt, StreamExt};
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        // Generated solely for this test; neither value is a real credential.
        const TOKEN: &str = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImZsb3cta2V5In0.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJhdWQiOiJjbGllbnQtYSIsInN1YiI6IjEyMzQ1Njc4OSIsImlhdCI6MTU3NzgzNjgwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.r8rCWGLFh8h8hr0Q_cGxWMH_39stMBRyZvVXBf3HJx-pfXt0gSnOMrc8UC5jzrxAF6ov-bjK4nthOBfUeaNxhIW671MQjNe_X74FT37jXfq5Y-iX7weAGRiRf5MHRpkOo4RZamlbrCNJw_wq1KxYZYidaipPr01RdEPAFAaI4zFTXacfZ_SmwmpT2Sjs7x1WfwwUmKs72zNp95fribsEKbugjcaWlYdNTLIJujZSn8vATRDs3NJFYDhGWI_KOeoKL89ES3cEVmo5NEMy8xWusnK7gmKc6wQfe_lpDv61Sv7BvbxRTTep37zOGioG6p_sb8LrKk88Ekf3P3LE0K5lnQ";
        let viewer = Arc::new(AtomicBool::new(false));
        let role = viewer.clone();
        let google = Router::new()
            .route("/certs", get(|| async { Json(json!({"keys":[{"kty":"RSA","kid":"flow-key","use":"sig","alg":"RS256","n":"tRhukFxWNAC1pKWN_v5QjZ7WQ69if-bsW63alKWRCuTBvednX4ZM4fjmsdJAyeb-zRZZzePIuH8cOIVTDlrtAMxwc7aQD9HCdUz9mTR9UOXf95PUtnaXyDdbBFvLidI7h2hBtHvoqBP8xpHRWqhCjvQnCoFRN-nLSym9RrFemqQc0PgN4ztj7ceA2sz2CZ1uH7iT6bPwJsoLo-G5Ot8SywLRczKtWi40OYhwwMqi_Wr7FMTk2dPTYvdWBQItq-RjsGkv8-n4zcYWQCHyhx7UAtzSBh6gsnKrf5-qssiaPL-6u5vMnFS8sn4TIXtXWtj5lchye2AolIBlOED_-GLopw","e":"AQAB"}]})) }))
            .route("/about", get(|| async { Json(json!({"user":{"emailAddress":"test@example.com"}})) }))
            .route("/userinfo", get(|headers: HeaderMap| async move {
                let sub = if headers.get("authorization").and_then(|h| h.to_str().ok()) == Some("Bearer matching-test-token") { "123456789" } else { "other" };
                Json(json!({"sub":sub}))
            }))
            .route("/files/{id}", get(move || { let role = role.clone(); async move {
                Json(json!({"id":"folder", "name":"board", "mimeType":"application/vnd.google-apps.folder", "trashed":false,
                    "ownedByMe":false, "capabilities":{"canListChildren":true,"canAddChildren":!role.load(Ordering::SeqCst)}}))
            }}));
        let google_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let google_base = format!("http://{}", google_listener.local_addr().unwrap());
        let google_server = tokio::spawn(axum::serve(google_listener, google).into_future());
        let mut verifier = GoogleDriveVerifier::new(vec!["configured.apps.googleusercontent.com".into()]).unwrap().with_test_base(&google_base).unwrap();
        verifier.audiences = vec!["client-a".into()];
        let directory = std::env::temp_dir().join(format!("pboard-drive-flow-test-{}", crate::nonce()));
        std::fs::create_dir(&directory).unwrap();
        let app = crate::App::new(crate::Config { rooms: HashMap::new() }, crate::Limits::default()).unwrap()
            .with_google_drive_verifier(verifier).with_sync(&directory).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let relay = tokio::spawn(axum::serve(listener, app.clone().router()).into_future());
        let (mut socket, _) = connect_async(format!("ws://{address}/ws")).await.unwrap();
        let welcome: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        let request = json!({"idToken":TOKEN, "accessToken":"matching-test-token", "boardId":"board", "folderId":"folder",
            "challenge":welcome["challenge"], "session":welcome["session"]});
        let client = reqwest::Client::new();
        let endpoint = format!("http://{address}/drive/admit");
        let mut wrong = request.clone(); wrong["accessToken"] = json!("wrong-test-token");
        assert_eq!(client.post(&endpoint).json(&wrong).send().await.unwrap().status(), StatusCode::FORBIDDEN);
        let response = client.post(&endpoint).json(&request).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(CACHE_CONTROL).unwrap(), "no-store");
        let admitted: Value = response.json().await.unwrap();
        let room = admitted["room"].as_str().unwrap();
        socket.send(Message::Text(json!({"type":"authenticate", "version":3, "room":room, "deviceKeyId":"actor-id", "signature":"", "serviceAdmission":admitted["ticket"]}).to_string().into())).await.unwrap();
        let authenticated: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(authenticated["type"], "authenticated");
        assert_eq!(authenticated["role"], "editor");
        let mut account_request = request.clone();
        account_request["boardId"] = json!(""); account_request["folderId"] = json!("");
        let account: Value = client.post(&endpoint).json(&account_request).send().await.unwrap().json().await.unwrap();
        assert_ne!(account["room"], room);
        socket.send(Message::Text(json!({"type":"attach", "room":account["room"], "deviceKeyId":"account-actor", "signature":"", "serviceAdmission":account["ticket"]}).to_string().into())).await.unwrap();
        let attached: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(attached["type"], "attached"); assert_eq!(attached["role"], "editor");
        let inbox: String = Sha256::digest(b"test@example.com").iter().map(|byte| format!("{byte:02x}")).collect();
        socket.send(Message::Text(json!({"type":"sync", "request":{"action":"publishAccountHint", "board":room, "to":inbox, "hintId":"invite-1", "payload":"aW52aXRl"}}).to_string().into())).await.unwrap();
        let stored: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(stored["action"], "accountHintStored");
        let hint: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hint["type"], "accountHint"); assert_eq!(hint["inbox"], inbox); assert_eq!(hint["board"], "board");
        socket.send(Message::Text(json!({"type":"sync", "request":{"action":"replayAccountHints", "board":account["room"], "afterSeq":0}}).to_string().into())).await.unwrap();
        let replay: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(replay["action"], "accountHints"); assert_eq!(replay["hints"].as_array().unwrap().len(), 1);
        viewer.store(true, Ordering::SeqCst);
        let renewal: Value = client.post(&endpoint).json(&request).send().await.unwrap().json().await.unwrap();
        assert_eq!(renewal["room"], room);
        socket.send(Message::Text(json!({"type":"renewGoogle", "room":room, "serviceAdmission":renewal["ticket"]}).to_string().into())).await.unwrap();
        let renewed: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(renewed["type"], "renewedGoogle"); assert_eq!(renewed["role"], "viewer");
        socket.send(Message::Text(json!({"type":"sync", "request":{"action":"submit", "board":room,
            "operations":[{"opId":"op-1", "protocolVersion":1, "logicalClock":1, "payload":"test"}]}}).to_string().into())).await.unwrap();
        let denied: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(denied["code"], "read_only");
        socket.close(None).await.unwrap(); app.shutdown(); relay.abort(); google_server.abort(); drop(app);
        std::fs::remove_dir_all(directory).unwrap();
    }

}
