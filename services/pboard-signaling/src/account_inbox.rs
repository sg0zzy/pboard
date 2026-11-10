//! Per-account hint inbox: cross-account board discovery the relay can route
//! without ever learning an identity.
//!
//! ## The gap this closes
//!
//! Requirement 4.2 is "share a board with another Google account and that
//! account's connected sessions learn about it without a reload". Until now the
//! relay could not express it at all, for two independent reasons:
//!
//! * an `account:<hash>` room is writable **only** by members of that account's
//!   own manifest ([`crate::admission::AdmissionProof::verify`] binds the topic
//!   `pboard-account-<hash>-order` to the board id `account:<hash>`), so the
//!   owner of a board shared *with* somebody cannot enqueue anything into the
//!   other account's room; and
//! * the relay cannot enumerate another account's sessions, because the verified
//!   email is discarded when the service ticket is consumed, so a session is
//!   only ever `(room, deviceKeyId, expiry)`.
//!
//! This module adds the missing primitive: an inbox **addressed by account
//! hash** — SHA-256 of the lowercased verified email, which is already the
//! account-room scope (`google_enrollment.rs`, `account_binding_invalid`) — that
//! the relay can deliver into without storing the address it belongs to. No
//! email, no display name, no Drive token and no session→account map is kept
//! here; the hash is the only name the server ever holds, and the client
//! already uses it as the account room's scope.
//!
//! ## Who may do what, and why a client assertion is not enough
//!
//! * **Writing** requires the connection to hold the *board's own* room — the
//!   room derived from an authority-signed manifest that passed
//!   [`crate::admission`] for this device, in an `editor`/`owner` seat — and to
//!   name the board that room is bound to. Account rooms are refused as targets
//!   (`account:` board ids), because otherwise any device could fan out from its
//!   own account room into every other inbox. The caller of [`AccountInbox::publish`]
//!   is the session loop, which passes the device id it authenticated, never one
//!   read from the frame.
//! * **Reading** requires the connection to hold *its own* account room, proven
//!   exactly as today. There is deliberately **no target parameter on the read
//!   path**: [`AccountInbox::replay`] takes the inbox, and the session loop
//!   derives it from the attached account room. A connection cannot ask for
//!   another account's inbox because there is no field in which to ask.
//!
//! The relay is therefore a router, not an authority: it never becomes the
//! thing that decides a board is accessible. A hint is a **hint**. The receiving
//! client still verifies the board against Drive (its existing create-free
//! verified discovery path) before anything becomes interactive, so a forged,
//! replayed or stale hint can at most cause a verification attempt that fails.
//! Losing a hint degrades to Drive polling; it never produces wrong state.
//!
//! ## What the relay can and cannot guarantee
//!
//! It can guarantee: the writer held a live, verified authorization for the
//! board it named at the moment of the write; the receiver holds the account
//! room it is reading; and the payload is stored and replayed byte for byte.
//! It cannot guarantee that the named board is in fact shared with the target
//! account — that fact lives in Drive's ACL, which the relay has no credential
//! to read. A holder of *some* board can therefore post an inert hint into an
//! arbitrary hash's inbox; the bound on that is structural (below) and the
//! consequence is a failed Drive verification on the receiver, never access.
//!
//! ## Bounds
//!
//! * A hint payload is at most [`MAX_HINT_BYTES`] decoded (4 KiB): a board id
//!   and a short sealed hint, not a document.
//! * An inbox holds at most [`MAX_HINTS_PER_INBOX`] hints, so its storage is
//!   bounded at `64 × 4096 = 262 144 bytes = 256 KiB` by construction.
//! * At capacity the **oldest** hint is evicted first, deterministically by
//!   `seq`. Refusing instead would let one busy account wedge every future
//!   share notification until expiry; evicting keeps the newest hints
//!   deliverable and costs only a Drive poll for the dropped one.
//! * A hint expires [`HINT_TTL_MS`] after it was written, matching the
//!   operation log's seven-day window. Expired rows are removed lazily, when
//!   their inbox is next written or read; the count cap above means an inbox
//!   nobody touches still cannot grow.
//!
//! ## Durability and restart
//!
//! Rows live in the operation log's SQLite file (WAL, `synchronous = FULL`), on
//! the log's single connection, and are committed before the writer is
//! acknowledged — so an acknowledged hint survives the process being replaced,
//! and a receiver that reconnects asks for everything after the last `seq` it
//! applied. The tables are additive and presence-gated, exactly like
//! [`crate::key_courier`]'s, and deliberately **do not raise** the shared schema
//! counter: an older binary opens the same file unchanged and simply ignores
//! them, which is what makes the rollback in `PROTOCOL.md` safe.
use std::fmt;
use std::sync::{Arc, Mutex};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::sync_log::{SyncLog, valid_id};

/// Decoded size cap for one hint payload. The payload is sealed by the client
/// and never parsed here; the cap is what stops the inbox becoming a blob store.
pub const MAX_HINT_BYTES: usize = 4 * 1024;

/// Hints retained per inbox. See the module docs for the storage bound this
/// implies and for why eviction, not refusal, is the over-capacity answer.
pub const MAX_HINTS_PER_INBOX: usize = 64;

/// How long a hint stays retrievable. Same seven days as the operation log's
/// retention window, because both exist for "a device was away for a while".
pub const HINT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Distinct inboxes the service will hold at once.
///
/// This one cap, times [`MAX_HINTS_PER_INBOX`] times [`MAX_HINT_BYTES`], is the
/// whole storage bound: `1024 × 64 × 4 KiB = 256 MiB`, the same order as the
/// operation log's own 512 MiB global cap.
///
/// Over capacity the answer is **eviction, never refusal**, for every cap here.
/// A refusal looks safer — it "cannot delete somebody else's hint" — but it is
/// the dangerous choice: any device holding any board can create an inbox, so a
/// refusal at the cap lets one actor deny share-notification delivery to every
/// future account for the whole retention window. Eviction loses a hint, and a
/// lost hint degrades to Drive polling, which this design already allows. There
/// is no third option in which a hint is both bounded and never lost.
pub const MAX_INBOXES: u64 = 1024;

/// Expired rows removed per write. Bounds the work one request may do while
/// still letting untouched inboxes drain over time.
const EXPIRY_SWEEP: usize = 1024;

/// Longest hint id the client may choose. It is the idempotency key: a retry
/// with the same id answers the sequence it was first given and stores nothing.
const MAX_HINT_ID_BYTES: usize = 128;

/// The account hash is SHA-256 rendered as lowercase hex by
/// `google_enrollment`, so it is exactly 64 characters of `[0-9a-f]`. Requiring
/// that here means an "inbox" can never be a free-form string: there is no room
/// for an email, a path, or a second addressing scheme to creep in.
fn valid_inbox(inbox: &str) -> bool {
    inbox.len() == 64
        && inbox
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Caps are on *decoded* bytes, so the blob must actually be base64. The bytes
/// are never inspected: the original string is what is stored and replayed.
fn decode_bounded(value: &str, max: usize) -> bool {
    if value.is_empty() || value.len() > max.div_ceil(3) * 4 {
        return false;
    }
    [&URL_SAFE_NO_PAD, &STANDARD, &STANDARD_NO_PAD]
        .iter()
        .any(|engine| engine.decode(value).is_ok_and(|bytes| !bytes.is_empty() && bytes.len() <= max))
}

pub enum InboxError {
    /// A field was missing, oversized, outside the accepted charset, or a
    /// payload that is not base64 within [`MAX_HINT_BYTES`].
    Invalid(&'static str),
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for InboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "invalid: {reason}"),
            Self::Io(error) => write!(f, "io: {error}"),
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
        }
    }
}

impl fmt::Debug for InboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for InboxError {}
impl From<std::io::Error> for InboxError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<rusqlite::Error> for InboxError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// What a write stored, or the sequence an earlier identical write already got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub seq: u64,
    /// True when `(inbox, hintId)` was already present: the retry is answered
    /// with its original sequence and nothing new is delivered, so a client that
    /// lost the acknowledgment cannot cause a second notification.
    pub duplicate: bool,
}

/// One stored hint, as the wire carries it. `payload` is the client's sealed
/// blob, verbatim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxHint {
    pub seq: u64,
    pub board_id: String,
    pub hint_id: String,
    pub sender: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub payload: String,
}

impl InboxHint {
    /// The frame a subscriber of the account room receives, and the element of
    /// a replay answer: identical shape in both places, so a client has one
    /// parser and one apply path whether the hint arrived live or after a
    /// reconnect.
    pub fn to_json(&self, inbox: &str) -> Value {
        json!({
            "type": "accountHint",
            "inbox": inbox,
            "seq": self.seq,
            "board": self.board_id,
            "hintId": self.hint_id,
            "sender": self.sender,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "payload": self.payload,
        })
    }
}

/// The answer to a replay request. `highest` is the cursor a client keeps: ask
/// again with `afterSeq = highest` and nothing repeats.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Replay {
    pub hints: Vec<InboxHint>,
    /// The highest sequence this inbox has ever issued. A client keeps it as
    /// its cursor and never moves backwards.
    pub highest: u64,
    /// Lowest sequence still retrievable, or `None` when the inbox retains
    /// nothing. Reported rather than silently omitted, exactly like the
    /// operation log's `oldestRetainedSeq`: a client whose cursor is below it
    /// (or that holds a cursor at all while this is `None` and `highest` is
    /// above it) knows it missed hints to eviction or expiry and must reconcile
    /// against Drive. An empty `hints` list with `highest` ahead of the cursor
    /// is therefore never mistakable for "you are up to date".
    pub oldest_retained: Option<u64>,
}

/// A write, as the frame carries it. Unknown fields are tolerated (a newer
/// client is not an attack); every field this build uses is required.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishFrame {
    pub to: String,
    pub board: String,
    pub hint_id: String,
    pub payload: String,
}

/// A replay request. It names no inbox on purpose: the account is taken from
/// the room this connection attached, so there is no call shape in which one
/// account asks for another's mail.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFrame {
    #[serde(default)]
    pub after_seq: u64,
}

/// The inbox. Shares the operation log's connection, hence its one-writer
/// property and its WAL/`synchronous = FULL` durability.
pub struct AccountInbox {
    connection: Arc<Mutex<Connection>>,
    now_ms: fn() -> u64,
}

impl AccountInbox {
    /// Attaches to an opened operation log's database, creating the inbox
    /// tables when they are absent.
    pub fn from_sync_log(log: &SyncLog) -> Result<Self, InboxError> {
        let inbox = Self {
            connection: log.connection(),
            now_ms: crate::now_ms,
        };
        inbox.migrate()?;
        Ok(inbox)
    }

    /// Creates the tables if they are not there yet.
    ///
    /// Keyed on table presence, not on a new version row: the shared counter is
    /// a high-water mark that gates *refusing a file written by a newer build*,
    /// and raising it here would make every older binary refuse to open a file
    /// that is in fact readable by it. `CREATE TABLE IF NOT EXISTS` makes this
    /// step idempotent across restarts and across a rollback/roll-forward.
    fn migrate(&self) -> Result<(), InboxError> {
        let mut connection = self.connection.lock().expect("sync log mutex");
        let transaction = connection.transaction()?;
        let present: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('account_hint', 'account_hint_cursor')",
            [],
            |row| row.get(0),
        )?;
        if present < 2 {
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS account_hint (
                     inbox      TEXT NOT NULL,
                     seq        INTEGER NOT NULL,
                     hint_id    TEXT NOT NULL,
                     board_id   TEXT NOT NULL,
                     sender     TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     expires_at INTEGER NOT NULL,
                     payload    TEXT NOT NULL,
                     PRIMARY KEY (inbox, seq)
                 );
                 -- The idempotency key: a retry of a write whose acknowledgment
                 -- was lost must answer the first sequence, not store a second.
                 CREATE UNIQUE INDEX IF NOT EXISTS account_hint_by_id
                     ON account_hint (inbox, hint_id);
                 -- Expiry is swept globally; this index keeps that from being a
                 -- table scan.
                 CREATE INDEX IF NOT EXISTS account_hint_by_expiry
                     ON account_hint (expires_at);
                 -- One row per inbox: the last sequence it issued and when it was
                 -- last written. `lastSeq` is what a replay reports as `highest`,
                 -- and it is per inbox because a brand-new inbox has issued
                 -- nothing and must say so rather than inherit the global clock's
                 -- current value. Absent row = never written = `highest` 0.
                 CREATE TABLE IF NOT EXISTS account_hint_cursor (
                     inbox      TEXT PRIMARY KEY,
                     last_seq   INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );
                 -- The global sequence clock. One counter for every inbox, which
                 -- is what makes an *evicted and re-created* inbox safe: its next
                 -- hint still gets a sequence above anything it ever issued, so a
                 -- client holding a cursor from before the eviction receives the
                 -- new hints instead of silently skipping them. A per-inbox
                 -- counter would have to be reset with the row, and a reset is
                 -- exactly that silent skip.
                 CREATE TABLE IF NOT EXISTS account_hint_clock (
                     id       INTEGER PRIMARY KEY CHECK (id = 1),
                     next_seq INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO account_hint_clock (id, next_seq) VALUES (1, 1);
                 -- Service-wide row budget and least-recently-written eviction
                 -- both count rows and reach the oldest first.
                 CREATE INDEX IF NOT EXISTS account_hint_by_created
                     ON account_hint (created_at);",
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Stores one hint for one inbox and returns the sequence it was given.
    ///
    /// `sender` is the device the *connection* authenticated; the caller never
    /// passes a frame-supplied value. Sequence allocation, deduplication,
    /// expiry cleanup and capacity eviction all happen inside one
    /// `BEGIN IMMEDIATE` transaction, so the receipt is the complete truth about
    /// what this call persisted and the acknowledgment may follow it
    /// unconditionally.
    pub fn publish(
        &self,
        inbox: &str,
        board: &str,
        sender: &str,
        hint_id: &str,
        payload: &str,
    ) -> Result<Receipt, InboxError> {
        if !valid_inbox(inbox) {
            return Err(InboxError::Invalid("inbox"));
        }
        // A hint must name a real board. An account id here would let a device
        // fan out from its own account room into every other inbox, which is the
        // one thing this path must not be usable for.
        if !valid_id(board, 256) || board.starts_with("account:") {
            return Err(InboxError::Invalid("board"));
        }
        if !valid_id(sender, 256) {
            return Err(InboxError::Invalid("sender"));
        }
        if !valid_id(hint_id, MAX_HINT_ID_BYTES) {
            return Err(InboxError::Invalid("hint id"));
        }
        if !decode_bounded(payload, MAX_HINT_BYTES) {
            return Err(InboxError::Invalid("payload"));
        }
        let now = (self.now_ms)();
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let existing: Option<i64> = transaction
            .query_row(
                "SELECT seq FROM account_hint WHERE inbox = ?1 AND hint_id = ?2",
                params![inbox, hint_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(seq) = existing {
            // Nothing is written and nothing is rebroadcast: the first write's
            // delivery already happened.
            return Ok(Receipt { seq: seq as u64, duplicate: true });
        }
        // Expired rows are removed service-wide before the budget is measured, so
        // a busy service is measured on what it actually retains rather than on
        // history retention has already released. Bounded rows per call: one
        // request must not become a full-table delete.
        transaction.execute(
            "DELETE FROM account_hint WHERE seq IN
                 (SELECT seq FROM account_hint WHERE expires_at <= ?1 LIMIT ?2)",
            params![now as i64, EXPIRY_SWEEP as i64],
        )?;
        let inboxes: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM account_hint_cursor",
            [],
            |row| row.get(0),
        )?;
        let exists: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM account_hint_cursor WHERE inbox = ?1",
            params![inbox],
            |row| row.get(0),
        )?;
        if exists == 0 && inboxes as u64 >= MAX_INBOXES {
            // A new inbox at the cap. Evict the least recently written one whole
            // — its cursor row and its hints — so a legitimate share still lands
            // and no actor can hold the cap by never writing again. Tie-break on
            // the hash so the choice is deterministic and reviewable; an inbox
            // with no hints has the oldest possible timestamp and goes first.
            let evicted: Option<String> = transaction
                .query_row(
                    "SELECT c.inbox FROM account_hint_cursor c
                     LEFT JOIN (SELECT inbox AS name, MAX(created_at) AS last
                                FROM account_hint GROUP BY inbox) h
                         ON h.name = c.inbox
                     WHERE c.inbox <> ?1
                     ORDER BY COALESCE(h.last, 0) ASC, c.inbox ASC
                     LIMIT 1",
                    params![inbox],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(evicted) = evicted {
                tracing::info!(event = "account_inbox_evicted", "inbox evicted at capacity");
                transaction.execute("DELETE FROM account_hint WHERE inbox = ?1", params![evicted])?;
                transaction.execute("DELETE FROM account_hint_cursor WHERE inbox = ?1", params![evicted])?;
            }
        }
        // One global counter: strictly increasing across evictions, across
        // service-wide pressure, and across an inbox being dropped and later
        // re-created. That is what keeps a client's stored cursor meaningful.
        let seq: i64 = transaction.query_row(
            "SELECT next_seq FROM account_hint_clock WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE account_hint_clock SET next_seq = ?1 WHERE id = 1",
            params![seq + 1],
        )?;
        transaction.execute(
            "DELETE FROM account_hint WHERE inbox = ?1 AND expires_at <= ?2",
            params![inbox, now as i64],
        )?;
        let live: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM account_hint WHERE inbox = ?1",
            params![inbox],
            |row| row.get(0),
        )?;
        // Deterministic over-capacity answer: the oldest sequence goes first, so
        // the newest hint is always deliverable and the eviction order is a
        // function of `seq` alone, not of arrival timing or of what a sweeper
        // happened to reach.
        let evict = (live + 1).saturating_sub(MAX_HINTS_PER_INBOX as i64);
        if evict > 0 {
            transaction.execute(
                "DELETE FROM account_hint WHERE seq IN
                     (SELECT seq FROM account_hint WHERE inbox = ?1 ORDER BY seq ASC LIMIT ?2)",
                params![inbox, evict],
            )?;
        }
        transaction.execute(
            "INSERT INTO account_hint (inbox, seq, hint_id, board_id, sender, created_at, expires_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                inbox,
                seq,
                hint_id,
                board,
                sender,
                now as i64,
                (now.saturating_add(HINT_TTL_MS)) as i64,
                payload
            ],
        )?;
        transaction.execute(
            "INSERT INTO account_hint_cursor (inbox, last_seq, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (inbox) DO UPDATE SET last_seq = ?2, updated_at = ?3",
            params![inbox, seq, now as i64],
        )?;
        transaction.commit()?;
        Ok(Receipt { seq: seq as u64, duplicate: false })
    }

    /// One stored hint by sequence, for the live fan-out after a write.
    ///
    /// The write path needs the row it just committed to build the frame — the
    /// alternative is for `publish` to return the whole row, which would make
    /// the receipt a copy of the payload on every retry — and reading it back
    /// through the same accessor a replay uses means the live frame and the
    /// replayed frame can never disagree in shape or in `expiresAt`.
    pub fn hint(&self, inbox: &str, seq: u64) -> Result<Option<InboxHint>, InboxError> {
        if !valid_inbox(inbox) {
            return Err(InboxError::Invalid("inbox"));
        }
        let guard = self.connection.lock().expect("sync log mutex");
        guard
            .query_row(
                "SELECT seq, board_id, hint_id, sender, created_at, expires_at, payload
                 FROM account_hint WHERE inbox = ?1 AND seq = ?2",
                params![inbox, seq as i64],
                |row| {
                    Ok(InboxHint {
                        seq: row.get::<_, i64>(0)? as u64,
                        board_id: row.get(1)?,
                        hint_id: row.get(2)?,
                        sender: row.get(3)?,
                        created_at: row.get::<_, i64>(4)? as u64,
                        expires_at: row.get::<_, i64>(5)? as u64,
                        payload: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(InboxError::from)
    }

    /// Everything after `after_seq`, oldest first, plus the cursor to keep.
    ///
    /// Expired rows are removed first, so an answer never contains a hint the
    /// TTL already withdrew. When the requested cursor is older than the oldest
    /// retained row the answer says so (`truncated_before`) rather than looking
    /// like a complete delta — a receiver that missed an eviction must
    /// reconcile against Drive, and silence would tell it the opposite.
    pub fn replay(&self, inbox: &str, after_seq: u64) -> Result<Replay, InboxError> {
        if !valid_inbox(inbox) {
            return Err(InboxError::Invalid("inbox"));
        }
        let now = (self.now_ms)();
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        transaction.execute(
            "DELETE FROM account_hint WHERE inbox = ?1 AND expires_at <= ?2",
            params![inbox, now as i64],
        )?;
        let last: Option<i64> = transaction
            .query_row(
                "SELECT last_seq FROM account_hint_cursor WHERE inbox = ?1",
                params![inbox],
                |row| row.get(0),
            )
            .optional()?;
        let highest = last.unwrap_or(0).max(0) as u64;
        let oldest_retained: Option<u64> = transaction
            .query_row(
                "SELECT MIN(seq) FROM account_hint WHERE inbox = ?1",
                params![inbox],
                |row| row.get::<_, Option<i64>>(0),
            )?
            .map(|seq| seq as u64);
        let hints = {
            let mut statement = transaction.prepare(
                "SELECT seq, board_id, hint_id, sender, created_at, expires_at, payload
                 FROM account_hint WHERE inbox = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
            )?;
            let rows = statement.query_map(
                params![inbox, after_seq as i64, MAX_HINTS_PER_INBOX as i64],
                |row| {
                    Ok(InboxHint {
                        seq: row.get::<_, i64>(0)? as u64,
                        board_id: row.get(1)?,
                        hint_id: row.get(2)?,
                        sender: row.get(3)?,
                        created_at: row.get::<_, i64>(4)? as u64,
                        expires_at: row.get::<_, i64>(5)? as u64,
                        payload: row.get(6)?,
                    })
                },
            )?;
            let mut collected = Vec::new();
            for row in rows {
                collected.push(row?);
            }
            collected
        };
        transaction.commit()?;
        Ok(Replay { hints, highest, oldest_retained })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        static CLOCK: std::cell::Cell<u64> = const { std::cell::Cell::new(1_000_000) };
    }
    fn now() -> u64 {
        CLOCK.with(|clock| clock.get())
    }

    fn inbox() -> AccountInbox {
        let log = SyncLog::in_memory(Default::default()).expect("log");
        let mut inbox = AccountInbox::from_sync_log(&log).expect("inbox");
        inbox.now_ms = now;
        inbox
    }

    fn hash(label: &str) -> String {
        // Any 64 lowercase hex characters is a well-formed account hash; the
        // module deliberately knows nothing else about it.
        format!("{:0>64}", label).chars().take(64).collect()
    }
    fn sealed(label: &str) -> String {
        URL_SAFE_NO_PAD.encode(format!("iv+ct:{label}"))
    }

    const ONE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TWO: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn a_write_is_acknowledged_once_and_a_retry_answers_the_same_sequence() {
        let inbox = inbox();
        let first = inbox.publish(ONE, "board-a", "device-a", "hint-1", &sealed("one")).expect("publish");
        assert_eq!(first, Receipt { seq: 1, duplicate: false });
        let retry = inbox.publish(ONE, "board-a", "device-a", "hint-1", &sealed("one")).expect("retry");
        assert_eq!(retry, Receipt { seq: 1, duplicate: true });
        let replay = inbox.replay(ONE, 0).expect("replay");
        assert_eq!(replay.hints.len(), 1);
        assert_eq!(replay.highest, 1);
        assert_eq!(replay.oldest_retained, Some(1));
        assert_eq!(replay.hints[0].payload, sealed("one"));
        assert_eq!(replay.hints[0].board_id, "board-a");
        assert_eq!(replay.hints[0].sender, "device-a");
    }

    #[test]
    fn inboxes_are_isolated_from_each_other() {
        let inbox = inbox();
        inbox.publish(ONE, "board-a", "device-a", "hint-1", &sealed("one")).expect("one");
        inbox.publish(TWO, "board-b", "device-a", "hint-2", &sealed("two")).expect("two");
        let first = inbox.replay(ONE, 0).expect("first");
        assert_eq!(first.hints.len(), 1);
        assert_eq!(first.hints[0].payload, sealed("one"));
        assert_eq!(first.hints[0].board_id, "board-a");
        assert_eq!(first.highest, first.hints[0].seq);
        let second = inbox.replay(TWO, 0).expect("second");
        assert_eq!(second.hints.len(), 1);
        assert_eq!(second.hints[0].payload, sealed("two"));
        assert_eq!(second.hints[0].board_id, "board-b");
        assert_eq!(second.highest, second.hints[0].seq);
        // Sequences are global and monotonic, so each inbox's cursor is still a
        // dense-enough statement about *its* history, and a cursor from one
        // inbox never selects rows in the other.
        assert!(second.hints[0].seq > first.hints[0].seq);
        assert!(inbox.replay(ONE, second.hints[0].seq - 1).expect("one after two").hints.is_empty());
        assert!(inbox.replay(&hash("c"), 0).expect("empty").hints.is_empty());
    }

    #[test]
    fn capacity_evicts_the_oldest_hint_first_and_never_exceeds_the_cap() {
        let inbox = inbox();
        for index in 0..(MAX_HINTS_PER_INBOX as u64 + 3) {
            inbox
                .publish(ONE, "board-a", "device-a", &format!("hint-{index}"), &sealed("x"))
                .expect("publish");
        }
        let replay = inbox.replay(ONE, 0).expect("replay");
        assert_eq!(replay.hints.len(), MAX_HINTS_PER_INBOX);
        // The first three writes are the three that were evicted.
        assert_eq!(replay.hints[0].seq, 4);
        // `MAX_HINTS_PER_INBOX + 3` writes: the first three (seq 1-3) were
        // evicted, the newest (seq 67) is retained.
        let newest = MAX_HINTS_PER_INBOX as u64 + 3;
        assert_eq!(replay.hints[MAX_HINTS_PER_INBOX - 1].seq, newest);
        // The lowest sequence still retrievable is reported, so a client holding
        // an older cursor learns it lost hints instead of being handed a delta
        // that looks complete.
        assert_eq!(replay.oldest_retained, Some(4));
        assert_eq!(replay.highest, newest);
        // The cursor floor is a fact about retention, not about the request: the
        // same notice is reported whatever `afterSeq` was asked for.
        assert_eq!(inbox.replay(ONE, 3).expect("behind").oldest_retained, Some(4));
        assert_eq!(inbox.replay(ONE, 4).expect("current").oldest_retained, Some(4));
    }

    #[test]
    fn a_hint_expires_after_the_retention_window_and_leaves_nothing_behind() {
        let inbox = inbox();
        let written = inbox.publish(ONE, "board-a", "device-a", "hint-1", &sealed("one")).expect("publish");
        assert_eq!(written.seq, 1);
        assert_eq!(inbox.replay(ONE, 0).expect("live").hints[0].expires_at, now() + HINT_TTL_MS);
        CLOCK.with(|clock| clock.set(now() + HINT_TTL_MS + 1));
        let expired = inbox.replay(ONE, 0).expect("expired");
        assert!(expired.hints.is_empty());
        assert_eq!(expired.oldest_retained, None);
        // The cursor does not move backwards: a client that already applied
        // sequence 1 is not told to apply 1 again, and one that had not been
        // connected sees `highest` ahead of its cursor with nothing retained —
        // the signal to reconcile against Drive.
        assert_eq!(expired.highest, 1);
    }

    #[test]
    fn oversized_malformed_and_account_scoped_writes_are_refused_before_storage() {
        let inbox = inbox();
        let huge = URL_SAFE_NO_PAD.encode(vec![7u8; MAX_HINT_BYTES + 1]);
        for (inbox_id, board, hint, payload) in [
            (ONE, "board-a", "hint-1", huge.as_str()),                // payload over cap
            (ONE, "board-a", "hint-1", "not base64!"),                // not base64
            (ONE, "board-a", "hint-1", ""),                           // empty
            (ONE, "account:abc", "hint-1", "AAAA"),                   // account room as a board
            (ONE, "board-a", &"x".repeat(MAX_HINT_ID_BYTES + 1), "AAAA"), // id over cap
            ("not-a-hash", "board-a", "hint-1", "AAAA"),              // not a hash
            (ONE, "bad board!", "hint-1", "AAAA"),                    // board charset
        ] {
            assert!(
                inbox.publish(inbox_id, board, "device-a", hint, payload).is_err(),
                "accepted {inbox_id}/{board}/{hint}"
            );
        }
        assert!(inbox.replay(ONE, 0).expect("replay").hints.is_empty());
    }

    /// The restart case: a durable file is reopened by a fresh [`AccountInbox`],
    /// and the undelivered hint plus its cursor are both still there. This is
    /// what "a reconnecting receiver gets what it missed" rests on.
    #[test]
    fn a_restart_preserves_undelivered_hints_and_their_cursor() {
        let directory = std::env::temp_dir().join(format!(
            "pboard-inbox-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("directory");
        let path = directory.join("sync-log.db");
        {
            let log = SyncLog::open(&path, Default::default()).expect("log");
            let mut inbox = AccountInbox::from_sync_log(&log).expect("inbox");
            inbox.now_ms = now;
            inbox.publish(ONE, "board-a", "device-a", "hint-1", &sealed("one")).expect("first");
            inbox.publish(ONE, "board-a", "device-a", "hint-2", &sealed("two")).expect("second");
            // The receiver saw sequence 1 before the process went away.
            assert_eq!(inbox.replay(ONE, 0).expect("live").highest, 2);
        }
        let log = SyncLog::open(&path, Default::default()).expect("reopen");
        let mut inbox = AccountInbox::from_sync_log(&log).expect("reopen inbox");
        inbox.now_ms = now;
        let replay = inbox.replay(ONE, 1).expect("replay");
        assert_eq!(replay.highest, 2);
        assert_eq!(replay.oldest_retained, Some(1));
        assert_eq!(replay.hints.len(), 1);
        assert_eq!(replay.hints[0].seq, 2);
        assert_eq!(replay.hints[0].payload, sealed("two"));
        // A re-send of the first hint after the restart is still a duplicate,
        // so the receiver does not get a second notification for it.
        assert_eq!(
            inbox.publish(ONE, "board-a", "device-a", "hint-1", &sealed("one")).expect("retry"),
            Receipt { seq: 1, duplicate: true }
        );
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// Service-wide capacity evicts rather than refusing, so one actor cannot
    /// deny delivery to everybody else by holding the cap.
    ///
    /// The property that matters is the one a *client* sees: an inbox that is
    /// evicted and later written again continues the sequence above anything it
    /// issued before, so its stored cursor is still meaningful and it is never
    /// silently skipped.
    #[test]
    fn a_full_service_evicts_the_least_recently_written_inbox_instead_of_refusing() {
        let inbox = inbox();
        // Seed to the inbox cap directly: the point under test is the eviction
        // rule, not how the rows got there.
        {
            let connection = inbox.connection.lock().expect("connection");
            for index in 0..(MAX_INBOXES - 1) {
                connection
                    .execute(
                        "INSERT INTO account_hint_cursor (inbox, last_seq, updated_at) VALUES (?1, 0, ?2)",
                        params![format!("{index:064x}"), now() as i64],
                    )
                    .expect("seed");
            }
        }
        // The last free slot goes to the inbox this test then fills, so the next
        // new one is the thousand-and-first and must displace somebody.
        let mine = "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe";
        inbox.publish(mine, "board-a", "device-a", "hint-mine", &sealed("mine")).expect("mine");
        assert_eq!(inbox.replay(mine, 0).expect("mine").highest, 1);
        // A write to a brand-new inbox is *accepted*: the least recently written
        // inbox is dropped whole and the new one takes its place.
        let newcomer = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let receipt = inbox.publish(newcomer, "board-a", "device-a", "hint-new", &sealed("new")).expect("accepted");
        assert!(!receipt.duplicate);
        // Exactly one inbox was displaced, so the count is unchanged...
        let cursors: i64 = inbox
            .connection
            .lock()
            .expect("connection")
            .query_row("SELECT COUNT(*) FROM account_hint_cursor", [], |row| row.get(0))
            .expect("count");
        assert_eq!(cursors as u64, MAX_INBOXES);
        // ...and the inbox that was dropped is one of the seeded, never-written
        // ones, not the recipient above.
        assert_eq!(inbox.replay(mine, 0).expect("mine survives").hints.len(), 1);
        assert_eq!(inbox.replay(newcomer, 0).expect("new").hints.len(), 1);
        // The evicted inbox starts above its own history when it comes back,
        // because the sequence counter is global and monotonic.
        let returning = "0000000000000000000000000000000000000000000000000000000000000000";
        let again = inbox.publish(returning, "board-a", "device-a", "hint-later", &sealed("later")).expect("re-created");
        assert!(again.seq > receipt.seq, "a re-created inbox must not reuse a sequence: {again:?} after {receipt:?}");
    }
}
