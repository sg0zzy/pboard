use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Semaphore, mpsc, watch};
pub mod admission;
pub mod board_grants;
pub mod google_enrollment;
pub mod identity_enrollment;
pub mod policy;
pub mod signals;
mod strict_json;
use admission::{AdmissionProof, VerifiedAdmission};

pub const MAX_MESSAGE: usize = 96 * 1024;
const QUEUE: usize = 4;
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn nonce() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    B64.encode(bytes)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicKey {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
}
impl PublicKey {
    fn key(&self) -> Result<VerifyingKey, &'static str> {
        if self.kty != "EC" || self.crv != "P-256" {
            return Err("invalid_key");
        }
        let x = B64.decode(&self.x).map_err(|_| "invalid_key")?;
        let y = B64.decode(&self.y).map_err(|_| "invalid_key")?;
        if x.len() != 32 || y.len() != 32 {
            return Err("invalid_key");
        }
        VerifyingKey::from_sec1_bytes(&[&[4], x.as_slice(), y.as_slice()].concat())
            .map_err(|_| "invalid_key")
    }
    pub fn fingerprint(&self) -> String {
        let canonical = json!({"crv":self.crv,"kty":self.kty,"x":self.x,"y":self.y}).to_string();
        B64.encode(Sha256::digest(canonical.as_bytes()))
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub public_key: PublicKey,
    pub expires_at: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub rooms: HashMap<String, HashMap<String, Grant>>,
}
impl Config {
    pub fn validate(&self) -> Result<(), &'static str> {
        // An empty operator allowlist is a valid deny-all configuration. Expiry
        // is enforced at authentication and throughout each active session, not
        // at process startup: a reboot must not turn expired grants into a crash loop.
        if self.rooms.len() > 1024 {
            return Err("invalid_rooms");
        }
        for (room, devices) in &self.rooms {
            if !valid_room(room) || devices.is_empty() || devices.len() > 64 {
                return Err("invalid_room");
            }
            for (id, grant) in devices {
                grant.public_key.key()?;
                if *id != grant.public_key.fingerprint() {
                    return Err("invalid_grant");
                }
            }
        }
        Ok(())
    }
}
fn valid_room(room: &str) -> bool {
    !room.is_empty()
        && room.len() <= 240
        && room
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
#[derive(Clone)]
pub struct Limits {
    pub connections: usize,
    pub peers_per_room: usize,
    pub messages_per_second: u32,
    pub idle: Duration,
    pub auth: Duration,
    pub automatic_auth_per_second: u32,
    pub authorization_scopes: usize,
    pub rooms: usize,
    pub message_bytes: usize,
    pub bytes_per_second: usize,
    pub session_bytes: usize,
    pub session_signals: usize,
    pub global_messages_per_second: usize,
    pub global_bytes_per_second: usize,
    pub http_concurrency: usize,
    pub http_per_second: usize,
    pub grant_bundle_bytes: usize,
    pub grant_cache_bytes: usize,
    pub grant_history: usize,
    pub replay_entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 128,
            peers_per_room: 16,
            messages_per_second: 60,
            idle: Duration::from_secs(45),
            auth: Duration::from_secs(10),
            automatic_auth_per_second: 32,
            authorization_scopes: 1024,
            rooms: 128,
            message_bytes: MAX_MESSAGE,
            bytes_per_second: 128 * 1024,
            session_bytes: 4 * 1024 * 1024,
            session_signals: 512,
            global_messages_per_second: 256,
            global_bytes_per_second: 2 * 1024 * 1024,
            http_concurrency: 4,
            http_per_second: 64,
            grant_bundle_bytes: 4 * 1024 * 1024,
            grant_cache_bytes: 32 * 1024 * 1024,
            grant_history: 4096,
            replay_entries: 8192,
        }
    }
}
#[derive(Clone)]
struct Member {
    session: String,
    expires_at: u64,
    tx: mpsc::Sender<Value>,
    cancel: watch::Sender<bool>,
    authorization: AuthorizationWatch,
    logical_session: Option<String>,
}
type AuthorizationWatch = Option<(String, watch::Receiver<String>)>;
fn authorization_current(value: &AuthorizationWatch) -> bool {
    value
        .as_ref()
        .is_none_or(|(digest, rx)| *rx.borrow() == *digest)
}
struct AcceptedAdmission {
    epoch: u64,
    retain_until: u64,
    digest: String,
    revision: watch::Sender<String>,
}
type Rooms = HashMap<String, HashMap<String, Member>>;
struct Traffic {
    at: Instant,
    messages: usize,
    bytes: usize,
}
#[derive(Clone)]
pub struct App {
    config: Arc<Config>,
    rooms: Arc<Mutex<Rooms>>,
    permits: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
    limits: Limits,
    automatic_admission: bool,
    board_grants: bool,
    grant_cache: Arc<Mutex<board_grants::GrantCache>>,
    grant_permits: Arc<Semaphore>,
    admissions: Arc<Mutex<HashMap<String, AcceptedAdmission>>>,
    auth_window: Arc<Mutex<(Instant, u32)>>,
    traffic: Arc<Mutex<Traffic>>,
    http_window: Arc<Mutex<(Instant, usize)>>,
    http_permits: Arc<Semaphore>,
    policy: policy::TransportPolicy,
    replay: Arc<Mutex<HashMap<String, u64>>>,
    publication_challenges: Arc<Mutex<HashMap<String, u64>>>,
    identity_enrollment: bool,
    identity_directory: Arc<Mutex<identity_enrollment::Directory>>,
    pub(crate) google_enrollment: Option<Arc<google_enrollment::GoogleEnrollment>>,
}
impl App {
    /// Public binary startup must never silently enable Google-free admission.
    pub fn validate_service_policy(&self) -> Result<(), &'static str> {
        if self.policy.require_tls_proxy
            && (self.google_enrollment.is_none()
                || (self.board_grants && !self.identity_enrollment))
        {
            return Err("public_service_requires_google_admission");
        }
        Ok(())
    }
    pub fn new(config: Config, limits: Limits) -> Result<Self, &'static str> {
        config.validate()?;
        limits.validate()?;
        Ok(Self {
            config: Arc::new(config),
            rooms: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(limits.connections)),
            shutdown: watch::channel(false).0,
            limits: limits.clone(),
            automatic_admission: false,
            board_grants: false,
            grant_cache: Arc::new(Mutex::new(board_grants::GrantCache::default())),
            grant_permits: Arc::new(Semaphore::new(1)),
            admissions: Arc::new(Mutex::new(HashMap::new())),
            auth_window: Arc::new(Mutex::new((Instant::now(), 0))),
            traffic: Arc::new(Mutex::new(Traffic {
                at: Instant::now(),
                messages: 0,
                bytes: 0,
            })),
            http_window: Arc::new(Mutex::new((Instant::now(), 0))),
            http_permits: Arc::new(Semaphore::new(limits.http_concurrency)),
            policy: policy::TransportPolicy::default(),
            replay: Arc::new(Mutex::new(HashMap::new())),
            publication_challenges: Arc::new(Mutex::new(HashMap::new())),
            identity_enrollment: false,
            identity_directory: Arc::new(Mutex::new(identity_enrollment::Directory::default())),
            google_enrollment: None,
        })
    }
    pub fn with_automatic_admission(mut self, enabled: bool) -> Self {
        self.automatic_admission = enabled;
        self
    }
    pub fn with_transport_policy(mut self, policy: policy::TransportPolicy) -> Self {
        self.policy = policy;
        self
    }
    fn permit_traffic(&self, bytes: usize) -> bool {
        let mut window = self.traffic.lock().unwrap();
        if window.at.elapsed() >= Duration::from_secs(1) {
            *window = Traffic {
                at: Instant::now(),
                messages: 0,
                bytes: 0,
            };
        }
        window.messages = window.messages.saturating_add(1);
        window.bytes = window.bytes.saturating_add(bytes);
        window.messages <= self.limits.global_messages_per_second
            && window.bytes <= self.limits.global_bytes_per_second
    }
    pub fn with_board_grants(mut self, enabled: bool) -> Self {
        self.board_grants = enabled;
        self.automatic_admission |= enabled;
        self
    }
    pub fn with_identity_enrollment(mut self, enabled: bool) -> Self {
        self.identity_enrollment = enabled;
        self
    }
    pub fn with_google_enrollment(
        mut self,
        enrollment: google_enrollment::GoogleEnrollment,
    ) -> Self {
        self.google_enrollment = Some(Arc::new(enrollment));
        self.automatic_admission = true;
        self
    }
    fn permit_automatic_auth(&self) -> bool {
        let mut window = self.auth_window.lock().unwrap();
        if window.0.elapsed() >= Duration::from_secs(1) {
            *window = (Instant::now(), 0);
        }
        if window.1 >= self.limits.automatic_auth_per_second {
            return false;
        }
        window.1 += 1;
        true
    }
    fn accept_admission(
        &self,
        proof: VerifiedAdmission,
    ) -> Result<AuthorizationWatch, &'static str> {
        let mut records = self.admissions.lock().unwrap();
        records.retain(|_, record| record.retain_until > now_ms());
        if let Some(record) = records.get_mut(&proof.scope) {
            if proof.epoch < record.epoch
                || (proof.epoch == record.epoch && proof.digest != record.digest)
            {
                return Err("authorization_stale");
            }
            if proof.epoch > record.epoch {
                record.epoch = proof.epoch;
                // Retain revocation tombstones for every already-issued proof's
                // possible remaining life, even if this newer proof expires sooner.
                record.retain_until = now_ms().saturating_add(390_000);
                record.digest = proof.digest;
                record.revision.send_replace(record.digest.clone());
            }
            return Ok(Some((record.digest.clone(), record.revision.subscribe())));
        }
        if records.len() >= self.limits.authorization_scopes {
            return Err("server_busy");
        }
        let (revision, receiver) = watch::channel(proof.digest.clone());
        let result = Some((proof.digest.clone(), receiver));
        records.insert(
            proof.scope,
            AcceptedAdmission {
                epoch: proof.epoch,
                retain_until: now_ms().saturating_add(390_000),
                digest: proof.digest,
                revision,
            },
        );
        Ok(result)
    }
    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
    pub fn router(self) -> Router {
        let bundle_limit = self.limits.grant_bundle_bytes;
        Router::new()
            .route(
                "/identity/challenge",
                axum::routing::post(identity_enrollment::challenge),
            )
            .route(
                "/identity/exchange",
                axum::routing::post(identity_enrollment::exchange),
            )
            .route(
                "/grants/challenge",
                axum::routing::post(board_grants::challenge),
            )
            .route(
                "/grants/publish",
                axum::routing::post(board_grants::publish)
                    .layer(axum::extract::DefaultBodyLimit::max(bundle_limit)),
            )
            .route("/grants/{scope}", get(board_grants::read))
            .route("/healthz", get(|| async { "ok\n" }))
            .route("/ws", get(upgrade))
            .route(
                "/experiment/challenge",
                axum::routing::post(google_enrollment::challenge),
            )
            .route(
                "/experiment/enroll",
                axum::routing::post(google_enrollment::enroll),
            )
            .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
            .layer(axum::middleware::from_fn_with_state(
                self.clone(),
                http_guard,
            ))
            .with_state(self)
    }
    fn leave(&self, room: &str, peer: &str, session: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        if let Some(members) = rooms.get_mut(room) {
            if members.get(peer).is_some_and(|m| m.session == session) {
                members.remove(peer);
                for m in members.values() {
                    if m.tx
                        .try_send(json!({"type":"peer_left","peerId":peer,"session":session}))
                        .is_err()
                    {
                        let _ = m.cancel.send(true);
                    }
                }
            }
            if members.is_empty() {
                rooms.remove(room);
            }
        }
    }
}
async fn http_guard(
    State(app): State<App>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if request.uri().path() == "/healthz" {
        return next.run(request).await;
    }
    if request.uri().query().is_some() || !app.policy.permits(request.headers()) {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let kind = if origin.is_empty() {
            "absent"
        } else if origin == "null" {
            "null"
        } else if origin.starts_with("moz-extension:") {
            "firefox_extension"
        } else if origin.starts_with("chrome-extension:") {
            "chromium_extension"
        } else {
            "web_or_invalid"
        };
        tracing::warn!(
            event = "transport_rejected",
            origin_kind = kind,
            "request rejected by transport policy"
        );
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(_permit) = app.http_permits.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    {
        let mut window = app.http_window.lock().unwrap();
        if window.0.elapsed() >= Duration::from_secs(1) {
            *window = (Instant::now(), 0);
        }
        window.1 = window.1.saturating_add(1);
        if window.1 > app.limits.http_per_second {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    }
    match tokio::time::timeout(Duration::from_secs(20), next.run(request)).await {
        Ok(response) => response,
        Err(_) => StatusCode::REQUEST_TIMEOUT.into_response(),
    }
}
async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> impl IntoResponse {
    match app.permits.clone().try_acquire_owned() {
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Ok(permit) => ws
            .read_buffer_size(app.limits.message_bytes.min(16 * 1024))
            .write_buffer_size(0)
            .max_write_buffer_size(2 * app.limits.message_bytes)
            .max_message_size(app.limits.message_bytes)
            .max_frame_size(app.limits.message_bytes)
            .on_upgrade(move |socket| async move {
                let _permit = permit;
                session(socket, app).await;
            })
            .into_response(),
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Client {
    #[serde(rename = "authenticate", rename_all = "camelCase")]
    Authenticate {
        version: u8,
        room: String,
        device_key_id: String,
        signature: String,
        #[serde(default)]
        authorization: Option<AdmissionProof>,
        #[serde(default)]
        service_admission: Option<String>,
    },
    #[serde(rename = "join")]
    Join {},
    #[serde(rename = "signal", rename_all = "camelCase")]
    Signal {
        to: String,
        session: String,
        data: Value,
    },
    #[serde(rename = "ping")]
    Ping {},
    #[serde(rename = "leave")]
    Leave {},
}
pub fn auth_bytes(challenge: &str, session: &str, room: &str, device: &str) -> Vec<u8> {
    serde_json::to_vec(&["pboard-ws-auth-v1", challenge, session, room, device]).unwrap()
}
async fn send(socket: &mut WebSocket, value: Value) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(value.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn session(mut socket: WebSocket, app: App) {
    let challenge = nonce();
    let connection = nonce();
    let session_id = &connection[..12];
    tracing::info!(
        event = "connect",
        session = session_id,
        "signaling session opened"
    );
    if !send(
        &mut socket,
        json!({"type":"welcome","version":1,"supportedVersions":if app.automatic_admission {vec![1,2]} else {vec![1]},"challenge":challenge,"session":connection,"requiresServiceAdmission":app.google_enrollment.is_some() && app.board_grants}),
    )
    .await
    {
        return;
    }
    let (tx, mut rx) = mpsc::channel::<Value>(QUEUE);
    let mut identity: Option<(String, String, u64)> = None;
    let mut authorization: AuthorizationWatch = None;
    let mut signal_context: Option<signals::Context> = None;
    let mut logical_session: Option<String> = None;
    let mut pair_counts = HashMap::<String, (u32, u32)>::new();
    let mut session_bytes = 0usize;
    let mut window_bytes = 0usize;
    let mut signal_count = 0usize;
    let mut shutdown = app.shutdown.subscribe();
    let (cancel, mut cancelled) = watch::channel(false);
    let mut joined = false;
    let started = Instant::now();
    let mut last = started;
    let mut window = started;
    let mut count = 0;
    let mut reason = "closed";
    let mut forwarded: u64 = 0;
    loop {
        if !authorization_current(&authorization) {
            reason = "authorization_changed";
            break;
        }
        if identity
            .as_ref()
            .is_some_and(|(_, _, expiry)| now_ms() >= *expiry)
        {
            reason = "grant_expired";
            break;
        }
        // Sleep to the next actual deadline; idle connections need no periodic poll.
        let mut wait = app.limits.idle.saturating_sub(last.elapsed());
        if identity.is_none() {
            wait = wait.min(app.limits.auth.saturating_sub(started.elapsed()));
        }
        if let Some((_, _, expiry)) = identity.as_ref() {
            wait = wait.min(Duration::from_millis(expiry.saturating_sub(now_ms())));
        }
        tokio::select! {
            _ = async {
                if let Some((_, rx)) = authorization.as_mut() { let _ = rx.changed().await; }
                else { std::future::pending::<()>().await; }
            } => { reason="authorization_changed"; break; }
            _ = shutdown.changed() => { reason="server_shutdown"; break; }
            _ = cancelled.changed() => { reason="slow_consumer"; break; }
            _ = tokio::time::sleep(wait) => {
                if identity.is_none() && started.elapsed() >= app.limits.auth { reason="auth_timeout"; break; }
                if last.elapsed() >= app.limits.idle { reason="idle_timeout"; break; }
                if identity.as_ref().is_some_and(|(_,_,expiry)| now_ms() >= *expiry) { reason="grant_expired"; break; }
            }
            Some(value) = rx.recv() => {
                if !authorization_current(&authorization) { reason="authorization_changed"; break; }
                if !send(&mut socket, value).await { reason="slow_consumer"; break; }
            }
            frame = socket.next() => {
                let Some(Ok(frame)) = frame else { break; };
                if !authorization_current(&authorization) { reason="authorization_changed"; break; }
                if window.elapsed() >= Duration::from_secs(1) { window=Instant::now(); count=0; window_bytes=0; }
                count += 1;
                if count > app.limits.messages_per_second { reason="rate_limit"; break; }
                last=Instant::now();
                let Message::Text(text) = frame else { reason="invalid_frame"; break; };
                window_bytes=window_bytes.saturating_add(text.len());session_bytes=session_bytes.saturating_add(text.len());
                if window_bytes>app.limits.bytes_per_second||session_bytes>app.limits.session_bytes||!app.permit_traffic(text.len()){reason="traffic_limit";break;}
                let Ok(value)=strict_json::parse(&text) else {reason="malformed";break;};
                let Ok(message) = serde_json::from_value::<Client>(value) else { reason="malformed"; break; };
                match message {
                    Client::Authenticate { version, room, device_key_id, signature, authorization: proof, service_admission } if identity.is_none() => {
                        let expiry;
                        if !app.permit_automatic_auth() { reason="server_busy"; break; }
                        let service_expiry = if app.google_enrollment.is_some() && app.board_grants {
                            let Some(ticket) = service_admission else { reason="service_auth_required"; break; };
                            match app.identity_directory.lock().unwrap().consume(&ticket, &challenge, &connection, &room, &device_key_id) {
                                Ok(expiry) => expiry,
                                Err(code) => { reason=code; break; }
                            }
                        } else { u64::MAX };
                        if version == 2 && app.automatic_admission {
                            let Some(proof) = proof else { reason="unauthorized"; break; };
                            let independent = app.board_grants && proof.standalone_board();
                            if !independent && app.google_enrollment.as_ref().is_some_and(|enrollment| proof.authority.fingerprint() != enrollment.authority().fingerprint()) { reason="unauthorized"; break; }
                            let Ok(verified) = proof.verify(&room,&device_key_id,&challenge,&connection,&signature,now_ms()) else { reason="unauthorized"; break; };
                            if independent && !app.grant_cache.lock().unwrap().is_current(&proof.authority.fingerprint(),&verified.context.board_id,&proof.manifest_payload,&proof.manifest_signature) {reason="authorization_unavailable";break;}
                            if !independent && app.google_enrollment.as_ref().is_some_and(|service|!service.is_current_proof(&proof)) {reason="authorization_stale";break;}
                            expiry = verified.expires_at;
                            signal_context=Some(verified.context.clone());
                            match app.accept_admission(verified) {
                                Ok(watch) => authorization=watch,
                                Err(code) => { reason=code; break; }
                            }
                        } else {
                            if app.google_enrollment.is_some() { reason="unauthorized"; break; }
                            let grant = app.config.rooms.get(&room).and_then(|r| r.get(&device_key_id));
                            let valid = version == 1 && proof.is_none() && !room.starts_with("pboard-v2-") && grant.is_some_and(|g| {
                            g.expires_at > now_ms() && g.public_key.key().is_ok_and(|key| {
                                B64.decode(signature).ok().and_then(|raw| Signature::from_slice(&raw).ok()).is_some_and(|sig| key.verify(&auth_bytes(&challenge,&connection,&room,&device_key_id), &sig).is_ok())
                            })
                            });
                            if !valid { reason="unauthorized"; break; }
                            expiry=grant.unwrap().expires_at;
                        }
                        // Correlation metadata only; never log proofs or signal payloads.
                        let room_hash = B64.encode(Sha256::digest(room.as_bytes()));
                        tracing::info!(event="authenticated", session=session_id, room=%&room_hash[..12], peer=%device_key_id, version, "device authentication accepted");
                        identity=Some((room,device_key_id.clone(),expiry.min(service_expiry)));
                        if !send(&mut socket,json!({"type":"authenticated","peerId":device_key_id,"session":connection})).await { break; }
                    }
                    Client::Join {} if identity.is_some() && !joined => {
                        let (room, peer, expiry) = identity.as_ref().unwrap();
                        if now_ms() >= *expiry { reason="grant_expired"; break; }
                        let roster = {
                            let mut rooms=app.rooms.lock().unwrap();
                            if !rooms.contains_key(room)&&rooms.len()>=app.limits.rooms {reason="room_limit";break;}
                            let members=rooms.entry(room.clone()).or_default();
                            if members.contains_key(peer) || members.len() >= app.limits.peers_per_room { None }
                            else {
                                let roster: Vec<Value> = members.iter().filter(|(_,m)| m.expires_at > now_ms() && authorization_current(&m.authorization)).map(|(id,m)| json!({"peerId":id,"session":m.session})).collect();
                                members.insert(peer.clone(),Member{session:connection.clone(),expires_at:*expiry,tx:tx.clone(),cancel:cancel.clone(),authorization:authorization.clone(),logical_session:None});
                                for (id,m) in members.iter() { if id != peer && m.tx.try_send(json!({"type":"peer_joined","peerId":peer,"session":connection})).is_err() { let _=m.cancel.send(true); } }
                                Some(roster)
                            }
                        };
                        let Some(roster)=roster else { reason="duplicate_or_full"; break; };
                        joined=true;
                        tracing::info!(event="join", session=session_id, peers=roster.len(), "authorized signaling session joined");
                        if !send(&mut socket,json!({"type":"joined","peers":roster})).await { break; }
                    }
                    Client::Signal { to, session, data } if joined => {
                        let (room,peer,expiry)=identity.as_ref().unwrap();
                        if now_ms() >= *expiry { reason="grant_expired"; break; }
                        let target = { app.rooms.lock().unwrap().get(room).and_then(|r| r.get(&to)).filter(|m| m.session==session && m.expires_at > now_ms() && authorization_current(&m.authorization)).cloned() };
                        let Some(target)=target else { reason="stale_target"; break; };
                        signal_count=signal_count.saturating_add(1);if signal_count>app.limits.session_signals{reason="signal_limit";break;}
                        let pair=format!("{to}:{session}");
                        if !pair_counts.contains_key(&pair)&&pair_counts.len()>=64{reason="signal_limit";break;}
                        let counters=pair_counts.entry(pair).or_default();
                        if let Some(context)=signal_context.as_ref() {
                            match signals::check(&data,context,peer,&to,logical_session.as_deref(),target.logical_session.as_deref()) {
                                Ok(signals::Checked::Presence(id))=>{
                                    counters.0+=1;if counters.0>32{reason="signal_limit";break;}
                                    logical_session=Some(id.clone());
                                    if let Some(member)=app.rooms.lock().unwrap().get_mut(room).and_then(|r|r.get_mut(peer)){member.logical_session=Some(id);}
                                }
                                Ok(signals::Checked::Signal{id,expires})=>{
                                    counters.1+=1;if counters.1>128{reason="signal_limit";break;}
                                    let mut replay=app.replay.lock().unwrap();signals::prune_replays(&mut replay);
                                    let id=B64.encode(Sha256::digest(format!("{}:{id}",context.manifest_hash).as_bytes()));
                                    if replay.contains_key(&id){reason="signal_replay";break;}
                                    if replay.len()>=app.limits.replay_entries{reason="server_busy";break;}
                                    replay.insert(id,expires);
                                }
                                Err(code)=>{reason=code;break;}
                            }
                        } else if !signals::negotiation(&data) {reason="invalid_signal";break;}
                        if target.tx.try_send(json!({"type":"signal","from":peer,"session":connection,"data":data})).is_err() { reason="slow_consumer"; break; }
                        forwarded += 1;
                        tracing::debug!(event="signal_forwarded", session=session_id, count=forwarded, "signaling envelope forwarded");
                    }
                    Client::Ping {} if identity.is_some() => { if !send(&mut socket,json!({"type":"pong"})).await { break; } }
                    Client::Leave {} => break,
                    _ => { reason="invalid_state"; break; }
                }
            }
        }
    }
    if let Some((room, peer, _)) = &identity
        && joined
    {
        app.leave(room, peer, &connection);
    }
    tracing::info!(
        event = "disconnect",
        session = session_id,
        reason,
        forwarded,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "signaling session ended"
    );
    let _ = send(&mut socket, json!({"type":"error","code":reason})).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close()).await;
}
