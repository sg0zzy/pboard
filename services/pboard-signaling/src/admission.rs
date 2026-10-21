//! Public, self-contained room authorization. The authority defines its own
//! cryptographic namespace; it never claims ownership of another authority's room.
use super::{PublicKey, valid_room};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionProof {
    pub topic: String,
    pub authority: PublicKey,
    /// Exact canonical payload bytes already signed by the pinned authority.
    pub manifest_payload: String,
    pub manifest_signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    protocol: u8,
    board_id: String,
    drive_project_file_id: String,
    drive_folder_id: String,
    authority_key_id: String,
    epoch: u64,
    issued_at: u64,
    expires_at: u64,
    devices: Vec<Device>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Device {
    device_key_id: String,
    public_key: PublicKey,
    role: Role,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Role {
    Owner,
    Editor,
    Viewer,
}

pub struct VerifiedAdmission {
    pub scope: String,
    pub digest: String,
    pub epoch: u64,
    pub expires_at: u64,
    pub context: crate::signals::Context,
}
fn hash(bytes: &[u8]) -> String {
    B64.encode(Sha256::digest(bytes))
}
pub fn room_name(authority: &str, topic: &str, file: &str, folder: &str) -> String {
    let binding = serde_json::to_vec(&["pboard-ws-room-v2", topic, file, folder]).unwrap();
    format!("pboard-v2-{authority}-{}", hash(&binding))
}
pub fn auth_bytes(
    challenge: &str,
    session: &str,
    room: &str,
    device: &str,
    digest: &str,
) -> Vec<u8> {
    serde_json::to_vec(&[
        "pboard-ws-auth-v2",
        challenge,
        session,
        room,
        device,
        digest,
    ])
    .unwrap()
}
fn verify_signature(key: &VerifyingKey, signature: &str, bytes: &[u8]) -> Result<(), &'static str> {
    let raw = B64.decode(signature).map_err(|_| "unauthorized")?;
    let sig = Signature::from_slice(&raw).map_err(|_| "unauthorized")?;
    key.verify(bytes, &sig).map_err(|_| "unauthorized")
}
fn valid_id(id: &str) -> bool {
    id.len() <= 200 && valid_room(id)
}

impl AdmissionProof {
    pub fn history_identity(&self) -> Result<(String, u64), &'static str> {
        let bytes = B64
            .decode(&self.manifest_payload)
            .map_err(|_| "invalid_grant")?;
        if bytes.len() > 65_536 {
            return Err("invalid_grant");
        }
        let m: Manifest = serde_json::from_slice(&bytes).map_err(|_| "invalid_grant")?;
        if m.protocol != 2
            || m.authority_key_id != self.authority.fingerprint()
            || !valid_id(&m.board_id)
            || !m.drive_project_file_id.is_empty()
            || !m.drive_folder_id.is_empty()
            || m.issued_at > super::now_ms().saturating_add(30_000)
            || m.expires_at <= m.issued_at
            || m.expires_at - m.issued_at > 360_000
            || m.epoch > 9_007_199_254_740_991
        {
            return Err("invalid_grant");
        }
        let mut signed = b"pboard-manifest-v2".to_vec();
        signed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        signed.extend_from_slice(&bytes);
        verify_signature(&self.authority.key()?, &self.manifest_signature, &signed)?;
        Ok((m.board_id, m.epoch))
    }
    /// Only empty-binding board grants can use the independent admission path.
    /// Full verification still follows; this classifier never authorizes a peer.
    pub fn standalone_board(&self) -> bool {
        B64.decode(&self.manifest_payload)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
            .is_some_and(|m| {
                !m.board_id.starts_with("account:")
                    && m.drive_project_file_id.is_empty()
                    && m.drive_folder_id.is_empty()
            })
    }
    pub fn verify(
        &self,
        room: &str,
        peer: &str,
        challenge: &str,
        session: &str,
        signature: &str,
        now: u64,
    ) -> Result<VerifiedAdmission, &'static str> {
        if self.manifest_payload.len() > 87_384 || !valid_room(&self.topic) {
            return Err("unauthorized");
        }
        let bytes = B64
            .decode(&self.manifest_payload)
            .map_err(|_| "unauthorized")?;
        if bytes.len() > 65_536 {
            return Err("unauthorized");
        }
        // Typed Serde rejects duplicate/unknown fields, non-integer timestamps,
        // invalid roles and excessive nesting. No cross-language reserialization.
        let m: Manifest = serde_json::from_slice(&bytes).map_err(|_| "unauthorized")?;
        if serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|_| "unauthorized")?
            .to_string()
            .as_bytes()
            != bytes
        {
            return Err("unauthorized");
        }
        let authority = self.authority.fingerprint();
        if m.protocol != 2
            || m.authority_key_id != authority
            || m.epoch > 9_007_199_254_740_991
            || m.expires_at > 9_007_199_254_740_991
            || m.issued_at > now.saturating_add(30_000)
            || m.expires_at <= now
            || !m
                .expires_at
                .checked_sub(m.issued_at)
                .is_some_and(|life| life > 0 && life <= 360_000)
            || m.devices.is_empty()
            || m.devices.len() > 64
        {
            return Err("unauthorized");
        }
        if let Some(account) = m.board_id.strip_prefix("account:") {
            if !valid_id(account)
                || !m.drive_project_file_id.is_empty()
                || !m.drive_folder_id.is_empty()
                || self.topic != format!("pboard-account-{account}-order")
            {
                return Err("unauthorized");
            }
        } else if !valid_id(&m.board_id)
            || !((m.drive_project_file_id.is_empty() && m.drive_folder_id.is_empty())
                || (valid_id(&m.drive_project_file_id) && valid_id(&m.drive_folder_id)))
            || ![
                format!("pboard-collab-{}-cards", m.board_id),
                format!("pboard-collab-{}-projects", m.board_id),
            ]
            .contains(&self.topic)
        {
            return Err("unauthorized");
        }
        if room
            != room_name(
                &authority,
                &self.topic,
                &m.drive_project_file_id,
                &m.drive_folder_id,
            )
        {
            return Err("unauthorized");
        }
        let mut signed = b"pboard-manifest-v2".to_vec();
        signed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        signed.extend_from_slice(&bytes);
        verify_signature(&self.authority.key()?, &self.manifest_signature, &signed)?;
        let mut ids = HashSet::new();
        let mut member = None;
        let mut owner = false;
        for d in &m.devices {
            if d.device_key_id != d.public_key.fingerprint() || !ids.insert(&d.device_key_id) {
                return Err("unauthorized");
            }
            let key = d.public_key.key()?;
            if d.device_key_id == peer {
                member = Some(key);
            }
            owner |= d.role == Role::Owner;
        }
        if !owner {
            return Err("unauthorized");
        }
        let digest = hash(&bytes);
        let member = member.ok_or("unauthorized")?;
        verify_signature(
            &member,
            signature,
            &auth_bytes(challenge, session, room, peer, &digest),
        )?;
        let scope = format!(
            "{authority}-{}",
            hash(
                &serde_json::to_vec(&[
                    "pboard-ws-scope-v2",
                    &m.board_id,
                    &m.drive_project_file_id,
                    &m.drive_folder_id
                ])
                .unwrap()
            )
        );
        Ok(VerifiedAdmission {
            scope,
            digest,
            epoch: m.epoch,
            expires_at: m.expires_at,
            context: crate::signals::Context {
                board_id: m.board_id.clone(),
                collection: if m.board_id.starts_with("account:") {
                    "accountOrder".into()
                } else {
                    self.topic.rsplit('-').next().ok_or("unauthorized")?.into()
                },
                epoch: m.epoch,
                manifest_hash: crate::signals::hex(&signed),
                manifest_payload: serde_json::from_slice(&bytes).map_err(|_| "unauthorized")?,
                key: member,
            },
        })
    }
}
