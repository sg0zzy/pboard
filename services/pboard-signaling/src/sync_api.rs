//! WebSocket synchronization protocol (Sync v3).
//!
//! One authenticated connection, many attached rooms, three needs: catch me up,
//! take what I have, and tell me what everyone else did. This module is the
//! protocol layer for those; [`crate::sync_log`] is the storage underneath and
//! the session loop in `lib.rs` owns the socket, the rate limits, and the
//! per-room admission proofs. Nothing here touches a socket or a database
//! directly, which is what makes the whole protocol testable as a function.
//!
//! ## Why it lives on the existing `/ws` connection
//!
//! The connection has already proved a device key against a challenge, already
//! carries the board's admission proof and its expiry, and is already dropped
//! when that authorization changes. A second endpoint would have to duplicate
//! every one of those guarantees, and a synchronization transport with a
//! hand-copied authorization path is how you get the bug where one transport
//! enforces roles and the other does not.
//!
//! ## Identity
//!
//! Three distinct identifiers, deliberately not interchangeable:
//!
//! * `board` — the room a frame names. Since protocol v3 a connection may hold
//!   *several* rooms, each with its own authorization and its own role, so the
//!   check is "is this room attached" ([`Identity::access`]) rather than "is
//!   this the one room". A frame naming a room this connection never attached
//!   is refused with `board_mismatch`, not re-scoped: attaching is an
//!   authenticated act, so an unattached room is unreachable rather than merely
//!   unauthorised.
//! * `actor` — the device key id the *room's* admission verified. Operations are
//!   attributed to it and a client cannot submit as another actor; the field is
//!   never read from the frame. An `attach` may present its own device key since
//!   protocol v3, so the actor is per room ([`Identity::actors`]); every room
//!   that did not record one falls back to the connection's authenticated
//!   device, which is what a v2 connection has always used.
//! * `session` — this one TCP connection, minted by the server in `welcome`.
//!   Two tabs of the same account are two sessions with the same actor, and
//!   neither replaces or disconnects the other.
//!
//! ## Ordering
//!
//! `seq` is assigned by the server inside the append transaction and is the only
//! ordering the protocol offers. The client's `logicalClock` is stored and
//! echoed for diagnostics; nothing in this module orders by it, and nothing
//! orders by wall-clock time. Convergence is the browser's job.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::account_inbox::{AccountInbox, InboxError};
use crate::key_courier::{CourierError, KeyCourier, KeyGrantInput};
use crate::sync_log::{AppendReceipt, OperationInput, ReplayGap, SyncLog, SyncLogError};

/// Server-to-client frames all share this envelope, so a client can route on
/// `type === "sync"` and switch on `action`.
pub const FRAME_TYPE: &str = "sync";

/// One synchronization request.
///
/// Unknown *request* fields are tolerated on purpose. This is a versioned
/// protocol shared by browsers that update at different times, and a frame that
/// merely carries an extra field is a newer client, not an attack — rejecting it
/// would turn every additive change into an outage, which is the mixed-version
/// problem the protocol version exists to solve. What is *not* tolerated is an
/// unknown field inside a submitted operation envelope
/// ([`SubmittedOperation`]), where a silently ignored field would change what an
/// operation means.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Request {
    /// Catch me up from `after_seq` (exclusive) and keep me live afterwards.
    #[serde(rename_all = "camelCase")]
    Subscribe { board: String, after_seq: u64 },
    /// Submit operations. Duplicates are answered, never stored twice.
    #[serde(rename_all = "camelCase")]
    Submit { board: String, operations: Vec<SubmittedOperation> },
    /// Ask for the right to publish this board's consolidated snapshot.
    #[serde(rename_all = "camelCase")]
    Lease { board: String, #[serde(default)] lease_ms: Option<u64> },
    Release { board: String },
    /// Report a snapshot that was published to Drive, advancing the checkpoint.
    #[serde(rename_all = "camelCase")]
    Commit {
        board: String,
        epoch: u64,
        seq: u64,
        snapshot_seq: u64,
        drive_etag: String,
    },
    /// Per-board diagnostics for the console surface.
    Status { board: String },
    /// Hand this device's wrap key to the board's roster; see [`crate::key_courier`].
    #[serde(rename_all = "camelCase")]
    PublishDeviceKey { board: String, public_key: String },
    /// Every device that published a wrap key for this board, caller included.
    ListDeviceKeys { board: String },
    /// Post public-key-wrapped content keys for named peers.
    #[serde(rename_all = "camelCase")]
    PublishKeyGrants { board: String, grants: Vec<KeyGrantOffer> },
    /// Read the mailbox of this connection's authenticated device.
    FetchKeyGrants { board: String },
    /// Notify another **account** that it now has a board. See
    /// [`crate::account_inbox`].
    ///
    /// `board` is the room this connection holds, exactly as every other frame
    /// means it; the *board id* carried in the stored hint is taken from that
    /// room's verified manifest, never from this frame. `to` is the target
    /// account hash — SHA-256 of the verified email, lowercase hex — which is
    /// the only name the relay has for an account and the only one it needs.
    #[serde(rename_all = "camelCase")]
    PublishAccountHint {
        board: String,
        to: String,
        hint_id: String,
        payload: String,
    },
    /// Everything this connection's account missed after `afterSeq`. `board` is
    /// the `account:<hash>` room the connection attached, so the account the
    /// answer is about comes from the admission of that room, not from a field
    /// a client could point somewhere else.
    #[serde(rename_all = "camelCase")]
    ReplayAccountHints {
        board: String,
        #[serde(default)]
        after_seq: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmittedOperation {
    pub op_id: String,
    /// Envelope protocol version, validated against
    /// [`crate::sync_log::SUPPORTED_PROTOCOL_VERSION`].
    pub protocol_version: u32,
    #[serde(default)]
    pub logical_clock: i64,
    /// Opaque client payload (sealed by the client). Never parsed here.
    pub payload: String,
}

/// One recipient-and-envelope pair of a `publishKeyGrants` batch. The envelope
/// is wrapped key material the server cannot open and never parses; it is
/// refused on size alone. `deny_unknown_fields`, as for [`SubmittedOperation`]:
/// a silently ignored field inside a grant is a misrouted key, not a newer
/// client.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyGrantOffer {
    pub device_key_id: String,
    pub envelope: String,
}

impl Request {
    /// The room every frame names.
    ///
    /// This is the whole authorization check the protocol needs, because
    /// authorization is per room: since protocol v3 a connection may hold several,
    /// and [`Identity::access`] answers "does this connection hold *this* room"
    /// for whichever one the frame names.
    pub fn board(&self) -> &str {
        match self {
            Self::Subscribe { board, .. }
            | Self::Submit { board, .. }
            | Self::Lease { board, .. }
            | Self::Release { board }
            | Self::Commit { board, .. }
            | Self::Status { board }
            | Self::PublishDeviceKey { board, .. }
            | Self::ListDeviceKeys { board }
            | Self::PublishKeyGrants { board, .. }
            | Self::FetchKeyGrants { board }
            | Self::PublishAccountHint { board, .. }
            | Self::ReplayAccountHints { board, .. } => board,
        }
    }
}

/// What one connection may do in one attached room.
///
/// The role is per room because it is derived per room: a signed manifest may
/// name the same device as `viewer` on one board and `editor` on another, and a
/// connection that carries both must honour each. Collapsing this to one flag
/// for the whole connection — which is what the single-room protocol did — is
/// exactly the bug this type exists to prevent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoomAccess {
    /// False for a read-only admission: it may subscribe, never submit.
    pub editor: bool,
}

impl RoomAccess {
    /// Owner or editor admission: may publish mutations.
    pub const WRITER: Self = Self { editor: true };
    /// Viewer admission: receives the stream, is refused every write.
    pub const READER: Self = Self { editor: false };
}

/// The verified identity of the connection issuing a request.
#[derive(Clone, Debug)]
pub struct Identity {
    /// Every room this connection is attached to, with the role it was admitted
    /// under *there*. A frame naming a room absent from this map is refused:
    /// authorization is per room, so an unattached room is not a permission
    /// question but a framing error.
    pub rooms: HashMap<String, RoomAccess>,
    /// The **verified** board id each attached room's manifest declared, keyed by
    /// room. Taken from the manifest the admission proof carried, never from a
    /// frame: it is what lets a protocol action name a board and have that name
    /// mean "the board this connection proved", which is the difference between
    /// a sender authorization and a client assertion.
    ///
    /// Absent for a room admitted in operator-grant mode (no manifest, nothing
    /// to vouch for a board id) and for a room whose manifest the build cannot
    /// attribute; such a room can carry every other action but cannot speak for
    /// a board into an inbox.
    pub board_ids: HashMap<String, String>,
    /// The **verified** device key id each attached room was admitted under,
    /// keyed by room.
    ///
    /// Since protocol v3 an attach may present its own device key, so a room's
    /// author is the device whose signature that room's admission checked, not
    /// the device the connection authenticated with. An operation appended
    /// through a room is attributed to this value — which is why it is recorded
    /// per attachment, from the admission, and never read from a frame.
    ///
    /// A room absent from this map is refused at [`Self::access`] before its
    /// actor is ever consulted.
    pub actors: HashMap<String, String>,
    /// Authenticated device key id; the author of any room that did not record
    /// its own. [`Self::actor_for`] is the only reader.
    pub actor: String,
    /// This connection, so a subscriber can be addressed and replaced exactly.
    pub session: String,
}

impl Identity {
    /// A connection that has authenticated but attached nothing yet.
    pub fn new(actor: impl Into<String>, session: impl Into<String>) -> Self {
        Self {
            rooms: HashMap::new(),
            board_ids: HashMap::new(),
            actors: HashMap::new(),
            actor: actor.into(),
            session: session.into(),
        }
    }

    /// Records one room's authorization. Re-attaching an already-attached room
    /// replaces its role, which is what a re-authenticated room means.
    pub fn with_room(mut self, room: impl Into<String>, access: RoomAccess) -> Self {
        self.rooms.insert(room.into(), access);
        self
    }

    /// Records the verified board id a room's manifest declared, alongside that
    /// room's access. Kept separate from [`Self::with_room`] because only a
    /// manifest-backed admission has one; a caller that has both calls this.
    pub fn with_board_id(mut self, room: impl Into<String>, board_id: impl Into<String>) -> Self {
        self.board_ids.insert(room.into(), board_id.into());
        self
    }

    /// The role this connection holds in `room`, or `None` if it never attached.
    pub fn access(&self, room: &str) -> Option<RoomAccess> {
        self.rooms.get(room).copied()
    }

    /// Records the device key id a room's admission actually verified, so
    /// operations appended through that room are attributed to it.
    pub fn with_actor(mut self, room: impl Into<String>, actor: impl Into<String>) -> Self {
        self.actors.insert(room.into(), actor.into());
        self
    }

    /// The device an operation in `room` is attributed to.
    ///
    /// The room's own verified device when its attachment recorded one, and the
    /// connection's authenticated device otherwise — which is exactly the value
    /// a v2 connection has always used, so a v3 client that attaches without
    /// naming a device keeps the old attribution.
    pub fn actor_for(&self, room: &str) -> &str {
        self.actors.get(room).map_or(self.actor.as_str(), String::as_str)
    }
}

/// Which frames a request produced. `broadcast` is published to every live
/// subscriber of the board *after* the durable append committed and after
/// `replies` were queued for the submitting socket — order matters: no peer is
/// ever told about an operation the sender has not been told is stored.
pub struct Outcome {
    pub replies: Vec<Value>,
    pub broadcast: Vec<Value>,
    /// Inbox fan-out: `(account hash, frame)`. Separate from `broadcast`
    /// because it is addressed by account rather than by room, and the
    /// distinction is the whole authorization model — a board broadcast reaches
    /// the room's members, an inbox broadcast reaches every live session of an
    /// account that is not a member of the sender's room.
    pub inbox_broadcast: Vec<(String, Value)>,
}

impl Outcome {
    fn only(reply: Value) -> Self {
        Self { replies: vec![reply], broadcast: Vec::new(), inbox_broadcast: Vec::new() }
    }

    /// Sends the broadcast half to every subscriber of each frame's board. The
    /// board travels in the frame (a client needs it to route replies), so the
    /// transport does not have to carry it twice.
    pub fn publish_broadcast(hub: &std::sync::Mutex<Hub>, broadcast: &[Value]) {
        if broadcast.is_empty() {
            return;
        }
        let mut hub = hub.lock().expect("sync hub mutex");
        for value in broadcast {
            if let Some(board) = value.get("board").and_then(Value::as_str) {
                hub.publish(board, value);
            }
        }
    }

    /// Sends each inbox frame to every live session of that account.
    ///
    /// Called **after** `replies`, exactly as [`Self::publish_broadcast`] is, so
    /// no receiver ever learns of a hint the sender has not been told is
    /// durable. Delivery is best-effort per socket and durable per hint: a
    /// session whose queue is full is skipped and replays the hint when it
    /// reconnects, which is why losing a live fan-out is a latency cost and
    /// never a lost event.
    pub fn publish_inbox(hub: &std::sync::Mutex<Hub>, inbox_broadcast: &[(String, Value)]) {
        if inbox_broadcast.is_empty() {
            return;
        }
        let mut hub = hub.lock().expect("sync hub mutex");
        for (inbox, value) in inbox_broadcast {
            hub.publish_inbox(inbox, value);
        }
    }
}

fn frame(action: &str, board: &str, mut fields: Vec<(&'static str, Value)>) -> Value {
    let mut object = json!({ "type": FRAME_TYPE, "action": action, "board": board });
    let Some(map) = object.as_object_mut() else { unreachable!() };
    for (key, value) in fields.drain(..) {
        map.insert(key.to_string(), value);
    }
    object
}

fn error(board: &str, code: &str) -> Value {
    frame("error", board, vec![("code", json!(code))])
}

fn code_for(error: &SyncLogError) -> &'static str {
    match error {
        // A held lease is the one refusal a client can do something useful with,
        // so it gets its own code instead of a generic invalid request.
        SyncLogError::Invalid("lease held by another writer") => "lease_busy",
        SyncLogError::Invalid(_) => "invalid_request",
        SyncLogError::UnsupportedVersion(_) => "protocol_version_unsupported",
        SyncLogError::UnknownBoard => "unknown_board",
        SyncLogError::EpochStale { .. } => "lease_expired",
        SyncLogError::CheckpointRejected(_) => "checkpoint_rejected",
        SyncLogError::EvidenceRejected(_) => "evidence_rejected",
        SyncLogError::Full => "log_full",
        SyncLogError::Io(_) | SyncLogError::Sqlite(_) => "server_error",
    }
}

/// Courier refusals carry the reason on the wire rather than truncating or
/// dropping: a client that posted thirty-three grants needs to know it may
/// resend two batches, not guess why nothing arrived.
fn code_for_courier(error: &CourierError) -> &'static str {
    match error {
        CourierError::PublicKeyTooLarge => "public_key_too_large",
        CourierError::EnvelopeTooLarge => "envelope_too_large",
        CourierError::BatchTooLarge => "batch_too_large",
        CourierError::TooManyDeviceKeys => "too_many_device_keys",
        CourierError::Invalid(_) => "invalid_request",
        CourierError::Io(_) | CourierError::Sqlite(_) => "server_error",
    }
}

/// Inbox refusals, named so the sender can act: `invalid_request` is its own
/// fault and will not improve on retry, `server_error` is ours. There is no
/// capacity code because capacity is answered by eviction, never by refusal —
/// see [`crate::account_inbox::MAX_INBOXES`] for why that is the safe direction.
fn code_for_inbox(error: &InboxError) -> &'static str {
    match error {
        InboxError::Invalid(_) => "invalid_request",
        InboxError::Io(_) | InboxError::Sqlite(_) => "server_error",
    }
}

fn operation_json(record: &crate::sync_log::StoredOperation) -> Value {
    json!({
        "opId": record.op_id,
        "seq": record.seq,
        "actorId": record.actor_id,
        "protocolVersion": record.protocol_version,
        "logicalClock": record.logical_clock,
        "enqueuedAt": record.enqueued_at,
        "payload": record.payload,
    })
}

/// Handles one sync request against the durable log and the key courier.
pub fn handle(
    log: &SyncLog,
    courier: &KeyCourier,
    inbox: Option<&AccountInbox>,
    identity: &Identity,
    request: Request,
    limits: &Limits,
) -> Outcome {
    // Authorization is per room, and the room is the frame's own `board`. A
    // frame naming a room this connection never attached is refused before any
    // storage call and cannot be re-scoped: attaching is the only way in, and
    // attaching is an authenticated act. Copied out so the match below may move.
    let board = request.board().to_string();
    let board: &str = &board;
    let Some(access) = identity.access(board) else {
        return Outcome::only(error(board, "board_mismatch"));
    };
    // Per-action, not per-connection: the same socket may be an editor here and
    // a viewer elsewhere, so the role is read from this room's attachment.
    let editor = access.editor;
    // The author of anything this frame stores is the device *that room* was
    // admitted under. For a v2 connection, and for a v3 attach that named no
    // device, that is the connection's own device; for an attach that presented
    // its own key it is that key, which is the whole point of `deviceKeyId` on
    // the frame. Taken from the attachment, never from the request.
    let actor = identity.actor_for(board);
    match request {
        Request::Subscribe { after_seq, .. } => match log.sync_from(board, after_seq, limits.replay_batch) {
            Err(failure) => Outcome::only(error(board, code_for(&failure))),
            Ok(window) => {
                // A gap is a first-class answer, never an empty list: a client
                // that cannot be brought forward from where it is must know to
                // adopt a snapshot instead of believing it is up to date.
                let gap = window.gap.as_ref().map(|gap| match gap {
                    ReplayGap::Pruned { checkpoint_seq, checkpoint_epoch, snapshot_seq } => json!({
                        "reason": "snapshot_required",
                        "checkpointSeq": checkpoint_seq,
                        "checkpointEpoch": checkpoint_epoch,
                        "snapshotSeq": snapshot_seq,
                    }),
                    ReplayGap::Unavailable { oldest_retained } => json!({
                        "reason": "history_unavailable",
                        "oldestRetainedSeq": oldest_retained,
                    }),
                });
                let snapshot_required = matches!(window.gap, Some(ReplayGap::Pruned { .. }));
                let mut fields = vec![
                    ("operations", Value::Array(window.ops.iter().map(operation_json).collect())),
                    ("liveFromSeq", json!(window.live_from_seq)),
                    ("checkpointSeq", json!(window.checkpoint_seq)),
                    // Explicit completion: the client is live from here and not
                    // before, and it is the client that declares it applied the
                    // window, not the server that assumes it.
                    ("synced", json!(window.gap.is_none())),
                ];
                if let Some(gap) = gap {
                    fields.push(("gap", gap));
                }
                // A board with nothing in it has no gap, so `synced` is already
                // true above: an empty board is synchronized, not broken.
                Outcome::only(frame(if snapshot_required { "snapshotRequired" } else { "window" }, board, fields))
            }
        },
        Request::Submit { operations, .. } => {
            if !editor {
                // Invariant: a read-only client receives updates and never
                // publishes mutations.
                return Outcome::only(error(board, "read_only"));
            }
            if operations.is_empty() || operations.len() > limits.submit_batch {
                return Outcome::only(error(board, "batch_too_large"));
            }
            for operation in &operations {
                if operation.payload.len() > limits.operation_bytes {
                    return Outcome::only(error(board, "op_too_large"));
                }
            }
            let inputs: Vec<OperationInput> = operations
                .into_iter()
                .map(|operation| OperationInput {
                    op_id: operation.op_id,
                    // The author is who authenticated, never who claimed.
                    actor_id: actor.to_string(),
                    protocol_version: operation.protocol_version,
                    logical_clock: operation.logical_clock,
                    payload: operation.payload,
                })
                .collect();
            let receipts = match log.append(board, &inputs) {
                Ok(receipts) => receipts,
                Err(failure) => return Outcome::only(error(board, code_for(&failure))),
            };
            // Past this point every operation in the batch is durable: the
            // acknowledgment below may not be withheld, and the broadcast below
            // may not run before it.
            let mut results = Vec::with_capacity(receipts.len());
            let mut published = Vec::with_capacity(receipts.len());
            for (receipt, input) in receipts.iter().zip(inputs.iter()) {
                match receipt {
                    AppendReceipt::Accepted { seq } => {
                        results.push(json!({ "opId": input.op_id, "seq": seq, "duplicate": false }));
                        published.push(json!({
                            "type": FRAME_TYPE,
                            "action": "operation",
                            "board": board,
                            "opId": input.op_id,
                            "seq": seq,
                            "actorId": actor,
                            "protocolVersion": input.protocol_version,
                            "logicalClock": input.logical_clock,
                            "payload": input.payload,
                        }));
                    }
                    // A retry answers with the original sequence and is not
                    // rebroadcast: its effect was delivered when it first landed.
                    AppendReceipt::Duplicate { seq } => results.push(json!({ "opId": input.op_id, "seq": seq, "duplicate": true })),
                }
            }
            let high = published.last().and_then(|value| value["seq"].as_u64()).or_else(|| results.last().and_then(|value| value["seq"].as_u64()));
            let mut fields = vec![("results", Value::Array(results))];
            if let Some(high) = high {
                fields.push(("ackedSeq", json!(high)));
            }
            Outcome { replies: vec![frame("accepted", board, fields)], broadcast: published, inbox_broadcast: Vec::new() }
        }
        Request::Lease { lease_ms, .. } => {
            if !editor {
                return Outcome::only(error(board, "read_only"));
            }
            let lease_ms = lease_ms.unwrap_or(limits.lease_ms).clamp(1_000, limits.lease_max_ms);
            match log.acquire_lease(board, actor, lease_ms) {
                Ok(lease) => Outcome::only(frame(
                    "lease",
                    board,
                    vec![("holder", json!(lease.holder)), ("epoch", json!(lease.epoch)), ("expiresAt", json!(lease.expires_at))],
                )),
                Err(failure) => Outcome::only(error(board, code_for(&failure))),
            }
        }
        Request::Release { .. } => match log.release_lease(board, actor) {
            Ok(()) => Outcome::only(frame("released", board, Vec::new())),
            Err(failure) => Outcome::only(error(board, code_for(&failure))),
        },
        Request::Commit { epoch, seq, snapshot_seq, drive_etag, .. } => {
            if !editor {
                return Outcome::only(error(board, "read_only"));
            }
            if drive_etag.len() > limits.etag_bytes {
                return Outcome::only(error(board, "invalid_request"));
            }
            match log.commit_checkpoint(board, epoch, seq, snapshot_seq, &drive_etag, actor) {
                Ok(record) => Outcome::only(frame(
                    "committed",
                    board,
                    vec![
                        ("checkpointSeq", json!(record.seq)),
                        ("epoch", json!(record.epoch)),
                        ("snapshotSeq", json!(record.snapshot_seq)),
                        ("stale", json!(record.stale)),
                    ],
                )),
                // `lease_expired` tells the client the exact thing it needs to
                // know: its right to publish ended, so it must re-read what the
                // current checkpoint is and watermark-merge before trying again.
                Err(failure) => Outcome::only(error(board, code_for(&failure))),
            }
        }
        Request::Status { .. } => {
            let boards = log.boards().unwrap_or_default();
            let board_health = boards.into_iter().find(|health| health.board_id == board);
            let checkpoint = log.checkpoint(board).ok().flatten();
            let lease = log.lease(board).ok().flatten();
            Outcome::only(frame(
                "status",
                board,
                vec![
                    ("nextSeq", json!(board_health.as_ref().map(|health| health.next_seq - 1))),
                    ("oldestRetainedSeq", json!(board_health.as_ref().and_then(|health| health.oldest_retained_seq))),
                    ("retainedOperations", json!(board_health.as_ref().map(|health| health.retained_ops))),
                    ("checkpointSeq", json!(checkpoint.as_ref().map(|record| record.seq))),
                    ("snapshotSeq", json!(checkpoint.as_ref().map(|record| record.snapshot_seq))),
                    ("checkpointStale", json!(checkpoint.as_ref().map(|record| record.stale))),
                    ("leaseEpoch", json!(lease.as_ref().map(|lease| lease.epoch))),
                    ("leaseHolder", json!(lease.as_ref().map(|lease| lease.holder == actor))),
                    ("leaseExpiresAt", json!(lease.as_ref().map(|lease| lease.expires_at))),
                ],
            ))
        }
        // Key courier frames. The board check above is their authorization: they
        // are gated by admission like every other frame, but not by the writer
        // role, because unlike `submit`/`lease`/`commit` they mutate no
        // operation log — they move envelopes the server cannot open between
        // devices, and refusing a read-only device's frame would deny it the
        // board's content key without protecting anything. The author is the
        // authenticated device, never a field in the frame: that is what makes
        // `fetchKeyGrants` select a mailbox nobody else can read.
        Request::PublishDeviceKey { public_key, .. } => match courier.publish_device_key(board, actor, &public_key) {
            Ok(stored) => Outcome::only(frame("deviceKeyStored", board, vec![("stored", json!(stored))])),
            Err(failure) => Outcome::only(error(board, code_for_courier(&failure))),
        },
        Request::ListDeviceKeys { .. } => match courier.device_keys(board) {
            Ok(keys) => Outcome::only(frame(
                "deviceKeys",
                board,
                vec![(
                    "devices",
                    Value::Array(
                        keys.iter()
                            .map(|key| json!({"deviceKeyId": key.device_key_id, "publicKey": key.public_key}))
                            .collect(),
                    ),
                )],
            )),
            Err(failure) => Outcome::only(error(board, code_for_courier(&failure))),
        },
        Request::PublishKeyGrants { grants, .. } => {
            let inputs: Vec<KeyGrantInput> = grants
                .into_iter()
                .map(|offer| KeyGrantInput { to_device_key_id: offer.device_key_id, envelope: offer.envelope })
                .collect();
            match courier.publish_key_grants(board, actor, &inputs) {
                Ok(stored) => Outcome::only(frame("keyGrantsStored", board, vec![("stored", json!(stored))])),
                Err(failure) => Outcome::only(error(board, code_for_courier(&failure))),
            }
        }
        Request::FetchKeyGrants { .. } => match courier.key_grants_for(board, actor) {
            Ok(mail) => Outcome::only(frame(
                "keyGrants",
                board,
                vec![(
                    "grants",
                    Value::Array(
                        mail.iter()
                            .map(|row| json!({"fromDeviceKeyId": row.from_device_key_id, "envelope": row.envelope}))
                            .collect(),
                    ),
                )],
            )),
            Err(failure) => Outcome::only(error(board, code_for_courier(&failure))),
        },
        // Cross-account discovery. The sender's authorization is the board room
        // it already holds: `board` is that room, and `identity.board_ids` is the
        // **verified** board id from that room's signed manifest — so the board
        // this hint names is the one the admission proved, never one the frame
        // chose. A frame whose room carries no manifest (operator-grant mode)
        // therefore has nothing to vouch for it and is refused.
        Request::PublishAccountHint { to, hint_id, payload, .. } => {
            if !editor {
                // A viewer may read a board and never speak for it.
                return Outcome::only(error(board, "read_only"));
            }
            let Some(inbox) = inbox else { return Outcome::only(error(board, "inbox_disabled")) };
            let Some(board_id) = identity.board_ids.get(board) else {
                return Outcome::only(error(board, "unauthorized"));
            };
            // An account room is not a board. Without this, any device could
            // fan out from its own account room into every other account's
            // inbox, which is the one abuse this path must be immune to.
            if board_id.starts_with("account:") {
                return Outcome::only(error(board, "unauthorized"));
            }
            match inbox.publish(&to, board_id, actor, &hint_id, &payload) {
                Ok(receipt) => {
                    // The reply goes to the sender; the frame goes to every live
                    // session of the target account. A duplicate publishes
                    // nothing: its delivery happened on the first write, and
                    // repeating it would make a retry look like a second share.
                    let mut outcome = Outcome::only(frame(
                        "accountHintStored",
                        board,
                        vec![
                            ("to", json!(to)),
                            ("seq", json!(receipt.seq)),
                            ("duplicate", json!(receipt.duplicate)),
                        ],
                    ));
                    if !receipt.duplicate
                        && let Some(hint) = inbox
                            .hint(&to, receipt.seq)
                            .ok()
                            .flatten()
                    {
                        outcome.inbox_broadcast.push((to.clone(), hint.to_json(&to)));
                    }
                    outcome
                }
                Err(failure) => Outcome::only(error(board, code_for_inbox(&failure))),
            }
        }
        // The receiver's authorization is the account room it proved. The inbox
        // is derived from *that* room, so a frame naming an `account:<hash>`
        // room this connection is not attached to is refused by the
        // `board_mismatch` check above before it reaches here.
        Request::ReplayAccountHints { after_seq, .. } => {
            let Some(inbox) = inbox else { return Outcome::only(error(board, "inbox_disabled")) };
            let Some(account) = identity.board_ids.get(board).and_then(|id| id.strip_prefix("account:")) else {
                return Outcome::only(error(board, "unauthorized"));
            };
            match inbox.replay(account, after_seq) {
                Ok(replay) => {
                    let mut fields = vec![
                        ("inbox", json!(account)),
                        ("hints", Value::Array(replay.hints.iter().map(|hint| hint.to_json(account)).collect())),
                        ("highest", json!(replay.highest)),
                    ];
                    if let Some(oldest) = replay.oldest_retained {
                        fields.push(("oldestRetained", json!(oldest)));
                    }
                    Outcome::only(frame("accountHints", board, fields))
                }
                Err(failure) => Outcome::only(error(board, code_for_inbox(&failure))),
            }
        }
    }
}

/// Per-connection protocol limits, taken from the service's own budget so one
/// client cannot use the sync protocol to bypass the signaling limits.
#[derive(Clone, Debug)]
pub struct Limits {
    pub submit_batch: usize,
    pub operation_bytes: usize,
    pub replay_batch: usize,
    pub lease_ms: u64,
    pub lease_max_ms: u64,
    pub etag_bytes: usize,
    /// How many rooms one connection may hold attached at once.
    ///
    /// This is a fan-out bound, not an authorization one: every room still
    /// passes its own admission, and every room is bounded on its own by
    /// `crate::Limits::room_bytes_per_window` in the session loop. 32 covers a board
    /// plus the account channel plus a realistic working set with room to
    /// spare; the point is that the number is finite, so one socket cannot be
    /// used to hold every room on the service.
    pub rooms_per_connection: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            submit_batch: 256,
            operation_bytes: 64 * 1024,
            replay_batch: 512,
            lease_ms: crate::leader::LEASE_MS,
            lease_max_ms: 5 * crate::leader::LEASE_MS,
            etag_bytes: 1_024,
            rooms_per_connection: 32,
        }
    }
}

/// Live subscribers per board. Senders are the same bounded queues the session
/// loop already drains, so a client that cannot keep up is dropped by its own
/// slow-consumer handling rather than by the publisher waiting on it.
///
/// A second index — `by_inbox` — carries the same subscriber type keyed by
/// **account hash** instead of room id. It exists because the two kinds of
/// fan-out answer different questions: `by_board` is "who holds this room",
/// `by_inbox` is "which live sessions belong to this account", and the second
/// question has no room name in its answer for a *sender* that is not a member
/// of that account to derive. A session enters the inbox index when it is
/// admitted to an `account:<hash>` room and leaves when that room goes, so the
/// index is a projection of attachment state and can never disagree with it for
/// longer than one loop iteration.
#[derive(Default)]
pub struct Hub {
    by_board: HashMap<String, Vec<Subscriber>>,
    by_inbox: HashMap<String, Vec<Subscriber>>,
    /// session → the one inbox it belongs to. Kept beside the index rather than
    /// searched for, because "which account is this connection?" is asked on
    /// every replay and a scan of every inbox is how a lookup becomes a leak of
    /// timing information about *other* accounts.
    inbox_owners: HashMap<String, String>,
}

#[derive(Clone)]
struct Subscriber {
    session: String,
    sender: tokio::sync::mpsc::Sender<Value>,
}

impl Hub {
    /// Registers `sender` for `board`, replacing the same session's earlier
    /// subscription to it (a reconnect within one connection must not double
    /// deliver). How many boards one session may hold is the caller's check,
    /// because it is the caller that knows what the connection was admitted to;
    /// fan-out per board needs no cap here, since membership of the board's room
    /// is already capped by `Limits::peers_per_room`.
    pub fn subscribe(&mut self, board: &str, session: &str, sender: tokio::sync::mpsc::Sender<Value>) {
        let entries = self.by_board.entry(board.to_string()).or_default();
        entries.retain(|subscriber| subscriber.session != session);
        entries.push(Subscriber { session: session.to_string(), sender });
    }

    pub fn unsubscribe_session(&mut self, session: &str) {
        for subscribers in self.by_board.values_mut() {
            subscribers.retain(|subscriber| subscriber.session != session);
        }
        self.by_board.retain(|_, subscribers| !subscribers.is_empty());
        for subscribers in self.by_inbox.values_mut() {
            subscribers.retain(|subscriber| subscriber.session != session);
        }
        self.by_inbox.retain(|_, subscribers| !subscribers.is_empty());
        self.inbox_owners.remove(session);
    }

    /// Drops one session from one board, leaving its other attachments alone.
    /// This is what `detach` and a per-room authorization change call, and it is
    /// the difference between losing a room and losing the connection.
    pub fn unsubscribe(&mut self, board: &str, session: &str) {
        let Some(subscribers) = self.by_board.get_mut(board) else { return };
        subscribers.retain(|subscriber| subscriber.session != session);
        if subscribers.is_empty() {
            self.by_board.remove(board);
        }
    }

    /// Enters one session into the inbox index for one account hash.
    ///
    /// Called exactly when the session loop admits the connection to an
    /// `account:<hash>` room, and with the hash taken from that room's own
    /// admission — never from a frame. `unsubscribe_inbox` is its inverse and is
    /// called from the same place the room attachment is dropped, so the index
    /// cannot outlive the proof of account membership that put the session in it.
    pub fn subscribe_inbox(&mut self, inbox: &str, session: &str, sender: tokio::sync::mpsc::Sender<Value>) {
        // One session belongs to one account at a time. If it is re-admitted to
        // a different account room — which would itself be a protocol misuse, as
        // a device key has one account — the old membership is dropped rather
        // than letting one socket receive two accounts' mail.
        if let Some(previous) = self.inbox_owners.insert(session.to_string(), inbox.to_string())
            && previous != inbox
        {
            self.unsubscribe_inbox(&previous, session);
        }
        let entries = self.by_inbox.entry(inbox.to_string()).or_default();
        entries.retain(|subscriber| subscriber.session != session);
        entries.push(Subscriber { session: session.to_string(), sender });
    }

    /// Drops one session from one inbox, and from the owner map that makes a
    /// session's account discoverable at all.
    pub fn unsubscribe_inbox(&mut self, inbox: &str, session: &str) {
        if self.inbox_owners.get(session).is_some_and(|owner| owner == inbox) {
            self.inbox_owners.remove(session);
        }
        let Some(subscribers) = self.by_inbox.get_mut(inbox) else { return };
        subscribers.retain(|subscriber| subscriber.session != session);
        if subscribers.is_empty() {
            self.by_inbox.remove(inbox);
        }
    }

    /// Delivers one stored hint to **every** live session of the account.
    ///
    /// This is the whole point of the inbox: a hint written by a stranger to the
    /// account must reach every connected tab and worker of that account, not
    /// the one socket that happened to be admitted first. A session whose queue
    /// is full is skipped exactly as [`Self::publish`] skips it — its own slow
    /// consumer handling closes it, and the hint is still durable, so the next
    /// reconnect replays it.
    pub fn publish_inbox(&mut self, inbox: &str, value: &Value) {
        if let Some(subscribers) = self.by_inbox.get_mut(inbox) {
            subscribers.retain(|subscriber| subscriber.sender.try_send(value.clone()).is_ok());
        }
    }

    /// Publishes to every subscriber of the board. A subscriber whose queue is
    /// full is skipped: its session loop will close it as a slow consumer, and
    /// blocking the writer to wait for a straggler would let one dead tab stall
    /// a board.
    pub fn publish(&mut self, board: &str, value: &Value) {
        if let Some(subscribers) = self.by_board.get_mut(board) {
            subscribers.retain(|subscriber| subscriber.sender.try_send(value.clone()).is_ok());
        }
    }

    #[cfg(test)]
    fn subscribers(&self, board: &str) -> usize {
        self.by_board.get(board).map_or(0, Vec::len)
    }

    #[cfg(test)]
    fn inbox_subscribers(&self, inbox: &str) -> usize {
        self.by_inbox.get(inbox).map_or(0, Vec::len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_log::{SyncLog, SyncLogLimits};
    use serde_json::json;

    thread_local! {
        static CLOCK: std::cell::Cell<u64> = const { std::cell::Cell::new(1_000) };
    }
    fn now() -> u64 {
        CLOCK.with(|clock| clock.get())
    }

    fn store() -> (SyncLog, KeyCourier) {
        let log = SyncLog::in_memory(SyncLogLimits { retention_ms: 60_000, now_ms: now, ..Default::default() }).expect("open");
        let courier = KeyCourier::from_sync_log(&log).expect("open courier");
        (log, courier)
    }

    /// Every non-inbox test calls the same entry point the session loop does,
    /// with an inbox built on the same connection. The wrapper exists so the
    /// inbox stays a real argument of `handle` (it is not optional *in the
    /// protocol*, only in a build without a log) instead of a second code path.
    fn handle(log: &SyncLog, courier: &KeyCourier, identity: &Identity, request: Request, limits: &Limits) -> Outcome {
        let inbox = crate::account_inbox::AccountInbox::from_sync_log(log).expect("inbox");
        super::handle(log, courier, Some(&inbox), identity, request, limits)
    }
    fn identity(board: &str, actor: &str) -> Identity {
        Identity::new(actor, "session-1").with_room(board, RoomAccess::WRITER)
    }
    fn reader(board: &str, actor: &str) -> Identity {
        Identity::new(actor, "session-1").with_room(board, RoomAccess::READER)
    }
    fn submit(board: &str, ops: Vec<Value>) -> Request {
        Request::Submit { board: board.into(), operations: serde_json::from_value(ops.into()).expect("frames") }
    }
    fn submitted(op_id: &str) -> Value {
        json!({ "opId": op_id, "protocolVersion": 1, "logicalClock": 3, "payload": format!("sealed:{op_id}") })
    }
    fn accepted(outcome: &Outcome) -> Vec<Value> {
        outcome.replies[0]["results"].as_array().expect("results").clone()
    }

    #[test]
    fn refuses_any_frame_for_a_board_this_connection_is_not_admitted_to() {
        let (log, courier) = store();
        let writer = identity("board-a", "device-a");
        for request in [
            Request::Subscribe { board: "board-b".into(), after_seq: 0 },
            Request::Release { board: "board-b".into() },
            Request::Status { board: "board-b".into() },
            submit("board-b", vec![submitted("op-1")]),
        ] {
            let outcome = handle(&log, &courier, &writer, request, &Limits::default());
            assert_eq!(outcome.replies[0]["code"], "board_mismatch");
            assert!(outcome.broadcast.is_empty());
        }
        // The refused board was not even created, so it cannot accumulate state.
        assert!(log.boards().expect("boards").is_empty());
    }

    #[test]
    fn attributes_an_operation_to_the_authenticated_device_not_to_the_frame() {
        let (log, courier) = store();
        let outcome = handle(&log, &courier, &identity("board", "device-a"), submit("board", vec![submitted("op-1")]), &Limits::default());
        assert_eq!(accepted(&outcome)[0]["seq"], 1);
        assert_eq!(outcome.broadcast[0]["actorId"], "device-a");
        let window = handle(&log, &courier, &identity("board", "device-b"), Request::Subscribe { board: "board".into(), after_seq: 0 }, &Limits::default());
        assert_eq!(window.replies[0]["operations"][0]["actorId"], "device-a");
    }

    #[test]
    fn attributes_each_room_to_the_device_that_room_admitted() {
        let (log, courier) = store();
        // One connection, two rooms, two device keys — the shape a v3 attach with
        // its own `deviceKeyId` produces.
        let identity = Identity::new("device-connection", "session-1")
            .with_room("board-a", RoomAccess::WRITER)
            .with_actor("board-a", "device-alpha")
            .with_room("board-b", RoomAccess::WRITER)
            .with_actor("board-b", "device-beta");
        let first = handle(&log, &courier, &identity, submit("board-a", vec![submitted("op-a")]), &Limits::default());
        assert_eq!(first.broadcast[0]["actorId"], "device-alpha");
        let second = handle(&log, &courier, &identity, submit("board-b", vec![submitted("op-b")]), &Limits::default());
        assert_eq!(second.broadcast[0]["actorId"], "device-beta");
        // Durable attribution matches the broadcast, per room.
        let read = handle(&log, &courier, &identity, Request::Subscribe { board: "board-b".into(), after_seq: 0 }, &Limits::default());
        assert_eq!(read.replies[0]["operations"][0]["actorId"], "device-beta");
        // A room that recorded no actor still falls back to the connection's
        // device: that is the v2/pre-field behaviour, unchanged.
        let fallback = Identity::new("device-connection", "session-1").with_room("board-c", RoomAccess::WRITER);
        let third = handle(&log, &courier, &fallback, submit("board-c", vec![submitted("op-c")]), &Limits::default());
        assert_eq!(third.broadcast[0]["actorId"], "device-connection");
    }

    #[test]
    fn acknowledges_submissions_that_arrive_in_a_second_batch_as_duplicates() {
        let (log, courier) = store();
        let writer = identity("board", "device-a");
        let limits = Limits::default();
        handle(&log, &courier, &writer, submit("board", vec![submitted("op-1"), submitted("op-2")]), &limits);
        // The client timed out and resent the first operation with the second.
        let retry = handle(&log, &courier, &writer, submit("board", vec![submitted("op-1"), submitted("op-3")]), &limits);
        assert_eq!(accepted(&retry)[0]["duplicate"], json!(true));
        assert_eq!(accepted(&retry)[0]["seq"], 1);
        assert_eq!(accepted(&retry)[1]["duplicate"], json!(false));
        assert_eq!(accepted(&retry)[1]["seq"], 3);
        // Only the genuinely new operation is rebroadcast.
        assert_eq!(retry.broadcast.len(), 1);
        assert_eq!(retry.broadcast[0]["opId"], "op-3");
    }

    #[test]
    fn a_read_only_client_subscribes_and_is_refused_every_mutation() {
        let (log, courier) = store();
        let reader = reader("board", "device-viewer");
        let window = handle(&log, &courier, &reader, Request::Subscribe { board: "board".into(), after_seq: 0 }, &Limits::default());
        assert_eq!(window.replies[0]["action"], "window");
        assert_eq!(window.replies[0]["synced"], json!(true));
        for request in [
            submit("board", vec![submitted("op-1")]),
            Request::Lease { board: "board".into(), lease_ms: None },
            Request::Commit { board: "board".into(), epoch: 1, seq: 0, snapshot_seq: 1, drive_etag: "etag".into() },
        ] {
            assert_eq!(handle(&log, &courier, &reader, request, &Limits::default()).replies[0]["code"], "read_only");
        }
    }

    #[test]
    fn asks_for_a_snapshot_when_the_history_a_client_needs_is_gone() {
        let (log, courier) = store();
        let writer = identity("board", "device-a");
        let limits = Limits::default();
        handle(&log, &courier, &writer, submit("board", vec![submitted("op-1"), submitted("op-2")]), &limits);
        handle(&log, &courier, &writer, Request::Lease { board: "board".into(), lease_ms: None }, &limits);
        handle(&log, &courier, &writer, Request::Commit { board: "board".into(), epoch: 1, seq: 2, snapshot_seq: 7, drive_etag: "etag".into() }, &limits);
        CLOCK.with(|clock| clock.set(now() + 30 * 60_000));
        // Prune through the log's own path, then ask for the pruned range.
        log.prune("board").expect("prune");
        let outcome = handle(&log, &courier, &writer, Request::Subscribe { board: "board".into(), after_seq: 0 }, &Limits::default());
        assert_eq!(outcome.replies[0]["action"], "snapshotRequired");
        assert_eq!(outcome.replies[0]["synced"], json!(false));
        assert_eq!(outcome.replies[0]["gap"]["reason"], "snapshot_required");
        assert_eq!(outcome.replies[0]["gap"]["snapshotSeq"], 7);
        // A client holding the checkpoint is served normally instead.
        let current = handle(&log, &courier, &writer, Request::Subscribe { board: "board".into(), after_seq: 2 }, &Limits::default());
        assert_eq!(current.replies[0]["action"], "window");
        assert_eq!(current.replies[0]["synced"], json!(true));
    }

    #[test]
    fn lease_and_commit_round_trip_advances_the_checkpoint_the_client_reports() {
        let (log, courier) = store();
        let writer = identity("board", "device-a");
        let limits = Limits::default();
        handle(&log, &courier, &writer, submit("board", vec![submitted("op-1")]), &limits);
        let lease = handle(&log, &courier, &writer, Request::Lease { board: "board".into(), lease_ms: Some(30_000) }, &limits);
        assert_eq!(lease.replies[0]["action"], "lease");
        let epoch = lease.replies[0]["epoch"].as_u64().expect("epoch");
        assert!(lease.replies[0]["holder"].as_str().is_some_and(|holder| holder == "device-a"));
        let committed = handle(&log, &courier, &writer, Request::Commit { board: "board".into(), epoch, seq: 1, snapshot_seq: 1, drive_etag: "etag".into() }, &limits);
        assert_eq!(committed.replies[0]["action"], "committed");
        assert_eq!(committed.replies[0]["checkpointSeq"], 1);
        assert_eq!(committed.replies[0]["stale"], json!(false));
        // Repeating the commit under the same lease is recovery from a lost
        // response, so it answers rather than refusing — and it is idempotent:
        // the same evidence reports the same checkpoint.
        let retried = handle(&log, &courier, &writer, Request::Commit { board: "board".into(), epoch, seq: 1, snapshot_seq: 1, drive_etag: "etag".into() }, &limits);
        assert_eq!(retried.replies[0]["action"], "committed");
        assert_eq!(retried.replies[0]["checkpointSeq"], 1);
        assert_eq!(retried.replies[0]["stale"], json!(true)); // same generation, republished
        // Losing the lease is what ends the writer's right to publish.
        CLOCK.with(|clock| clock.set(now() + 60_000));
        let other = identity("board", "device-b");
        handle(&log, &courier, &other, Request::Lease { board: "board".into(), lease_ms: Some(30_000) }, &limits);
        let stale = handle(&log, &courier, &writer, Request::Commit { board: "board".into(), epoch, seq: 1, snapshot_seq: 3, drive_etag: "etag-3".into() }, &limits);
        assert_eq!(stale.replies[0]["code"], "lease_expired");
    }

    #[test]
    fn rejects_oversized_and_unsupported_envelopes_before_storing_anything() {
        let (log, courier) = store();
        let writer = identity("board", "device-a");
        let limits = Limits { operation_bytes: 32, ..Default::default() };
        let oversized = json!({ "opId": "op-1", "protocolVersion": 1, "payload": "x".repeat(33) });
        assert_eq!(handle(&log, &courier, &writer, submit("board", vec![oversized]), &limits).replies[0]["code"], "op_too_large");
        let unsupported = json!({ "opId": "op-2", "protocolVersion": 9, "payload": "x" });
        assert_eq!(handle(&log, &courier, &writer, submit("board", vec![unsupported]), &limits).replies[0]["code"], "protocol_version_unsupported");
        let empty: Vec<Value> = Vec::new();
        assert_eq!(handle(&log, &courier, &writer, submit("board", empty), &limits).replies[0]["code"], "batch_too_large");
        assert_eq!(log.boards().expect("boards").len(), 0);
    }

    #[test]
    fn reports_per_board_status_for_the_console() {
        let (log, courier) = store();
        let writer = identity("board", "device-a");
        let limits = Limits::default();
        handle(&log, &courier, &writer, submit("board", vec![submitted("op-1")]), &limits);
        let status = handle(&log, &courier, &writer, Request::Status { board: "board".into() }, &limits);
        assert_eq!(status.replies[0]["nextSeq"], 1);
        assert_eq!(status.replies[0]["retainedOperations"], 1);
        assert_eq!(status.replies[0]["leaseEpoch"], serde_json::Value::Null);
    }

    #[test]
    fn hub_delivers_to_subscribers_and_drops_the_ones_that_cannot_keep_up() {
        let mut hub = Hub::default();
        let (fast, mut fast_rx) = tokio::sync::mpsc::channel(4);
        let (slow, mut slow_rx) = tokio::sync::mpsc::channel(1);
        hub.subscribe("board", "fast", fast.clone());
        hub.subscribe("board", "slow", slow.clone());
        hub.subscribe("other", "fast", fast);
        assert_eq!(hub.subscribers("board"), 2);
        // Fill the slow queue first, exactly as a stalled socket would.
        assert!(slow.try_send(json!({"busy": true})).is_ok());
        hub.publish("board", &json!({"action": "operation", "seq": 1}));
        assert_eq!(fast_rx.try_recv().expect("fast frame")["seq"], 1);
        assert_eq!(slow_rx.try_recv().expect("queued")["busy"], true);
        assert_eq!(hub.subscribers("board"), 1); // the stalled subscriber is gone
        hub.publish("board", &json!({"action": "operation", "seq": 2}));
        assert_eq!(fast_rx.try_recv().expect("still live")["seq"], 2);
        // A disconnect removes that session everywhere, never another's.
        hub.unsubscribe_session("fast");
        assert_eq!(hub.subscribers("board"), 0);
        assert_eq!(hub.subscribers("other"), 0);
    }

    #[test]
    fn subscribing_twice_on_one_session_replaces_rather_than_duplicates() {
        let mut hub = Hub::default();
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        hub.subscribe("board", "session", sender.clone());
        hub.subscribe("board", "session", sender);
        assert_eq!(hub.subscribers("board"), 1);
        hub.publish("board", &json!({"seq": 1}));
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err()); // one copy, not two
    }

    #[test]
    fn a_full_submit_batch_is_refused_as_a_whole() {
        let (log, courier) = store();
        let writer = identity("board", "device-a");
        let operations = (0..3).map(|index| submitted(&format!("op-{index}"))).collect();
        let limits = Limits { submit_batch: 2, ..Default::default() };
        assert_eq!(handle(&log, &courier, &writer, submit("board", operations), &limits).replies[0]["code"], "batch_too_large");
        assert_eq!(log.boards().expect("boards").len(), 0);
    }

    #[test]
    fn every_frame_carries_the_board_so_a_client_can_route_replies() {
        let (log, courier) = store();
        let outcome = handle(&log, &courier, &identity("board", "device-a"), Request::Status { board: "board".into() }, &Limits::default());
        assert_eq!(outcome.replies[0]["type"], FRAME_TYPE);
        assert_eq!(outcome.replies[0]["board"], "board");
    }

    /// The four courier actions' wire names are the contract with the browser;
    /// parsing them from JSON (rather than constructing the enum) pins them,
    /// and the fetch proves the mailbox is keyed by the *authenticated* device:
    /// the sender wrote to `device-b` and cannot read it back.
    #[test]
    fn courier_actions_round_trip_their_wire_names_and_isolate_mailboxes() {
        let (log, courier) = store();
        let writer = identity("board", "device-a");
        let limits = Limits::default();
        let parse = |frame: Value| serde_json::from_value::<Request>(frame).expect("request");
        let outcome = handle(&log, &courier, &writer, parse(json!({"action": "publishDeviceKey", "board": "board", "publicKey": "aGVsbG8"})), &limits);
        assert_eq!(outcome.replies[0]["action"], "deviceKeyStored");
        assert_eq!(outcome.replies[0]["stored"], json!(true));
        let listed = handle(&log, &courier, &writer, parse(json!({"action": "listDeviceKeys", "board": "board"})), &limits);
        assert_eq!(listed.replies[0]["action"], "deviceKeys");
        assert_eq!(listed.replies[0]["devices"][0]["deviceKeyId"], "device-a");
        assert_eq!(listed.replies[0]["devices"][0]["publicKey"], "aGVsbG8");
        let stored = handle(
            &log,
            &courier,
            &writer,
            parse(json!({"action": "publishKeyGrants", "board": "board", "grants": [{"deviceKeyId": "device-b", "envelope": "Zm9yLWI"}]})),
            &limits,
        );
        assert_eq!(stored.replies[0]["action"], "keyGrantsStored");
        assert_eq!(stored.replies[0]["stored"], json!(1));
        // The sender's own fetch is empty: a grant addressed to `device-b`
        // lives in `device-b`'s mailbox only.
        let own = handle(&log, &courier, &writer, parse(json!({"action": "fetchKeyGrants", "board": "board"})), &limits);
        assert_eq!(own.replies[0]["action"], "keyGrants");
        assert_eq!(own.replies[0]["grants"].as_array().expect("grants").len(), 0);
        let recipient = identity("board", "device-b");
        let mail = handle(&log, &courier, &recipient, parse(json!({"action": "fetchKeyGrants", "board": "board"})), &limits);
        assert_eq!(mail.replies[0]["grants"][0]["fromDeviceKeyId"], "device-a");
        assert_eq!(mail.replies[0]["grants"][0]["envelope"], "Zm9yLWI");
    }

    const ACCOUNT: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    /// A sender holding `board-a` writes a hint into `ACCOUNT`'s inbox; the frame
    /// it produces is addressed by account, not by room, and names the board the
    /// *manifest* proved rather than a `board` field the frame chose.
    #[test]
    fn a_hint_names_the_verified_board_and_fans_out_by_account() {
        let (log, courier) = store();
        let inbox = crate::account_inbox::AccountInbox::from_sync_log(&log).expect("inbox");
        let room = "pboard-v2-authority-board-a";
        let sender = Identity::new("device-a", "session-1")
            .with_room(room, RoomAccess::WRITER)
            .with_board_id(room, "board-a");
        let outcome = super::handle(
            &log,
            &courier,
            Some(&inbox),
            &sender,
            Request::PublishAccountHint {
                board: room.into(),
                to: ACCOUNT.into(),
                hint_id: "hint-1".into(),
                payload: "aXYrY3Q".into(),
            },
            &Limits::default(),
        );
        assert_eq!(outcome.replies.len(), 1);
        assert_eq!(outcome.replies[0]["action"], "accountHintStored");
        assert_eq!(outcome.replies[0]["seq"], 1);
        assert_eq!(outcome.replies[0]["duplicate"], json!(false));
        assert!(outcome.broadcast.is_empty());
        assert_eq!(outcome.inbox_broadcast.len(), 1);
        let (target, hint) = &outcome.inbox_broadcast[0];
        assert_eq!(target, ACCOUNT);
        assert_eq!(hint["type"], "accountHint");
        assert_eq!(hint["inbox"], ACCOUNT);
        // The board is the one the admission proved, not one from the frame.
        assert_eq!(hint["board"], "board-a");
        assert_eq!(hint["sender"], "device-a");
        assert_eq!(hint["payload"], "aXYrY3Q");
        // A retry stores nothing and broadcasts nothing.
        let retry = super::handle(
            &log,
            &courier,
            Some(&inbox),
            &sender,
            Request::PublishAccountHint {
                board: room.into(),
                to: ACCOUNT.into(),
                hint_id: "hint-1".into(),
                payload: "aXYrY3Q".into(),
            },
            &Limits::default(),
        );
        assert_eq!(retry.replies[0]["duplicate"], json!(true));
        assert_eq!(retry.replies[0]["seq"], 1);
        assert!(retry.inbox_broadcast.is_empty());
    }

    /// The three ways a write is refused, and the fact that none of them stores
    /// anything: no verified board id (operator-grant mode), a room that is not
    /// a board (the account room), and a viewer seat.
    #[test]
    fn an_unauthorized_sender_stores_nothing() {
        let (log, courier) = store();
        let inbox = crate::account_inbox::AccountInbox::from_sync_log(&log).expect("inbox");
        let write = |board: &str| Request::PublishAccountHint {
            board: board.into(),
            to: ACCOUNT.into(),
            hint_id: "hint-1".into(),
            payload: "aXYrY3Q".into(),
        };
        // No verified board id: nothing vouches for the board this hint names.
        let anonymous = Identity::new("device-a", "session-1").with_room("room", RoomAccess::WRITER);
        let refused = super::handle(&log, &courier, Some(&inbox), &anonymous, write("room"), &Limits::default());
        assert_eq!(refused.replies[0]["code"], "unauthorized");
        assert!(refused.inbox_broadcast.is_empty());
        // An account room is not a board, even though its manifest proves an id.
        let account_room = Identity::new("device-a", "session-1")
            .with_room("room", RoomAccess::WRITER)
            .with_board_id("room", format!("account:{ACCOUNT}"));
        let refused = super::handle(&log, &courier, Some(&inbox), &account_room, write("room"), &Limits::default());
        assert_eq!(refused.replies[0]["code"], "unauthorized");
        assert!(refused.inbox_broadcast.is_empty());
        // A viewer may read a board and may not speak for it.
        let viewer = Identity::new("device-a", "session-1")
            .with_room("room", RoomAccess::READER)
            .with_board_id("room", "board-a");
        let refused = super::handle(&log, &courier, Some(&inbox), &viewer, write("room"), &Limits::default());
        assert_eq!(refused.replies[0]["code"], "read_only");
        assert!(refused.inbox_broadcast.is_empty());
        assert_eq!(inbox.replay(ACCOUNT, 0).expect("replay").hints.len(), 0);
    }

    /// A receiver reads only the inbox of the account room it is attached to:
    /// the account is derived from that room, so a frame naming a room the
    /// connection does not hold is refused before any read, and a connection
    /// holding account A cannot ask about account B at all.
    #[test]
    fn a_receiver_reads_only_its_own_account_and_a_foreign_room_is_refused() {
        let (log, courier) = store();
        let inbox = crate::account_inbox::AccountInbox::from_sync_log(&log).expect("inbox");
        let other = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let room = |hash: &str| format!("pboard-account-{hash}-order");
        // Seed both inboxes through the writer path.
        let writer = Identity::new("device-a", "session-1")
            .with_room("board-room", RoomAccess::WRITER)
            .with_board_id("board-room", "board-a");
        for target in [ACCOUNT, other] {
            super::handle(
                &log,
                &courier,
                Some(&inbox),
                &writer,
                Request::PublishAccountHint {
                    board: "board-room".into(),
                    to: target.into(),
                    hint_id: "hint-1".into(),
                    payload: "aXYrY3Q".into(),
                },
                &Limits::default(),
            );
        }
        let mine = Identity::new("device-a", "session-1")
            .with_room(room(ACCOUNT), RoomAccess::READER)
            .with_board_id(room(ACCOUNT), format!("account:{ACCOUNT}"));
        let read = |board: &str| Request::ReplayAccountHints { board: board.into(), after_seq: 0 };
        let own = super::handle(&log, &courier, Some(&inbox), &mine, read(&room(ACCOUNT)), &Limits::default());
        assert_eq!(own.replies[0]["action"], "accountHints");
        assert_eq!(own.replies[0]["inbox"], ACCOUNT);
        assert_eq!(own.replies[0]["hints"].as_array().expect("hints").len(), 1);
        assert_eq!(own.replies[0]["hints"][0]["inbox"], ACCOUNT);
        // Naming another account's room is a room this connection never
        // attached: refused, not re-scoped and not read.
        let foreign = super::handle(&log, &courier, Some(&inbox), &mine, read(&room(other)), &Limits::default());
        assert_eq!(foreign.replies[0]["code"], "board_mismatch");
        assert!(foreign.replies[0].get("hints").is_none());
        // Attaching that room but proving a *board* under it is not an account
        // either: a manifest that does not declare `account:<hash>` does not
        // make the connection an inbox reader.
        let impostor = Identity::new("device-a", "session-1")
            .with_room(room(ACCOUNT), RoomAccess::READER)
            .with_board_id(room(ACCOUNT), "board-a");
        let refused = super::handle(&log, &courier, Some(&inbox), &impostor, read(&room(ACCOUNT)), &Limits::default());
        assert_eq!(refused.replies[0]["code"], "unauthorized");
        assert!(refused.replies[0].get("hints").is_none());
    }

    /// Delivery reaches every attached session of the account, and the hub index
    /// follows attachments rather than connections: a session that detaches the
    /// account room leaves the fan-out at once.
    #[test]
    fn every_session_of_the_account_is_a_delivery_target_until_it_detaches() {
        let mut hub = Hub::default();
        let (one, mut one_rx) = tokio::sync::mpsc::channel(4);
        let (two, mut two_rx) = tokio::sync::mpsc::channel(4);
        let (stranger, mut stranger_rx) = tokio::sync::mpsc::channel(4);
        hub.subscribe_inbox(ACCOUNT, "session-one", one);
        hub.subscribe_inbox(ACCOUNT, "session-two", two);
        hub.subscribe_inbox(&"0".repeat(64), "session-stranger", stranger);
        assert_eq!(hub.inbox_subscribers(ACCOUNT), 2);
        hub.publish_inbox(ACCOUNT, &json!({"type": "accountHint", "seq": 1}));
        assert_eq!(one_rx.try_recv().expect("one")["seq"], 1);
        assert_eq!(two_rx.try_recv().expect("two")["seq"], 1);
        assert!(stranger_rx.try_recv().is_err());
        // Detaching the account room ends that session's mail, and only that one.
        hub.unsubscribe_inbox(ACCOUNT, "session-one");
        assert_eq!(hub.inbox_subscribers(ACCOUNT), 1);
        hub.publish_inbox(ACCOUNT, &json!({"type": "accountHint", "seq": 2}));
        assert!(one_rx.try_recv().is_err());
        assert_eq!(two_rx.try_recv().expect("two still live")["seq"], 2);
        // A disconnect clears every index including the inbox one.
        hub.unsubscribe_session("session-two");
        assert_eq!(hub.inbox_subscribers(ACCOUNT), 0);
        assert_eq!(hub.inbox_subscribers(&"0".repeat(64)), 1);
    }

    /// One socket belongs to one account at a time, so a re-admission to a
    /// different account room moves it instead of duplicating it.
    #[test]
    fn a_session_moves_between_inboxes_rather_than_belonging_to_two() {
        let mut hub = Hub::default();
        let other = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        hub.subscribe_inbox(ACCOUNT, "session", sender.clone());
        hub.subscribe_inbox(other, "session", sender);
        assert_eq!(hub.inbox_subscribers(ACCOUNT), 0);
        assert_eq!(hub.inbox_subscribers(other), 1);
        hub.publish_inbox(ACCOUNT, &json!({"seq": 1}));
        assert!(receiver.try_recv().is_err());
        hub.publish_inbox(other, &json!({"seq": 2}));
        assert_eq!(receiver.try_recv().expect("moved")["seq"], 2);
    }
}
