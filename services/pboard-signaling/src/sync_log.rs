//! Durable per-board operation log (Sync v3).
//!
//! This is the service's only copy of an operation between "a client submitted
//! it" and "a browser published a Drive snapshot that provably contains it".
//! The older [`crate::op_buffer`] kept a hand-rolled append-only journal; this
//! module moves the same guarantees into SQLite (WAL) so that sequence
//! allocation, deduplication, replay, checkpoint advancement and pruning are
//! each one indexed query instead of an in-memory scan, and so the backup story
//! is a file copy plus a WAL checkpoint rather than a bespoke format.
//!
//! Invariants this module is responsible for, and where they live:
//!
//! * **An acknowledged operation is durable.** Every append commits its SQLite
//!   transaction with `synchronous = FULL` before the caller may acknowledge,
//!   so an ack survives `kill -9` and a power loss. Callers acknowledge the
//!   return value, never the intent to persist.
//! * **Stable identity, no duplicates.** `(board_id, op_id)` is unique and is
//!   consulted *before* a sequence is consumed, so a retry of an already
//!   accepted operation returns the sequence it was first given and allocates
//!   nothing. `AppendReceipt::Duplicate` is how the caller learns that.
//! * **Per-board monotonic sequence.** `board.next_seq` is assigned inside the
//!   same `BEGIN IMMEDIATE` transaction as the insert, so two concurrent
//!   submitters cannot receive the same sequence or leave a hole behind.
//! * **Replay never silently skips.** [`SyncLog::sync_from`] returns the
//!   operations after a sequence *and* the sequence a live subscription must
//!   start from, read in one transaction; if the requested point predates both
//!   the retained log and the checkpoint, it reports a gap instead of returning
//!   an empty list.
//! * **Pruning cannot destroy the only copy.** Only operations at or below the
//!   checkpoint sequence — i.e. inside a snapshot the writer committed as
//!   published — are eligible, and only after the retention window. The
//!   commit's evidence is validated into a typed [`PublicationReceipt`] at
//!   write time; prune reads *that record*, never the free-form string it came
//!   in on, and refuses any checkpoint that did not come out of this path.
//! * **Evidence records an assertion, not a verification.** The relay holds no
//!   Drive credential, so it cannot confirm that the file named by a commit
//!   exists, is readable, or contains `seq`. What it can do — and does — is
//!   refuse an absent or malformed receipt, and only ever prune behind a
//!   checkpoint its own lease-holding writer accepted. The residual risk is
//!   closed by client ordering (upload, then commit), documented in
//!   `PROTOCOL.md`, not by a server-side check that cannot exist.
//! * **A stale lease cannot overwrite.** Checkpoint advancement is refused when
//!   the fencing epoch is older than the board's current lease epoch.
//!
//! Deliberate non-responsibility: the payload is an opaque string. The server
//! orders, stores and relays operations; it never interprets them. Ordering is
//! the sequence, and the client-side `logical_clock` is carried for
//! diagnostics only — wall-clock and client clocks never decide precedence.
use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

/// Highest operation-envelope protocol version this build understands.
pub const SUPPORTED_PROTOCOL_VERSION: u32 = 1;

/// Highest database schema version this build can open. Version 1 is the
/// operation log created by [`SyncLog::migrate`]; version 2 belongs to
/// [`crate::key_courier`], whose tables deliberately live in this same file so
/// one connection and one `BEGIN IMMEDIATE` still serialise every writer in the
/// service; version 3 is the retention schema — the typed publication receipt
/// on each checkpoint and the per-segment coverage times that
/// [`SyncLog::prune`] measures retention from; version 4 records migration
/// fences. Opening a file with a newer
/// version than this is refused rather than guessed at, which is why the
/// number is one shared constant and not one per module.
pub const SUPPORTED_SCHEMA_VERSION: i64 = 4;

/// Longest publication evidence a commit may carry, matching the service-side
/// frame limit. Evidence is a file id, never free-form text.
pub const MAX_EVIDENCE_BYTES: usize = 1_024;

/// Bounds on the Drive file id a publication receipt asserts. A Drive id is
/// URL-safe base64; four bytes is the floor the protocol's own fixtures use,
/// and the character set is what actually rejects prose.
const MIN_FILE_ID_BYTES: usize = 4;
const MAX_FILE_ID_BYTES: usize = 256;

pub enum SyncLogError {
    /// A field was missing, oversized, or outside the accepted character set.
    Invalid(&'static str),
    /// The envelope declares a protocol version this build cannot store.
    UnsupportedVersion(u32),
    /// A board, sequence or lease reference does not exist.
    UnknownBoard,
    /// A writer presented a fencing epoch older than the current lease.
    EpochStale { current: u64 },
    /// A checkpoint would move backwards or claim operations that never existed.
    CheckpointRejected(&'static str),
    /// A commit carried no evidence, or evidence that is not a publication
    /// receipt of the claimed shape. Refused rather than stored: the stored
    /// receipt is what authorises pruning.
    EvidenceRejected(&'static str),
    /// Configured capacity for one board or for the whole log is exhausted.
    Full,
    /// A migration has fenced new writes while retaining the old relay log.
    MigrationFenced,
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for SyncLogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "invalid: {reason}"),
            Self::UnsupportedVersion(version) => write!(f, "unsupported protocol version {version}"),
            Self::UnknownBoard => f.write_str("unknown board"),
            Self::EpochStale { current } => write!(f, "fencing epoch is stale, current is {current}"),
            Self::CheckpointRejected(reason) => write!(f, "checkpoint rejected: {reason}"),
            Self::EvidenceRejected(reason) => write!(f, "publication evidence rejected: {reason}"),
            Self::Full => f.write_str("operation log capacity exhausted"),
            Self::MigrationFenced => f.write_str("board migration has fenced new writes"),
            Self::Io(error) => write!(f, "io: {error}"),
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
        }
    }
}

impl fmt::Debug for SyncLogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for SyncLogError {}
impl From<std::io::Error> for SyncLogError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<rusqlite::Error> for SyncLogError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// One operation as submitted by a client. `payload` is stored and returned
/// verbatim and is never parsed; it is the sealed operation body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationInput {
    pub op_id: String,
    pub actor_id: String,
    pub protocol_version: u32,
    /// Client-side logical clock. Stored for diagnostics; never ordered by.
    pub logical_clock: i64,
    pub payload: String,
}

/// What an append decided about one submitted operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppendReceipt {
    /// Newly stored, assigned `seq` by this call. Safe to acknowledge.
    Accepted { seq: u64 },
    /// Already present under `seq`; this call stored nothing and acknowledged
    /// the original. A retry can never produce a second entry.
    Duplicate { seq: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredOperation {
    pub seq: u64,
    pub op_id: String,
    pub actor_id: String,
    pub protocol_version: u32,
    pub logical_clock: i64,
    pub enqueued_at: u64,
    pub payload: String,
}

/// Why a replay request could not be served from `after_seq` onwards.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayGap {
    /// Operations between `after_seq` and the retained log were pruned because
    /// they are inside a published snapshot. The client must bootstrap from the
    /// checkpoint before it can apply anything newer.
    Pruned { checkpoint_seq: u64, checkpoint_epoch: u64, snapshot_seq: u64 },
    /// The board has no retained operations at or after `after_seq` and no
    /// checkpoint, so there is nothing to replay from.
    Unavailable { oldest_retained: u64 },
}

/// The answer to "give me everything after `after_seq`", plus the sequence a
/// live subscription must start at. Both halves come from one read snapshot,
/// which is what lets a transport subscribe without either missing an operation
/// that lands during the read or receiving it twice with nothing to tell it so.
#[derive(Clone, Debug)]
pub struct SyncWindow {
    /// Operations after `after_seq`, ascending. When `gap` is set this list is
    /// not applicable on its own — the caller must close the gap first (adopt
    /// the checkpoint, or resynchronize) and never apply these rows as if the
    /// window had been complete.
    pub ops: Vec<StoredOperation>,
    /// Exclusive upper bound of this window: subscribe live from here.
    pub live_from_seq: u64,
    pub checkpoint_seq: u64,
    pub gap: Option<ReplayGap>,
}

/// What a commit actually establishes: that the writer holding the lease
/// uploaded one immutable Drive file and named it here. It is an *assertion* by
/// an authenticated, fenced writer — the relay holds no Drive credential, so it
/// can never verify the bytes. Naming it a receipt rather than an "etag" is the
/// point: the value the client sends is a Drive file id (the client lists the
/// snapshot file it just created and takes `.id`), which an entity tag would not
/// be, and treating it as an etag encouraged treating it as proof.
///
/// Validation is structural and happens once, at commit: a receipt that is not
/// shaped like a Drive file id is refused, and prune only ever reads this stored
/// shape, never the raw string a frame carried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationReceipt {
    /// Drive file id of the snapshot the writer says it uploaded.
    pub file_id: String,
    /// Number of operations the writer says the snapshot contains — the same
    /// `seq` the commit advanced the checkpoint to. Carried explicitly so the
    /// receipt is self-describing: the record says what the file is claimed to
    /// cover without the reader having to join it back to the checkpoint row.
    pub covered_seq: u64,
    /// The checkpoint generation (`snapshot_seq`) the writer asserts.
    pub generation: u64,
}

impl PublicationReceipt {
    /// Validates a commit and builds the receipt it claims to be. Refusals are
    /// `EvidenceRejected` with a stable reason string, and they are the whole of
    /// what this service can check: the file's existence and content are Drive's
    /// business and the writer's obligation.
    pub fn parse(file_id: &str, covered_seq: u64, generation: u64) -> Result<Self, SyncLogError> {
        if file_id.is_empty() {
            return Err(SyncLogError::EvidenceRejected("missing publication evidence"));
        }
        if file_id.len() > MAX_EVIDENCE_BYTES || file_id.len() > MAX_FILE_ID_BYTES {
            return Err(SyncLogError::EvidenceRejected("publication evidence too long"));
        }
        if file_id.len() < MIN_FILE_ID_BYTES
            || !file_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            // A Drive file id, or nothing. Prose, an etag in quotes, a URL, a
            // client-side path: all refused, because any of them would let a
            // client hand the pruner a string it never has to be able to justify.
            return Err(SyncLogError::EvidenceRejected("publication evidence is not a Drive file id"));
        }
        if generation == 0 {
            // A publication with no generation cannot be ordered against an
            // earlier one, so `stale` would be meaningless and the receipt could
            // not be compared with the checkpoint it claims to advance.
            return Err(SyncLogError::EvidenceRejected("publication evidence names no generation"));
        }
        Ok(Self { file_id: file_id.to_string(), covered_seq, generation })
    }
}

/// A recorded, published snapshot commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointRecord {
    pub seq: u64,
    pub epoch: u64,
    pub snapshot_seq: u64,
    pub drive_etag: String,
    pub writer: String,
    pub committed_at: u64,
    /// `snapshot_seq` not strictly above the previously recorded one: two
    /// writers published, and the newer file may have overwritten the older.
    /// Drive has no hook for our epoch, so this is detection, not prevention —
    /// the same accepted limit [`crate::leader`] documents, and the reason the
    /// next leader watermark-merges before publishing.
    pub stale: bool,
}

impl CheckpointRecord {
    /// The validated receipt this checkpoint was recorded from. Always
    /// constructible for a row written through [`SyncLog::commit_checkpoint`];
    /// `None` only for a row written before schema version 3, which is exactly
    /// the row [`SyncLog::prune`] must not trust.
    pub fn publication(&self) -> Option<PublicationReceipt> {
        PublicationReceipt::parse(&self.drive_etag, self.seq, self.snapshot_seq).ok()
    }
}

/// Current lease view for one board, as persisted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseRecord {
    pub holder: String,
    pub epoch: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardHealth {
    pub board_id: String,
    pub next_seq: u64,
    pub oldest_retained_seq: Option<u64>,
    pub retained_ops: u64,
    pub retained_bytes: u64,
    pub checkpoint_seq: u64,
    pub checkpoint_epoch: u64,
    pub lease: Option<LeaseRecord>,
}

#[derive(Clone, Debug)]
pub struct SyncLogLimits {
    pub max_ops_per_batch: usize,
    pub max_op_bytes: usize,
    pub max_ops_per_board: u64,
    pub max_bytes_per_board: u64,
    pub max_total_bytes: u64,
    /// How long operations stay retrievable *after the snapshot that covers them
    /// was published*, for a client that reconnects and wants the delta it
    /// missed rather than a full snapshot download. Anchored to publication and
    /// not to enqueue time on purpose: measuring from enqueue would let a board
    /// whose consolidation runs an hour after the edits drop the whole delta the
    /// moment it is committed. Uncovered operations are never pruned at all.
    pub retention_ms: u64,
    /// How often the background sweeper runs. One hour: the window it enforces
    /// is seven days, so the sweep only has to be right within an hour, and a
    /// board that is a few minutes late losing nothing is worth far less
    /// database traffic than a tight interval. A pass is bounded by
    /// [`SyncLog::prune_batch`]'s arguments, not by this number.
    pub sweep_interval_ms: u64,
    /// Boards examined per sweep. Each is one indexed query plus at most one
    /// bounded delete, so 16 boards is a small constant of work even on a busy
    /// installation, and rotation means every board is reached regardless of
    /// how many exist.
    pub sweep_boards: usize,
    /// Rows deleted per board per sweep: 20 000 rows of a 200 000-row board, so
    /// a completely full board drains in ten sweeps (ten hours at the default
    /// interval) while no single sweep holds the writer lock long enough to
    /// stall an append for more than a few milliseconds. The remainder is
    /// eligible next pass; every pass is idempotent.
    pub sweep_rows_per_board: usize,
    pub max_id_bytes: usize,
    pub now_ms: fn() -> u64,
}

impl Default for SyncLogLimits {
    fn default() -> Self {
        Self {
            max_ops_per_batch: 512,
            max_op_bytes: 64 * 1024,
            max_ops_per_board: 200_000,
            max_bytes_per_board: 64 * 1024 * 1024,
            max_total_bytes: 512 * 1024 * 1024,
            retention_ms: 7 * 24 * 60 * 60 * 1000,
            sweep_interval_ms: 60 * 60 * 1000,
            sweep_boards: 16,
            sweep_rows_per_board: 20_000,
            max_id_bytes: 256,
            now_ms: crate::now_ms,
        }
    }
}

/// Identifier charset shared with the rest of the service: opaque ids, never
/// paths, never markup.
pub(crate) fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
}

/// The durable log. `Connection` is `Send` but not `Sync`, hence the mutex;
/// every public method takes it exactly once, so SQLite never sees two
/// concurrent writers and `BEGIN IMMEDIATE` cannot deadlock against itself.
pub struct SyncLog {
    connection: Arc<Mutex<Connection>>,
    limits: SyncLogLimits,
    /// Rotation point for [`SyncLog::prune_batch`], so a bounded sweep still
    /// reaches every board instead of re-examining the first `max_boards` ones
    /// forever.
    prune_cursor: Mutex<String>,
}

impl SyncLog {
    /// Opens (creating and migrating when absent) the database at `path`.
    pub fn open(path: impl AsRef<Path>, limits: SyncLogLimits) -> Result<Self, SyncLogError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection, limits)
    }

    /// In-memory log for tests and the loopback fixtures.
    pub fn in_memory(limits: SyncLogLimits) -> Result<Self, SyncLogError> {
        Self::from_connection(Connection::open_in_memory()?, limits)
    }

    fn from_connection(connection: Connection, limits: SyncLogLimits) -> Result<Self, SyncLogError> {
        // WAL so a replaying reader never blocks an appending writer; FULL so a
        // commit that returned has reached the storage the ack promises.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 5_000)?;
        let log = Self { connection: Arc::new(Mutex::new(connection)), limits, prune_cursor: Mutex::new(String::new()) };
        log.migrate()?;
        Ok(log)
    }

    /// The shared connection handle. [`crate::key_courier::KeyCourier`] stores
    /// its tables in this same database: one file, one connection, one writer,
    /// which is what keeps `BEGIN IMMEDIATE` deadlock-free across both modules.
    pub fn connection(&self) -> Arc<Mutex<Connection>> {
        self.connection.clone()
    }

    /// The limits this log was opened with. The background retention sweep reads
    /// its interval and slice sizes from here rather than inventing its own, so
    /// one place decides how much work retention may do.
    pub fn limits(&self) -> &SyncLogLimits {
        &self.limits
    }

    /// Applies pending schema migrations. Versioned explicitly: a later release
    /// appends a step here and refuses to open an older-than-it-can-migrate file
    /// rather than guessing at a shape it no longer recognises.
    fn migrate(&self) -> Result<(), SyncLogError> {
        let mut connection = self.connection.lock().expect("sync log mutex");
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_schema (version INTEGER NOT NULL);",
        )?;
        let version: i64 = transaction
            .query_row("SELECT COALESCE(MAX(version), 0) FROM sync_schema", [], |row| row.get(0))
            .optional()?
            .unwrap_or(0);
        if version > SUPPORTED_SCHEMA_VERSION {
            return Err(SyncLogError::Invalid("database was written by a newer Pboard service"));
        }
        if version < 1 {
            transaction.execute_batch(
                "CREATE TABLE board (
                     board_id         TEXT PRIMARY KEY,
                     next_seq         INTEGER NOT NULL,
                     checkpoint_seq   INTEGER NOT NULL DEFAULT 0,
                     checkpoint_epoch INTEGER NOT NULL DEFAULT 0,
                     fence_epoch      INTEGER NOT NULL DEFAULT 0,
                     retained_ops     INTEGER NOT NULL DEFAULT 0,
                     retained_bytes   INTEGER NOT NULL DEFAULT 0,
                     updated_at       INTEGER NOT NULL
                 );
                 CREATE TABLE operation (
                     board_id         TEXT NOT NULL,
                     seq              INTEGER NOT NULL,
                     op_id            TEXT NOT NULL,
                     actor_id         TEXT NOT NULL,
                     protocol_version INTEGER NOT NULL,
                     logical_clock    INTEGER NOT NULL,
                     enqueued_at      INTEGER NOT NULL,
                     payload          TEXT NOT NULL,
                     PRIMARY KEY (board_id, seq)
                 );
                 -- Deduplication is a uniqueness constraint, not a lookup the
                 -- caller has to remember to perform.
                 CREATE UNIQUE INDEX operation_by_board_id ON operation (board_id, op_id);
                 CREATE TABLE checkpoint (
                     board_id      TEXT PRIMARY KEY,
                     seq           INTEGER NOT NULL,
                     epoch         INTEGER NOT NULL,
                     snapshot_seq  INTEGER NOT NULL,
                     drive_etag    TEXT NOT NULL,
                     writer        TEXT NOT NULL,
                     committed_at  INTEGER NOT NULL,
                     stale         INTEGER NOT NULL
                 );
                 CREATE TABLE lease (
                     board_id   TEXT PRIMARY KEY,
                     holder     TEXT NOT NULL,
                     epoch      INTEGER NOT NULL,
                     expires_at INTEGER NOT NULL
                 );",
            )?;
            transaction.execute("INSERT INTO sync_schema (version) VALUES (1)", [])?;
        }
        // Version 3 records *when each prefix of the log was declared covered*
        // by a published snapshot, so retention is measured from publication of
        // each segment rather than from the latest commit. The two coincide only
        // while no newer commit exists: once a writer commits `seq = 500`, the
        // single checkpoint row is overwritten and its `committed_at` refreshed,
        // so an anchor derived from it would defer pruning of operations 1-100
        // by another whole window on every newer commit — and a board with
        // steady commits would never prune at all. That is the 200k/64 MiB wedge
        // this path exists to prevent.
        //
        // A pre-v3 file has checkpoints this build cannot vouch for, so the
        // migration deliberately backfills nothing: no coverage row, and
        // `evidence_kind` defaults to 0. Such a board keeps its operations and
        // becomes prunable again only after its committer publishes once under
        // this build, which is the one event that produces both a validated
        // receipt and a coverage time this service recorded itself.
        if version < 3 {
            // Provenance, not just shape. A string cannot prove where it came
            // from: "etag" is four URL-safe characters and passes any syntactic
            // test, yet it is exactly the value the old protocol stored without
            // checking. So the checkpoint row records *whether this build
            // validated the evidence it holds* — a column only
            // `commit_checkpoint` can set, and only after
            // `PublicationReceipt::parse` accepted the value. Rows that predate
            // this schema default to 0 and are never a pruning licence.
            let has_marker: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('checkpoint') WHERE name = 'evidence_kind'",
                [],
                |row| row.get(0),
            )?;
            if has_marker == 0 {
                transaction.execute_batch(
                    "ALTER TABLE checkpoint ADD COLUMN evidence_kind INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS coverage (
                     board_id     TEXT NOT NULL,
                     upto_seq     INTEGER NOT NULL,
                     covered_at   INTEGER NOT NULL,
                     PRIMARY KEY (board_id, upto_seq)
                 );
                 -- Backfill: a pre-v3 checkpoint was not validated, so it gets
                 -- no coverage row at all — the segment's publication time is
                 -- unknown to this build, and inventing one would authorise a
                 -- delete on a time nobody recorded.
                 ",
            )?;
            transaction.execute("INSERT INTO sync_schema (version) VALUES (3)", [])?;
        }
        if version < 4 {
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS migration_fence (
                     board_id TEXT PRIMARY KEY,
                     through_seq INTEGER NOT NULL,
                     generation TEXT NOT NULL
                 );",
            )?;
            transaction.execute("INSERT INTO sync_schema (version) VALUES (4)", [])?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn validate(&self, board: &str, ops: &[OperationInput]) -> Result<(), SyncLogError> {
        if !valid_id(board, self.limits.max_id_bytes) {
            return Err(SyncLogError::Invalid("board id"));
        }
        if ops.is_empty() || ops.len() > self.limits.max_ops_per_batch {
            return Err(SyncLogError::Invalid("batch size"));
        }
        let mut seen = std::collections::HashSet::with_capacity(ops.len());
        for op in ops {
            if !valid_id(&op.op_id, self.limits.max_id_bytes) {
                return Err(SyncLogError::Invalid("operation id"));
            }
            if !valid_id(&op.actor_id, self.limits.max_id_bytes) {
                return Err(SyncLogError::Invalid("actor id"));
            }
            if op.protocol_version == 0 || op.protocol_version > SUPPORTED_PROTOCOL_VERSION {
                return Err(SyncLogError::UnsupportedVersion(op.protocol_version));
            }
            if op.payload.is_empty() || op.payload.len() > self.limits.max_op_bytes {
                return Err(SyncLogError::Invalid("payload size"));
            }
            if !seen.insert(op.op_id.as_str()) {
                // The same id twice in one batch would otherwise be accepted
                // twice by inserts that only consult the database.
                return Err(SyncLogError::Invalid("duplicate operation id in batch"));
            }
        }
        Ok(())
    }

    /// Stores every operation not already present and returns one receipt per
    /// input, in input order. Sequence allocation and deduplication share a
    /// single `BEGIN IMMEDIATE` transaction, so the receipts are the complete
    /// truth about what this call persisted, and the caller's ack may follow
    /// them unconditionally.
    pub fn append(&self, board: &str, ops: &[OperationInput]) -> Result<Vec<AppendReceipt>, SyncLogError> {
        self.validate(board, ops)?;
        let now = (self.limits.now_ms)();
        let mut guard = self.connection.lock().expect("sync log mutex");
        let connection = guard.transaction()?;

        connection.execute(
            "INSERT INTO board (board_id, next_seq, updated_at) VALUES (?1, 1, ?2)
             ON CONFLICT (board_id) DO NOTHING",
            params![board, now as i64],
        )?;
        let (mut next_seq, retained_ops, retained_bytes): (i64, i64, i64) = connection.query_row(
            "SELECT next_seq, retained_ops, retained_bytes FROM board WHERE board_id = ?1",
            params![board],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let fenced: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM migration_fence WHERE board_id = ?1)",
            params![board], |row| row.get(0),
        )?;
        let total_bytes: i64 = connection.query_row(
            "SELECT COALESCE(SUM(retained_bytes), 0) FROM board",
            [],
            |row| row.get(0),
        )?;

        let mut receipts = Vec::with_capacity(ops.len());
        let mut inserted_ops = 0i64;
        let mut inserted_bytes = 0i64;
        for op in ops {
            let existing: Option<i64> = connection
                .query_row(
                    "SELECT seq FROM operation WHERE board_id = ?1 AND op_id = ?2",
                    params![board, op.op_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(seq) = existing {
                receipts.push(AppendReceipt::Duplicate { seq: seq as u64 });
                continue;
            }
            if fenced {
                return Err(SyncLogError::MigrationFenced);
            }
            if (retained_ops + inserted_ops) as u64 >= self.limits.max_ops_per_board
                || (retained_bytes + inserted_bytes) as u64 >= self.limits.max_bytes_per_board
                || (total_bytes + inserted_bytes) as u64 >= self.limits.max_total_bytes
            {
                // Refusing the batch is the only safe answer: accepting some
                // operations of a batch and not others would leave the client
                // with a partial ack it cannot retry idempotently.
                return Err(SyncLogError::Full);
            }
            let seq = next_seq as u64;
            next_seq += 1;
            inserted_ops += 1;
            inserted_bytes += op.payload.len() as i64;
            connection.execute(
                "INSERT INTO operation (board_id, seq, op_id, actor_id, protocol_version, logical_clock, enqueued_at, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![board, seq as i64, op.op_id, op.actor_id, op.protocol_version as i64, op.logical_clock, now as i64, op.payload],
            )?;
            receipts.push(AppendReceipt::Accepted { seq });
        }
        if inserted_ops > 0 {
            connection.execute(
                "UPDATE board SET next_seq = ?2, retained_ops = retained_ops + ?3, retained_bytes = retained_bytes + ?4, updated_at = ?5
                 WHERE board_id = ?1",
                params![board, next_seq, inserted_ops, inserted_bytes, now as i64],
            )?;
        }
        connection.commit()?;
        Ok(receipts)
    }

    /// Atomically fence new writes and capture the last accepted sequence.
    /// This storage primitive is intentionally not exposed as a wire request:
    /// the caller must first establish an authenticated owner and a safe resume
    /// and cutover protocol. Repeating the same generation is idempotent.
    pub fn fence_migration(&self, board: &str, generation: &str) -> Result<u64, SyncLogError> {
        if !valid_id(board, self.limits.max_id_bytes) || !valid_id(generation, self.limits.max_id_bytes) {
            return Err(SyncLogError::Invalid("migration fence identity"));
        }
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        if let Some((existing, through)) = transaction.query_row(
            "SELECT generation, through_seq FROM migration_fence WHERE board_id = ?1",
            params![board], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).optional()? {
            if existing != generation { return Err(SyncLogError::MigrationFenced); }
            return Ok(through as u64);
        }
        let next: Option<i64> = transaction.query_row(
            "SELECT next_seq FROM board WHERE board_id = ?1", params![board], |row| row.get(0),
        ).optional()?;
        let through = next.unwrap_or(1) - 1;
        transaction.execute("INSERT INTO migration_fence (board_id, through_seq, generation) VALUES (?1, ?2, ?3)",
            params![board, through, generation])?;
        transaction.commit()?;
        Ok(through as u64)
    }

    /// Abort a still-uncommitted migration. A different generation cannot
    /// release the fence; repeating an abort after it succeeded is harmless.
    /// There is deliberately no cutover transition in this primitive yet.
    pub fn cancel_migration(&self, board: &str, generation: &str) -> Result<(), SyncLogError> {
        if !valid_id(board, self.limits.max_id_bytes) || !valid_id(generation, self.limits.max_id_bytes) {
            return Err(SyncLogError::Invalid("migration fence identity"));
        }
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let existing: Option<String> = transaction.query_row(
            "SELECT generation FROM migration_fence WHERE board_id = ?1",
            params![board], |row| row.get(0),
        ).optional()?;
        match existing {
            Some(ref current) if current != generation => return Err(SyncLogError::MigrationFenced),
            Some(_) => { transaction.execute("DELETE FROM migration_fence WHERE board_id = ?1 AND generation = ?2", params![board, generation])?; }
            None => {}
        }
        transaction.commit()?;
        Ok(())
    }

    /// The read side of synchronization: everything after `after_seq`, plus the
    /// sequence a live subscription must continue from.
    ///
    /// `after_seq` is what the client last *applied*, not merely received: a
    /// client that received but did not apply would skip an operation forever,
    /// and the server cannot tell the difference, so the protocol defines the
    /// field as applied.
    pub fn sync_from(&self, board: &str, after_seq: u64, limit: usize) -> Result<SyncWindow, SyncLogError> {
        if !valid_id(board, self.limits.max_id_bytes) {
            return Err(SyncLogError::Invalid("board id"));
        }
        let limit = limit.clamp(1, self.limits.max_ops_per_batch);
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let board_row: Option<(i64, i64, i64)> = transaction
            .query_row(
                "SELECT next_seq, checkpoint_seq, checkpoint_epoch FROM board WHERE board_id = ?1",
                params![board],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((next_seq, checkpoint_seq, checkpoint_epoch)) = board_row else {
            return Ok(SyncWindow { ops: Vec::new(), live_from_seq: 1, checkpoint_seq: 0, gap: None });
        };
        let oldest_retained: Option<i64> = transaction
            .query_row(
                "SELECT MIN(seq) FROM operation WHERE board_id = ?1",
                params![board],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let snapshot_seq: Option<u64> = transaction
            .query_row("SELECT snapshot_seq FROM checkpoint WHERE board_id = ?1", params![board], |row| row.get::<_, i64>(0))
            .optional()?
            .map(|value| value as u64);
        let mut statement = transaction.prepare(
            "SELECT seq, op_id, actor_id, protocol_version, logical_clock, enqueued_at, payload
             FROM operation WHERE board_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = statement.query_map(params![board, after_seq as i64, limit as i64], |row| {
            Ok(StoredOperation {
                seq: row.get::<_, i64>(0)? as u64,
                op_id: row.get(1)?,
                actor_id: row.get(2)?,
                protocol_version: row.get::<_, u32>(3)?,
                logical_clock: row.get(4)?,
                enqueued_at: row.get::<_, i64>(5)? as u64,
                payload: row.get(6)?,
            })
        })?;
        let mut ops = Vec::with_capacity(limit.min(64));
        for row in rows {
            ops.push(row?);
        }
        // The live start point is read in this same transaction, so an
        // operation appended while the transport was catching up is either in
        // `ops` or at or after `live_from_seq` — never in neither.
        let live_from_seq = next_seq as u64;
        let checkpoint_seq = checkpoint_seq as u64;
        let wanted = after_seq + 1; // the first sequence the client still needs
        let oldest_retained = oldest_retained.map(|value| value as u64);
        let gap = if wanted > live_from_seq {
            // The client claims to be ahead of the log, which can only mean a
            // confused or forged request. The honest answer is where the log
            // actually ends; the client must not be told it is caught up.
            Some(ReplayGap::Unavailable { oldest_retained: live_from_seq })
        } else if oldest_retained.is_some_and(|first| wanted < first) {
            // A hole between what the client holds and what is retained.
            if wanted <= checkpoint_seq {
                let snapshot_seq = snapshot_seq.unwrap_or(0);
                Some(ReplayGap::Pruned { checkpoint_seq, checkpoint_epoch: checkpoint_epoch as u64, snapshot_seq })
            } else {
                Some(ReplayGap::Unavailable { oldest_retained: oldest_retained.unwrap_or(live_from_seq) })
            }
        } else if oldest_retained.is_none() && wanted <= checkpoint_seq && checkpoint_seq > 0 {
            // Everything is pruned and the client is behind the checkpoint.
            Some(ReplayGap::Pruned { checkpoint_seq, checkpoint_epoch: checkpoint_epoch as u64, snapshot_seq: snapshot_seq.unwrap_or(0) })
        } else {
            None
        };
        Ok(SyncWindow { ops, live_from_seq, checkpoint_seq, gap })
    }

    /// Grants or renews the consolidation lease for a board, returning its
    /// fencing epoch. Epochs come from `board.fence_epoch`, so they outlive a
    /// restart and are never reused: a writer holding epoch 7 cannot be
    /// confused for epoch 8 after the service restarted mid-lease.
    pub fn acquire_lease(&self, board: &str, holder: &str, lease_ms: u64) -> Result<LeaseRecord, SyncLogError> {
        if !valid_id(board, self.limits.max_id_bytes) || !valid_id(holder, self.limits.max_id_bytes) || lease_ms == 0 {
            return Err(SyncLogError::Invalid("lease identifiers"));
        }
        let now = (self.limits.now_ms)();
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let current: Option<(String, i64)> = transaction
            .query_row(
                "SELECT holder, expires_at FROM lease WHERE board_id = ?1",
                params![board],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((holder_of, expires_at)) = &current {
            if *expires_at as u64 > now && holder_of != holder {
                return Err(SyncLogError::Invalid("lease held by another writer"));
            }
        } else {
            transaction.execute(
                "INSERT INTO board (board_id, next_seq, updated_at) VALUES (?1, 1, ?2) ON CONFLICT (board_id) DO NOTHING",
                params![board, now as i64],
            )?;
        }
        let epoch: i64 = transaction.query_row(
            "UPDATE board SET fence_epoch = fence_epoch + 1 WHERE board_id = ?1 RETURNING fence_epoch",
            params![board],
            |row| row.get(0),
        )?;
        let expires_at = now.saturating_add(lease_ms);
        transaction.execute(
            "INSERT INTO lease (board_id, holder, epoch, expires_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (board_id) DO UPDATE SET holder = ?2, epoch = ?3, expires_at = ?4",
            params![board, holder, epoch, expires_at as i64],
        )?;
        transaction.commit()?;
        Ok(LeaseRecord { holder: holder.to_string(), epoch: epoch as u64, expires_at })
    }

    /// Releases a lease early, but only for its holder: a client that lost the
    /// lease must be able to fail, not to hand somebody else's lease back.
    pub fn release_lease(&self, board: &str, holder: &str) -> Result<(), SyncLogError> {
        let guard = self.connection.lock().expect("sync log mutex");
        guard.execute(
            "DELETE FROM lease WHERE board_id = ?1 AND holder = ?2",
            params![board, holder],
        )?;
        Ok(())
    }

    pub fn lease(&self, board: &str) -> Result<Option<LeaseRecord>, SyncLogError> {
        let guard = self.connection.lock().expect("sync log mutex");
        let now = (self.limits.now_ms)();
        let record = guard
            .query_row(
                "SELECT holder, epoch, expires_at FROM lease WHERE board_id = ?1",
                params![board],
                |row| {
                    Ok(LeaseRecord {
                        holder: row.get(0)?,
                        epoch: row.get::<_, i64>(1)? as u64,
                        expires_at: row.get::<_, i64>(2)? as u64,
                    })
                },
            )
            .optional()?;
        Ok(record.filter(|lease| lease.expires_at > now))
    }

    /// Records that a snapshot covering operations up to `seq` was published to
    /// Drive, and advances the board checkpoint.
    ///
    /// Refused, rather than accepted-and-flagged, when the fencing epoch is
    /// older than the board's current lease: that writer had already lost the
    /// right to publish. `stale` is reserved for the one race that genuinely
    /// cannot be prevented client-side (an upload already in flight when the
    /// lease lapsed), and even then the checkpoint never moves backwards.
    ///
    /// `evidence` is the Drive file id the writer says it uploaded. It is
    /// validated into a [`PublicationReceipt`] here — exactly once, at the
    /// boundary — and only the validated form is stored, so [`Self::prune`]
    /// reads a record this service produced rather than a string a frame
    /// supplied. The relay cannot check Drive; see the module note.
    pub fn commit_checkpoint(
        &self,
        board: &str,
        epoch: u64,
        seq: u64,
        snapshot_seq: u64,
        evidence: &str,
        writer: &str,
    ) -> Result<CheckpointRecord, SyncLogError> {
        if !valid_id(board, self.limits.max_id_bytes) || !valid_id(writer, self.limits.max_id_bytes) {
            return Err(SyncLogError::Invalid("checkpoint identifiers"));
        }
        // Before touching the database: a commit that cannot describe its own
        // coverage is refused even if every other field is well formed.
        let receipt = PublicationReceipt::parse(evidence, seq, snapshot_seq)?;
        let now = (self.limits.now_ms)();
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let board_row: Option<(i64, i64, i64, i64)> = transaction
            .query_row(
                "SELECT next_seq, checkpoint_seq, checkpoint_epoch, fence_epoch FROM board WHERE board_id = ?1",
                params![board],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((next_seq, checkpoint_seq, checkpoint_epoch, fence_epoch)) = board_row else {
            return Err(SyncLogError::UnknownBoard);
        };
        // A fencing epoch is a *reference* to a lease, not a capability: epochs
        // are small per-board integers, so accepting any number the writer types
        // would let one device commit as another. The presented epoch must be the
        // one this board actually issued, and the writer must be the device it was
        // issued to.
        //
        // An expired-but-still-latest lease is accepted, because nothing can have
        // superseded it: no newer epoch was issued, and `snapshot_seq` below cannot
        // have moved. Once somebody else has been granted a newer epoch, the old
        // writer's publish is refused outright — that is the one case where its
        // snapshot really can be an overwrite of newer work.
        let lease: Option<(String, i64, i64)> = transaction
            .query_row("SELECT holder, epoch, expires_at FROM lease WHERE board_id = ?1", params![board], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()?;
        let current = fence_epoch.max(checkpoint_epoch) as u64;
        match &lease {
            Some((holder, issued, _)) => {
                if *holder != writer || epoch != *issued as u64 {
                    return Err(SyncLogError::EpochStale { current: (*issued).max(current as i64) as u64 });
                }
            }
            // No lease: the only commit still honored is a retry of the one this
            // board already accepted, so a client that lost the response can settle.
            None => {
                if checkpoint_epoch == 0 || epoch != checkpoint_epoch as u64 {
                    return Err(SyncLogError::EpochStale { current });
                }
            }
        }
        if seq > next_seq as u64 - 1 {
            return Err(SyncLogError::CheckpointRejected("claims operations the log never held"));
        }
        if seq < checkpoint_seq as u64 {
            return Err(SyncLogError::CheckpointRejected("would move the checkpoint backwards"));
        }
        let previous: Option<i64> = transaction
            .query_row("SELECT snapshot_seq FROM checkpoint WHERE board_id = ?1", params![board], |row| row.get::<_, i64>(0))
            .optional()?;
        let stale = previous.is_some_and(|last| snapshot_seq <= last as u64);
        transaction.execute(
            "INSERT INTO checkpoint (board_id, seq, epoch, snapshot_seq, drive_etag, writer, committed_at, stale, evidence_kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
             ON CONFLICT (board_id) DO UPDATE SET seq = ?2, epoch = ?3, snapshot_seq = ?4, drive_etag = ?5, writer = ?6, committed_at = ?7, stale = ?8, evidence_kind = 1",
            params![board, seq as i64, epoch as i64, snapshot_seq as i64, receipt.file_id, writer, now as i64, stale as i64],
        )?;
        // The coverage row is what retention measures. Written in the same
        // transaction as the checkpoint, so there is no instant at which the
        // board claims a checkpoint whose coverage time pruner cannot see.
        // `MIN` on conflict, not `SET covered_at = excluded.covered_at`: a
        // re-commit of the same prefix is recovery from a lost reply, not a new
        // publication, and must not push the segment's date forward and restart
        // its retention window. Taking the earlier of the two is both idempotent
        // and never *earlier* than an actual publication.
        if seq > 0 {
            transaction.execute(
                "INSERT INTO coverage (board_id, upto_seq, covered_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (board_id, upto_seq) DO UPDATE SET covered_at = MIN(covered_at, excluded.covered_at)",
                params![board, seq as i64, now as i64],
            )?;
        }
        if seq > checkpoint_seq as u64 || epoch > checkpoint_epoch as u64 {
            transaction.execute(
                "UPDATE board SET checkpoint_seq = MAX(checkpoint_seq, ?2), checkpoint_epoch = MAX(checkpoint_epoch, ?3), updated_at = ?4 WHERE board_id = ?1",
                params![board, seq as i64, epoch as i64, now as i64],
            )?;
        }
        transaction.commit()?;
        Ok(CheckpointRecord {
            seq,
            epoch,
            snapshot_seq,
            drive_etag: receipt.file_id,
            writer: writer.to_string(),
            committed_at: now,
            stale,
        })
    }

    pub fn checkpoint(&self, board: &str) -> Result<Option<CheckpointRecord>, SyncLogError> {
        let guard = self.connection.lock().expect("sync log mutex");
        let record = guard
            .query_row(
                "SELECT seq, epoch, snapshot_seq, drive_etag, writer, committed_at, stale FROM checkpoint WHERE board_id = ?1",
                params![board],
                |row| {
                    Ok(CheckpointRecord {
                        seq: row.get::<_, i64>(0)? as u64,
                        epoch: row.get::<_, i64>(1)? as u64,
                        snapshot_seq: row.get::<_, i64>(2)? as u64,
                        drive_etag: row.get(3)?,
                        writer: row.get(4)?,
                        committed_at: row.get::<_, i64>(5)? as u64,
                        stale: row.get::<_, i64>(6)? != 0,
                    })
                },
            )
            .optional()?;
        Ok(record)
    }

    /// Deletes operations that a committed snapshot covers, and only after the
    /// retention window measured from *that segment's* publication.
    ///
    /// The safety argument, stated as the two conditions the query enforces:
    ///
    /// 1. **There is a checkpoint row this build wrote, and its evidence parses
    ///    as a publication receipt.** `checkpoint.evidence_kind = 1` is set only
    ///    by [`Self::commit_checkpoint`], after the parser accepted the value, so
    ///    a row that predates this schema — or that anything else wrote — is not
    ///    a licence to delete, however plausible its string looks. The parser is
    ///    then re-run on the stored value, so an out-of-band edit after the fact
    ///    is refused as well. Two independent checks, because the failure they
    ///    guard against is silent data loss. This is the invariant that makes a
    ///    client-supplied string incapable of causing a delete on its own.
    /// 2. **A coverage row at or above the row's sequence is older than the
    ///    retention window.** Coverage rows are written only by
    ///    [`Self::commit_checkpoint`], for the exact `seq` it accepted and with
    ///    the `committed_at` of the first time that prefix was committed. The
    ///    cutoff is the highest prefix covered *more than one window ago*:
    ///
    ///    ```text
    ///    cutoff = MAX(upto_seq) FROM coverage WHERE covered_at <= now - retention_ms
    ///    eligible rows: seq <= min(cutoff, board.checkpoint_seq)
    ///    ```
    ///
    ///    Anchoring per *segment* rather than to the newest commit is what makes
    ///    retention actually fire: with a single "newest commit" anchor, a board
    ///    that consolidates every five minutes would refresh its anchor forever
    ///    and prune nothing — exactly the wedge this path exists to remove. Here
    ///    the snapshot that covered operations 1..100 is dated once, and those
    ///    rows become eligible a window after *that* upload, however many newer
    ///    commits exist.
    ///
    /// The `min(.., checkpoint_seq)` term is redundant for a well-formed database
    /// (the checkpoint is the maximum committed sequence) and is kept as a hard
    /// second barrier: rows above the checkpoint have no snapshot at all, and this
    /// predicate means no code path, however the tables were written, can delete
    /// one.
    ///
    /// The residual trust is the client's upload, which the relay cannot observe;
    /// see the module documentation. Idempotent and safe to call at any time,
    /// including when nothing is eligible: it deletes nothing, and correctness
    /// never depends on it having run.
    pub fn prune(&self, board: &str) -> Result<u64, SyncLogError> {
        self.prune_limited(board, usize::MAX)
    }

    /// As [`Self::prune`], but deletes at most `max_rows` operations. The
    /// background sweeper uses this so one large board cannot hold the single
    /// database mutex long enough to stall appends; the remainder is simply
    /// eligible on the next pass, and every pass is idempotent. Rows are taken
    /// lowest-sequence first, so a partial pass still removes a *prefix* of the
    /// covered range and never leaves a hole under a retained row.
    pub fn prune_limited(&self, board: &str, max_rows: usize) -> Result<u64, SyncLogError> {
        if max_rows == 0 {
            return Ok(0);
        }
        if !valid_id(board, self.limits.max_id_bytes) {
            return Err(SyncLogError::Invalid("board id"));
        }
        let now = (self.limits.now_ms)();
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let fenced: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM migration_fence WHERE board_id = ?1)",
            params![board], |row| row.get(0),
        )?;
        if fenced { return Ok(0); }
        // Condition 1: the board's own checkpoint, as this service recorded it.
        let checkpoint: Option<(i64, i64, String, u64, i64)> = transaction
            .query_row(
                "SELECT board.checkpoint_seq, checkpoint.snapshot_seq, checkpoint.drive_etag, checkpoint.seq, checkpoint.evidence_kind
                 FROM board JOIN checkpoint ON checkpoint.board_id = board.board_id
                 WHERE board.board_id = ?1",
                params![board],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? as u64, row.get(4)?)),
            )
            .optional()?;
        let Some((checkpoint_seq, snapshot_seq, evidence, recorded_seq, evidence_kind)) = checkpoint else {
            return Ok(0); // no checkpoint at all: nothing is covered, so nothing goes
        };
        // Provenance first: a row this build did not write carries no receipt it
        // ever validated, whatever the string happens to look like.
        if evidence_kind != 1 {
            return Ok(0);
        }
        if checkpoint_seq <= 0 {
            return Ok(0);
        }
        // Then the shape: even a row this build wrote is re-parsed, so a value
        // edited out of band after the fact is not trusted either.
        if PublicationReceipt::parse(&evidence, recorded_seq, snapshot_seq as u64).is_err() {
            return Ok(0);
        }
        // Condition 2: the highest prefix whose *own* publication is older than
        // the retention window. `MAX(upto_seq)` over eligible segments, not the
        // newest commit, so a board with steady commits still ages out its old
        // segments instead of refreshing one anchor forever.
        let horizon = now.saturating_sub(self.limits.retention_ms);
        let cutoff: Option<i64> = transaction
            .query_row(
                "SELECT MAX(upto_seq) FROM coverage WHERE board_id = ?1 AND covered_at <= ?2",
                params![board, horizon as i64],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(cutoff) = cutoff else {
            // No segment is old enough — or none was ever recorded. Either way
            // nothing is eligible, and the safe answer is to delete nothing.
            return Ok(0);
        };
        // The hard barrier: never above the checkpoint, whatever the coverage
        // table says.
        let eligible_to = cutoff.min(checkpoint_seq);
        if eligible_to <= 0 {
            return Ok(0);
        }
        // One statement per board, not one per row: the bounded slice is chosen
        // first so the byte accounting is exact, then the whole prefix is
        // deleted in a single `DELETE`. Five thousand individual deletes would
        // hold the database mutex (and its writer lock) for no benefit.
        let bounded: Option<i64> = transaction
            .query_row(
                "SELECT MAX(seq) FROM (SELECT seq FROM operation
                                       WHERE board_id = ?1 AND seq <= ?2
                                       ORDER BY seq LIMIT ?3)",
                params![board, eligible_to, max_rows as i64],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(delete_to) = bounded else {
            return Ok(0); // nothing retained at or below the cutoff
        };
        let (removed_ops, removed_bytes): (i64, i64) = transaction.query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM operation
             WHERE board_id = ?1 AND seq <= ?2",
            params![board, delete_to],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if removed_ops == 0 {
            return Ok(0);
        }
        transaction.execute(
            "DELETE FROM operation WHERE board_id = ?1 AND seq <= ?2",
            params![board, delete_to],
        )?;
        // Coverage rows at or below the deleted prefix are dropped: every
        // operation they described is gone, so they can never make another row
        // eligible, and keeping one per commit generation forever would trade a
        // bounded operation table for an unbounded one. Rows *above* it stay —
        // those are the segments whose operations are still retained, and they
        // are what ages them out later. `snapshot_required` does not read this
        // table: it is decided by the checkpoint and the oldest retained row.
        transaction.execute(
            "DELETE FROM coverage WHERE board_id = ?1 AND upto_seq <= ?2",
            params![board, delete_to],
        )?;
        transaction.execute(
            "UPDATE board SET retained_ops = retained_ops - ?2, retained_bytes = retained_bytes - ?3, updated_at = ?4 WHERE board_id = ?1",
            params![board, removed_ops, removed_bytes, now as i64],
        )?;
        transaction.commit()?;
        Ok(removed_ops as u64)
    }

    /// Runs [`Self::prune_limited`] over every board that has a committer, one
    /// board per call, in a bounded slice: at most `max_boards` boards and at
    /// most `max_rows_per_board` rows from each. Returns `(board, removed)` for
    /// boards that gave something back, so the caller can log the work it
    /// actually did rather than the work it attempted.
    ///
    /// Bounded on purpose: the background caller must not hold the single
    /// database mutex for a full sweep of a large installation, and a board with
    /// 200k prunable rows must not starve appends. `max_boards` boards are
    /// examined per invocation, and a board whose prune fails is skipped rather
    /// than aborting the sweep — one damaged board must not stop retention for
    /// the rest.
    ///
    /// Boards are visited in `board_id` order from a cursor that carries across
    /// calls and wraps at the end, so every board is reached within
    /// `ceil(board_count / max_boards)` invocations. Ordering by activity would
    /// let one idle-but-unprunable board (nothing past its window yet) hold the
    /// front of the queue forever and starve every board behind it.
    pub fn prune_batch(&self, max_boards: usize, max_rows_per_board: usize) -> Result<Vec<(String, u64)>, SyncLogError> {
        if max_boards == 0 || max_rows_per_board == 0 {
            return Ok(Vec::new());
        }
        let mut cursor = self.prune_cursor.lock().expect("prune cursor");
        let candidates = self.prune_candidates(&cursor, max_boards)?;
        let candidates = if candidates.is_empty() && !cursor.is_empty() {
            *cursor = String::new();
            self.prune_candidates(&cursor, max_boards)?
        } else {
            candidates
        };
        if let Some(last) = candidates.last() {
            *cursor = last.clone();
        }
        drop(cursor);
        let mut pruned = Vec::new();
        for board in candidates {
            match self.prune_limited(&board, max_rows_per_board) {
                Ok(removed) if removed > 0 => pruned.push((board, removed)),
                Ok(_) => {}
                Err(error) => {
                    // Logged, then skipped: a board that cannot be pruned simply
                    // retains longer, which is the safe direction. Aborting the
                    // sweep would let one damaged board stop retention for every
                    // other one.
                    tracing::warn!(board = %board, %error, "prune_skipped");
                }
            }
        }
        Ok(pruned)
    }

    fn prune_candidates(&self, after: &str, max_boards: usize) -> Result<Vec<String>, SyncLogError> {
        // Only boards with both a checkpoint and retained operations can yield
        // anything; this is an indexed scan of the board table, never the sweep.
        let guard = self.connection.lock().expect("sync log mutex");
        let mut statement = guard.prepare(
            "SELECT board_id FROM board
             WHERE checkpoint_seq > 0 AND retained_ops > 0 AND board_id > ?1
             ORDER BY board_id LIMIT ?2",
        )?;
        let rows = statement.query_map(params![after, max_boards as i64], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every board's retained state: the diagnostics surface and the health
    /// endpoint read this.
    pub fn boards(&self) -> Result<Vec<BoardHealth>, SyncLogError> {
        let guard = self.connection.lock().expect("sync log mutex");
        let mut statement = guard.prepare(
            "SELECT board_id, next_seq, retained_ops, retained_bytes, checkpoint_seq, checkpoint_epoch FROM board ORDER BY board_id",
        )?;
        let mut boards = Vec::new();
        let rows = statement.query_map([], |row| {
            Ok(BoardHealth {
                board_id: row.get(0)?,
                next_seq: row.get::<_, i64>(1)? as u64,
                oldest_retained_seq: None,
                retained_ops: row.get::<_, i64>(2)? as u64,
                retained_bytes: row.get::<_, i64>(3)? as u64,
                checkpoint_seq: row.get::<_, i64>(4)? as u64,
                checkpoint_epoch: row.get::<_, i64>(5)? as u64,
                lease: None,
            })
        })?;
        for row in rows {
            boards.push(row?);
        }
        drop(statement);
        for board in &mut boards {
            board.oldest_retained_seq = guard
                .query_row(
                    "SELECT MIN(seq) FROM operation WHERE board_id = ?1",
                    params![board.board_id],
                    |row| row.get::<_, i64>(0).map(|value| value as u64),
                )
                .optional()?;
            board.lease = guard
                .query_row(
                    "SELECT holder, epoch, expires_at FROM lease WHERE board_id = ?1",
                    params![board.board_id],
                    |row| {
                        Ok(LeaseRecord {
                            holder: row.get(0)?,
                            epoch: row.get::<_, i64>(1)? as u64,
                            expires_at: row.get::<_, i64>(2)? as u64,
                        })
                    },
                )
                .optional()?;
        }
        Ok(boards)
    }

    pub fn stats(&self) -> Result<HashMap<&'static str, u64>, SyncLogError> {
        let guard = self.connection.lock().expect("sync log mutex");
        let (boards, ops, bytes): (i64, i64, i64) = guard.query_row(
            "SELECT (SELECT COUNT(*) FROM board), (SELECT COUNT(*) FROM operation), COALESCE((SELECT SUM(retained_bytes) FROM board), 0)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let mut stats = HashMap::new();
        stats.insert("boards", boards as u64);
        stats.insert("retainedOperations", ops as u64);
        stats.insert("retainedBytes", bytes as u64);
        Ok(stats)
    }

    /// `PRAGMA integrity_check` for the operational health check and for
    /// release-time verification of a written database.
    pub fn integrity_check(&self) -> Result<(), SyncLogError> {
        let guard = self.connection.lock().expect("sync log mutex");
        let outcome: String = guard.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if outcome == "ok" {
            Ok(())
        } else {
            Err(SyncLogError::Invalid("database integrity check reported damage"))
        }
    }

    /// Checkpoints the WAL into the main database file so a plain file copy is
    /// a consistent backup. The backup procedure calls this, then copies.
    pub fn checkpoint_wal(&self) -> Result<(), SyncLogError> {
        let guard = self.connection.lock().expect("sync log mutex");
        guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests run on parallel threads, so the clock is per-test-thread; a shared
    // atomic here would let one test's time travel break another's retention.
    thread_local! {
        static CLOCK: std::cell::Cell<u64> = const { std::cell::Cell::new(1_000) };
    }
    fn now() -> u64 {
        CLOCK.with(|clock| clock.get())
    }
    fn advance_now(delta: u64) {
        CLOCK.with(|clock| clock.set(clock.get() + delta));
    }
    fn clock() -> fn() -> u64 {
        now
    }

    fn limits() -> SyncLogLimits {
        SyncLogLimits { retention_ms: 60_000, now_ms: clock(), ..Default::default() }
    }
    fn op(op_id: &str) -> OperationInput {
        OperationInput {
            op_id: op_id.into(),
            actor_id: "device:aaaa".into(),
            protocol_version: SUPPORTED_PROTOCOL_VERSION,
            logical_clock: 7,
            payload: format!("{{\"ct\":\"{op_id}\"}}"),
        }
    }
    fn log() -> SyncLog {
        SyncLog::in_memory(limits()).expect("open")
    }

    #[test]
    fn migration_fence_survives_restart_and_blocks_new_writes_and_pruning() {
        let directory = std::env::temp_dir().join(format!("pboard-migration-fence-{}", uuid()));
        {
            let log = SyncLog::open(&directory, limits()).expect("open");
            log.append("board", &[op("op-1")]).expect("append");
            log.acquire_lease("board", "writer", 1_000).expect("lease");
            log.commit_checkpoint("board", 1, 1, 1, "driveFileId0001", "writer").expect("commit");
            assert_eq!(log.fence_migration("board", "generation-1").expect("fence"), 1);
            assert_eq!(log.fence_migration("board", "generation-1").expect("retry"), 1);
            assert!(matches!(log.fence_migration("board", "generation-2"), Err(SyncLogError::MigrationFenced)));
            assert_eq!(log.append("board", &[op("op-1")]).expect("duplicate"), vec![AppendReceipt::Duplicate { seq: 1 }]);
            assert!(matches!(log.append("board", &[op("op-1"), op("op-2")]), Err(SyncLogError::MigrationFenced)));
            advance_now(120_000);
            assert_eq!(log.prune("board").expect("prune"), 0);
        }
        {
            let reopened = SyncLog::open(&directory, limits()).expect("reopen");
            assert_eq!(reopened.fence_migration("board", "generation-1").expect("retry"), 1);
            assert!(matches!(reopened.append("board", &[op("op-2")]), Err(SyncLogError::MigrationFenced)));
            assert_eq!(reopened.sync_from("board", 0, 10).expect("replay").ops.len(), 1);
            assert!(reopened.append("other", &[op("op-2")]).is_ok());
        }
        std::fs::remove_file(directory).expect("cleanup");
    }

    #[test]
    fn only_the_matching_generation_can_cancel_a_fence() {
        let log = log();
        assert_eq!(log.fence_migration("board", "first").expect("fence"), 0);
        assert!(matches!(log.cancel_migration("board", "other"), Err(SyncLogError::MigrationFenced)));
        assert!(matches!(log.append("board", &[op("op-1")]), Err(SyncLogError::MigrationFenced)));
        log.cancel_migration("board", "first").expect("cancel");
        log.cancel_migration("board", "first").expect("idempotent cancel");
        assert_eq!(log.append("board", &[op("op-1")]).expect("append"), vec![AppendReceipt::Accepted { seq: 1 }]);
        assert_eq!(log.fence_migration("board", "second").expect("new fence"), 1);
        assert!(matches!(log.cancel_migration("board", "first"), Err(SyncLogError::MigrationFenced)));
    }

    #[test]
    fn assigns_per_board_sequences_from_one() {
        let log = log();
        let first = log.append("board-a", &[op("op-1"), op("op-2")]).expect("append");
        assert_eq!(first[0], AppendReceipt::Accepted { seq: 1 });
        assert_eq!(first[1], AppendReceipt::Accepted { seq: 2 });
        // Sequences are per board, not global: a second board starts at one.
        let other = log.append("board-b", &[op("op-9")]).expect("append");
        assert_eq!(other[0], AppendReceipt::Accepted { seq: 1 });
    }

    #[test]
    fn a_retried_operation_returns_its_original_sequence_without_consuming_one() {
        let log = log();
        log.append("board", &[op("op-1")]).expect("first");
        let retry = log.append("board", &[op("op-1")]).expect("retry");
        assert_eq!(retry, vec![AppendReceipt::Duplicate { seq: 1 }]);
        // The retry allocated nothing, so the next new operation is sequence 2.
        let next = log.append("board", &[op("op-2")]).expect("next");
        assert_eq!(next, vec![AppendReceipt::Accepted { seq: 2 }]);
        let window = log.sync_from("board", 0, 10).expect("window");
        assert_eq!(window.ops.iter().map(|stored| stored.op_id.as_str()).collect::<Vec<_>>(), vec!["op-1", "op-2"]);
    }

    #[test]
    fn a_retry_mixed_with_new_work_stores_only_the_new_work() {
        let log = log();
        log.append("board", &[op("op-1")]).expect("first");
        let mixed = log.append("board", &[op("op-1"), op("op-2")]).expect("mixed");
        assert_eq!(mixed, vec![AppendReceipt::Duplicate { seq: 1 }, AppendReceipt::Accepted { seq: 2 }]);
    }

    #[test]
    fn rejects_a_duplicate_id_inside_one_batch() {
        let log = log();
        // Accepting both entries would either break the unique index mid-write
        // or hand the client two sequences for one operation.
        assert!(matches!(log.append("board", &[op("dup"), op("dup")]), Err(SyncLogError::Invalid("duplicate operation id in batch"))));
    }

    #[test]
    fn refuses_to_store_an_envelope_it_cannot_understand() {
        let log = log();
        let future = OperationInput { protocol_version: SUPPORTED_PROTOCOL_VERSION + 1, ..op("op-1") };
        assert!(matches!(log.append("board", &[future]), Err(SyncLogError::UnsupportedVersion(2))));
        let oversized = OperationInput { payload: "x".repeat(limits().max_op_bytes + 1), ..op("op-2") };
        assert!(matches!(log.append("board", &[oversized]), Err(SyncLogError::Invalid("payload size"))));
        let hostile = OperationInput { op_id: "has space".into(), ..op("op-3") };
        assert!(matches!(log.append("board", &[hostile]), Err(SyncLogError::Invalid("operation id"))));
    }

    #[test]
    fn replays_in_sequence_order_after_a_point() {
        let log = log();
        for id in ["a", "b", "c", "d"] {
            log.append("board", &[op(id)]).expect("append");
        }
        let window = log.sync_from("board", 2, 10).expect("window");
        assert_eq!(window.ops.iter().map(|stored| stored.seq).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(window.gap, None);
        assert_eq!(window.live_from_seq, 5);
        let limited = log.sync_from("board", 0, 2).expect("limited");
        assert_eq!(limited.ops.len(), 2);
        // A page is not a gap: the rest is still ahead, live.
        assert_eq!(limited.gap, None);
    }

    #[test]
    fn reports_a_gap_instead_of_an_empty_answer_when_operations_are_gone() {
        let log = log();
        for id in ["a", "b", "c"] {
            log.append("board", &[op(id)]).expect("append");
        }
        log.acquire_lease("board", "writer", 1_000).expect("lease");
        log.commit_checkpoint("board", 1, 2, 100, "driveFileId0001", "writer").expect("commit");
        advance_now(120_000);
        assert_eq!(log.prune("board").expect("prune"), 2);
        // 0 and 1 are inside the published snapshot: a client asking for them
        // must bootstrap, not receive a quietly short list.
        let window = log.sync_from("board", 0, 10).expect("window");
        assert_eq!(window.gap, Some(ReplayGap::Pruned { checkpoint_seq: 2, checkpoint_epoch: 1, snapshot_seq: 100 }));
        assert_eq!(window.ops.iter().map(|stored| stored.seq).collect::<Vec<_>>(), vec![3]);
        // A client that already holds the checkpoint is served normally.
        assert_eq!(log.sync_from("board", 2, 10).expect("current").gap, None);
    }

    #[test]
    fn never_prunes_an_operation_a_snapshot_does_not_cover() {
        let log = log();
        for id in ["a", "b", "c"] {
            log.append("board", &[op(id)]).expect("append");
        }
        advance_now(10 * 60_000);
        // Nothing committed: retention elapsed, and still nothing may go.
        assert_eq!(log.prune("board").expect("prune"), 0);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 3);
        log.acquire_lease("board", "writer", 1_000).expect("lease");
        log.commit_checkpoint("board", 1, 2, 1, "driveFileId0001", "writer").expect("commit");
        // The snapshot is published, but the window right after publication is
        // exactly when a reconnecting client still wants the delta.
        assert_eq!(log.prune("board").expect("prune"), 0);
        advance_now(120_000);
        assert_eq!(log.prune("board").expect("prune"), 2);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 1);
    }

    #[test]
    fn leases_fence_older_writers_and_survive_a_restart() {
        let limits = limits();
        let directory = std::env::temp_dir().join(format!("pboard-sync-log-{}", uuid()));
        {
            let log = SyncLog::open(&directory, limits.clone()).expect("open");
            let first = log.acquire_lease("board", "writer-a", 60_000).expect("first");
            assert_eq!(first.epoch, 1);
            assert!(matches!(log.acquire_lease("board", "writer-b", 60_000), Err(SyncLogError::Invalid("lease held by another writer"))));
            assert!(log.release_lease("board", "writer-c").is_ok()); // not the holder: no-op
            log.release_lease("board", "writer-a").expect("release");
        }
        // Reopening the same file must not reset epochs to a value an old writer
        // could still present.
        let log = SyncLog::open(&directory, limits).expect("reopen");
        let second = log.acquire_lease("board", "writer-b", 60_000).expect("second");
        assert_eq!(second.epoch, 2);
        std::fs::remove_file(&directory).ok();
        std::fs::remove_file(format!("{}.wal", directory.display())).ok();
        std::fs::remove_file(format!("{}-shm", directory.display())).ok();
    }

    #[test]
    fn an_expired_lease_is_reclaimable_and_a_stale_commit_is_refused() {
        let log = log();
        log.append("board", &[op("a")]).expect("append");
        let first = log.acquire_lease("board", "writer-a", 1_000).expect("first");
        advance_now(5_000);
        assert!(log.lease("board").expect("lease").is_none()); // expired
        let second = log.acquire_lease("board", "writer-b", 60_000).expect("second");
        assert!(second.epoch > first.epoch);
        // Writer A wakes up late and tries to publish anyway.
        assert!(matches!(
            log.commit_checkpoint("board", first.epoch, 1, 1, "driveFileAAAA01", "writer-a"),
            Err(SyncLogError::EpochStale { current: 2 })
        ));
        let accepted = log.commit_checkpoint("board", second.epoch, 1, 1, "driveFileBBBB02", "writer-b").expect("commit");
        assert!(!accepted.stale);
    }

    #[test]
    fn a_checkpoint_may_neither_move_backwards_nor_claim_phantom_operations() {
        let log = log();
        log.append("board", &[op("a"), op("b")]).expect("append");
        log.acquire_lease("board", "writer", 60_000).expect("lease");
        assert!(matches!(
            log.commit_checkpoint("board", 1, 99, 1, "driveFileId0001", "writer"),
            Err(SyncLogError::CheckpointRejected("claims operations the log never held"))
        ));
        log.commit_checkpoint("board", 1, 2, 10, "driveFileId0001", "writer").expect("commit");
        advance_now(5_000);
        log.acquire_lease("board", "writer", 60_000).expect("second lease");
        assert!(matches!(
            log.commit_checkpoint("board", 2, 1, 11, "driveFileId0001", "writer"),
            Err(SyncLogError::CheckpointRejected("would move the checkpoint backwards"))
        ));
        // A strictly newer snapshot generation is normal progress.
        let newer = log.commit_checkpoint("board", 2, 2, 11, "driveFileGen002", "writer").expect("newer");
        assert!(!newer.stale);
        // Re-publishing the same generation is the overwrite race Drive cannot
        // prevent (an upload in flight when the lease lapsed), so it is accepted
        // and flagged for the next leader to watermark-merge.
        let repeated = log.commit_checkpoint("board", 2, 2, 11, "driveFileGen003", "writer").expect("repeat");
        assert!(repeated.stale);
        let older = log.commit_checkpoint("board", 2, 2, 4, "driveFileGen004", "writer").expect("older");
        assert!(older.stale);
    }

    #[test]
    fn capacity_is_enforced_per_board() {
        let limits = SyncLogLimits { max_ops_per_board: 2, now_ms: clock(), ..Default::default() };
        let log = SyncLog::in_memory(limits).expect("open");
        log.append("board", &[op("a"), op("b")]).expect("append");
        assert!(matches!(log.append("board", &[op("c")]), Err(SyncLogError::Full)));
        // A board at capacity does not consume sequences for the refused batch.
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 2);
    }

    // ---- Publication evidence -------------------------------------------------
    //
    // The rule under test: a commit is only accepted when it can describe the
    // publication it claims, and prune only ever acts on a checkpoint this
    // service produced. A client-supplied string must never be enough.

    #[test]
    fn a_version_two_file_migrates_and_keeps_its_checkpoint() {
        // A file written by the previous build has no `coverage` table and its
        // checkpoint evidence was never validated. Opening it must succeed,
        // backfill the coverage row from the checkpoint's own timestamp, and
        // leave the checkpoint's meaning intact — but a *pre-v3 unvalidated*
        // evidence string must not silently become a pruning licence.
        let directory = std::env::temp_dir().join(format!("pboard-sync-log-v2-{}", uuid()));
        {
            let log = SyncLog::open(&directory, limits()).expect("open");
            log.append("board", &[op("a"), op("b")]).expect("append");
            {
                let guard = log.connection();
                let connection = guard.lock().expect("lock");
                // Rewind to the shape the previous build wrote: version 2, no
                // coverage table, evidence that is not a receipt.
                connection.execute_batch("DROP TABLE coverage; DELETE FROM sync_schema; INSERT INTO sync_schema (version) VALUES (2);").expect("rewind");
                connection.execute(
                    "INSERT INTO checkpoint (board_id, seq, epoch, snapshot_seq, drive_etag, writer, committed_at, stale)
                     VALUES ('board', 2, 1, 1, 'etag', 'writer', 1000, 0)",
                    [],
                ).expect("legacy checkpoint");
                connection.execute("UPDATE board SET checkpoint_seq = 2, checkpoint_epoch = 1 WHERE board_id = 'board'", []).expect("advance");
            }
        }
        let log = SyncLog::open(&directory, limits()).expect("migrate");
        // The checkpoint survives, evidence and all — it is history, not a
        // decision this build gets to rewrite.
        assert_eq!(log.checkpoint("board").expect("checkpoint").expect("row").drive_etag, "etag");
        // But it authorises nothing: the evidence is not a receipt.
        advance_now(120_000);
        assert_eq!(log.prune("board").expect("prune"), 0);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 2);
        // A fresh commit from this build supersedes it and is prunable normally.
        let lease = log.acquire_lease("board", "writer", 60_000).expect("lease");
        log.commit_checkpoint("board", lease.epoch, 2, 2, "driveFileId0001", "writer").expect("commit");
        advance_now(120_000);
        assert_eq!(log.prune("board").expect("prune"), 2);
        std::fs::remove_file(&directory).ok();
        std::fs::remove_file(format!("{}.wal", directory.display())).ok();
        std::fs::remove_file(format!("{}-shm", directory.display())).ok();
    }

    #[test]
    fn a_commit_without_a_publication_receipt_is_refused() {
        let log = log();
        log.append("board", &[op("a"), op("b")]).expect("append");
        log.acquire_lease("board", "writer", 60_000).expect("lease");

        // Absent, and nothing is written: the checkpoint is what authorises a
        // prune, so a commit with no evidence must not create one.
        assert!(matches!(
            log.commit_checkpoint("board", 1, 2, 5, "", "writer"),
            Err(SyncLogError::EvidenceRejected("missing publication evidence"))
        ));
        // Malformed: prose, an etag in quotes, a URL, a path, whitespace — every
        // one of these was previously stored verbatim as "proof".
        for hostile in [
            "\"e2f0c1\"",
            "https://www.googleapis.com/drive/v3/files/abc",
            "snapshot-17.json",
            "has space",
            "../../etc/passwd",
        ] {
            assert!(
                matches!(log.commit_checkpoint("board", 1, 2, 5, hostile, "writer"), Err(SyncLogError::EvidenceRejected(_))),
                "evidence {hostile:?} must be refused"
            );
        }
        // Oversized: bounded before it can reach the database.
        let huge = "a".repeat(MAX_EVIDENCE_BYTES + 1);
        assert!(matches!(log.commit_checkpoint("board", 1, 2, 5, &huge, "writer"), Err(SyncLogError::EvidenceRejected(_))));
        // A generation is part of the claim; without one the receipt cannot be
        // ordered against an earlier publication.
        assert!(matches!(
            log.commit_checkpoint("board", 1, 2, 0, "driveFileId0001", "writer"),
            Err(SyncLogError::EvidenceRejected("publication evidence names no generation"))
        ));
        // None of the refusals wrote anything, so there is nothing to prune behind.
        assert!(log.checkpoint("board").expect("checkpoint").is_none());
        assert_eq!(log.prune("board").expect("prune"), 0);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 2);

        // A well-formed receipt is accepted and stored as the receipt, not the
        // raw frame string: only the validated file id is persisted.
        let committed = log.commit_checkpoint("board", 1, 2, 5, "driveFileId0001", "writer").expect("commit");
        assert_eq!(committed.publication().expect("receipt").file_id, "driveFileId0001");
        assert_eq!(committed.publication().expect("receipt").covered_seq, 2);
        assert_eq!(committed.publication().expect("receipt").generation, 5);
    }

    #[test]
    fn prune_without_a_checkpoint_does_nothing() {
        let log = log();
        for id in ["a", "b", "c"] {
            log.append("board", &[op(id)]).expect("append");
        }
        // Far past any retention window, and still untouchable: nothing has ever
        // been committed, so every one of these rows is the only copy.
        advance_now(30 * 24 * 60 * 60_000);
        assert_eq!(log.prune("board").expect("prune"), 0);
        assert_eq!(log.prune_limited("board", 1).expect("bounded prune"), 0);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 3);
    }

    #[test]
    fn prune_deletes_only_rows_at_or_below_the_checkpoint() {
        let log = log();
        for id in ["a", "b", "c", "d", "e"] {
            log.append("board", &[op(id)]).expect("append");
        }
        log.acquire_lease("board", "writer", 60_000).expect("lease");
        // A snapshot covering operations 1..3 was published.
        log.commit_checkpoint("board", 1, 3, 1, "driveFileId0001", "writer").expect("commit");
        advance_now(120_000);
        assert_eq!(log.prune("board").expect("prune"), 3);
        // Everything above the checkpoint survives, in order, untouched.
        let window = log.sync_from("board", 0, 10).expect("window");
        assert_eq!(window.ops.iter().map(|stored| stored.seq).collect::<Vec<_>>(), vec![4, 5]);
        // The deleted prefix is inside the snapshot, so a client below it is told
        // to adopt the checkpoint rather than handed the newer rows alone.
        assert_eq!(window.gap, Some(ReplayGap::Pruned { checkpoint_seq: 3, checkpoint_epoch: 1, snapshot_seq: 1 }));
        // And a client that already holds the checkpoint is served the rest.
        assert_eq!(log.sync_from("board", 3, 10).expect("current").ops.len(), 2);
        // The second prune is a no-op: nothing else is covered, so nothing else goes.
        assert_eq!(log.prune("board").expect("second prune"), 0);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 2);
    }

    #[test]
    fn pruning_retires_the_coverage_rows_it_has_no_further_use_for() {
        // The coverage table must not become the new unbounded growth: rows for
        // prefixes whose operations are gone cannot make anything else eligible,
        // so they are dropped with the prefix. Rows still covering retained
        // operations stay, because those are what ages them out later.
        let log = log();
        for id in ["a", "b", "c", "d"] {
            log.append("board", &[op(id)]).expect("append");
        }
        log.acquire_lease("board", "writer", 60_000).expect("lease");
        log.commit_checkpoint("board", 1, 2, 1, "driveFileId0001", "writer").expect("first");
        log.commit_checkpoint("board", 1, 4, 2, "driveFileId0002", "writer").expect("second");
        let coverage = || -> Vec<i64> {
            let guard = log.connection();
            let connection = guard.lock().expect("lock");
            let mut statement = connection.prepare("SELECT upto_seq FROM coverage WHERE board_id = 'board' ORDER BY upto_seq").expect("prepare");
            statement.query_map([], |row| row.get(0)).expect("rows").collect::<Result<Vec<_>, _>>().expect("collect")
        };
        assert_eq!(coverage(), vec![2, 4]);
        advance_now(120_000);
        assert_eq!(log.prune("board").expect("prune"), 4);
        assert!(coverage().is_empty(), "every covered prefix is gone, so its coverage is too");
        // And a board with no coverage left prunes nothing further, rather than
        // deleting on a stale record.
        assert_eq!(log.prune("board").expect("second prune"), 0);
    }

    #[test]
    fn an_operation_older_than_the_window_but_above_the_checkpoint_is_kept() {
        let log = log();
        for id in ["a", "b", "c", "d"] {
            log.append("board", &[op(id)]).expect("append");
        }
        log.acquire_lease("board", "writer", 60_000).expect("lease");
        // The snapshot covers only the first operation. Operations 2..4 are then
        // *older than the retention window* — the case a time-only rule gets
        // wrong — and must still be here, because no snapshot covers them.
        log.commit_checkpoint("board", 1, 1, 1, "driveFileId0001", "writer").expect("commit");
        advance_now(30 * 24 * 60 * 60_000);
        assert_eq!(log.prune("board").expect("prune"), 1);
        let window = log.sync_from("board", 1, 10).expect("window");
        assert_eq!(window.ops.iter().map(|stored| stored.seq).collect::<Vec<_>>(), vec![2, 3, 4]);
    }

    #[test]
    fn a_covered_board_regains_capacity_and_accepts_appends_again() {
        // The production wedge, at a small bound: the board fills to its limit,
        // no append can succeed, and only retention can make room.
        let limits = SyncLogLimits { max_ops_per_board: 8, retention_ms: 60_000, now_ms: clock(), ..Default::default() };
        let log = SyncLog::in_memory(limits).expect("open");
        let batch: Vec<OperationInput> = (0..8).map(|index| op(&format!("op-{index}"))).collect();
        log.append("board", &batch).expect("fill");
        assert!(matches!(log.append("board", &[op("overflow")]), Err(SyncLogError::Full)), "the wedge is real");

        log.acquire_lease("board", "writer", 60_000).expect("lease");
        // The writer publishes a snapshot covering everything the board holds.
        log.commit_checkpoint("board", 1, 8, 1, "driveFileId0001", "writer").expect("commit");
        // Inside the window, the full board still refuses: retention is not a
        // pressure valve that overrides the retrieval promise.
        assert!(matches!(log.append("board", &[op("too-early")]), Err(SyncLogError::Full)));
        assert_eq!(log.prune("board").expect("prune"), 0);

        advance_now(61_000);
        assert_eq!(log.prune("board").expect("prune"), 8);
        // The log is empty of covered rows, so the sequence continues from 9 —
        // a recovered board never reuses a sequence a client may have applied.
        let appended = log.append("board", &[op("after")]).expect("append after pruning");
        assert_eq!(appended, vec![AppendReceipt::Accepted { seq: 9 }]);
    }

    #[test]
    fn retention_is_measured_per_segment_not_from_the_newest_commit() {
        // A board that consolidates steadily must still age out its old
        // segments. Anchoring to the newest commit would refresh the anchor on
        // every publish and never free anything, which is the wedge again.
        let log = log();
        for id in ["a", "b", "c", "d", "e", "f"] {
            log.append("board", &[op(id)]).expect("append");
        }
        log.acquire_lease("board", "writer", 600_000).expect("lease");
        log.commit_checkpoint("board", 1, 2, 1, "driveFileId0001", "writer").expect("first");
        advance_now(40_000);
        log.commit_checkpoint("board", 1, 4, 2, "driveFileId0002", "writer").expect("second");
        advance_now(40_000);
        log.commit_checkpoint("board", 1, 6, 3, "driveFileId0003", "writer").expect("third");
        // 80s since the first segment, 40s since the second, none since the
        // third; the window is 60s, so only the first is eligible — and the
        // board prunes *something* even though a commit landed 40 seconds ago.
        // Anchored to the newest commit instead, this would have been zero.
        assert_eq!(log.prune("board").expect("prune"), 2);
        assert_eq!(log.sync_from("board", 2, 10).expect("window").ops.iter().map(|stored| stored.seq).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
        // A window later the second segment ages out and the board keeps draining.
        advance_now(40_000);
        assert_eq!(log.prune("board").expect("second prune"), 2);
        assert_eq!(log.sync_from("board", 4, 10).expect("window").ops.iter().map(|stored| stored.seq).collect::<Vec<_>>(), vec![5, 6]);
    }

    #[test]
    fn a_bounded_prune_pass_removes_a_prefix_and_resumes_next_time() {
        let log = log();
        for id in ["a", "b", "c", "d", "e"] {
            log.append("board", &[op(id)]).expect("append");
        }
        log.acquire_lease("board", "writer", 60_000).expect("lease");
        log.commit_checkpoint("board", 1, 5, 1, "driveFileId0001", "writer").expect("commit");
        advance_now(120_000);
        // Two at a time: the sweep must never hold the writer lock for a whole
        // board, and a partial pass must still leave a contiguous prefix retained.
        assert_eq!(log.prune_limited("board", 2).expect("first pass"), 2);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.iter().map(|stored| stored.seq).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert_eq!(log.prune_batch(16, 2).expect("sweep"), vec![("board".to_string(), 2)]);
        // The sweep rotates past what it has seen: a second call reaches the
        // board again rather than stopping at the first 16 boards forever.
        assert_eq!(log.prune_batch(16, 2).expect("second sweep"), vec![("board".to_string(), 1)]);
        assert_eq!(log.prune_batch(16, 2).expect("empty sweep"), Vec::new());
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 0);
    }

    #[test]
    fn a_reconnect_below_the_pruned_prefix_asks_for_a_snapshot() {
        // The production meaning of `snapshot_required`: the server no longer has
        // the operations the client needs, and it says so with the checkpoint to
        // adopt rather than quietly returning the newer rows.
        let log = log();
        for id in ["a", "b", "c", "d"] {
            log.append("board", &[op(id)]).expect("append");
        }
        log.acquire_lease("board", "writer", 60_000).expect("lease");
        log.commit_checkpoint("board", 1, 3, 7, "driveFileId0001", "writer").expect("commit");
        advance_now(120_000);
        log.prune("board").expect("prune");
        for cursor in [0, 1, 2] {
            assert_eq!(
                log.sync_from("board", cursor, 10).expect("window").gap,
                Some(ReplayGap::Pruned { checkpoint_seq: 3, checkpoint_epoch: 1, snapshot_seq: 7 }),
                "cursor {cursor} is below the pruned prefix"
            );
        }
        // A cursor at the checkpoint is current, not behind.
        assert_eq!(log.sync_from("board", 3, 10).expect("window").gap, None);
    }

    #[test]
    fn an_unparseable_checkpoint_row_never_authorises_a_prune() {
        // Defence in depth for a database written before evidence was typed:
        // even with a coverage row present, a checkpoint whose stored evidence is
        // not a receipt is not a licence to delete anything.
        let log = log();
        log.append("board", &[op("a"), op("b")]).expect("append");
        log.acquire_lease("board", "writer", 60_000).expect("lease");
        log.commit_checkpoint("board", 1, 2, 1, "driveFileId0001", "writer").expect("commit");
        {
            let guard = log.connection();
            let connection = guard.lock().expect("lock");
            connection.execute("UPDATE checkpoint SET drive_etag = 'not an id' WHERE board_id = 'board'", []).expect("damage");
        }
        advance_now(120_000);
        assert_eq!(log.prune("board").expect("prune"), 0);
        assert_eq!(log.sync_from("board", 0, 10).expect("window").ops.len(), 2);
    }

    #[test]
    fn survives_reopening_a_file_that_holds_data() {
        let limits = limits();
        let directory = std::env::temp_dir().join(format!("pboard-sync-log-restart-{}", uuid()));
        {
            let log = SyncLog::open(&directory, limits.clone()).expect("open");
            log.append("board", &[op("a"), op("b")]).expect("append");
            log.integrity_check().expect("integrity");
        }
        let log = SyncLog::open(&directory, limits).expect("reopen");
        let window = log.sync_from("board", 1, 10).expect("window");
        assert_eq!(window.ops.iter().map(|stored| stored.op_id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(window.live_from_seq, 3);
        log.integrity_check().expect("still consistent");
        log.checkpoint_wal().expect("wal checkpoint");
        std::fs::remove_file(&directory).ok();
        std::fs::remove_file(format!("{}.wal", directory.display())).ok();
        std::fs::remove_file(format!("{}-shm", directory.display())).ok();
    }

    #[test]
    fn an_unknown_board_is_an_empty_window_not_an_error() {
        let log = log();
        let window = log.sync_from("never-seen", 0, 10).expect("window");
        assert!(window.ops.is_empty());
        assert_eq!(window.live_from_seq, 1);
        assert_eq!(window.gap, None);
    }

    #[test]
    fn a_fencing_epoch_is_a_lease_reference_not_a_bearer_token() {
        let log = log();
        log.append("board", &[op("a")]).expect("append");
        log.acquire_lease("board", "writer-a", 60_000).expect("lease");
        // A guessed epoch that happens to be *newer* is not authorization, and the
        // answer reports the epoch the board really is on, not the one invented.
        assert!(matches!(
            log.commit_checkpoint("board", 99, 1, 1, "driveFileId0001", "writer-b"),
            Err(SyncLogError::EpochStale { current: 1 })
        ));
        // Even the right epoch does not authorize a device that did not lease it.
        assert!(matches!(
            log.commit_checkpoint("board", 1, 1, 1, "driveFileId0001", "writer-b"),
            Err(SyncLogError::EpochStale { current: 1 })
        ));
        log.commit_checkpoint("board", 1, 1, 1, "driveFileId0001", "writer-a").expect("holder commits");
    }

    #[test]
    fn reports_health_per_board() {
        let log = log();
        log.append("board-a", &[op("a"), op("b")]).expect("append");
        log.acquire_lease("board-a", "writer", 60_000).expect("lease");
        let boards = log.boards().expect("boards");
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].next_seq, 3);
        assert_eq!(boards[0].oldest_retained_seq, Some(1));
        assert_eq!(boards[0].retained_ops, 2);
        assert_eq!(boards[0].lease.as_ref().map(|lease| lease.holder.as_str()), Some("writer"));
        let stats = log.stats().expect("stats");
        assert_eq!(stats.get("retainedOperations"), Some(&2));
    }

    fn uuid() -> String {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
    }
}
