//! Durable per-board operation buffer (Sync v2).
//!
//! The buffer holds sealed (encrypted by the client — the server only ever
//! stores and returns opaque base64url fields) application operations until a
//! leader confirms they are inside a published Drive snapshot. It is insurance
//! against crashes and leader changes, never a canonical store: the client
//! journal and Drive snapshots remain the authority.
//!
//! Durability model: an append-only, fsync'd journal with an in-memory index,
//! replayed on open. Records: `{"t":"a",...}` op appends, `{"t":"c",...}`
//! commit marks. A torn final line (crash mid-append) is truncated on replay;
//! append-then-fsync means an acknowledged op is never silently lost.
//! Committed ops stop being returned by `list` immediately and leave the file
//! at the next compaction (atomic temp + fsync + rename, the same persistence
//! pattern as the enrollment registry).
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, Write};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum BufferError {
    Invalid(&'static str),
    TooLarge,
    Full,
    Io(std::io::Error),
}

impl fmt::Display for BufferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "invalid: {reason}"),
            Self::TooLarge => f.write_str("op exceeds the size limit"),
            Self::Full => f.write_str("buffer full"),
            Self::Io(error) => write!(f, "io: {error}"),
        }
    }
}

impl std::error::Error for BufferError {}
impl From<std::io::Error> for BufferError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<serde_json::Error> for BufferError {
    fn from(_: serde_json::Error) -> Self {
        Self::Invalid("serialization")
    }
}

#[derive(Clone)]
pub struct BufferLimits {
    pub max_op_bytes: usize,
    pub max_ops_per_board: usize,
    pub max_bytes_per_board: usize,
    pub max_total_bytes: usize,
    /// How long committed ops may remain on disk for post-crash auditing
    /// before compaction may drop them. Never applies to uncommitted ops.
    pub retention_ms: u64,
    pub now_ms: fn() -> u64,
}

impl Default for BufferLimits {
    fn default() -> Self {
        Self {
            max_op_bytes: 64 * 1024,
            max_ops_per_board: 50_000,
            max_bytes_per_board: 32 * 1024 * 1024,
            max_total_bytes: 256 * 1024 * 1024,
            retention_ms: 7 * 24 * 60 * 60 * 1000,
            now_ms: crate::now_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpInput {
    pub op_id: String,
    pub key_id: String,
    pub iv: String,
    pub ct: String,
}

#[derive(Clone, Debug)]
pub struct BufferedOp {
    pub op: OpInput,
    pub seq: u64,
    pub buffered_at: u64,
    pub committed_epoch: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "t", deny_unknown_fields)]
enum Record {
    #[serde(rename = "a")]
    Append {
        b: String,
        #[serde(rename = "at")]
        buffered_at: u64,
        op: OpInput,
    },
    #[serde(rename = "c")]
    Commit { b: String, epoch: u64, ids: Vec<String> },
}

#[derive(Default)]
struct BoardState {
    ops: Vec<BufferedOp>,
    ids: HashSet<String>,
    bytes: usize,
}

pub struct OpBuffer {
    path: PathBuf,
    file: File,
    limits: BufferLimits,
    boards: HashMap<String, BoardState>,
    next_seq: u64,
    live_bytes: usize,
    tombstone_bytes: usize,
}

fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.'))
}

impl OpBuffer {
    pub fn open(path: impl AsRef<Path>, limits: BufferLimits) -> Result<Self, BufferError> {
        let path = path.as_ref().to_path_buf();
        let existed = path.exists();
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path)?;
        let mut buffer = Self {
            path,
            file,
            limits,
            boards: HashMap::new(),
            next_seq: 1,
            live_bytes: 0,
            tombstone_bytes: 0,
        };
        if existed {
            buffer.replay()?;
        }
        buffer.file.seek(std::io::SeekFrom::End(0))?;
        Ok(buffer)
    }

    fn replay(&mut self) -> Result<(), BufferError> {
        let bytes = std::fs::read(&self.path)?;
        let mut good_len = 0usize;
        let mut applied = Vec::new();
        let mut reader = BufReader::new(bytes.as_slice());
        loop {
            let mut line = String::new();
            let read = reader.read_line(&mut line)?;
            if read == 0 {
                break;
            }
            match serde_json::from_str::<Record>(line.trim_end()) {
                Ok(record) => {
                    good_len += read;
                    applied.push(record);
                }
                // A torn write can only be the final line; everything before
                // it was fsync'd and must survive.
                Err(_) => break,
            }
        }
        if good_len < bytes.len() {
            let truncated = OpenOptions::new().write(true).open(&self.path)?;
            truncated.set_len(good_len as u64)?;
        }
        for record in applied {
            match record {
                Record::Append { b, buffered_at, op } => {
                    let seq = self.next_seq;
                    self.next_seq += 1;
                    let size = op.ct.len() + op.op_id.len();
                    self.index(b, BufferedOp { op, seq, buffered_at, committed_epoch: None }, size);
                }
                Record::Commit { b, epoch, ids } => {
                    let (bytes, _) = self.mark_committed(&b, epoch, &ids);
                    self.tombstone_bytes += bytes;
                }
            }
        }
        Ok(())
    }

    fn index(&mut self, board: String, op: BufferedOp, size: usize) {
        self.live_bytes += size;
        let state = self.boards.entry(board).or_default();
        state.bytes += size;
        state.ids.insert(op.op.op_id.clone());
        state.ops.push(op);
    }

    /// Returns (newly tombstoned bytes, newly tombstoned count).
    fn mark_committed(&mut self, board: &str, epoch: u64, ids: &[String]) -> (usize, usize) {
        let Some(state) = self.boards.get_mut(board) else {
            return (0, 0);
        };
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut bytes = 0usize;
        let mut count = 0usize;
        for op in &mut state.ops {
            if op.committed_epoch.is_none() && wanted.contains(op.op.op_id.as_str()) {
                op.committed_epoch = Some(epoch);
                bytes += op.op.ct.len() + op.op.op_id.len();
                count += 1;
            }
        }
        (bytes, count)
    }

    fn ensure_valid(&self, board: &str, inputs: &[OpInput]) -> Result<(), BufferError> {
        if !valid_id(board, 256) {
            return Err(BufferError::Invalid("board id"));
        }
        if inputs.is_empty() || inputs.len() > 512 {
            return Err(BufferError::Invalid("batch size"));
        }
        for input in inputs {
            if !valid_id(&input.op_id, 256) || !valid_id(&input.key_id, 128) || !valid_id(&input.iv, 64) {
                return Err(BufferError::Invalid("op identifier fields"));
            }
            if input.ct.len() > self.limits.max_op_bytes {
                return Err(BufferError::TooLarge);
            }
        }
        Ok(())
    }

    /// Durably appends every op not already buffered (idempotent by op id).
    /// Either the whole batch is fsync'd before returning, or the journal is
    /// restored to its prior length and the caller gets an error.
    pub fn insert(&mut self, board: &str, inputs: &[OpInput]) -> Result<usize, BufferError> {
        self.ensure_valid(board, inputs)?;
        let now = (self.limits.now_ms)();
        let mut accepted: Vec<OpInput> = Vec::with_capacity(inputs.len());
        let mut seen: HashSet<&str> = HashSet::new();
        let (board_ops, board_bytes) = self
            .boards
            .get(board)
            .map(|state| (state.ops.len(), state.bytes))
            .unwrap_or((0, 0));
        let mut extra_bytes = 0usize;
        for input in inputs {
            if !seen.insert(input.op_id.as_str()) || self.boards.get(board).is_some_and(|state| state.ids.contains(&input.op_id)) {
                continue;
            }
            extra_bytes += input.ct.len() + input.op_id.len();
            if board_ops + accepted.len() + 1 > self.limits.max_ops_per_board
                || board_bytes + extra_bytes > self.limits.max_bytes_per_board
                || self.live_bytes + extra_bytes > self.limits.max_total_bytes
            {
                return Err(BufferError::Full);
            }
            accepted.push(input.clone());
        }
        if accepted.is_empty() {
            return Ok(0);
        }
        let mark = self.file.stream_position()?;
        let appended = (|| -> Result<(), BufferError> {
            for input in &accepted {
                let line = serde_json::to_string(&Record::Append {
                    b: board.to_string(),
                    buffered_at: now,
                    op: input.clone(),
                })?;
                self.file.write_all(line.as_bytes())?;
                self.file.write_all(b"\n")?;
            }
            self.file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = appended {
            let _ = self.file.set_len(mark);
            let _ = self.file.seek(std::io::SeekFrom::End(0));
            return Err(error);
        }
        let accepted_count = accepted.len();
        for input in accepted {
            let size = input.ct.len() + input.op_id.len();
            let seq = self.next_seq;
            self.next_seq += 1;
            self.index(board.to_string(), BufferedOp { op: input, seq, buffered_at: now, committed_epoch: None }, size);
        }
        Ok(accepted_count)
    }

    /// Uncommitted ops in arrival order — the leader's replay stream.
    pub fn list(&self, board: &str) -> Vec<&BufferedOp> {
        self.boards
            .get(board)
            .map(|state| state.ops.iter().filter(|op| op.committed_epoch.is_none()).collect())
            .unwrap_or_default()
    }

    /// Names the ops a published snapshot includes. They stop appearing in
    /// `list` immediately and leave the journal at the next compaction.
    pub fn commit(&mut self, board: &str, epoch: u64, ids: &[String]) -> Result<usize, BufferError> {
        if !valid_id(board, 256) || ids.len() > 100_000 {
            return Err(BufferError::Invalid("commit arguments"));
        }
        let line = serde_json::to_string(&Record::Commit { b: board.to_string(), epoch, ids: ids.to_vec() })?;
        let mark = self.file.stream_position()?;
        if let Err(error) = self.file.write_all(line.as_bytes()).and_then(|()| self.file.write_all(b"\n")).and_then(|()| self.file.sync_all()) {
            let _ = self.file.set_len(mark);
            return Err(BufferError::Io(error));
        }
        self.file.seek(std::io::SeekFrom::End(0))?;
        let (bytes, count) = self.mark_committed(board, epoch, ids);
        self.tombstone_bytes += bytes;
        if self.tombstone_bytes.saturating_mul(2) > self.live_bytes.max(1) {
            self.compact()?;
        }
        Ok(count)
    }

    /// Atomically rewrites the journal keeping only uncommitted ops. Committed
    /// ops past their audit retention are dropped; uncommitted ops are never
    /// aged out (cleanup happens only through confirmed consolidation).
    pub fn compact(&mut self) -> Result<(), BufferError> {
        let now = (self.limits.now_ms)();
        let temp = self.path.with_extension("compact");
        {
            let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(&temp)?;
            let mut entries: Vec<&String> = self.boards.keys().collect();
            entries.sort();
            for board in entries {
                for op in self.boards[board].ops.iter().filter(|op| {
                    op.committed_epoch.is_none() || now.saturating_sub(op.buffered_at) <= self.limits.retention_ms
                }) {
                    if op.committed_epoch.is_some() {
                        // Still inside the audit window: persist as an append
                        // plus a re-applied commit mark so replay rebuilds the
                        // same visibility state.
                        let append = serde_json::to_string(&Record::Append { b: board.clone(), buffered_at: op.buffered_at, op: op.op.clone() })?;
                        file.write_all(append.as_bytes())?;
                        file.write_all(b"\n")?;
                        let commit = serde_json::to_string(&Record::Commit {
                            b: board.clone(),
                            epoch: op.committed_epoch.unwrap_or_default(),
                            ids: vec![op.op.op_id.clone()],
                        })?;
                        file.write_all(commit.as_bytes())?;
                        file.write_all(b"\n")?;
                    } else {
                        let append = serde_json::to_string(&Record::Append { b: board.clone(), buffered_at: op.buffered_at, op: op.op.clone() })?;
                        file.write_all(append.as_bytes())?;
                        file.write_all(b"\n")?;
                    }
                }
            }
            file.sync_all()?;
        }
        std::fs::rename(&temp, &self.path)?;
        self.file = OpenOptions::new().read(true).write(true).open(&self.path)?;
        self.file.seek(std::io::SeekFrom::End(0))?;
        let cutoff = now.saturating_sub(self.limits.retention_ms);
        for state in self.boards.values_mut() {
            state.ops.retain(|op| !(op.committed_epoch.is_some() && op.buffered_at < cutoff));
            state.bytes = state.ops.iter().map(|op| op.op.ct.len() + op.op.op_id.len()).sum();
            state.ids = state.ops.iter().map(|op| op.op.op_id.clone()).collect();
        }
        self.boards.retain(|_, state| !state.ops.is_empty());
        self.live_bytes = self.boards.values().map(|state| state.bytes).sum();
        self.tombstone_bytes = 0;
        Ok(())
    }

    pub fn stats(&self) -> HashMap<String, (usize, usize)> {
        self.boards
            .iter()
            .map(|(board, state)| {
                (board.clone(), (state.ops.iter().filter(|op| op.committed_epoch.is_none()).count(), state.bytes))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static CLOCK: AtomicU64 = AtomicU64::new(1_000_000);
    fn clock() -> u64 {
        CLOCK.load(Ordering::Relaxed)
    }
    fn limits() -> BufferLimits {
        BufferLimits {
            max_op_bytes: 1024,
            max_ops_per_board: 3,
            max_bytes_per_board: 4096,
            max_total_bytes: 1 << 20,
            retention_ms: 500,
            now_ms: clock,
        }
    }
    fn dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("pboard-buffer-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn op(id: &str) -> OpInput {
        OpInput { op_id: format!("deviceA:{id}"), key_id: "k1".into(), iv: "aaa".into(), ct: format!("ct{id}") }
    }

    #[test]
    fn insert_is_idempotent_and_ordered() {
        let path = dir("insert").join("journal");
        let mut buffer = OpBuffer::open(&path, limits()).unwrap();
        assert_eq!(buffer.insert("b1", &[op("1"), op("2"), op("1")]).unwrap(), 2);
        assert_eq!(buffer.insert("b1", &[op("1")]).unwrap(), 0);
        let ids: Vec<&str> = buffer.list("b1").iter().map(|o| o.op.op_id.as_str()).collect();
        assert_eq!(ids, ["deviceA:1", "deviceA:2"]);
    }

    #[test]
    fn acknowledged_ops_survive_reopen_and_torn_tails() {
        let dir = dir("durability");
        let path = dir.join("journal");
        {
            let mut buffer = OpBuffer::open(&path, limits()).unwrap();
            buffer.insert("b1", &[op("1"), op("2")]).unwrap();
        }
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"t\":\"a\",\"b\":tru")
            .unwrap();
        let mut buffer = OpBuffer::open(&path, limits()).unwrap();
        assert_eq!(buffer.list("b1").len(), 2);
        assert_eq!(buffer.insert("b1", &[op("1"), op("3")]).unwrap(), 1);
    }

    #[test]
    fn limits_reject_without_side_effects() {
        let path = dir("limits").join("journal");
        let mut buffer = OpBuffer::open(&path, limits()).unwrap();
        assert!(matches!(
            buffer.insert("b1", &[OpInput { op_id: "d:1".into(), key_id: "k".into(), iv: "a".into(), ct: "x".repeat(1025) }]),
            Err(BufferError::TooLarge)
        ));
        buffer.insert("b1", &[op("1"), op("2"), op("3")]).unwrap();
        assert!(matches!(buffer.insert("b1", &[op("4")]), Err(BufferError::Full)));
        assert_eq!(buffer.list("b1").len(), 3);
    }

    #[test]
    fn commit_hides_then_expires_with_compaction() {
        let dir = dir("commit");
        let path = dir.join("journal");
        let mut buffer = OpBuffer::open(&path, limits()).unwrap();
        buffer.insert("b1", &[op("1"), op("2")]).unwrap();
        assert_eq!(buffer.commit("b1", 7, &["deviceA:1".to_string()]).unwrap(), 1);
        assert_eq!(buffer.list("b1").len(), 1);
        buffer.compact().unwrap();
        let mut reopened = OpBuffer::open(&path, limits()).unwrap();
        assert_eq!(reopened.list("b1").len(), 1);
        assert_eq!(reopened.insert("b1", &[op("1")]).unwrap(), 0);
        CLOCK.store(1_000_000 + 1000, Ordering::Relaxed);
        reopened.compact().unwrap();
        let mut reopened = OpBuffer::open(&path, limits()).unwrap();
        assert_eq!(reopened.list("b1").len(), 1);
        assert_eq!(reopened.insert("b1", &[op("1")]).unwrap(), 1);
        CLOCK.store(1_000_000, Ordering::Relaxed);
    }

    #[test]
    fn boards_are_isolated() {
        let path = dir("isolation").join("journal");
        let mut buffer = OpBuffer::open(&path, limits()).unwrap();
        buffer.insert("b1", &[op("1")]).unwrap();
        buffer.insert("b2", &[op("1")]).unwrap();
        assert_eq!(buffer.list("b1").len(), 1);
        assert_eq!(buffer.stats().get("b2").unwrap().0, 1);
    }
}
