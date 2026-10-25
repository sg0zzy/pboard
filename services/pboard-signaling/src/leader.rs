//! Board persistence-leader leases and epochs (Sync v2).
//!
//! One peer at a time may publish a board's consolidated snapshot to Google
//! Drive. This module is the arbiter: it hands out time-bounded leases and a
//! strictly monotonic fencing epoch per board, and records the outcome of
//! publishes so a stale writer is *identifiable* after the fact.
//!
//! Honest limit (design §8, accepted): Google Drive has no hook for our epoch,
//! so an already-running upload cannot be blocked mid-flight. Safety here is
//! cooperative (leases) plus detect-and-repair: every accepted publish reports
//! its `snapshot_seq`, an out-of-order sequence is flagged (`stale`), and
//! `observe` lets a leader attest what it actually read back from Drive so
//! the next leader's watermark merge can repair any lost overwrite. Strict
//! prevention would require publishing through the server, which changes the
//! trust model and was rejected.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const LEASE_MS: u64 = 45_000;
const MAX_BOARDS: usize = 100_000;

#[derive(Debug, PartialEq)]
pub enum LeaderError {
    Busy { retry_after_ms: u64 },
    NotLeader,
    EpochStale,
    Invalid,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseState {
    pub holder: String,
    pub epoch: u64,
    pub expires_at: u64,
}

/// Terminal record of a published snapshot, newest only per board.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRecord {
    pub epoch: u64,
    pub snapshot_seq: u64,
    pub writer: String,
    pub drive_etag: String,
    pub at: u64,
    /// A snapshot_seq not strictly above the last accepted one: an overwrite
    /// race happened; the next leader must watermark-merge before publishing.
    pub stale: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaderView {
    pub lease: Option<LeaseState>,
    pub last_commit: Option<CommitRecord>,
    /// Drive revision reported by the current or most recent lease holder.
    pub drive_etag: Option<String>,
}

#[derive(Default)]
struct Board {
    holder: Option<String>,
    epoch: u64,
    expires_at: u64,
    last_commit: Option<CommitRecord>,
    last_seq: u64,
    drive_etag: Option<String>,
}

#[derive(Default)]
pub struct LeaderRegistry {
    boards: HashMap<String, Board>,
}

fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.'))
}

impl LeaderRegistry {
    /// Claims or renews the lease. Reclaiming one's own live lease extends it
    /// at the same epoch; any other claimant must wait for expiry, and then
    /// takes over at a strictly higher epoch.
    pub fn claim(&mut self, board: &str, holder: &str, now: u64) -> Result<(u64, u64), LeaderError> {
        if !valid_id(board, 256) || !valid_id(holder, 256) {
            return Err(LeaderError::Invalid);
        }
        if !self.boards.contains_key(board) && self.boards.len() >= MAX_BOARDS {
            return Err(LeaderError::Invalid);
        }
        let entry = self.boards.entry(board.to_string()).or_default();
        let live = entry.holder.is_some() && entry.expires_at > now;
        if let Some(current) = &entry.holder {
            if live && current == holder {
                entry.expires_at = now + LEASE_MS;
                return Ok((entry.epoch, entry.expires_at));
            }
            if live {
                return Err(LeaderError::Busy { retry_after_ms: entry.expires_at - now });
            }
        }
        entry.epoch += 1;
        entry.holder = Some(holder.to_string());
        entry.expires_at = now + LEASE_MS;
        Ok((entry.epoch, entry.expires_at))
    }

    /// A holder reports the Drive revision it observed for `epoch`.
    pub fn observe(&mut self, board: &str, holder: &str, epoch: u64, drive_etag: &str, now: u64) -> Result<(), LeaderError> {
        let entry = self.boards.get_mut(board).ok_or(LeaderError::NotLeader)?;
        if entry.holder.as_deref() != Some(holder) || entry.expires_at <= now {
            return Err(LeaderError::NotLeader);
        }
        if epoch != entry.epoch {
            return Err(LeaderError::EpochStale);
        }
        entry.drive_etag = Some(drive_etag.to_string());
        Ok(())
    }

    /// Records a completed Drive publish. `stale` marks a snapshot sequence
    /// that did not advance the board's history (out-of-order overwrite).
    pub fn commit(
        &mut self,
        board: &str,
        holder: &str,
        epoch: u64,
        snapshot_seq: u64,
        drive_etag: &str,
        now: u64,
    ) -> Result<bool, LeaderError> {
        let entry = self.boards.get_mut(board).ok_or(LeaderError::NotLeader)?;
        if entry.holder.as_deref() != Some(holder) || entry.expires_at <= now {
            return Err(LeaderError::NotLeader);
        }
        if epoch < entry.epoch {
            return Err(LeaderError::EpochStale);
        }
        let stale = snapshot_seq <= entry.last_seq;
        entry.last_seq = entry.last_seq.max(snapshot_seq);
        entry.last_commit = Some(CommitRecord {
            epoch,
            snapshot_seq,
            writer: holder.to_string(),
            drive_etag: drive_etag.to_string(),
            at: now,
            stale,
        });
        entry.drive_etag = Some(drive_etag.to_string());
        Ok(stale)
    }

    /// Hands leadership over explicitly (clean shutdown); the next claim
    /// still takes a new epoch, so the departing leader cannot publish.
    pub fn release(&mut self, board: &str, holder: &str, epoch: u64) -> Result<(), LeaderError> {
        let Some(entry) = self.boards.get_mut(board) else {
            return Err(LeaderError::NotLeader);
        };
        if entry.holder.as_deref() != Some(holder) {
            return Err(LeaderError::NotLeader);
        }
        if epoch != entry.epoch {
            return Err(LeaderError::EpochStale);
        }
        entry.holder = None;
        entry.expires_at = 0;
        Ok(())
    }

    pub fn view(&self, board: &str, now: u64) -> Option<LeaderView> {
        let entry = self.boards.get(board)?;
        Some(LeaderView {
            lease: entry.holder.as_ref().map(|holder| LeaseState {
                holder: holder.clone(),
                epoch: entry.epoch,
                expires_at: entry.expires_at,
            }),
            last_commit: entry.last_commit.clone(),
            drive_etag: entry.drive_etag.clone(),
        })
        .map(|view| {
            let lease_live = view.lease.as_ref().is_some_and(|lease| lease.expires_at > now);
            LeaderView {
                lease: if lease_live { view.lease } else { None },
                ..view
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_is_exclusive_until_expiry_and_epochs_increase() {
        let mut registry = LeaderRegistry::default();
        let (epoch_a, expires) = registry.claim("b1", "alice-1", 1000).unwrap();
        assert_eq!(epoch_a, 1);
        assert_eq!(expires, 1000 + LEASE_MS);
        assert!(matches!(registry.claim("b1", "bob-1", 1100), Err(LeaderError::Busy { .. })));
        // Renewing one's own lease keeps the epoch.
        assert_eq!(registry.claim("b1", "alice-1", 2000).unwrap().0, 1);
        // Expiry hands over at a strictly higher epoch (renewal moved expiry).
        let (epoch_b, _) = registry.claim("b1", "bob-1", 2000 + LEASE_MS).unwrap();
        assert_eq!(epoch_b, 2);
        // The old holder's late renewals and commits are refused.
        assert_eq!(registry.claim("b1", "alice-1", 2000 + LEASE_MS), Err(LeaderError::Busy { retry_after_ms: LEASE_MS }));
        assert_eq!(registry.commit("b1", "alice-1", 1, 1, "rev-1", 1000 + LEASE_MS), Err(LeaderError::NotLeader));
    }

    #[test]
    fn release_enables_takeover_but_blocks_the_releaser() {
        let mut registry = LeaderRegistry::default();
        let (epoch, _) = registry.claim("b1", "alice-1", 0).unwrap();
        registry.release("b1", "alice-1", epoch).unwrap();
        let (next, _) = registry.claim("b1", "bob-1", 10).unwrap();
        assert_eq!(next, epoch + 1);
        assert_eq!(registry.observe("b1", "alice-1", epoch, "etag", 11), Err(LeaderError::NotLeader));
        assert_eq!(registry.release("b1", "alice-1", epoch), Err(LeaderError::NotLeader));
    }

    #[test]
    fn commit_sequence_must_advance_or_is_flagged_stale() {
        let mut registry = LeaderRegistry::default();
        let (epoch, _) = registry.claim("b1", "alice-1", 0).unwrap();
        registry.observe("b1", "alice-1", epoch, "rev-9", 0).unwrap();
        assert_eq!(registry.commit("b1", "alice-1", epoch, 5, "rev-10", 1), Ok(false));
        let view = registry.view("b1", 1).unwrap();
        assert_eq!(view.drive_etag.as_deref(), Some("rev-10"));
        assert_eq!(registry.commit("b1", "alice-1", epoch, 5, "rev-11", 2), Ok(true));
        // Takeover by another holder: its first (higher) sequence is clean.
        registry.claim("b1", "bob-1", LEASE_MS + 1).unwrap();
        assert_eq!(registry.commit("b1", "bob-1", 2, 6, "rev-12", LEASE_MS + 1), Ok(false));
        assert_eq!(registry.commit("b1", "bob-1", 2, 6, "rev-13", LEASE_MS + 2), Ok(true));
        let view = registry.view("b1", LEASE_MS + 2).unwrap();
        assert!(view.last_commit.unwrap().stale);
    }

    #[test]
    fn stale_epoch_cannot_observe_or_commit() {
        let mut registry = LeaderRegistry::default();
        registry.claim("b1", "alice-1", 0).unwrap();
        registry.claim("b1", "bob-1", LEASE_MS).unwrap();
        assert_eq!(registry.observe("b1", "alice-1", 1, "etag", LEASE_MS), Err(LeaderError::NotLeader));
        assert_eq!(registry.commit("b1", "alice-1", 1, 1, "etag", LEASE_MS), Err(LeaderError::NotLeader));
    }
}
