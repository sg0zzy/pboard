//! Validate the existing Pboard control-plane schema; never resolve SDP addresses.
//! Valid SDP/ICE can encode a bounded covert channel; this is not binary attestation.
use crate::now_ms;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, net::IpAddr};

#[derive(Clone)]
pub struct Context {
    pub board_id: String,
    pub collection: String,
    pub epoch: u64,
    pub manifest_hash: String,
    pub manifest_payload: Value,
    pub key: VerifyingKey,
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-:+/.".contains(&b))
}
fn exact(v: &Value, fields: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == fields.len() && fields.iter().all(|key| o.contains_key(*key)))
}
fn unsigned(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 10
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<u32>().is_ok()
}
fn address(value: &str) -> bool {
    value.parse::<IpAddr>().is_ok()
        || (value.len() <= 80
            && value.strip_suffix(".local").is_some_and(|v| {
                !v.is_empty()
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
                    && v.split('.')
                        .all(|label| !label.is_empty() && label.len() <= 63)
            }))
}
pub fn ice(value: &str) -> bool {
    if value.len() > 1024 || !value.is_ascii() || value.bytes().any(|b| !(32..=126).contains(&b)) {
        return false;
    }
    let Some(value) = value.strip_prefix("candidate:") else {
        return false;
    };
    let t: Vec<_> = value.split(' ').collect();
    if t.len() < 8
        || !token(t[0], 32)
        || t[1] != "1"
        || !matches!(t[2].to_ascii_lowercase().as_str(), "udp" | "tcp")
        || !unsigned(t[3])
        || !address(t[4])
        || t[5].parse::<u16>().is_err()
        || t[6] != "typ"
        || !matches!(t[7], "host" | "srflx" | "prflx" | "relay")
        || !(t.len() - 8).is_multiple_of(2)
    {
        return false;
    }
    let mut fields = std::collections::HashSet::new();
    for pair in t[8..].as_chunks::<2>().0 {
        if !fields.insert(pair[0]) {
            return false;
        }
        let valid = match pair[0] {
            "raddr" => address(pair[1]),
            "rport" => pair[1].parse::<u16>().is_ok(),
            "tcptype" => matches!(pair[1], "active" | "passive" | "so"),
            "ufrag" => token(pair[1], 256),
            "generation" | "network-id" | "network-cost" => unsigned(pair[1]),
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    true
}
pub fn sdp(value: &str) -> bool {
    if value.len() > 16 * 1024 || !value.is_ascii() {
        return false;
    }
    let lines: Vec<_> = value
        .split_terminator('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    if lines.len() > 128 || lines.first() != Some(&"v=0") {
        return false;
    }
    let (mut origin, mut name, mut time, mut media, mut fingerprint, mut sctp) = (0, 0, 0, 0, 0, 0);
    for line in lines {
        if line.len() > 1024 || line.bytes().any(|b| !(32..=126).contains(&b)) {
            return false;
        }
        let valid = if let Some(rest) = line.strip_prefix("o=") {
            origin += 1;
            let t: Vec<_> = rest.split(' ').collect();
            t.len() == 6
                && (t[0] == "-"
                    || t[0]
                        .strip_prefix("mozilla...THIS_IS_SDPARTA-")
                        .is_some_and(|v| {
                            v.len() <= 32
                                && v.bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
                        }))
                && t[1].parse::<u64>().is_ok()
                && t[2].parse::<u64>().is_ok()
                && t[3] == "IN"
                && matches!(t[4], "IP4" | "IP6")
                && t[5].parse::<IpAddr>().is_ok()
        } else if line == "s=-" {
            name += 1;
            true
        } else if line == "t=0 0" {
            time += 1;
            true
        } else if let Some(rest) = line.strip_prefix("m=application ") {
            media += 1;
            let t: Vec<_> = rest.split(' ').collect();
            t.len() == 3
                && t[0].parse::<u16>().is_ok()
                && ((t[1] == "UDP/DTLS/SCTP" && t[2] == "webrtc-datachannel")
                    || (t[1] == "DTLS/SCTP" && t[2].parse::<u16>().is_ok()))
        } else if let Some(rest) = line.strip_prefix("c=IN ") {
            let t: Vec<_> = rest.split(' ').collect();
            t.len() == 2 && matches!(t[0], "IP4" | "IP6") && t[1].parse::<IpAddr>().is_ok()
        } else if let Some(rest) = line.strip_prefix("a=") {
            if let Some(rest) = rest.strip_prefix("fingerprint:sha-256 ") {
                fingerprint += 1;
                rest.len() == 95
                    && rest.split(':').count() == 32
                    && rest
                        .split(':')
                        .all(|v| v.len() == 2 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            } else if let Some(rest) = rest.strip_prefix("sctp-port:") {
                sctp += 1;
                rest.parse::<u16>().is_ok()
            } else if let Some(rest) = rest.strip_prefix("sctpmap:") {
                sctp += 1;
                let t: Vec<_> = rest.split(' ').collect();
                t.len() == 3
                    && t[0].parse::<u16>().is_ok()
                    && t[1] == "webrtc-datachannel"
                    && unsigned(t[2])
            } else if rest.starts_with("candidate:") {
                ice(rest)
            } else if let Some(rest) = rest.strip_prefix("ice-ufrag:") {
                (4..=256).contains(&rest.len()) && token(rest, 256)
            } else if let Some(rest) = rest.strip_prefix("ice-pwd:") {
                (22..=256).contains(&rest.len()) && token(rest, 256)
            } else if let Some(rest) = rest.strip_prefix("ice-options:") {
                !rest.is_empty()
                    && rest
                        .split(' ')
                        .all(|v| matches!(v, "trickle" | "renomination" | "ice2"))
            } else if let Some(rest) = rest.strip_prefix("group:BUNDLE ") {
                token(rest, 32)
            } else if let Some(rest) = rest.strip_prefix("mid:") {
                token(rest, 32)
            } else if let Some(rest) = rest.strip_prefix("max-message-size:") {
                unsigned(rest)
            } else {
                matches!(
                    rest,
                    "setup:actpass"
                        | "setup:active"
                        | "setup:passive"
                        | "setup:holdconn"
                        | "end-of-candidates"
                        | "ice-lite"
                        | "bundle-only"
                        | "extmap-allow-mixed"
                        | "sendrecv"
                        | "inactive"
                        | "msid-semantic:WMS"
                        | "msid-semantic:WMS *"
                        | "msid-semantic: WMS"
                        | "msid-semantic: WMS *"
                )
            }
        } else {
            line == "v=0"
        };
        if !valid {
            return false;
        }
    }
    origin == 1 && name == 1 && time == 1 && media == 1 && fingerprint == 1 && sctp == 1
}
pub fn negotiation(value: &Value) -> bool {
    if exact(value, &["type", "sdp"]) {
        return matches!(value["type"].as_str(), Some("offer" | "answer"))
            && value["sdp"].as_str().is_some_and(sdp);
    }
    if exact(value, &["renegotiate"]) {
        return value["renegotiate"] == true;
    }
    if !exact(value, &["candidate"]) {
        return false;
    }
    let Some(c) = value["candidate"].as_object() else {
        return false;
    };
    if !c.contains_key("candidate")
        || c.len() > 4
        || !c.keys().all(|k| {
            matches!(
                k.as_str(),
                "candidate" | "sdpMid" | "sdpMLineIndex" | "usernameFragment"
            )
        })
    {
        return false;
    }
    c["candidate"].as_str().is_some_and(ice)
        && c.get("sdpMid")
            .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|v| token(v, 32)))
        && c.get("sdpMLineIndex")
            .is_none_or(|v| v.is_null() || v.as_u64().is_some_and(|n| n < 64))
        && c.get("usernameFragment")
            .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|v| token(v, 256)))
}
fn verify(
    key: &VerifyingKey,
    domain: &str,
    payload: &Value,
    signature: &str,
) -> Result<(), &'static str> {
    let body = payload.to_string();
    if !body.is_ascii() || body.len() > 65536 {
        return Err("invalid_signal");
    }
    let mut bytes = domain.as_bytes().to_vec();
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(body.as_bytes());
    let raw = B64.decode(signature).map_err(|_| "invalid_signal")?;
    let signature = Signature::from_slice(&raw).map_err(|_| "invalid_signal")?;
    key.verify(&bytes, &signature).map_err(|_| "invalid_signal")
}
fn lifetime(issued: u64, expires: u64, max: u64) -> bool {
    issued <= now_ms().saturating_add(30_000)
        && expires > now_ms()
        && expires
            .checked_sub(issued)
            .is_some_and(|v| v > 0 && v <= max)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Presence {
    protocol: u8,
    board_id: String,
    collection: String,
    manifest_hash: String,
    epoch: u64,
    device_key_id: String,
    session_id: String,
    issued_at: u64,
    expires_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Signal {
    protocol: u8,
    board_id: String,
    collection: String,
    manifest_hash: String,
    epoch: u64,
    from_device_key_id: String,
    from_session_id: String,
    to_device_key_id: String,
    to_session_id: String,
    signal_id: String,
    issued_at: u64,
    expires_at: u64,
    sequence: u64,
    signal: Value,
}
pub enum Checked {
    Presence(String),
    Signal { id: String, expires: u64 },
}
pub fn check(
    value: &Value,
    context: &Context,
    from: &str,
    to: &str,
    own_session: Option<&str>,
    target_session: Option<&str>,
) -> Result<Checked, &'static str> {
    if exact(value, &["kind", "envelope"]) && value["kind"] == "pboard-presence" {
        let envelope = &value["envelope"];
        if !exact(envelope, &["manifest", "presence"])
            || envelope["manifest"] != context.manifest_payload
        {
            return Err("invalid_signal");
        }
        let signed = &envelope["presence"];
        if !exact(signed, &["payload", "signature"]) {
            return Err("invalid_signal");
        }
        let p: Presence =
            serde_json::from_value(signed["payload"].clone()).map_err(|_| "invalid_signal")?;
        if p.protocol != 2
            || p.board_id != context.board_id
            || p.collection != context.collection
            || p.manifest_hash != context.manifest_hash
            || p.epoch != context.epoch
            || p.device_key_id != from
            || !token(&p.session_id, 200)
            || !lifetime(p.issued_at, p.expires_at, 150_000)
            || own_session.is_some_and(|s| s != p.session_id)
        {
            return Err("invalid_signal");
        }
        verify(
            &context.key,
            "pboard-presence-v2",
            &signed["payload"],
            signed["signature"].as_str().ok_or("invalid_signal")?,
        )?;
        return Ok(Checked::Presence(p.session_id));
    }
    if !exact(value, &["payload", "signature"]) {
        return Err("invalid_signal");
    }
    let p: Signal =
        serde_json::from_value(value["payload"].clone()).map_err(|_| "invalid_signal")?;
    if p.protocol != 2
        || p.board_id != context.board_id
        || p.collection != context.collection
        || p.manifest_hash != context.manifest_hash
        || p.epoch != context.epoch
        || p.from_device_key_id != from
        || p.to_device_key_id != to
        || own_session != Some(p.from_session_id.as_str())
        || target_session != Some(p.to_session_id.as_str())
        || !token(&p.signal_id, 64)
        || p.sequence > 9_007_199_254_740_991
        || !lifetime(p.issued_at, p.expires_at, 90_000)
        || !negotiation(&p.signal)
    {
        return Err("invalid_signal");
    }
    verify(
        &context.key,
        "pboard-signal-v2",
        &value["payload"],
        value["signature"].as_str().ok_or("invalid_signal")?,
    )?;
    Ok(Checked::Signal {
        id: format!("{}:{}:{}", from, p.from_session_id, p.signal_id),
        expires: p.expires_at,
    })
}
pub fn prune_replays(records: &mut HashMap<String, u64>) {
    records.retain(|_, expires| *expires > now_ms());
}
