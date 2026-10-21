//! Explicit experimental exception: transient Google credentials verify identity
//! and metadata only. Never derive Debug for credential-bearing request types.
use crate::{App, PublicKey, now_ms};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{
    Signature, SigningKey,
    signature::{Signer, Verifier},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};
use tokio::sync::Semaphore;

const MAX_STATE: usize = 32 * 1024 * 1024;
const MAX_HISTORY: usize = 256;
#[derive(Clone, Serialize, Deserialize)]
struct Member {
    email: String,
    key: PublicKey,
    role: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Scope {
    members: BTreeMap<String, Member>,
    history: Vec<Value>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Registry {
    scopes: BTreeMap<String, Scope>,
}
pub struct GoogleEnrollment {
    key: SigningKey,
    allowed: BTreeSet<String>,
    path: PathBuf,
    registry: Mutex<Registry>,
    challenges: Mutex<HashMap<String, u64>>,
    permits: Semaphore,
    http: reqwest::Client,
    google_base: String,
    lifetime_ms: u64,
    renew_before_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollmentRequest {
    challenge: String,
    kind: String,
    scope: String,
    drive_project_file_id: String,
    drive_folder_id: String,
    public_key: PublicKey,
    signature: String,
}
impl GoogleEnrollment {
    /// The persisted issuer registry survives a restart; old, still-unexpired
    /// membership proofs must not resurrect a removed device or older epoch.
    pub fn is_current_proof(&self, proof: &crate::admission::AdmissionProof) -> bool {
        let Ok(bytes) = B64.decode(&proof.manifest_payload) else {
            return false;
        };
        let Ok(payload) = serde_json::from_slice::<Value>(&bytes) else {
            return false;
        };
        self.registry.lock().unwrap().scopes.values().any(|scope| {
            scope.history.last().is_some_and(|last| {
                last["payload"] == payload
                    && last["signature"].as_str() == Some(proof.manifest_signature.as_str())
            })
        })
    }
    #[cfg(any(test, feature = "test-google-fixture"))]
    pub fn with_test_google_base(mut self, base: String) -> Result<Self, &'static str> {
        let url = reqwest::Url::parse(&base).map_err(|_| "invalid_test_google_base")?;
        if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
            return Err("invalid_test_google_base");
        }
        self.google_base = base;
        Ok(self)
    }
    #[cfg(feature = "test-google-fixture")]
    pub fn with_test_lifetime(mut self, ms: u64) -> Result<Self, &'static str> {
        if !(30_000..=300_000).contains(&ms) {
            return Err("invalid_test_lifetime");
        }
        self.lifetime_ms = ms;
        self.renew_before_ms = ms / 3;
        Ok(self)
    }
    pub fn new(
        key: SigningKey,
        allowed: BTreeSet<String>,
        path: PathBuf,
    ) -> Result<Self, &'static str> {
        if allowed.is_empty()
            || allowed.len() > 16
            || allowed
                .iter()
                .any(|e| e.trim().to_lowercase() != *e || !e.contains('@'))
        {
            return Err("invalid_email_allowlist");
        }
        let registry: Registry = if path.exists() {
            let bytes = std::fs::read(&path).map_err(|_| "registry_read_failed")?;
            if bytes.len() > MAX_STATE {
                return Err("registry_capacity");
            }
            serde_json::from_slice(&bytes).map_err(|_| "registry_invalid")?
        } else {
            Registry::default()
        };
        if registry.scopes.len() > 64 {
            return Err("registry_capacity");
        }
        for scope in registry.scopes.values() {
            if scope.history.len() > MAX_HISTORY || scope.members.len() > 16 {
                return Err("registry_capacity");
            }
            for signed in &scope.history {
                let payload =
                    serde_json::to_vec(&signed["payload"]).map_err(|_| "registry_invalid")?;
                let raw = B64
                    .decode(signed["signature"].as_str().ok_or("registry_invalid")?)
                    .map_err(|_| "registry_invalid")?;
                let signature = Signature::from_slice(&raw).map_err(|_| "registry_invalid")?;
                let mut bytes = b"pboard-manifest-v2".to_vec();
                bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
                bytes.extend_from_slice(&payload);
                key.verifying_key()
                    .verify(&bytes, &signature)
                    .map_err(|_| "registry_authority_mismatch")?;
            }
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "http_setup_failed")?;
        Ok(Self {
            key,
            allowed,
            path,
            registry: Mutex::new(registry),
            challenges: Mutex::new(HashMap::new()),
            permits: Semaphore::new(4),
            http,
            google_base: "https://www.googleapis.com/drive/v3".into(),
            lifetime_ms: 300_000,
            renew_before_ms: 120_000,
        })
    }
    pub fn authority(&self) -> PublicKey {
        let point = self.key.verifying_key().to_encoded_point(false);
        PublicKey {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: B64.encode(point.x().unwrap()),
            y: B64.encode(point.y().unwrap()),
        }
    }
    async fn get(&self, path: &str, fields: &str, token: &str) -> Result<Value, &'static str> {
        let response = self
            .http
            .get(format!("{}{path}", self.google_base))
            .query(&[("fields", fields)])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "google_unavailable")?;
        if !response.status().is_success() {
            return Err(if response.status().as_u16() == 401 {
                "google_token_rejected"
            } else {
                "google_permission_denied"
            });
        }
        if response.content_length().is_some_and(|n| n > 128 * 1024) {
            return Err("google_response_invalid");
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "google_unavailable")? {
            if bytes.len() + chunk.len() > 128 * 1024 {
                return Err("google_response_invalid");
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "google_response_invalid")
    }
    /// Identity only: no folder/file metadata or ACL lookup. The caller must
    /// separately require a board-root-signed policy and device grant.
    pub(crate) async fn verify_identity(&self, token: &str) -> Result<String, &'static str> {
        let _permit = self.permits.try_acquire().map_err(|_| "server_busy")?;
        let about = self.get("/about", "user(emailAddress)", token).await?;
        let email = about["user"]["emailAddress"]
            .as_str()
            .ok_or("google_identity_missing")?
            .trim()
            .to_lowercase();
        if email.len() > 254
            || !email.is_ascii()
            || !email.contains('@')
            || email
                .bytes()
                .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        {
            return Err("google_identity_missing");
        }
        Ok(email)
    }
    async fn verify_google(
        &self,
        req: &EnrollmentRequest,
        token: &str,
    ) -> Result<(String, BTreeMap<String, String>), &'static str> {
        let about = self.get("/about", "user(emailAddress)", token).await?;
        let email = about["user"]["emailAddress"]
            .as_str()
            .ok_or("google_identity_missing")?
            .trim()
            .to_lowercase();
        if !self.allowed.contains(&email) {
            return Err("email_not_allowed");
        }
        if req.kind == "account" {
            let hash = Sha256::digest(email.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            if req.scope != hash
                || !req.drive_folder_id.is_empty()
                || !req.drive_project_file_id.is_empty()
            {
                return Err("account_binding_invalid");
            }
            return Ok((email.clone(), BTreeMap::from([(email, "owner".into())])));
        }
        if req.kind != "board" {
            return Err("invalid_kind");
        }
        let fields = "id,name,mimeType,parents,trashed,capabilities(canEdit)";
        let file = self
            .get(
                &format!("/files/{}", req.drive_project_file_id),
                fields,
                token,
            )
            .await?;
        let folder = self
            .get(&format!("/files/{}", req.drive_folder_id), fields, token)
            .await?;
        if file["id"] != req.drive_project_file_id
            || file["name"] != "project.json"
            || file["mimeType"] != "application/json"
            || file["trashed"] != false
            || !file["parents"]
                .as_array()
                .is_some_and(|parents| parents.iter().any(|p| p == &req.drive_folder_id))
            || folder["id"] != req.drive_folder_id
            || folder["name"] != req.scope
            || folder["mimeType"] != "application/vnd.google-apps.folder"
            || folder["trashed"] != false
        {
            return Err("drive_binding_invalid");
        }
        let permissions = self
            .get(
                &format!("/files/{}/permissions", req.drive_folder_id),
                "permissions(type,emailAddress,role,deleted),nextPageToken",
                token,
            )
            .await?;
        // Large/paginated ACLs are outside this two-account experiment; fail closed.
        if permissions.get("nextPageToken").is_some() {
            return Err("acl_too_large");
        }
        let mut roles = BTreeMap::new();
        for p in permissions["permissions"]
            .as_array()
            .ok_or("google_response_invalid")?
        {
            if p["type"] != "user" || p["deleted"] == true {
                continue;
            }
            let Some(email) = p["emailAddress"].as_str() else {
                continue;
            };
            let email = email.trim().to_lowercase();
            if !self.allowed.contains(&email) {
                continue;
            }
            let role = match p["role"].as_str() {
                Some("owner") => "owner",
                Some("writer") => "editor",
                Some("reader") => "viewer",
                _ => continue,
            };
            roles.insert(email, role.into());
        }
        let role = roles.get(&email).ok_or("board_access_denied")?;
        if role != "viewer"
            && (file["capabilities"]["canEdit"] != true
                || folder["capabilities"]["canEdit"] != true)
        {
            return Err("board_write_denied");
        }
        Ok((email, roles))
    }
    fn issue(
        &self,
        req: &EnrollmentRequest,
        email: String,
        roles: BTreeMap<String, String>,
    ) -> Result<Value, &'static str> {
        let now = now_ms();
        let board = if req.kind == "account" {
            format!("account:{}", req.scope)
        } else {
            req.scope.clone()
        };
        let binding = json!([board, req.drive_project_file_id, req.drive_folder_id]).to_string();
        let mut guard = self.registry.lock().unwrap();
        let mut next = guard.clone();
        if !next.scopes.contains_key(&binding) && next.scopes.len() >= 64 {
            return Err("registry_capacity");
        }
        let scope = next.scopes.entry(binding).or_default();
        scope
            .members
            .retain(|_, m| self.allowed.contains(&m.email) && roles.contains_key(&m.email));
        for member in scope.members.values_mut() {
            member.role = roles[&member.email].clone();
        }
        let id = req.public_key.fingerprint();
        if scope.members.get(&id).is_some_and(|m| m.email != email) {
            return Err("device_account_mismatch");
        }
        if !scope.members.contains_key(&id) && scope.members.len() >= 16 {
            return Err("device_capacity");
        }
        scope.members.insert(
            id.clone(),
            Member {
                role: roles[&email].clone(),
                email,
                key: req.public_key.clone(),
            },
        );
        if !scope.members.values().any(|m| m.role == "owner") {
            return Err("owner_must_connect_first");
        }
        let devices: Vec<Value> = scope
            .members
            .iter()
            .map(|(id, m)| json!({"deviceKeyId":id,"publicKey":m.key,"role":m.role}))
            .collect();
        let last = scope.history.last();
        let changed = last.is_none_or(|m| {
            m["payload"]["devices"] != json!(devices)
                || m["payload"]["expiresAt"].as_u64().unwrap_or(0) <= now + self.renew_before_ms
        });
        if changed {
            if scope.history.len() >= MAX_HISTORY {
                return Err("history_capacity");
            }
            let epoch = last.map_or(1, |m| m["payload"]["epoch"].as_u64().unwrap() + 1);
            let payload = json!({"protocol":2,"boardId":board,"driveProjectFileId":req.drive_project_file_id,"driveFolderId":req.drive_folder_id,"authorityKeyId":self.authority().fingerprint(),"epoch":epoch,"issuedAt":now,"expiresAt":now+self.lifetime_ms,"devices":devices});
            let bytes = serde_json::to_vec(&payload).unwrap();
            let mut signed = b"pboard-manifest-v2".to_vec();
            signed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            signed.extend_from_slice(&bytes);
            let signature: Signature = self.key.sign(&signed);
            scope
                .history
                .push(json!({"payload":payload,"signature":B64.encode(signature.to_bytes())}));
        }
        let response = json!({"authority":self.authority(),"manifest":scope.history.last(),"history":scope.history,"deviceKeyId":id});
        if !changed {
            return Ok(response);
        }
        // Authorization metadata only. Atomic persistence precedes publication;
        // failed writes leave both the old file and in-memory state intact.
        let bytes = serde_json::to_vec(&next).map_err(|_| "registry_invalid")?;
        if bytes.len() > MAX_STATE {
            return Err("registry_capacity");
        }
        let temp = self.path.with_extension("pending");
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| "registry_write_failed")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "registry_write_failed")?;
        std::fs::rename(&temp, &self.path).map_err(|_| "registry_write_failed")?;
        if let Some(parent) = self.path.parent() {
            std::fs::File::open(parent)
                .and_then(|f| f.sync_all())
                .map_err(|_| "registry_write_failed")?;
        }
        *guard = next;
        tracing::info!(event = "google_enrollment", peer = %&id[..12], kind = %req.kind,
            "Google identity and room permission verified; authorization updated");
        Ok(response)
    }
}
fn answer(result: Result<Value, &'static str>) -> Response {
    let (status, body) = match result {
        Ok(body) => (StatusCode::OK, body),
        Err(code) => {
            tracing::warn!(
                event = "google_enrollment_rejected",
                reason = code,
                "experimental enrollment rejected"
            );
            (StatusCode::FORBIDDEN, json!({"code":code}))
        }
    };
    (status, [("Cache-Control", "no-store")], Json(body)).into_response()
}
pub async fn challenge(State(app): State<App>) -> Response {
    let Some(service) = app.google_enrollment.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !app.permit_automatic_auth() {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let mut challenges = service.challenges.lock().unwrap();
    challenges.retain(|_, expiry| *expiry > now_ms());
    if challenges.len() >= 256 {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let challenge = crate::nonce();
    challenges.insert(challenge.clone(), now_ms() + 30_000);
    answer(Ok(json!({"challenge":challenge})))
}
pub async fn enroll(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<EnrollmentRequest>,
) -> Response {
    let Some(service) = app.google_enrollment.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(_permit) = service.permits.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let result = async {
        let expiry = service
            .challenges
            .lock()
            .unwrap()
            .remove(&req.challenge)
            .ok_or("challenge_invalid")?;
        if expiry <= now_ms() {
            return Err("challenge_expired");
        }
        let valid = |s: &str| {
            !s.is_empty()
                && s.len() <= 200
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        if !valid(&req.scope)
            || (req.kind != "account"
                && (!valid(&req.drive_folder_id) || !valid(&req.drive_project_file_id)))
        {
            return Err("binding_invalid");
        }
        let bytes = serde_json::to_vec(&json!([
            "pboard-google-enroll-v1",
            req.challenge,
            req.public_key.fingerprint(),
            req.kind,
            req.scope,
            req.drive_project_file_id,
            req.drive_folder_id
        ]))
        .unwrap();
        let signature = B64
            .decode(&req.signature)
            .map_err(|_| "device_proof_invalid")?;
        let signature = Signature::from_slice(&signature).map_err(|_| "device_proof_invalid")?;
        req.public_key
            .key()?
            .verify(&bytes, &signature)
            .map_err(|_| "device_proof_invalid")?;
        let token = headers
            .get("Authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|s| !s.is_empty() && s.len() <= 8192)
            .ok_or("google_token_missing")?;
        let (email, roles) =
            tokio::time::timeout(Duration::from_secs(12), service.verify_google(&req, token))
                .await
                .map_err(|_| "google_unavailable")??;
        service.issue(&req, email, roles)
    }
    .await;
    answer(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::{OriginalUri, State},
        routing::get,
    };
    use rand_core::OsRng;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    struct Fixture {
        base: String,
        app: App,
        path: PathBuf,
        key: SigningKey,
        revoked: Arc<AtomicBool>,
        task: tokio::task::JoinHandle<()>,
    }
    async fn fixture() -> Fixture {
        let revoked = Arc::new(AtomicBool::new(false));
        let google=Router::new().fallback(get(|State(revoked):State<Arc<AtomicBool>>, uri:OriginalUri, headers:HeaderMap|async move {
            assert!(!uri.query().unwrap_or("").contains("alt=media"));
            let token=headers.get("Authorization").and_then(|v|v.to_str().ok()).unwrap_or("");
            let email=match token {"Bearer owner-token"=>"owner@example.test","Bearer editor-token"=>"editor@example.test","Bearer other-token"=>"other@example.test",_=>return (StatusCode::UNAUTHORIZED,Json(json!({}))).into_response()};
            let data=match uri.path() {
                "/about"=>json!({"user":{"emailAddress":email}}),
                "/files/file"=>json!({"id":"file","name":"project.json","mimeType":"application/json","parents":["folder"],"trashed":false,"capabilities":{"canEdit":true}}),
                "/files/folder"=>json!({"id":"folder","name":"board","mimeType":"application/vnd.google-apps.folder","trashed":false,"capabilities":{"canEdit":true}}),
                "/files/folder/permissions"=>{
                    let mut acl=vec![json!({"type":"user","emailAddress":"owner@example.test","role":"owner"})];
                    if !revoked.load(Ordering::SeqCst) {acl.push(json!({"type":"user","emailAddress":"editor@example.test","role":"writer"}));}
                    json!({"permissions":acl})
                },
                _=>return (StatusCode::NOT_FOUND,Json(json!({}))).into_response()
            };
            Json(data).into_response()
        })).with_state(revoked.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let google_base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, google).await.unwrap();
        });
        let key = SigningKey::random(&mut OsRng);
        let path =
            std::env::temp_dir().join(format!("pboard-enrollment-test-{}.json", crate::nonce()));
        let mut enrollment = GoogleEnrollment::new(
            key.clone(),
            BTreeSet::from(["owner@example.test".into(), "editor@example.test".into()]),
            path.clone(),
        )
        .unwrap();
        enrollment.google_base = google_base;
        let app = App::new(
            crate::Config {
                rooms: HashMap::new(),
            },
            crate::Limits::default(),
        )
        .unwrap()
        .with_google_enrollment(enrollment);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Fixture {
            base,
            app,
            path,
            key,
            revoked,
            task,
        }
    }
    async fn request(
        f: &Fixture,
        key: &SigningKey,
        token: &str,
        kind: &str,
        scope: &str,
        folder: &str,
    ) -> (StatusCode, Value) {
        let http = reqwest::Client::new();
        let challenge: Value = http
            .post(format!("{}/experiment/challenge", f.base))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let point = key.verifying_key().to_encoded_point(false);
        let public = PublicKey {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: B64.encode(point.x().unwrap()),
            y: B64.encode(point.y().unwrap()),
        };
        let file = if kind == "account" { "" } else { "file" };
        let signature: Signature = key.sign(
            &serde_json::to_vec(&json!([
                "pboard-google-enroll-v1",
                challenge["challenge"],
                public.fingerprint(),
                kind,
                scope,
                file,
                folder
            ]))
            .unwrap(),
        );
        let response=http.post(format!("{}/experiment/enroll",f.base)).bearer_auth(token).json(&json!({"challenge":challenge["challenge"],"kind":kind,"scope":scope,"driveProjectFileId":file,"driveFolderId":folder,"publicKey":public,"signature":B64.encode(signature.to_bytes())})).send().await.unwrap();
        let status = response.status();
        (status, response.json().await.unwrap())
    }
    #[tokio::test]
    async fn verifies_google_admits_owner_then_editor_and_persists_no_credentials() {
        let f = fixture().await;
        let owner = SigningKey::random(&mut OsRng);
        let editor = SigningKey::random(&mut OsRng);
        assert_eq!(
            request(&f, &editor, "editor-token", "board", "board", "folder")
                .await
                .1["code"],
            "owner_must_connect_first"
        );
        let (status, first) = request(&f, &owner, "owner-token", "board", "board", "folder").await;
        assert_eq!(status, StatusCode::OK);
        let (_, next) = request(&f, &editor, "editor-token", "board", "board", "folder").await;
        assert_eq!(next["manifest"]["payload"]["epoch"], 2);
        assert_eq!(
            next["manifest"]["payload"]["devices"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(next["history"][0], first["manifest"]);
        let (_, repeat) = request(&f, &editor, "editor-token", "board", "board", "folder").await;
        assert_eq!(repeat["manifest"], next["manifest"]);
        let bytes = std::fs::read_to_string(&f.path).unwrap();
        assert!(!bytes.contains("-token"));
        assert!(!bytes.contains("accessToken"));
        let restored = GoogleEnrollment::new(
            f.key.clone(),
            BTreeSet::from(["owner@example.test".into(), "editor@example.test".into()]),
            f.path.clone(),
        )
        .unwrap();
        assert_eq!(
            restored
                .registry
                .lock()
                .unwrap()
                .scopes
                .values()
                .next()
                .unwrap()
                .history
                .len(),
            2
        );
        assert!(
            GoogleEnrollment::new(
                SigningKey::random(&mut OsRng),
                BTreeSet::from(["owner@example.test".into()]),
                f.path.clone()
            )
            .is_err()
        );
        f.task.abort();
        let _ = std::fs::remove_file(f.path);
    }
    #[tokio::test]
    async fn rejects_nonallowlisted_invalid_tokens_wrong_bindings_and_revoked_acl() {
        let f = fixture().await;
        let owner = SigningKey::random(&mut OsRng);
        let editor = SigningKey::random(&mut OsRng);
        for (token, scope, folder, code) in [
            ("other-token", "board", "folder", "email_not_allowed"),
            ("bad-token", "board", "folder", "google_token_rejected"),
            ("owner-token", "other", "folder", "drive_binding_invalid"),
            ("owner-token", "board", "other", "google_permission_denied"),
        ] {
            assert_eq!(
                request(&f, &owner, token, "board", scope, folder).await.1["code"],
                code
            );
        }
        request(&f, &owner, "owner-token", "board", "board", "folder").await;
        request(&f, &editor, "editor-token", "board", "board", "folder").await;
        f.revoked.store(true, Ordering::SeqCst);
        assert_eq!(
            request(&f, &editor, "editor-token", "board", "board", "folder")
                .await
                .1["code"],
            "board_access_denied"
        );
        let (_, renew) = request(&f, &owner, "owner-token", "board", "board", "folder").await;
        assert_eq!(
            renew["manifest"]["payload"]["devices"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        f.task.abort();
        let _ = std::fs::remove_file(f.path);
    }
    #[tokio::test]
    async fn scopes_account_membership_and_rejects_challenge_replay_or_forgery() {
        let f = fixture().await;
        let owner = SigningKey::random(&mut OsRng);
        let hash = Sha256::digest(b"owner@example.test")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        assert_eq!(
            request(&f, &owner, "owner-token", "account", &hash, "")
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&f, &owner, "editor-token", "account", &hash, "")
                .await
                .1["code"],
            "account_binding_invalid"
        );
        let service = f.app.google_enrollment.as_ref().unwrap();
        let http = reqwest::Client::new();
        let response: Value = http
            .post(format!("{}/experiment/challenge", f.base))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let point = owner.verifying_key().to_encoded_point(false);
        let public = PublicKey {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: B64.encode(point.x().unwrap()),
            y: B64.encode(point.y().unwrap()),
        };
        let forged = json!({"challenge":response["challenge"],"kind":"account","scope":hash,"driveProjectFileId":"","driveFolderId":"","publicKey":public,"signature":B64.encode([0;64])});
        for expected in ["device_proof_invalid", "challenge_invalid"] {
            let result: Value = http
                .post(format!("{}/experiment/enroll", f.base))
                .bearer_auth("owner-token")
                .json(&forged)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(result["code"], expected);
        }
        assert!(service.challenges.lock().unwrap().is_empty());
        f.task.abort();
        let _ = std::fs::remove_file(f.path);
    }
    #[tokio::test]
    async fn broker_mode_rejects_otherwise_valid_self_signed_room_authorization() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        let f = fixture().await;
        let rogue = SigningKey::random(&mut OsRng);
        let point = rogue.verifying_key().to_encoded_point(false);
        let public = PublicKey {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: B64.encode(point.x().unwrap()),
            y: B64.encode(point.y().unwrap()),
        };
        let id = public.fingerprint();
        let topic = "pboard-collab-board-cards";
        let room = crate::admission::room_name(&id, topic, "file", "folder");
        let payload = json!({"protocol":2,"boardId":"board","driveProjectFileId":"file","driveFolderId":"folder","authorityKeyId":id,"epoch":1,"issuedAt":now_ms(),"expiresAt":now_ms()+300_000,"devices":[{"deviceKeyId":id,"publicKey":public,"role":"owner"}]});
        let bytes = serde_json::to_vec(&payload).unwrap();
        let mut envelope = b"pboard-manifest-v2".to_vec();
        envelope.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        envelope.extend_from_slice(&bytes);
        let signed: Signature = rogue.sign(&envelope);
        let (mut socket, _) = connect_async(format!("{}/ws", f.base.replace("http:", "ws:")))
            .await
            .unwrap();
        let welcome: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        let digest = B64.encode(Sha256::digest(&bytes));
        let proof: Signature = rogue.sign(&crate::admission::auth_bytes(
            welcome["challenge"].as_str().unwrap(),
            welcome["session"].as_str().unwrap(),
            &room,
            &id,
            &digest,
        ));
        socket.send(Message::Text(json!({"type":"authenticate","version":2,"room":room,"deviceKeyId":id,"signature":B64.encode(proof.to_bytes()),"authorization":{"topic":topic,"authority":public,"manifestPayload":B64.encode(bytes),"manifestSignature":B64.encode(signed.to_bytes())}}).to_string().into())).await.unwrap();
        let result: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(result["code"], "unauthorized");
        f.task.abort();
    }
}
