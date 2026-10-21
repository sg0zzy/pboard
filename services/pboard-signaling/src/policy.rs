//! Operator limits and browser/TLS defense in depth. Never an identity proof.
use crate::Limits;
use axum::http::HeaderMap;
use std::{collections::HashSet, time::Duration};

impl Limits {
    pub fn from_env() -> Result<Self, &'static str> {
        for (key, value) in std::env::vars_os() {
            if key
                .to_str()
                .is_some_and(|key| key.starts_with("PBOARD_SIGNALING_"))
                && value.to_str().is_none()
            {
                return Err("invalid_resource_limit");
            }
        }
        Self::from_settings(|key| std::env::var(key).ok())
    }
    pub fn from_settings(get: impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        let mut limits = Self::default();
        macro_rules! setting {
            ($field:ident, $name:literal) => {
                if let Some(value) = get(concat!("PBOARD_SIGNALING_", $name)) {
                    limits.$field = value.parse().map_err(|_| "invalid_resource_limit")?;
                }
            };
        }
        setting!(connections, "MAX_CONNECTIONS");
        setting!(peers_per_room, "MAX_PEERS_PER_ROOM");
        setting!(rooms, "MAX_ROOMS");
        setting!(message_bytes, "MAX_MESSAGE_BYTES");
        setting!(messages_per_second, "MESSAGES_PER_SECOND");
        setting!(bytes_per_second, "BYTES_PER_SECOND");
        setting!(session_bytes, "MAX_SESSION_BYTES");
        setting!(session_signals, "MAX_SESSION_SIGNALS");
        setting!(global_messages_per_second, "GLOBAL_MESSAGES_PER_SECOND");
        setting!(global_bytes_per_second, "GLOBAL_BYTES_PER_SECOND");
        setting!(automatic_auth_per_second, "AUTH_PER_SECOND");
        setting!(authorization_scopes, "MAX_AUTHORIZATION_SCOPES");
        setting!(http_concurrency, "HTTP_CONCURRENCY");
        setting!(http_per_second, "HTTP_PER_SECOND");
        setting!(grant_bundle_bytes, "MAX_GRANT_BYTES");
        setting!(grant_cache_bytes, "MAX_GRANT_CACHE_BYTES");
        setting!(grant_history, "MAX_GRANT_HISTORY");
        setting!(replay_entries, "MAX_REPLAY_ENTRIES");
        for (name, target) in [
            ("AUTH_TIMEOUT_SECONDS", &mut limits.auth),
            ("IDLE_TIMEOUT_SECONDS", &mut limits.idle),
        ] {
            if let Some(value) = get(&format!("PBOARD_SIGNALING_{name}")) {
                *target = Duration::from_secs(value.parse().map_err(|_| "invalid_resource_limit")?);
            }
        }
        limits.validate()?;
        Ok(limits)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=2048).contains(&self.connections)
            || !(1..=64).contains(&self.peers_per_room)
            || !(1..=1024).contains(&self.rooms)
            || !(1024..=crate::MAX_MESSAGE).contains(&self.message_bytes)
            || !(1..=120).contains(&self.messages_per_second)
            || !(1024..=1024 * 1024).contains(&self.bytes_per_second)
            || !(1024..=16 * 1024 * 1024).contains(&self.session_bytes)
            || !(1..=1024).contains(&self.session_signals)
            || !(1..=1024).contains(&self.global_messages_per_second)
            || !(1024..=16 * 1024 * 1024).contains(&self.global_bytes_per_second)
            || !(1..=128).contains(&self.automatic_auth_per_second)
            || !(1..=1024).contains(&self.authorization_scopes)
            || !(1..=8).contains(&self.http_concurrency)
            || !(1..=128).contains(&self.http_per_second)
            || !(16 * 1024..=4 * 1024 * 1024).contains(&self.grant_bundle_bytes)
            || !(self.grant_bundle_bytes..=64 * 1024 * 1024).contains(&self.grant_cache_bytes)
            || !(1..=4096).contains(&self.grant_history)
            || !(1..=32768).contains(&self.replay_entries)
            || self.auth.is_zero()
            || self.auth > Duration::from_secs(30)
            || self.idle.is_zero()
            || self.idle > Duration::from_secs(120)
        {
            return Err("invalid_resource_limit");
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct TransportPolicy {
    pub require_tls_proxy: bool,
    pub allow_loopback_origins: bool,
    pub allowed_origins: HashSet<String>,
}
impl TransportPolicy {
    pub fn from_env() -> Result<Self, &'static str> {
        fn flag(key: &str) -> Result<bool, &'static str> {
            match std::env::var(key).as_deref() {
                Ok("1") => Ok(true),
                Ok("0") | Err(std::env::VarError::NotPresent) => Ok(false),
                _ => Err("invalid_transport_policy"),
            }
        }
        let policy = Self {
            require_tls_proxy: flag("PBOARD_SIGNALING_REQUIRE_TLS_PROXY")?,
            allow_loopback_origins: flag("PBOARD_SIGNALING_ALLOW_LOOPBACK_ORIGINS")?,
            allowed_origins: std::env::var("PBOARD_SIGNALING_ALLOWED_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        };
        if policy.allowed_origins.len() > 32 {
            return Err("invalid_transport_policy");
        }
        for origin in &policy.allowed_origins {
            let url = reqwest::Url::parse(origin).map_err(|_| "invalid_transport_policy")?;
            if origin.len() > 256
                || url.origin().ascii_serialization() != *origin
                || url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("invalid_transport_policy");
            }
        }
        Ok(policy)
    }
    pub fn permits(&self, headers: &HeaderMap) -> bool {
        if self.require_tls_proxy
            && (headers.get_all("x-forwarded-proto").iter().count() != 1
                || headers
                    .get("x-forwarded-proto")
                    .is_none_or(|v| v != "https"))
        {
            return false;
        }
        let mut origins = headers.get_all("origin").iter();
        let Some(origin) = origins.next() else {
            return true;
        }; // native client: still requires cryptographic admission
        if origins.next().is_some() {
            return false;
        }
        let Ok(origin) = origin.to_str() else {
            return false;
        };
        if self.allowed_origins.contains(origin) {
            return true;
        }
        if let Some(id) = origin.strip_prefix("chrome-extension://") {
            return id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b));
        }
        if let Some(id) = origin.strip_prefix("moz-extension://") {
            return id.len() == 36
                && id.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                });
        }
        if self.allow_loopback_origins
            && let Ok(url) = reqwest::Url::parse(origin)
        {
            return url.origin().ascii_serialization() == origin
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        }
        false
    }
}
