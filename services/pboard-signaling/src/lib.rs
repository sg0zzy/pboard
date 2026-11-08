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
pub mod account_inbox;
pub mod admission;
pub mod board_grants;
pub mod buffer_api;
pub mod google_enrollment;
pub mod identity_enrollment;
pub mod key_courier;
pub mod leader;
pub mod op_buffer;
pub mod policy;
pub mod signals;
pub mod sync_api;
pub mod sync_log;
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
    /// Sustained ingress budget for one connection over one [`Self::byte_window`].
    ///
    /// This replaces the old `session_bytes` lifetime cap. That field was a
    /// *cumulative total that never reset*, so a socket that lived long enough
    /// died on its own history — fine for a socket that was reopened on every
    /// board switch, fatal for the one multiplexed socket the v3 protocol asks a
    /// client to hold. A rolling window keeps the anti-flood property (a client
    /// cannot push unbounded traffic through one connection) without the
    /// property nobody wants (a healthy long-lived connection is eventually
    /// killed by the bytes it already delivered). 4 MiB per 60 s is ≈ 68 KiB/s
    /// sustained, which is an order of magnitude above the steady state of a
    /// board under active editing and above the per-second burst allowance.
    pub bytes_per_window: usize,
    /// Sustained ingress budget for one *attached room* over one
    /// [`Self::byte_window`], so one busy board cannot starve the other rooms
    /// that share its connection. Half the connection budget: two rooms can each
    /// run at their own budget, and a room that exhausts its share is detached
    /// on its own (v3) rather than closing the socket.
    pub room_bytes_per_window: usize,
    /// Length of the rolling window both byte budgets renew on.
    pub byte_window: Duration,
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
            bytes_per_window: 4 * 1024 * 1024,
            room_bytes_per_window: 2 * 1024 * 1024,
            byte_window: Duration::from_secs(60),
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

/// What the service knows about one live connection, keyed by its session id.
///
/// The session id is the `nonce` minted in `welcome` and signed into every
/// admission proof, so it is stable for the life of the socket, unique across
/// reconnects (each dial mints a new one), and impossible to confuse with a
/// device key. The registry exists so "which connections belong to this device,
/// and which rooms do they hold" has an answer that is not a guess: it is
/// written on authentication, updated on attach/detach, and removed exactly once
/// on disconnect.
#[derive(Clone, Debug)]
pub struct SessionRecord {
    /// The device the connection authenticated as. Still the connection's
    /// identity; since a v3 `attach` may present its own device key, it is no
    /// longer the device of every room the connection holds.
    pub device: String,
    pub rooms: std::collections::HashSet<String>,
    /// The verified device each attached room was admitted under. Written on
    /// attach and removed with the room, so "which device holds this room" has
    /// an answer that comes from the admission rather than the connection.
    pub room_devices: std::collections::HashMap<String, String>,
}
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
    op_buffer: Option<Arc<std::sync::Mutex<op_buffer::OpBuffer>>>,
    /// Durable operation log for the WebSocket sync protocol (Sync v3). Absent
    /// until an operator points the service at a data directory: a relay that
    /// has nowhere durable to put an operation must not advertise the protocol,
    /// because it would then have to acknowledge work it cannot promise.
    sync: Option<Arc<sync_log::SyncLog>>,
    /// Key courier tables live in the log's database file, so the courier comes
    /// into existence and goes away with the log in [`App::with_sync`]: a
    /// service that cannot store an envelope cannot courier one either.
    key_courier: Option<Arc<key_courier::KeyCourier>>,
    /// Per-account hint inbox for cross-account board discovery. Lives in the
    /// log's file and comes into existence with it, for the same reason the
    /// courier does: a hint the service cannot store durably must not be
    /// acknowledged.
    account_inbox: Option<Arc<account_inbox::AccountInbox>>,
    sync_hub: Arc<std::sync::Mutex<sync_api::Hub>>,
    leader_registry: Arc<std::sync::Mutex<leader::LeaderRegistry>>,
    buffer_challenges: Arc<std::sync::Mutex<HashMap<String, u64>>>,
    admissions: Arc<Mutex<HashMap<String, AcceptedAdmission>>>,
    /// Live sessions by server-minted session id. See [`SessionRecord`].
    sessions: Arc<Mutex<HashMap<String, SessionRecord>>>,
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
            op_buffer: None,
            sync: None,
            key_courier: None,
            account_inbox: None,
            sync_hub: Arc::new(std::sync::Mutex::new(sync_api::Hub::default())),
            leader_registry: Arc::new(std::sync::Mutex::new(leader::LeaderRegistry::default())),
            buffer_challenges: Arc::new(std::sync::Mutex::new(HashMap::new())),
            admissions: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
    /// Enables the durable op buffer (Sync v2). The leader registry is
    /// always available in memory, but the HTTP surface opens only when a
    /// buffer directory is configured, keeping the feature inert by default.
    /// Opens (creating and migrating when absent) the durable operation log.
    /// Kept separate from [`App::with_op_buffer`]: the two are different stores
    /// with different lifetimes, and the legacy buffer may be retired while the
    /// sync log outlives it.
    pub fn with_sync(mut self, directory: &std::path::Path) -> Result<Self, String> {
        let log = sync_log::SyncLog::open(directory.join("sync-log.db"), sync_log::SyncLogLimits::default())
            .map_err(|error| format!("sync_log_open: {error}"))?;
        let courier = key_courier::KeyCourier::from_sync_log(&log)
            .map_err(|error| format!("key_courier_open: {error}"))?;
        let inbox = account_inbox::AccountInbox::from_sync_log(&log)
            .map_err(|error| format!("account_inbox_open: {error}"))?;
        self.sync = Some(Arc::new(log));
        self.key_courier = Some(Arc::new(courier));
        self.account_inbox = Some(Arc::new(inbox));
        Ok(self)
    }
    pub fn sync(&self) -> Option<&Arc<sync_log::SyncLog>> {
        self.sync.as_ref()
    }
    pub fn key_courier(&self) -> Option<&Arc<key_courier::KeyCourier>> {
        self.key_courier.as_ref()
    }
    /// The per-account hint inbox, present exactly when the operation log is.
    pub fn account_inbox(&self) -> Option<&Arc<account_inbox::AccountInbox>> {
        self.account_inbox.as_ref()
    }
    pub fn sync_hub(&self) -> &Arc<std::sync::Mutex<sync_api::Hub>> {
        &self.sync_hub
    }
    /// The live session registry: server-minted session id → device and rooms.
    ///
    /// This is the "which sockets belong to this device" answer the transport
    /// consolidation needs. It is keyed by the session id that is already signed
    /// into every admission proof, so it is stable for the life of a socket,
    /// fresh on every reconnect, and carries no user account concept: the device
    /// key and the Drive-authorised rooms remain the authority.
    pub fn sessions(&self) -> &Arc<Mutex<HashMap<String, SessionRecord>>> {
        &self.sessions
    }
    pub fn with_op_buffer(mut self, directory: &std::path::Path) -> Result<Self, String> {
        let buffer = op_buffer::OpBuffer::open(directory.join("buffer-journal"), op_buffer::BufferLimits::default())
            .map_err(|error| format!("op_buffer_open_failed: {error}"))?;
        self.op_buffer = Some(Arc::new(std::sync::Mutex::new(buffer)));
        Ok(self)
    }
    pub fn op_buffer(&self) -> Option<&Arc<std::sync::Mutex<op_buffer::OpBuffer>>> {
        self.op_buffer.as_ref()
    }
    pub fn op_buffer_lock(&self) -> &Arc<std::sync::Mutex<op_buffer::OpBuffer>> {
        self.op_buffer
            .as_ref()
            .expect("op buffer routes require with_op_buffer")
    }
    pub fn leader_registry(&self) -> &Arc<std::sync::Mutex<leader::LeaderRegistry>> {
        &self.leader_registry
    }
    pub fn buffer_challenges(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.buffer_challenges.lock().unwrap()
    }
    pub fn grant_permits(&self) -> Arc<Semaphore> {
        self.grant_permits.clone()
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
    /// Verifies one room's authorization and returns what the connection may do
    /// there. This is the single admission path for all three protocol versions:
    /// `authenticate` calls it for the first room, `attach` for every further
    /// room, so a multiplexed connection cannot reach a room that the
    /// single-room protocol would have refused.
    ///
    /// `version` is the negotiated protocol. Version 3 accepts everything v2
    /// accepts and nothing more; it exists on the wire so a client can learn the
    /// server is capable before relying on `attach`, not to weaken the check.
    ///
    /// `device` is the device key id this room's proof speaks for. On
    /// `authenticate` that is the connection's device and nothing else; on a v3
    /// `attach` it is the frame's own `deviceKeyId`, defaulted to the
    /// connection's device when the field is absent. Everything downstream —
    /// which key the signature is verified against, which seat of the room's
    /// manifest is looked up, and the device this attachment is recorded and
    /// attributed under — follows from this one argument, so the widening cannot
    /// apply to one half of the check and not the other.
    /// `service_expiry` is the Google service-admission expiry already consumed
    /// for this exact `(challenge, session, room, device)` tuple, or `u64::MAX`.
    #[allow(clippy::too_many_arguments)]
    fn admit_room(
        &self,
        room: &str,
        device: &str,
        challenge: &str,
        session: &str,
        version: u8,
        proof: Option<&AdmissionProof>,
        signature: &str,
        service_expiry: u64,
    ) -> Result<Attached, &'static str> {
        if version == 0 || version > 3 {
            return Err("version_unsupported");
        }
        if version >= 2 && self.automatic_admission {
            let Some(proof) = proof else { return Err("unauthorized") };
            let independent = self.board_grants && proof.standalone_board();
            if !independent
                && self.google_enrollment.as_ref().is_some_and(|enrollment| {
                    proof.authority.fingerprint() != enrollment.authority().fingerprint()
                })
            {
                return Err("unauthorized");
            }
            let verified = proof.verify(room, device, challenge, session, signature, now_ms())?;
            if independent
                && !self.grant_cache.lock().unwrap().is_current(
                    &proof.authority.fingerprint(),
                    &verified.context.board_id,
                    &proof.manifest_payload,
                    &proof.manifest_signature,
                )
            {
                return Err("authorization_unavailable");
            }
            if !independent
                && self
                    .google_enrollment
                    .as_ref()
                    .is_some_and(|service| !service.is_current_proof(proof))
            {
                return Err("authorization_stale");
            }
            let role = verified.role;
            let expiry = verified.expires_at.min(service_expiry);
            let context = verified.context.clone();
            // Registered *after* the proof is known good, so an attach cannot
            // consume an authorization scope it is not entitled to.
            let authorization = self.accept_admission(verified)?;
            let board_id = context.board_id.clone();
            Ok(Attached {
                editor: role.can_write(),
                // The device *this* proof verified, which is the frame's
                // `deviceKeyId` on an attach and the connection's device on
                // `authenticate`. Recorded from the admission, never from a
                // later frame.
                device: device.to_owned(),
                expires_at: expiry,
                authorization,
                context: Some(context),
                board_id: Some(board_id),
            })
        } else {
            if self.google_enrollment.is_some() {
                return Err("unauthorized");
            }
            // Version 1 is the operator-grant protocol, unchanged: the grants
            // file is the authority, there are no roles, and being listed *is*
            // the write authorization. Version 3 in this mode attaches further
            // rooms through the same file — the per-room proof is a v1 signature
            // bound to this challenge, this session and *that* room, so a
            // multiplexed connection cannot reach a room its device is not
            // listed for.
            let valid = (version == 1 || version == 3)
                && proof.is_none()
                && !room.starts_with("pboard-v2-")
                && self
                    .config
                    .rooms
                    .get(room)
                    .and_then(|devices| devices.get(device))
                    .filter(|grant| grant.expires_at > now_ms())
                    .is_some_and(|grant| {
                        grant.public_key.key().is_ok_and(|key| {
                            B64.decode(signature)
                                .ok()
                                .and_then(|raw| Signature::from_slice(&raw).ok())
                                .is_some_and(|signature| {
                                    key.verify(&auth_bytes(challenge, session, room, device), &signature).is_ok()
                                })
                        })
                    });
            if !valid {
                return Err("unauthorized");
            }
            let Some(grant) = self.config.rooms.get(room).and_then(|devices| devices.get(device)) else {
                return Err("unauthorized");
            };
            Ok(Attached {
                editor: true,
                device: device.to_owned(),
                expires_at: grant.expires_at.min(service_expiry),
                authorization: None,
                context: None,
                board_id: None,
            })
        }
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
            // Buffer batches: up to 64 client ops of the 64 KiB ct ceiling
            // (512-op batches stay well under this envelope at typical sizes);
            // the per-op and per-board byte limits live in `op_buffer`.
            .merge(
                Router::new()
                    .route("/buffer/ops", axum::routing::post(buffer_api::insert_ops))
                    .route("/buffer/list", axum::routing::post(buffer_api::list_ops))
                    .route("/buffer/commit", axum::routing::post(buffer_api::commit_ops))
                    .route("/leader/claim", axum::routing::post(buffer_api::leader_claim))
                    .route("/leader/observe", axum::routing::post(buffer_api::leader_observe))
                    .route("/leader/commit", axum::routing::post(buffer_api::leader_commit))
                    .layer(axum::extract::DefaultBodyLimit::max(5 * 1024 * 1024)),
            )
            .route("/buffer/challenge", get(buffer_api::challenge))
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
/// One room attached to one connection, with the authorization it was admitted
/// under *for that room*. Per-room, not per-connection: two rooms on one socket
/// may hold different roles and different epochs, and revocation is scoped to the
/// room whose scope changed.
struct Attached {
    /// False for a read-only admission: it may subscribe, never submit.
    editor: bool,
    /// The device key id this room's admission verified, for *this* room.
    ///
    /// Since a v3 `attach` may present its own device key, this is not
    /// necessarily the connection's device: it is the key whose signature the
    /// room's proof carried and whose seat the room's manifest named. Every
    /// operation appended through this room is attributed to it, so a
    /// multiplexed connection cannot launder one board's writes through another
    /// device's identity.
    device: String,
    /// When this room's proof (or its service admission) expires.
    expires_at: u64,
    /// The revocation watch for this room's admission scope. `None` in
    /// operator-grant mode, where a room's authorization cannot be revoked
    /// except by restarting with a changed grants file.
    authorization: AuthorizationWatch,
    /// Signaling context, for manifests that carry one.
    context: Option<signals::Context>,
    /// The board id this room's verified manifest declared, when it declared
    /// one. `Some` for every manifest-backed admission; `None` in operator-grant
    /// mode, where the room name *is* the whole authorization and there is no
    /// signed board id to speak for. This is the value a hint names, so that
    /// "the board I am notifying you about" is the board the admission proved
    /// rather than a string the client chose.
    board_id: Option<String>,
}

/// A v3 `attach` frame: one more room, carrying that room's own authorization.
///
/// Deliberately *not* parsed as [`Client`], which denies unknown fields so that a
/// v1/v2 client's frames are interpreted exactly as they always were. A newer
/// client that adds a field to `attach` is a newer client, not an attack, so this
/// shape tolerates extra fields; only the fields it understands are required.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachFrame {
    room: String,
    /// The device whose key signed this attach, when it is not the device the
    /// connection authenticated as. Absent means "the connection's device",
    /// which is exactly what every v3 client sends today, so the field is
    /// additive and old frames keep their meaning.
    #[serde(default)]
    device_key_id: Option<String>,
    signature: String,
    #[serde(default)]
    authorization: Option<AdmissionProof>,
    #[serde(default)]
    service_admission: Option<String>,
}

/// A v3 `detach` frame. Unknown fields tolerated for the same reason.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetachFrame {
    room: String,
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
    /// Synchronization request; see [`sync_api`] for the request and reply
    /// shapes. Nested rather than flat so one admission check in one place can
    /// refuse every frame that names a foreign board.
    #[serde(rename = "sync", rename_all = "camelCase")]
    Sync { request: sync_api::Request },
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
        json!({
            "type": "welcome",
            // `version` is the envelope version and stays 1. `supportedVersions`
            // is the capability list, and it is additive: a v2 client reads the
            // same field it always did and still finds the 2 it requires.
            "version": 1,
            "supportedVersions": if app.automatic_admission { vec![1, 2, 3] } else { vec![1, 3] },
            "challenge": challenge,
            "session": connection,
            "requiresServiceAdmission": app.google_enrollment.is_some() && app.board_grants,
        }),
    )
    .await
    {
        return;
    }
    let (tx, mut rx) = mpsc::channel::<Value>(QUEUE);
    let sync_limits = sync_api::Limits {
        submit_batch: (app.limits.messages_per_second.max(8) as usize).min(256),
        operation_bytes: (app.limits.message_bytes / 2).min(64 * 1024),
        ..Default::default()
    };
    // One entry per attached room, each with its own role, expiry and revocation
    // watch. This is the whole of "multiple rooms per connection": the hub, the
    // sync log and the roster were already keyed by room.
    let mut attachments = HashMap::<String, Attached>::new();
    // The room the legacy `join`/`signal` surface speaks for: the first room this
    // connection authenticated, so a v1/v2 client's peer roster means exactly
    // what it always did. Other rooms are sync-only and have no roster.
    let mut primary: Option<String> = None;
    let mut authenticated = false;
    // The protocol the connection negotiated. 1 and 2 are the deployed protocol,
    // in which an unparseable frame closes the socket; 3 tolerates an unknown
    // *action* and answers it instead, because that tolerance is what lets the
    // server ship first.
    let mut negotiated: u8 = 1;
    let mut pair_counts = HashMap::<String, (u32, u32)>::new();
    let mut conn_bytes = 0usize;
    let mut room_bytes = HashMap::<String, usize>::new();
    let mut byte_window = Instant::now();
    let mut window_bytes = 0usize;
    let mut signal_count = 0usize;
    let mut shutdown = app.shutdown.subscribe();
    let (cancel, mut cancelled) = watch::channel(false);
    let mut joined = false;
    // Per-room signaling context, kept for the legacy `signal` surface, which
    // speaks for `primary`; the sync protocol reads each room's own role from
    // `attachments` instead.
    let mut logical_session: Option<String> = None;
    let started = Instant::now();
    let mut last = started;
    let mut window = started;
    let mut count = 0;
    let mut reason = "closed";
    let mut forwarded: u64 = 0;
    'session: loop {
        // One pass over the attachments decides both per-room revocation and
        // per-room expiry before any frame is served, so nothing is ever
        // answered on an authorization that has already moved.
        let ended = expired_rooms(&attachments);
        for (room, code) in ended {
            if negotiated >= 3 {
                // Only the room whose authorization moved dies. This is the
                // requirement the one-room-per-connection protocol could not
                // express: the socket and its other rooms are untouched.
                drop_room(&app, &mut attachments, &mut primary, &room, &connection, &mut joined);
                tracing::info!(event = "room_detached", session = session_id, reason = code, "room attachment ended");
                if !send(&mut socket, json!({"type":"detached","room":room,"code":code})).await {
                    reason = "slow_consumer";
                    break 'session;
                }
            } else {
                // v1/v2 hold exactly this room, so the old observable behaviour
                // is preserved verbatim: the identical code, the identical close.
                reason = code;
                break 'session;
            }
        }
        // Sleep to the next actual deadline; idle connections need no periodic poll.
        let mut wait = app.limits.idle.saturating_sub(last.elapsed());
        if !authenticated {
            wait = wait.min(app.limits.auth.saturating_sub(started.elapsed()));
        }
        if let Some(expiry) = attachments.values().map(|attached| attached.expires_at).min() {
            wait = wait.min(Duration::from_millis(expiry.saturating_sub(now_ms())));
        }
        tokio::select! {
            _ = watch_rooms(&attachments) => {
                // Resolved by the loop top into a per-room detach (v3) or a close
                // (v1/v2); no frame is served in between.
                continue 'session;
            }
            _ = shutdown.changed() => { reason="server_shutdown"; break; }
            _ = cancelled.changed() => { reason="slow_consumer"; break; }
            _ = tokio::time::sleep(wait) => {
                if !authenticated && started.elapsed() >= app.limits.auth { reason="auth_timeout"; break; }
                if last.elapsed() >= app.limits.idle { reason="idle_timeout"; break; }
                continue 'session;
            }
            Some(value) = rx.recv() => {
                // A queued frame must not leak from a room whose authorization
                // already changed; the loop top ends that attachment first.
                if !all_current(&attachments) { continue 'session; }
                if !send(&mut socket, value).await { reason="slow_consumer"; break; }
            }
            frame = socket.next() => {
                let Some(Ok(frame)) = frame else { break; };
                // Control frames are protocol, not application traffic. A
                // backgrounded worker cannot stop its browser from keep-alive
                // pinging an idle socket, and RFC 6455 makes that answerable
                // at the protocol layer — so ping and pong refresh the idle
                // clock and spend neither the message-rate nor the byte
                // budget charged to application frames. A Close ends the
                // session the way the stream end it summarizes would; a
                // Binary frame stays an invalid frame below.
                match frame {
                    Message::Ping(_) | Message::Pong(_) => {
                        last = Instant::now();
                        continue 'session;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
                // A bump that landed while this frame was in flight must not be
                // answered on the withdrawn grant. The loop top turns it into a
                // per-room detach (v3) or the old close (v1/v2).
                if !all_current(&attachments) { continue 'session; }
                if window.elapsed() >= Duration::from_secs(1) { window=Instant::now(); count=0; window_bytes=0; }
                count += 1;
                if count > app.limits.messages_per_second { reason="rate_limit"; break; }
                last=Instant::now();
                let Message::Text(text) = frame else { reason="invalid_frame"; break; };
                window_bytes=window_bytes.saturating_add(text.len());
                if window_bytes>app.limits.bytes_per_second || !app.permit_traffic(text.len()) {reason="traffic_limit";break;}
                // Rolling window, renewed rather than accumulated. This replaces
                // the old *lifetime* total: a healthy multiplexed connection now
                // costs its current window, not its whole history.
                if byte_window.elapsed() >= app.limits.byte_window {
                    byte_window = Instant::now();
                    conn_bytes = 0;
                    room_bytes.clear();
                }
                conn_bytes = conn_bytes.saturating_add(text.len());
                if conn_bytes > app.limits.bytes_per_window {reason="traffic_limit";break;}
                let Ok(value)=strict_json::parse(&text) else {reason="malformed";break;};
                // Charge the frame to the room it names, if that room is attached.
                // One busy board then spends its own budget instead of starving
                // the siblings that share this socket.
                if let Some(room) = value_room(&value, &attachments) {
                    let used = room_bytes.entry(room.clone()).or_insert(0);
                    *used = used.saturating_add(text.len());
                    if *used > app.limits.room_bytes_per_window {
                        if negotiated >= 3 {
                            drop_room(&app, &mut attachments, &mut primary, &room, &connection, &mut joined);
                            if !send(&mut socket, json!({"type":"detached","room":room,"code":"budget"})).await {
                                reason = "slow_consumer";
                                break;
                            }
                            continue 'session;
                        }
                        reason="traffic_limit";break;
                    }
                }
                // `attach`/`detach` are parsed from their own tolerant shapes:
                // [`Client`] denies unknown fields so that a v1/v2 client's
                // frames stay byte-for-byte interpreted, which is not a property
                // an evolving frame should inherit from the version that has no
                // way to evolve.
                let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
                if (kind == "attach" || kind == "detach") && negotiated >= 3 {
                    if !authenticated {
                        // Attaching is an authenticated act: a pre-auth socket
                        // gets the same `invalid_state` close it would get for
                        // `join` or `signal`.
                        reason = "invalid_state";
                        break;
                    }
                    if kind == "attach" {
                        let Ok(frame) = serde_json::from_value::<AttachFrame>(value.clone()) else {
                            if !send(&mut socket, json!({"type":"refused","code":"invalid_request"})).await { reason="slow_consumer"; break; }
                            continue;
                        };
                        if attachments.contains_key(&frame.room) {
                            // Idempotent: attaching twice is a client that
                            // reconnected its idea of the room, not an error,
                            // and must not double-subscribe. It is also not a
                            // device change: the room keeps the device its
                            // first admission verified, so naming a different
                            // `deviceKeyId` here grants nothing and alters no
                            // attribution. A client that really wants another
                            // device to hold the room detaches and re-attaches,
                            // which is a fresh admission.
                            if !send(&mut socket, json!({"type":"attached","room":frame.room,"role":role_name(attachments.get(&frame.room))})).await { reason="slow_consumer"; break; }
                            continue;
                        }
                        if attachments.len() >= sync_limits.rooms_per_connection {
                            if !send(&mut socket, json!({"type":"refused","code":"room_limit","room":frame.room})).await { reason="slow_consumer"; break; }
                            continue;
                        }
                        let Some(connection_device) = app.sessions.lock().unwrap().get(&connection).map(|record| record.device.clone()) else { reason="invalid_state"; break; };
                        // Which device this attachment speaks for. A v3 attach
                        // may present its own key, because the client signs each
                        // board's proof with that board's device key
                        // (`board-device:<board>`) and one socket has to hold
                        // boards belonging to different devices. Absent means
                        // "the connection's device", so today's frame means
                        // exactly what it always did.
                        let peer = frame.device_key_id.clone().unwrap_or(connection_device);
                        // A device key id is a fingerprint: base64url, bounded.
                        // Refusing a shape no manifest could list costs nothing
                        // and keeps a bogus identifier from spending a service
                        // admission receipt on a lookup that cannot succeed.
                        if peer.len() > 200 || !valid_room(&peer) {
                            if !send(&mut socket, json!({"type":"refused","code":"unauthorized","room":frame.room})).await { reason="slow_consumer"; break; }
                            continue;
                        }
                        // An attach is an authorization event like any other, so
                        // it draws on the same budget: a client cannot turn one
                        // authenticated socket into an unbounded verifier.
                        if !app.permit_automatic_auth() {
                            if !send(&mut socket, json!({"type":"refused","code":"server_busy","room":frame.room})).await { reason="slow_consumer"; break; }
                            continue;
                        }
                        let service_expiry = if app.google_enrollment.is_some() && app.board_grants {
                            let Some(ticket) = frame.service_admission else {
                                // Refused, not fatal: the other rooms are fine.
                                if !send(&mut socket, json!({"type":"refused","code":"service_auth_required","room":frame.room})).await { reason="slow_consumer"; break; }
                                continue;
                            };
                            // The receipt is bound to the device the attach
                            // *presents*, not the connection's: a receipt minted
                            // for `board-device:<board>` is exactly the proof
                            // that this connection may act for that board's
                            // device, and a receipt for another device would let
                            // one connection borrow an admission it never
                            // obtained. `admit_room` below then checks that the
                            // presented device is the one the room's manifest
                            // authorizes.
                            // The guard is dropped before the await: a std mutex
                            // held across a yield point is the one thing that
                            // cannot be in a `Send` future, and this future is
                            // driven by the runtime.
                            let consumed = app.identity_directory.lock().unwrap().consume(&ticket, &challenge, &connection, &frame.room, &peer);
                            match consumed {
                                Ok(expiry) => expiry,
                                Err(code) => {
                                    if !send(&mut socket, json!({"type":"refused","code":code,"room":frame.room})).await { reason="slow_consumer"; break; }
                                    continue;
                                }
                            }
                        } else { u64::MAX };
                        let admitted = match app.admit_room(&frame.room, &peer, &challenge, &connection, negotiated, frame.authorization.as_ref(), &frame.signature, service_expiry) {
                            Ok(admitted) => admitted,
                            Err(code) => {
                                // Refused without closing the socket and without
                                // touching any other room: the requirement that
                                // makes one connection safe to hold many boards.
                                tracing::info!(event = "attach_refused", session = session_id, reason = code, "room attachment refused");
                                if !send(&mut socket, json!({"type":"refused","code":code,"room":frame.room})).await { reason="slow_consumer"; break; }
                                continue;
                            }
                        };
                        let role = role_name(Some(&admitted));
                        // A connection whose primary room was detached can
                        // regain the legacy roster by attaching a room again;
                        // the first attached room becomes the one `join` and
                        // `signal` speak for.
                        if primary.is_none() {
                            primary = Some(frame.room.clone());
                        }
                        // Taken before the attachment is filed, so it is the
                        // *verified* account id from this room's manifest.
                        let inbox = admitted
                            .board_id
                            .as_deref()
                            .and_then(|id| id.strip_prefix("account:"))
                            .map(str::to_owned);
                        // Recorded per room: this socket's `sync` frames now
                        // carry one author per attachment, not one per socket.
                        if let Some(record) = app.sessions.lock().unwrap().get_mut(&connection) {
                            record.rooms.insert(frame.room.clone());
                            record.room_devices.insert(frame.room.clone(), admitted.device.clone());
                        }
                        attachments.insert(frame.room.clone(), admitted);
                        if app.sync.is_some() {
                            let mut hub = app.sync_hub.lock().unwrap();
                            hub.subscribe(&frame.room, &connection, tx.clone());
                            // An account room is also an inbox. Registering the
                            // connection here is what makes "every session of
                            // this account" a set the relay can fan out to at
                            // all — the account hash comes from the room's own
                            // verified manifest, never from a frame.
                            if let Some(hash) = inbox {
                                hub.subscribe_inbox(&hash, &connection, tx.clone());
                            }
                        }
                        tracing::info!(event = "room_attached", session = session_id, role, "room attachment accepted");
                        if !send(&mut socket, json!({"type":"attached","room":frame.room,"role":role})).await { reason="slow_consumer"; break; }
                    } else {
                        let Ok(frame) = serde_json::from_value::<DetachFrame>(value.clone()) else {
                            if !send(&mut socket, json!({"type":"refused","code":"invalid_request"})).await { reason="slow_consumer"; break; }
                            continue;
                        };
                        if !attachments.contains_key(&frame.room) {
                            // Detaching what was never attached is a no-op, so a
                            // client retrying a detach after a dropped reply is
                            // not punished for it.
                            if !send(&mut socket, json!({"type":"detached","room":frame.room,"code":"not_attached"})).await { reason="slow_consumer"; break; }
                            continue;
                        }
                        drop_room(&app, &mut attachments, &mut primary, &frame.room, &connection, &mut joined);
                        if !send(&mut socket, json!({"type":"detached","room":frame.room})).await { reason="slow_consumer"; break; }
                    }
                    continue;
                }
                // Parsed for v3 with unknown top-level fields discarded, so an
                // additive field is a newer client rather than a dropped frame.
                // The inner shapes (`request`, submitted operations, key grants)
                // keep their own strictness: there, a silently ignored field
                // would change what an operation means.
                let parse_version = value.clone();
                let parsed = if negotiated >= 3 {
                    serde_json::from_value::<Client>(without_unknown_fields(parse_version))
                } else {
                    serde_json::from_value::<Client>(parse_version)
                };
                let Ok(message) = parsed else {
                    // v3 only: an action this build does not know is answered,
                    // never punished. A deployed v2 client cannot produce one —
                    // it does not know the vocabulary — so its behaviour is
                    // untouched, and for v1/v2 an unknown frame still closes
                    // exactly as it always did.
                    if negotiated >= 3 {
                        if !send(&mut socket, json!({"type":"refused","code":"unknown_action"})).await {
                            reason = "slow_consumer";
                            break;
                        }
                        continue;
                    }
                    reason="malformed"; break;
                };
                match message {
                    Client::Authenticate { version, room, device_key_id, signature, authorization: proof, service_admission } if !authenticated => {
                        // Charged before verification, exactly as before: a flood
                        // of bad proofs must cost the flooder the permit, not
                        // cost the service the work of verifying them.
                        if !app.permit_automatic_auth() { reason="server_busy"; break; }
                        let service_expiry = if app.google_enrollment.is_some() && app.board_grants {
                            let Some(ticket) = service_admission else { reason="service_auth_required"; break; };
                            match app.identity_directory.lock().unwrap().consume(&ticket, &challenge, &connection, &room, &device_key_id) {
                                Ok(expiry) => expiry,
                                Err(code) => { reason=code; break; }
                            }
                        } else { u64::MAX };
                        let admitted = match app.admit_room(&room, &device_key_id, &challenge, &connection, version, proof.as_ref(), &signature, service_expiry) {
                            Ok(admitted) => admitted,
                            Err(code) => { reason=code; break; }
                        };
                        negotiated = version;
                        // Correlation metadata only; never log proofs or signal payloads.
                        let room_hash = B64.encode(Sha256::digest(room.as_bytes()));
                        tracing::info!(event="authenticated", session=session_id, room=%&room_hash[..12], peer=%device_key_id, version, "device authentication accepted");
                        authenticated = true;
                        primary = Some(room.clone());
                        let inbox = admitted
                            .board_id
                            .as_deref()
                            .and_then(|id| id.strip_prefix("account:"))
                            .map(str::to_owned);
                        if app.sync.is_some() {
                            let mut hub = app.sync_hub.lock().unwrap();
                            hub.subscribe(&room, &connection, tx.clone());
                            // The first room may itself be the account room, in
                            // which case this connection is in the inbox fan-out
                            // from the first frame: a single-room client that
                            // dials the account channel directly is a receiver
                            // exactly like one that attached it.
                            if let Some(hash) = inbox {
                                hub.subscribe_inbox(&hash, &connection, tx.clone());
                            }
                        }
                        attachments.insert(room.clone(), admitted);
                        app.sessions.lock().unwrap().insert(connection.clone(), SessionRecord {
                            device: device_key_id.clone(),
                            rooms: std::collections::HashSet::from([room.clone()]),
                            // `authenticate` semantics are unchanged: the first
                            // room's device *is* the connection's device, and
                            // that is the only frame that sets this field.
                            room_devices: std::collections::HashMap::from([(room.clone(), device_key_id.clone())]),
                        });
                        if !send(&mut socket,json!({"type":"authenticated","peerId":device_key_id,"session":connection,"version":negotiated})).await { break; }
                    }
                    Client::Authenticate { .. } => { reason="invalid_state"; break; }
                    Client::Join {} if authenticated && !joined => {
                        // The legacy roster speaks for one room. On a v3 socket
                        // that room can have been detached on its own, and that
                        // is a refusal for this action, not for the connection.
                        let Some(room) = primary.clone() else {
                            if !send(&mut socket, json!({"type":"refused","code":"no_primary_room"})).await { reason="slow_consumer"; break; }
                            continue;
                        };
                        // The roster entry is the device this room's admission
                        // verified. On a v3 socket the primary room may have
                        // been attached with its own key, so reading the
                        // connection's device here would list the socket as a
                        // peer the room never admitted.
                        let Some(peer) = attachments.get(&room).map(|attached| attached.device.clone()) else { reason="invalid_state"; break; };
                        let Some(expiry) = attachments.get(&room).map(|attached| attached.expires_at) else { reason="invalid_state"; break; };
                        let authorization = attachments.get(&room).and_then(|attached| attached.authorization.clone());
                        if now_ms() >= expiry { reason="grant_expired"; break; }
                        let roster = {
                            let mut rooms=app.rooms.lock().unwrap();
                            if !rooms.contains_key(&room)&&rooms.len()>=app.limits.rooms {reason="room_limit";break;}
                            let members=rooms.entry(room.clone()).or_default();
                            if members.contains_key(&peer) || members.len() >= app.limits.peers_per_room { None }
                            else {
                                let roster: Vec<Value> = members.iter().filter(|(_,m)| m.expires_at > now_ms() && authorization_current(&m.authorization)).map(|(id,m)| json!({"peerId":id,"session":m.session})).collect();
                                members.insert(peer.clone(),Member{session:connection.clone(),expires_at:expiry,tx:tx.clone(),cancel:cancel.clone(),authorization,logical_session:None});
                                for (id,m) in members.iter() { if id != &peer && m.tx.try_send(json!({"type":"peer_joined","peerId":peer,"session":connection})).is_err() { let _=m.cancel.send(true); } }
                                Some(roster)
                            }
                        };
                        let Some(roster)=roster else { reason="duplicate_or_full"; break; };
                        joined=true;
                        tracing::info!(event="join", session=session_id, peers=roster.len(), "authorized signaling session joined");
                        if !send(&mut socket,json!({"type":"joined","peers":roster})).await { break; }
                    }
                    Client::Signal { to, session, data } if joined => {
                        let Some(room) = primary.clone() else {
                            if !send(&mut socket, json!({"type":"refused","code":"no_primary_room"})).await { reason="slow_consumer"; break; }
                            continue;
                        };
                        let Some(peer) = attachments.get(&room).map(|attached| attached.device.clone()) else { reason="invalid_state"; break; };
                        let expiry = attachments.get(&room).map_or(0, |attached| attached.expires_at);
                        if now_ms() >= expiry { reason="grant_expired"; break; }
                        let target = { app.rooms.lock().unwrap().get(&room).and_then(|r| r.get(&to)).filter(|m| m.session==session && m.expires_at > now_ms() && authorization_current(&m.authorization)).cloned() };
                        let Some(target)=target else { reason="stale_target"; break; };
                        signal_count=signal_count.saturating_add(1);if signal_count>app.limits.session_signals{reason="signal_limit";break;}
                        let pair=format!("{to}:{session}");
                        if !pair_counts.contains_key(&pair)&&pair_counts.len()>=64{reason="signal_limit";break;}
                        let counters=pair_counts.entry(pair).or_default();
                        let signal_context = attachments.get(&room).and_then(|attached| attached.context.as_ref());
                        if let Some(context)=signal_context {
                            match signals::check(&data,context,&peer,&to,logical_session.as_deref(),target.logical_session.as_deref()) {
                                Ok(signals::Checked::Presence(id))=>{
                                    counters.0+=1;if counters.0>32{reason="signal_limit";break;}
                                    logical_session=Some(id.clone());
                                    if let Some(member)=app.rooms.lock().unwrap().get_mut(&room).and_then(|r|r.get_mut(&peer)){member.logical_session=Some(id);}
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
                    Client::Sync { request } if authenticated => {
                        let Some(log) = app.sync.clone() else { reason = "sync_disabled"; break; };
                        // The courier opened with the log in `with_sync`;
                        // reaching here without one would be a broken build.
                        let Some(courier) = app.key_courier.clone() else { reason = "sync_disabled"; break; };
                        // Present exactly when the log is; `None` makes the two
                        // inbox actions refuse with `inbox_disabled` rather than
                        // pretending a hint was stored.
                        let inbox = app.account_inbox.clone();
                        let Some(peer) = app.sessions.lock().unwrap().get(&connection).map(|record| record.device.clone()) else {
                            reason = "invalid_state";
                            break;
                        };
                        // Built from the attachments, so the role in each room is
                        // the one that room's own admission resolved: a viewer on
                        // one board and an editor on another both work, and a
                        // room absent from this map is refused by the protocol.
                        let rooms = attachments
                            .iter()
                            .map(|(room, attached)| (room.clone(), sync_api::RoomAccess { editor: attached.editor }))
                            .collect();
                        // The verified board id of each room, from the manifest
                        // the admission proved. A hint names this, not a string
                        // from the frame.
                        let board_ids = attachments
                            .iter()
                            .filter_map(|(room, attached)| {
                                attached.board_id.clone().map(|id| (room.clone(), id))
                            })
                            .collect();
                        // The author of a frame is the device *that room* was
                        // admitted under. Per attachment, because one socket now
                        // holds boards belonging to different device keys; the
                        // connection's own device remains the fallback for a
                        // room that recorded none.
                        let actors = attachments
                            .iter()
                            .map(|(room, attached)| (room.clone(), attached.device.clone()))
                            .collect();
                        let identity = sync_api::Identity {
                            rooms,
                            board_ids,
                            actors,
                            actor: peer,
                            session: connection.clone(),
                        };
                        let limits = sync_limits.clone();
                        // SQLite is synchronous by design, and this protocol must
                        // not acknowledge on a runtime thread it might be holding
                        // for somebody else's replay. This connection awaits its
                        // own work, so acknowledgments cannot overtake each other.
                        let outcome = match tokio::task::spawn_blocking(move || {
                            sync_api::handle(&log, &courier, inbox.as_deref(), &identity, request, &limits)
                        })
                        .await
                        {
                            Ok(outcome) => outcome,
                            Err(_) => {
                                reason = "server_error";
                                break;
                            }
                        };
                        // Replies first, always: no peer learns of an operation
                        // before its author is told the operation is durable.
                        let sync_api::Outcome { replies, broadcast, inbox_broadcast } = outcome;
                        let mut closed = false;
                        for reply in replies {
                            if !send(&mut socket, reply).await {
                                closed = true;
                                break;
                            }
                        }
                        if closed {
                            reason = "slow_consumer";
                            break;
                        }
                        sync_api::Outcome::publish_broadcast(&app.sync_hub, &broadcast);
                        sync_api::Outcome::publish_inbox(&app.sync_hub, &inbox_broadcast);
                    }
                    Client::Ping {} if authenticated => { if !send(&mut socket,json!({"type":"pong"})).await { break; } }
                    Client::Leave {} => break,
                    _ => { reason="invalid_state"; break; }
                }
            }
        }
    }
    for room in attachments.keys().cloned().collect::<Vec<_>>() {
        drop_room(&app, &mut attachments, &mut primary, &room, &connection, &mut joined);
    }
    app.sync_hub.lock().unwrap().unsubscribe_session(&connection);
    app.sessions.lock().unwrap().remove(&connection);
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
/// Drops top-level framing fields this build does not know.
///
/// Only the envelope is filtered. The nested payloads (`request`, submitted
/// operations, key grants) deliberately keep `deny_unknown_fields`, because
/// there an ignored field changes what the operation means; at the envelope
/// level an extra field is a newer client announcing itself, and refusing it
/// would make every additive change an outage.
fn without_unknown_fields(value: Value) -> Value {
    const KNOWN: &[&str] = &[
        "type",
        "version",
        "room",
        "deviceKeyId",
        "signature",
        "authorization",
        "serviceAdmission",
        "to",
        "session",
        "data",
        "request",
    ];
    let Value::Object(map) = value else { return value };
    Value::Object(map.into_iter().filter(|(key, _)| KNOWN.contains(&key.as_str())).collect())
}

/// Which room a frame is charged to, for the per-room byte budget.
///
/// Sync frames name it in `board`; attach/detach name it in `room`. Everything
/// else (ping, authenticate, join, signal) is connection-level and is charged
/// only to the connection budget, deliberately: a room budget is for room
/// traffic, and a frame that names no room is not one room's fault.
fn value_room(value: &Value, attached: &HashMap<String, Attached>) -> Option<String> {
    let name = match value.get("type").and_then(Value::as_str) {
        Some("sync") => value.get("request")?.get("board")?.as_str()?,
        Some("attach") | Some("detach") => value.get("room")?.as_str()?,
        _ => return None,
    };
    attached.contains_key(name).then(|| name.to_string())
}

fn all_current(attachments: &HashMap<String, Attached>) -> bool {
    attachments.values().all(|attached| authorization_current(&attached.authorization))
}

/// Resolves when any attachment's authorization revision moves.
///
/// One future per watch, resolved to the room that moved, so the caller can
/// scope the consequence: a v3 connection loses exactly that room, while a v1/v2
/// connection — which by protocol holds one — closes, precisely as it always did.
async fn watch_rooms(attachments: &HashMap<String, Attached>) {
    let waits: Vec<futures_util::future::BoxFuture<'static, ()>> = attachments
        .values()
        .filter_map(|attached| attached.authorization.as_ref().map(|(current, receiver)| {
            let expected = current.clone();
            let mut receiver = receiver.clone();
            Box::pin(async move {
                // If the revision is already different, resolve at once; awaiting
                // `changed()` alone would wait for the *next* bump and serve one
                // more frame on a grant that had already been withdrawn.
                if *receiver.borrow_and_update() == expected {
                    // A sender that went away (its admission record was pruned)
                    // can never bump this watch again. Parking — rather than
                    // resolving — is what keeps that from becoming a busy loop;
                    // the room is still bounded, because the record outlives the
                    // proof it recorded, so expiry closes it.
                    if receiver.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                }
            }) as futures_util::future::BoxFuture<'static, ()>
        }))
        .collect();
    if waits.is_empty() {
        std::future::pending::<()>().await;
    }
    futures_util::future::select_all(waits).await;
}

/// Rooms whose authorization has moved or whose proof has expired, each with the
/// code that ends it.
fn expired_rooms(attachments: &HashMap<String, Attached>) -> Vec<(String, &'static str)> {
    let now = now_ms();
    attachments
        .iter()
        .filter_map(|(room, attached)| {
            if !authorization_current(&attached.authorization) {
                Some((room.clone(), "authorization_changed"))
            } else if now >= attached.expires_at {
                Some((room.clone(), "grant_expired"))
            } else {
                None
            }
        })
        .collect()
}

fn role_name(attached: Option<&Attached>) -> &'static str {
    match attached {
        Some(attached) if attached.editor => "editor",
        Some(_) => "viewer",
        None => "none",
    }
}
/// Removes one room's attachment, leaving the connection and every other room
/// intact: the hub subscription, the peer-roster entry (if this was the room the
/// legacy `join` surface speaks for) and the session-registry entry all go.
fn drop_room(
    app: &App,
    attachments: &mut HashMap<String, Attached>,
    primary: &mut Option<String>,
    room: &str,
    connection: &str,
    joined: &mut bool,
) {
    let Some(attached) = attachments.remove(room) else {
        return;
    };
    {
        let mut hub = app.sync_hub.lock().unwrap();
        hub.unsubscribe(room, connection);
        // The inbox membership goes with the room that proved it: a connection
        // that loses its account room must stop receiving that account's mail in
        // the same instant, or a revocation would leave a live delivery path.
        if let Some(hash) = attached
            .board_id
            .as_deref()
            .and_then(|id| id.strip_prefix("account:"))
        {
            hub.unsubscribe_inbox(hash, connection);
        }
    }
    if let Some(record) = app.sessions.lock().unwrap().get_mut(connection) {
        record.rooms.remove(room);
        // The room's device goes with the room: a later attach may present a
        // different key for the same room name, and a stale entry would then
        // answer for a device that is no longer admitted there.
        record.room_devices.remove(room);
    }
    // The roster entry belongs to the device that admission verified for this
    // room, which may not be the connection's device.
    let holder = attached.device;
    if primary.as_deref() == Some(room) {
        // The legacy roster is a one-room surface. If the room it speaks for
        // goes away, its roster entry goes with it: `join`/`signal` refuse
        // rather than answering for a room this connection no longer holds.
        app.leave(room, &holder, connection);
        *primary = None;
        *joined = false;
    }
}
