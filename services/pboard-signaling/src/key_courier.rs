//! Key courier: a bounded mailbox for public-key-wrapped board content keys.
//!
//! Two devices of one Google account have to agree on a board's AES content key
//! without the signaling service ever learning it. Each device publishes an
//! ECDH wrap key; a device that already holds the content key seals it to a
//! peer's wrap key and posts the result here; the peer fetches the rows
//! addressed to it and opens them locally. The service stores opaque base64
//! blobs, validates only their size and shape, and holds neither a plaintext
//! nor any key that opens one. Nothing in this module can decrypt an envelope,
//! which is the invariant: the courier is storage, not a cryptographer.
//!
//! The trust boundary is the operation log's, unchanged: a connection may touch
//! a board's keys only if it is admitted to that board's room, and the caller's
//! `deviceKeyId` is the one authenticated at `authenticate` — a device id in a
//! request body is never believed. [`KeyCourier::key_grants_for`] selects by
//! the caller's authenticated id, so one device cannot read another device's
//! mailbox even on the same board, and [`KeyCourier::device_keys`] is scoped to
//! one board because this connection's admission says nothing about any other.
//!
//! Tables live in the operation log's database file, added as schema version 2
//! in the same versioned-migration style as [`crate::sync_log::SyncLog::migrate`]
//! — never a bare `CREATE TABLE` that would surprise an existing deployment.
//!
//! Deliberate non-responsibilities:
//!
//! * **Revocation.** A departed device keeps every content key it already
//!   received; nothing here takes that ability back. Content rotation is a
//!   separate decision, and the protocol docs say so rather than implying a
//!   guarantee.
//! * **Pruning.** [`crate::sync_log::SyncLog::prune`] deletes operations a
//!   published snapshot provably covers; key rows are never deleted with them.
//!   A board's wrap keys outlive its retained operations — a device that
//!   reconnects after a prune still finds its peers' keys and its own mail —
//!   and the caps below bound both tables absolutely, so keeping them cannot
//!   grow without limit. When in doubt, keep them.
use std::fmt;
use std::sync::{Arc, Mutex};

use base64::{Engine, engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD}};
use rusqlite::{Connection, params, OptionalExtension};

use crate::sync_log::{SyncLog, valid_id};

/// A P-256 SPKI document is 91 DER bytes; 128 leaves room for a future curve
/// without letting a "public key" become a blob store.
pub const MAX_PUBLIC_KEY_BYTES: usize = 128;
/// One AES-256-GCM envelope (12-byte IV plus ciphertext plus tag) is well under
/// this; 1 KiB is the cap, not an expectation.
pub const MAX_ENVELOPE_BYTES: usize = 1024;
/// One device publishes to the whole roster in one frame; rosters are bounded
/// by admission, so 32 is generous and still far under the message budget.
pub const MAX_GRANTS_PER_BATCH: usize = 32;
/// Wrap keys per board. Devices per board are bounded by admission; 64 caps
/// the table absolutely even if a board's membership churns.
pub const MAX_DEVICE_KEYS_PER_BOARD: usize = 64;
/// The id charset and length the rest of the service accepts.
const MAX_ID_BYTES: usize = 256;

pub enum CourierError {
    /// An id was outside the accepted charset, or a blob was not base64.
    Invalid(&'static str),
    /// `publicKey` decoded to more than [`MAX_PUBLIC_KEY_BYTES`].
    PublicKeyTooLarge,
    /// An envelope decoded to more than [`MAX_ENVELOPE_BYTES`].
    EnvelopeTooLarge,
    /// A batch was empty or held more than [`MAX_GRANTS_PER_BATCH`] entries.
    BatchTooLarge,
    /// The board already stores [`MAX_DEVICE_KEYS_PER_BOARD`] distinct devices'
    /// keys and this publish would add a sixty-fifth.
    TooManyDeviceKeys,
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for CourierError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "invalid: {reason}"),
            Self::PublicKeyTooLarge => f.write_str("public key over cap"),
            Self::EnvelopeTooLarge => f.write_str("envelope over cap"),
            Self::BatchTooLarge => f.write_str("batch over cap"),
            Self::TooManyDeviceKeys => f.write_str("board device key capacity exhausted"),
            Self::Io(error) => write!(f, "io: {error}"),
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
        }
    }
}

impl fmt::Debug for CourierError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for CourierError {}
impl From<std::io::Error> for CourierError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<rusqlite::Error> for CourierError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// One entry of a `publishKeyGrants` batch: an envelope this connection's
/// authenticated device addressed to `to_device_key_id`.
#[derive(Clone, Debug)]
pub struct KeyGrantInput {
    pub to_device_key_id: String,
    /// Base64 as the client sent it. Stored and echoed verbatim.
    pub envelope: String,
}

/// A published wrap key, as `listDeviceKeys` answers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceKeyRecord {
    pub device_key_id: String,
    pub public_key: String,
}

/// A stored envelope, as `fetchKeyGrants` answers it. The recipient is never
/// part of the answer — the caller is the recipient and already knows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyGrantRecord {
    pub from_device_key_id: String,
    pub envelope: String,
}

/// The courier. Shares the operation log's connection (hence its mutex and its
/// one-writer property); see [`SyncLog::connection`].
pub struct KeyCourier {
    connection: Arc<Mutex<Connection>>,
}

impl KeyCourier {
    /// Attaches to an opened operation log's database, migrating the schema to
    /// version 2 when the courier tables are not yet present. Constructing one
    /// requires a live [`SyncLog`] precisely because the tables must live in the
    /// log's file, under the log's versioned schema.
    pub fn from_sync_log(log: &SyncLog) -> Result<Self, CourierError> {
        let courier = Self { connection: log.connection() };
        courier.migrate()?;
        Ok(courier)
    }

    /// Applies the version 2 step. Read the shared `sync_schema` table exactly
    /// the way [`SyncLog::migrate`] reads its own: a newer file is refused, not
    /// reshaped, and each step inserts the version it completed.
    fn migrate(&self) -> Result<(), CourierError> {
        let mut connection = self.connection.lock().expect("sync log mutex");
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_schema (version INTEGER NOT NULL);",
        )?;
        let version: i64 = transaction
            .query_row("SELECT COALESCE(MAX(version), 0) FROM sync_schema", [], |row| row.get(0))
            .optional()?
            .unwrap_or(0);
        // The ceiling is the *shared* constant, not a literal: the courier shares
        // one file and one version counter with the operation log, so a log step
        // that raises the version (the retention schema, v3) must not make every
        // courier open fail with "written by a newer Pboard service". The
        // courier's own step below is still keyed to version 2.
        if version > crate::sync_log::SUPPORTED_SCHEMA_VERSION {
            return Err(CourierError::Invalid("database was written by a newer Pboard service"));
        }
        if version < 1 {
            // The operation log migrates version 1 before anything can open the
            // file; arriving here would mean it never ran, and silently
            // creating half a schema on top of an unknown file is worse.
            return Err(CourierError::Invalid("operation log schema is missing"));
        }
        // Version numbers are a *high-water mark* of what has been applied, not a
        // sequence every module must walk through: the log's own step to 3 lands
        // before this one runs on a fresh file. So the courier's step is keyed to
        // the absence of its tables, not to the counter. `CREATE TABLE IF NOT
        // EXISTS` makes the step idempotent, and recording version 2 only when it
        // is the highest applied keeps the counter monotone for readers.
        let courier_tables: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('device_key', 'key_grant')",
            [],
            |row| row.get(0),
        )?;
        if courier_tables < 2 {
            transaction.execute_batch(
                "CREATE TABLE device_key (
                     board_id      TEXT NOT NULL,
                     device_key_id TEXT NOT NULL,
                     public_key    TEXT NOT NULL,
                     updated_at    INTEGER NOT NULL,
                     PRIMARY KEY (board_id, device_key_id)
                 );
                 CREATE TABLE key_grant (
                     board_id           TEXT NOT NULL,
                     from_device_key_id TEXT NOT NULL,
                     to_device_key_id   TEXT NOT NULL,
                     envelope           TEXT NOT NULL,
                     updated_at         INTEGER NOT NULL,
                     PRIMARY KEY (board_id, from_device_key_id, to_device_key_id)
                 );
                 -- Fetching is always \"this board's mail for this device\", and
                 -- the primary key is ordered by sender, so the recipient side
                 -- needs its own index rather than a table scan.
                 CREATE INDEX key_grant_by_recipient ON key_grant (board_id, to_device_key_id);",
            )?;
            // Only record the version when it is still the highest applied; on a
            // file that has already reached 3, inserting 2 would leave MAX() at 3
            // anyway, but the row would be a false history of what ran.
            if version < 2 {
                transaction.execute("INSERT INTO sync_schema (version) VALUES (2)", [])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Stores (or replaces) one device's wrap key for one board. The answer is
    /// `false` only when the row already held exactly this key: a re-publish of
    /// an unchanged key is an idempotent no-op, and the caller may treat both
    /// answers as stored. A board at capacity refuses a *new* device with
    /// [`CourierError::TooManyDeviceKeys`] rather than evicting an old one —
    /// silently dropping a peer's key would deny that peer its content keys,
    /// and sixty-four devices on one board is the cap saying stop.
    pub fn publish_device_key(&self, board: &str, device_key_id: &str, public_key: &str) -> Result<bool, CourierError> {
        if !valid_id(board, MAX_ID_BYTES) || !valid_id(device_key_id, MAX_ID_BYTES) {
            return Err(CourierError::Invalid("identifier"));
        }
        decode_bounded(public_key, MAX_PUBLIC_KEY_BYTES, CourierError::PublicKeyTooLarge)?;
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT public_key FROM device_key WHERE board_id = ?1 AND device_key_id = ?2",
                params![board, device_key_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_none() {
            let stored: i64 = transaction
                .query_row("SELECT COUNT(*) FROM device_key WHERE board_id = ?1", params![board], |row| row.get(0))?;
            if stored >= MAX_DEVICE_KEYS_PER_BOARD as i64 {
                return Err(CourierError::TooManyDeviceKeys);
            }
        } else if existing.as_deref() == Some(public_key) {
            return Ok(false);
        }
        let now = crate::now_ms() as i64;
        transaction.execute(
            "INSERT INTO device_key (board_id, device_key_id, public_key, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (board_id, device_key_id) DO UPDATE SET public_key = ?3, updated_at = ?4",
            params![board, device_key_id, public_key, now],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    /// Every device that published a wrap key for this board, including the
    /// caller. Scoped to one board because the connection's admission covers
    /// exactly that one; there is no cross-board roster here to leak.
    pub fn device_keys(&self, board: &str) -> Result<Vec<DeviceKeyRecord>, CourierError> {
        if !valid_id(board, MAX_ID_BYTES) {
            return Err(CourierError::Invalid("board id"));
        }
        let guard = self.connection.lock().expect("sync log mutex");
        let mut statement = guard.prepare("SELECT device_key_id, public_key FROM device_key WHERE board_id = ?1 ORDER BY device_key_id")?;
        let rows = statement.query_map(params![board], |row| {
            Ok(DeviceKeyRecord { device_key_id: row.get(0)?, public_key: row.get(1)? })
        })?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    /// Stores a batch of envelopes from the caller to named recipients and
    /// returns how many were stored. Every entry is validated *before* anything
    /// is written: one oversized envelope in a batch of thirty-two refuses the
    /// batch whole, exactly as an over-capacity operation batch does, because a
    /// partial store would leave the client with a count it cannot retry
    /// idempotently. An envelope for a given sender+recipient is *replaced*, so
    /// re-wrapping a rotated key cannot grow the row count; a batch naming the
    /// same recipient twice is legal and the last entry wins.
    pub fn publish_key_grants(&self, board: &str, from_device_key_id: &str, grants: &[KeyGrantInput]) -> Result<usize, CourierError> {
        if !valid_id(board, MAX_ID_BYTES) || !valid_id(from_device_key_id, MAX_ID_BYTES) {
            return Err(CourierError::Invalid("identifier"));
        }
        if grants.is_empty() || grants.len() > MAX_GRANTS_PER_BATCH {
            return Err(CourierError::BatchTooLarge);
        }
        for grant in grants {
            if !valid_id(&grant.to_device_key_id, MAX_ID_BYTES) {
                return Err(CourierError::Invalid("recipient id"));
            }
            decode_bounded(&grant.envelope, MAX_ENVELOPE_BYTES, CourierError::EnvelopeTooLarge)?;
        }
        let mut guard = self.connection.lock().expect("sync log mutex");
        let transaction = guard.transaction()?;
        let now = crate::now_ms() as i64;
        for grant in grants {
            transaction.execute(
                "INSERT INTO key_grant (board_id, from_device_key_id, to_device_key_id, envelope, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (board_id, from_device_key_id, to_device_key_id) DO UPDATE SET envelope = ?4, updated_at = ?5",
                params![board, from_device_key_id, grant.to_device_key_id, grant.envelope, now],
            )?;
        }
        transaction.commit()?;
        Ok(grants.len())
    }

    /// The caller's mail: envelopes addressed to `to_device_key_id` — which the
    /// protocol layer passes from the *authenticated* identity, never from a
    /// frame body. One device reading another device's envelopes is the entire
    /// attack this function is designed against, so the parameter list is the
    /// defense: there is no call shape that selects "someone else's inbox".
    pub fn key_grants_for(&self, board: &str, to_device_key_id: &str) -> Result<Vec<KeyGrantRecord>, CourierError> {
        if !valid_id(board, MAX_ID_BYTES) || !valid_id(to_device_key_id, MAX_ID_BYTES) {
            return Err(CourierError::Invalid("identifier"));
        }
        let guard = self.connection.lock().expect("sync log mutex");
        let mut statement = guard.prepare(
            "SELECT from_device_key_id, envelope FROM key_grant
             WHERE board_id = ?1 AND to_device_key_id = ?2 ORDER BY from_device_key_id",
        )?;
        let rows = statement.query_map(params![board, to_device_key_id], |row| {
            Ok(KeyGrantRecord { from_device_key_id: row.get(0)?, envelope: row.get(1)? })
        })?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }
}

/// Caps are on *decoded* bytes, so the blob must actually be base64. It is
/// otherwise opaque: decoded content is never inspected, and the original
/// string is what gets stored and echoed. Canonical encoding is unpadded
/// base64url like every other id in this protocol, but the padded standard
/// dialect decodes too — refusing an interoperable client's padding would be an
/// outage without being any safer.
fn decode_bounded(value: &str, max: usize, too_large: CourierError) -> Result<(), CourierError> {
    // Cheap pre-check: no dialect encodes `max` bytes in more characters.
    if value.len() > max.div_ceil(3) * 4 {
        return Err(too_large);
    }
    for engine in [&URL_SAFE_NO_PAD, &STANDARD, &STANDARD_NO_PAD] {
        if let Ok(bytes) = engine.decode(value) {
            if bytes.is_empty() {
                return Err(CourierError::Invalid("empty base64"));
            }
            if bytes.len() > max {
                return Err(too_large);
            }
            return Ok(());
        }
    }
    Err(CourierError::Invalid("malformed base64"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn courier() -> (SyncLog, KeyCourier) {
        let log = SyncLog::in_memory(Default::default()).expect("open log");
        let courier = KeyCourier::from_sync_log(&log).expect("open courier");
        (log, courier)
    }

    fn key(label: &str) -> String {
        URL_SAFE_NO_PAD.encode(format!("spki:{label}"))
    }
    fn envelope(label: &str) -> String {
        URL_SAFE_NO_PAD.encode(format!("iv+ct:{label}"))
    }
    fn grant(to: &str, envelope: &str) -> KeyGrantInput {
        KeyGrantInput { to_device_key_id: to.into(), envelope: envelope.into() }
    }

    #[test]
    fn a_republished_wrap_key_replaces_instead_of_appending() {
        let (_log, courier) = courier();
        assert!(courier.publish_device_key("board", "device-a", &key("one")).expect("first"));
        assert!(courier.publish_device_key("board", "device-b", &key("bee")).expect("other"));
        // Same bytes again is an idempotent no-op, not a second row or a change.
        assert!(!courier.publish_device_key("board", "device-a", &key("one")).expect("retry"));
        assert!(courier.publish_device_key("board", "device-a", &key("two")).expect("rotate"));
        let keys = courier.device_keys("board").expect("list");
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0], DeviceKeyRecord { device_key_id: "device-a".into(), public_key: key("two") });
        assert_eq!(keys[1].device_key_id, "device-b");
    }

    #[test]
    fn a_republished_envelope_is_replaced_not_appended_per_sender_and_recipient() {
        let (_log, courier) = courier();
        assert_eq!(courier.publish_key_grants("board", "device-a", &[grant("device-b", &envelope("v1"))]).expect("first"), 1);
        assert_eq!(courier.publish_key_grants("board", "device-a", &[grant("device-b", &envelope("v2"))]).expect("re-wrap"), 1);
        // The re-wrap of a rotated content key leaves exactly one row, holding
        // the newer envelope: replace-not-append is what bounds the table.
        let mail = courier.key_grants_for("board", "device-b").expect("mail");
        assert_eq!(mail, vec![KeyGrantRecord { from_device_key_id: "device-a".into(), envelope: envelope("v2") }]);
        // A different sender to the same recipient is a different row; a batch
        // naming one recipient twice keeps the last entry.
        courier.publish_key_grants("board", "device-c", &[grant("device-b", &envelope("other"))]).expect("c");
        courier.publish_key_grants("board", "device-a", &[grant("device-b", &envelope("x")), grant("device-b", &envelope("y"))]).expect("twice");
        let mail = courier.key_grants_for("board", "device-b").expect("mail");
        assert_eq!(mail.len(), 2);
        assert!(mail.iter().any(|row| row.from_device_key_id == "device-a" && row.envelope == envelope("y")));
    }

    #[test]
    fn fetching_selects_the_callers_mailbox_only() {
        let (_log, courier) = courier();
        courier.publish_key_grants("board", "sender", &[grant("device-a", &envelope("for-a")), grant("device-b", &envelope("for-b"))]).expect("publish");
        let a = courier.key_grants_for("board", "device-a").expect("a");
        assert_eq!(a, vec![KeyGrantRecord { from_device_key_id: "sender".into(), envelope: envelope("for-a") }]);
        let b = courier.key_grants_for("board", "device-b").expect("b");
        assert_eq!(b, vec![KeyGrantRecord { from_device_key_id: "sender".into(), envelope: envelope("for-b") }]);
        // A third device on the same board reads nothing of the exchange.
        assert!(courier.key_grants_for("board", "device-c").expect("c").is_empty());
        // Boards are isolated from each other exactly as devices are.
        courier.publish_key_grants("other-board", "sender", &[grant("device-a", &envelope("elsewhere"))]).expect("other");
        assert_eq!(courier.key_grants_for("board", "device-a").expect("still one").len(), 1);
    }

    #[test]
    fn an_envelope_over_one_kibibyte_is_refused_not_truncated() {
        let (_log, courier) = courier();
        let at_cap = URL_SAFE_NO_PAD.encode(vec![7u8; MAX_ENVELOPE_BYTES]);
        courier.publish_key_grants("board", "device-a", &[grant("device-b", &at_cap)]).expect("at cap");
        let over = URL_SAFE_NO_PAD.encode(vec![7u8; MAX_ENVELOPE_BYTES + 1]);
        assert!(matches!(courier.publish_key_grants("board", "device-a", &[grant("device-b", &over)]), Err(CourierError::EnvelopeTooLarge)));
        // The refused envelope left the stored one alone.
        assert_eq!(courier.key_grants_for("board", "device-b").expect("mail")[0].envelope, at_cap);
        let big_key = URL_SAFE_NO_PAD.encode(vec![7u8; MAX_PUBLIC_KEY_BYTES + 1]);
        assert!(matches!(courier.publish_device_key("board", "device-a", &big_key), Err(CourierError::PublicKeyTooLarge)));
        assert!(courier.device_keys("board").expect("list").is_empty());
    }

    #[test]
    fn a_batch_over_thirty_two_grants_is_refused_whole_before_storing() {
        let (_log, courier) = courier();
        let many: Vec<KeyGrantInput> = (0..=MAX_GRANTS_PER_BATCH).map(|index| grant(&format!("device-{index}"), &envelope("x"))).collect();
        assert!(matches!(courier.publish_key_grants("board", "device-a", &many), Err(CourierError::BatchTooLarge)));
        assert!(matches!(courier.publish_key_grants("board", "device-a", &[]), Err(CourierError::BatchTooLarge)));
        let at_cap: Vec<KeyGrantInput> = (0..MAX_GRANTS_PER_BATCH).map(|index| grant(&format!("device-{index}"), &envelope("x"))).collect();
        assert_eq!(courier.publish_key_grants("board", "device-a", &at_cap).expect("at cap"), MAX_GRANTS_PER_BATCH);
        // One bad envelope among good ones stores none of them.
        let over = URL_SAFE_NO_PAD.encode(vec![7u8; MAX_ENVELOPE_BYTES + 1]);
        let mixed = [grant("device-ok", &envelope("fine")), grant("device-bad", &over)];
        assert!(matches!(courier.publish_key_grants("board", "device-a", &mixed), Err(CourierError::EnvelopeTooLarge)));
        assert!(courier.key_grants_for("board", "device-ok").expect("mail").is_empty());
    }

    #[test]
    fn a_board_holds_sixty_four_wrap_keys_and_no_more() {
        let (_log, courier) = courier();
        for index in 0..MAX_DEVICE_KEYS_PER_BOARD {
            let device = format!("device-{index}");
            assert!(courier.publish_device_key("board", &device, &key(&device)).expect("publish"));
        }
        assert!(matches!(courier.publish_device_key("board", "device-64", &key("late")), Err(CourierError::TooManyDeviceKeys)));
        // At capacity, a device already on the roster may still rotate its key:
        // the cap counts devices, not publishes.
        assert!(courier.publish_device_key("board", "device-0", &key("rotated")).expect("rotate"));
        // And the cap is per board, not global.
        assert!(courier.publish_device_key("other-board", "device-64", &key("late")).expect("other board"));
    }

    #[test]
    fn malformed_blobs_and_hostile_ids_are_refused_before_storage() {
        let (_log, courier) = courier();
        assert!(matches!(courier.publish_device_key("board", "device-a", "not base64 !"), Err(CourierError::Invalid(_))));
        assert!(matches!(courier.publish_device_key("board", "device-a", ""), Err(CourierError::Invalid(_))));
        assert!(matches!(courier.publish_device_key("board", "has space", &key("x")), Err(CourierError::Invalid(_))));
        assert!(matches!(courier.publish_device_key("board/../x", "device-a", &key("x")), Err(CourierError::Invalid(_))));
        assert!(matches!(courier.publish_key_grants("board", "device-a", &[grant("bad id", &envelope("x"))]), Err(CourierError::Invalid(_))));
        assert!(matches!(courier.device_keys(""), Err(CourierError::Invalid(_))));
        assert!(matches!(courier.key_grants_for("board", ""), Err(CourierError::Invalid(_))));
        // None of the refusals created a row.
        assert!(courier.device_keys("board").expect("list").is_empty());
        assert!(courier.key_grants_for("board", "device-a").expect("mail").is_empty());
    }

    #[test]
    fn base64_dialects_decode_to_the_same_cap() {
        let (_log, courier) = courier();
        // Canonical is unpadded base64url; padded standard decodes too, and the
        // string the client sent is what a later list echoes back.
        let padded = STANDARD.encode([9u8; 40]);
        assert!(courier.publish_device_key("board", "device-a", &padded).expect("padded"));
        assert_eq!(courier.device_keys("board").expect("list")[0].public_key, padded);
        // 40 bytes encoded with padding is 56 characters; the same 40 bytes in
        // canonical form must sit under the same cap either way, while 129
        // decoded bytes is over it no matter the dialect.
        let over = STANDARD.encode(vec![9u8; MAX_PUBLIC_KEY_BYTES + 1]);
        assert!(matches!(courier.publish_device_key("board", "device-b", &over), Err(CourierError::PublicKeyTooLarge)));
    }

    #[test]
    fn the_courier_shares_the_logs_database_and_survives_a_reopen() {
        let directory = std::env::temp_dir().join(format!("pboard-key-courier-{}", std::process::id()));
        {
            let log = SyncLog::open(&directory, Default::default()).expect("open log");
            let courier = KeyCourier::from_sync_log(&log).expect("open courier");
            courier.publish_device_key("board", "device-a", &key("one")).expect("publish");
            log.integrity_check().expect("integrity");
        }
        // Reopening runs both migration steps against a version 2 file; nothing
        // is recreated, refused, or lost.
        let log = SyncLog::open(&directory, Default::default()).expect("reopen log");
        let courier = KeyCourier::from_sync_log(&log).expect("reopen courier");
        assert_eq!(courier.device_keys("board").expect("list")[0].public_key, key("one"));
        std::fs::remove_file(&directory).ok();
        std::fs::remove_file(format!("{}.wal", directory.display())).ok();
        std::fs::remove_file(format!("{}-shm", directory.display())).ok();
    }
}
