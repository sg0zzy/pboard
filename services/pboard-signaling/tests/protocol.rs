use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use pboard_signaling::{App, Config, Grant, Limits, MAX_MESSAGE, PublicKey, auth_bytes, now_ms};
use rand_core::OsRng;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
mod common;
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
struct Device {
    key: SigningKey,
    id: String,
    grant: Grant,
}
fn device() -> Device {
    let key = SigningKey::random(&mut OsRng);
    let point = key.verifying_key().to_encoded_point(false);
    let public_key = PublicKey {
        kty: "EC".into(),
        crv: "P-256".into(),
        x: B64.encode(point.x().unwrap()),
        y: B64.encode(point.y().unwrap()),
    };
    Device {
        id: public_key.fingerprint(),
        key,
        grant: Grant {
            public_key,
            expires_at: now_ms() + 60_000,
        },
    }
}
async fn server(devices: &[&Device], limits: Limits) -> (App, String, tokio::task::JoinHandle<()>) {
    let grants = devices
        .iter()
        .map(|d| (d.id.clone(), d.grant.clone()))
        .collect::<HashMap<_, _>>();
    let app = App::new(
        Config {
            rooms: HashMap::from([("room-a".into(), grants.clone()), ("room-b".into(), grants)]),
        },
        limits,
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let router = app.clone().router();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (app, url, task)
}
async fn recv(ws: &mut Socket) -> Value {
    let msg = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("receive timeout")
        .expect("frame")
        .expect("websocket");
    serde_json::from_str(msg.to_text().unwrap()).unwrap()
}
async fn send(ws: &mut Socket, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}
fn proof(d: &Device, w: &Value, room: &str) -> Value {
    let sig: Signature = d.key.sign(&auth_bytes(
        w["challenge"].as_str().unwrap(),
        w["session"].as_str().unwrap(),
        room,
        &d.id,
    ));
    json!({"type":"authenticate","version":1,"room":room,"deviceKeyId":d.id,"signature":B64.encode(sig.to_bytes())})
}
async fn join(url: &str, d: &Device, room: &str) -> (Socket, Value) {
    let (mut ws, _) = connect_async(url).await.unwrap();
    let welcome = recv(&mut ws).await;
    send(&mut ws, proof(d, &welcome, room)).await;
    assert_eq!(recv(&mut ws).await["type"], "authenticated");
    send(&mut ws, json!({"type":"join"})).await;
    let joined = recv(&mut ws).await;
    assert_eq!(joined["type"], "joined");
    (ws, welcome)
}
#[tokio::test]
async fn persistent_service_with_empty_or_expired_grants_denies_authentication() {
    let mut expired = device();
    expired.grant.expires_at = now_ms() - 1;
    for rooms in [
        HashMap::new(),
        HashMap::from([(
            "room-a".into(),
            HashMap::from([(expired.id.clone(), expired.grant.clone())]),
        )]),
    ] {
        let app = App::new(Config { rooms }, Limits::default()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (mut ws, _) = connect_async(&url).await.unwrap();
        let welcome = recv(&mut ws).await;
        send(&mut ws, proof(&expired, &welcome, "room-a")).await;
        assert_eq!(recv(&mut ws).await["code"], "unauthorized");
        app.shutdown();
        task.abort();
    }
    let mut invalid = expired.grant;
    invalid.public_key.x = "invalid".into();
    assert!(
        App::new(
            Config {
                rooms: HashMap::from([("room-a".into(), HashMap::from([(expired.id, invalid)]))]),
            },
            Limits::default(),
        )
        .is_err()
    );
}
#[tokio::test]
async fn authenticated_forwarding_presence_disconnect_and_reconnect() {
    let a = device();
    let b = device();
    let (app, url, task) = server(&[&a, &b], Limits::default()).await;
    let (mut first, wa) = join(&url, &a, "room-a").await;
    let (mut second, wb) = join(&url, &b, "room-a").await;
    assert_eq!(recv(&mut first).await["type"], "peer_joined");
    for payload in [
        json!({"type":"offer","sdp":common::sdp()}),
        json!({"type":"answer","sdp":common::sdp()}),
        json!({"candidate":{"candidate":common::ICE}}),
        json!({"renegotiate":true}),
    ] {
        send(
            &mut first,
            json!({"type":"signal","to":b.id,"session":wb["session"],"data":payload}),
        )
        .await;
        let relayed = recv(&mut second).await;
        assert_eq!(relayed["data"], payload);
        assert_eq!(relayed["from"], a.id);
        assert_eq!(relayed["session"], wa["session"]);
    }
    send(&mut second, json!({"type":"leave"})).await;
    assert_eq!(recv(&mut first).await["type"], "peer_left");
    let (second, new_w) = join(&url, &b, "room-a").await;
    assert_ne!(wb["session"], new_w["session"]);
    assert_eq!(recv(&mut first).await["type"], "peer_joined");
    drop(second);
    assert_eq!(recv(&mut first).await["type"], "peer_left");
    app.shutdown();
    task.abort();
}
#[tokio::test]
async fn rejects_unknown_keys_rooms_wrong_signatures_and_replay() {
    let a = device();
    let rogue = device();
    let (app, url, task) = server(&[&a], Limits::default()).await;
    let (mut ws, _) = connect_async(&url).await.unwrap();
    let welcome = recv(&mut ws).await;
    let replay = proof(&a, &welcome, "room-a");
    drop(ws);
    for (d, room, reused) in [
        (&rogue, "room-a", None),
        (&a, "unknown", None),
        (&a, "room-a", Some(replay)),
    ] {
        let (mut ws, _) = connect_async(&url).await.unwrap();
        let w = recv(&mut ws).await;
        send(&mut ws, reused.unwrap_or_else(|| proof(d, &w, room))).await;
        assert_eq!(recv(&mut ws).await["code"], "unauthorized");
    }
    let (mut ws, _) = connect_async(&url).await.unwrap();
    let w = recv(&mut ws).await;
    let mut forged = proof(&a, &w, "room-a");
    forged["signature"] = json!("A".repeat(86));
    send(&mut ws, forged).await;
    assert_eq!(recv(&mut ws).await["code"], "unauthorized");
    app.shutdown();
    task.abort();
}
#[tokio::test]
async fn duplicate_sessions_cannot_replace_existing_member() {
    let a = device();
    let (app, url, task) = server(&[&a], Limits::default()).await;
    let (mut ws, _) = join(&url, &a, "room-a").await;
    let (mut dup, _) = connect_async(&url).await.unwrap();
    let w = recv(&mut dup).await;
    send(&mut dup, proof(&a, &w, "room-a")).await;
    recv(&mut dup).await;
    send(&mut dup, json!({"type":"join"})).await;
    assert_eq!(recv(&mut dup).await["code"], "duplicate_or_full");
    send(&mut ws, json!({"type":"ping"})).await;
    assert_eq!(recv(&mut ws).await["type"], "pong");
    app.shutdown();
    task.abort();
}
#[tokio::test]
async fn isolates_rooms_and_rejects_stale_targets() {
    let a = device();
    let b = device();
    let (app, url, task) = server(&[&a, &b], Limits::default()).await;
    let (mut first, _) = join(&url, &a, "room-a").await;
    let (mut second, w) = join(&url, &b, "room-b").await;
    send(
        &mut first,
        json!({"type":"signal","to":b.id,"session":w["session"],"data":{}}),
    )
    .await;
    assert_eq!(recv(&mut first).await["code"], "stale_target");
    send(&mut second, json!({"type":"ping"})).await;
    assert_eq!(recv(&mut second).await["type"], "pong");
    app.shutdown();
    task.abort();
}
#[tokio::test]
async fn malformed_oversized_and_unauthenticated_messages() {
    let a = device();
    let (app, url, task) = server(&[&a], Limits::default()).await;
    for text in [
        "{bad".to_string(),
        json!({"type":"join"}).to_string(),
        json!({"type":"authenticate","version":99}).to_string(),
    ] {
        let (mut ws, _) = connect_async(&url).await.unwrap();
        recv(&mut ws).await;
        ws.send(Message::Text(text.into())).await.unwrap();
        assert_eq!(recv(&mut ws).await["type"], "error");
    }
    let (mut ws, _) = connect_async(&url).await.unwrap();
    recv(&mut ws).await;
    ws.send(Message::Text("x".repeat(MAX_MESSAGE + 1).into()))
        .await
        .unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap();
    if let Some(Ok(Message::Text(text))) = next {
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["type"],
            "error"
        );
    }
    app.shutdown();
    task.abort();
}
#[tokio::test]
async fn enforces_rate_idle_auth_expiry_and_capacity() {
    let mut a = device();
    let b = device();
    let limits = Limits {
        messages_per_second: 3,
        idle: Duration::from_millis(500),
        auth: Duration::from_millis(300),
        peers_per_room: 1,
        ..Limits::default()
    };
    let (app, url, task) = server(&[&a, &b], limits).await;
    let (mut ws, _) = join(&url, &a, "room-a").await;
    for _ in 0..2 {
        send(&mut ws, json!({"type":"ping"})).await;
    }
    assert_eq!(recv(&mut ws).await["type"], "pong");
    assert_eq!(recv(&mut ws).await["code"], "rate_limit");
    let (mut ws, _) = connect_async(&url).await.unwrap();
    recv(&mut ws).await;
    assert_eq!(recv(&mut ws).await["code"], "auth_timeout");
    let (mut idle, _) = join(&url, &a, "room-a").await;
    let (mut full, _) = connect_async(&url).await.unwrap();
    let w = recv(&mut full).await;
    send(&mut full, proof(&b, &w, "room-a")).await;
    recv(&mut full).await;
    send(&mut full, json!({"type":"join"})).await;
    assert_eq!(recv(&mut full).await["code"], "duplicate_or_full");
    assert_eq!(recv(&mut idle).await["code"], "idle_timeout");
    app.shutdown();
    task.abort();
    a.grant.expires_at = now_ms() + 400;
    let (app, url, task) = server(&[&a], Limits::default()).await;
    let (mut ws, _) = join(&url, &a, "room-a").await;
    assert_eq!(recv(&mut ws).await["code"], "grant_expired");
    app.shutdown();
    task.abort();
}
#[tokio::test]
async fn restart_discards_sessions_and_challenges() {
    let a = device();
    let (app, url, task) = server(&[&a], Limits::default()).await;
    let (mut ws, w) = join(&url, &a, "room-a").await;
    app.shutdown();
    assert_eq!(recv(&mut ws).await["code"], "server_shutdown");
    task.abort();
    let (app, url, task) = server(&[&a], Limits::default()).await;
    let (_, fresh) = join(&url, &a, "room-a").await;
    assert_ne!(fresh["session"], w["session"]);
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn oversized_valid_signal_is_not_forwarded() {
    let a = device();
    let b = device();
    let (app, url, task) = server(&[&a, &b], Limits::default()).await;
    let (mut first, _) = join(&url, &a, "room-a").await;
    let (mut second, w) = join(&url, &b, "room-a").await;
    assert_eq!(recv(&mut first).await["type"], "peer_joined");
    send(
        &mut first,
        json!({"type":"signal","to":b.id,"session":w["session"],"data":"x".repeat(MAX_MESSAGE)}),
    )
    .await;
    assert_eq!(recv(&mut second).await["type"], "peer_left");
    send(&mut second, json!({"type":"ping"})).await;
    assert_eq!(recv(&mut second).await["type"], "pong");
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn stale_session_cannot_address_rejoined_peer() {
    let a = device();
    let b = device();
    let (app, url, task) = server(&[&a, &b], Limits::default()).await;
    let (mut first, _) = join(&url, &a, "room-a").await;
    let (mut second, old) = join(&url, &b, "room-a").await;
    recv(&mut first).await;
    send(&mut second, json!({"type":"leave"})).await;
    recv(&mut first).await;
    let (mut fresh, new) = join(&url, &b, "room-a").await;
    recv(&mut first).await;
    assert_ne!(old["session"], new["session"]);
    send(
        &mut first,
        json!({"type":"signal","to":b.id,"session":old["session"],"data":{"sdp":"stale"}}),
    )
    .await;
    assert_eq!(recv(&mut first).await["code"], "stale_target");
    assert_eq!(recv(&mut fresh).await["type"], "peer_left");
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn connection_cap_rejects_upgrade() {
    let a = device();
    let (app, url, task) = server(
        &[&a],
        Limits {
            connections: 1,
            ..Limits::default()
        },
    )
    .await;
    let (mut first, _) = connect_async(&url).await.unwrap();
    recv(&mut first).await;
    let rejected = connect_async(&url).await.unwrap_err();
    match rejected {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), 503),
        other => panic!("unexpected {other}"),
    }
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn enforces_total_room_and_cumulative_byte_quotas() {
    let a = device();
    let b = device();
    let (app, url, task) = server(
        &[&a, &b],
        Limits {
            rooms: 1,
            ..Limits::default()
        },
    )
    .await;
    let (_first, _) = join(&url, &a, "room-a").await;
    let (mut other, _) = connect_async(&url).await.unwrap();
    let w = recv(&mut other).await;
    send(&mut other, proof(&b, &w, "room-b")).await;
    recv(&mut other).await;
    send(&mut other, json!({"type":"join"})).await;
    assert_eq!(recv(&mut other).await["code"], "room_limit");
    app.shutdown();
    task.abort();
    let (app, url, task) = server(
        &[&a, &b],
        Limits {
            session_bytes: 1024,
            ..Limits::default()
        },
    )
    .await;
    let (mut first, _) = join(&url, &a, "room-a").await;
    let (_second, w) = join(&url, &b, "room-a").await;
    recv(&mut first).await;
    let frame = json!({"type":"signal","to":b.id,"session":w["session"],"data":{"type":"offer","sdp":common::sdp()}});
    send(&mut first, frame.clone()).await;
    let mut got_limit = false;
    for _ in 0..3 {
        send(&mut first, frame.clone()).await;
        if let Ok(Some(Ok(Message::Text(text)))) =
            tokio::time::timeout(Duration::from_millis(100), first.next()).await
        {
            let reply: Value = serde_json::from_str(&text).unwrap();
            if reply["code"] == "traffic_limit" {
                got_limit = true;
                break;
            }
        }
    }
    assert!(got_limit);
    // No content assertion depends on how many bounded frames fit before quota.
    app.shutdown();
    task.abort();
}
