use axum::http::{HeaderMap, HeaderValue};
use futures_util::{SinkExt, StreamExt};
use pboard_signaling::{App, Config, Limits, policy::TransportPolicy};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
mod common;

async fn server(limits: Limits, policy: TransportPolicy) -> (String, tokio::task::JoinHandle<()>) {
    let app = App::new(
        Config {
            rooms: HashMap::new(),
        },
        limits,
    )
    .unwrap()
    .with_transport_policy(policy)
    .with_board_grants(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app.router()).await.unwrap();
    });
    (base, task)
}
#[test]
fn operator_limits_are_configurable_bounded_and_fail_closed() {
    let configured = Limits::from_settings(|key| match key {
        "PBOARD_SIGNALING_MAX_CONNECTIONS" => Some("20".into()),
        "PBOARD_SIGNALING_MAX_MESSAGE_BYTES" => Some("32768".into()),
        _ => None,
    })
    .unwrap();
    assert_eq!(configured.connections, 20);
    assert_eq!(configured.message_bytes, 32768);
    for (key, value) in [
        ("MAX_CONNECTIONS", "0"),
        ("MAX_CONNECTIONS", "2049"),
        ("MESSAGES_PER_SECOND", "unlimited"),
        ("IDLE_TIMEOUT_SECONDS", "121"),
        ("MAX_GRANT_BYTES", "0"),
        ("MAX_REPLAY_ENTRIES", "999999"),
    ] {
        assert!(
            Limits::from_settings(
                |actual| (actual == format!("PBOARD_SIGNALING_{key}")).then(|| value.into())
            )
            .is_err()
        );
    }
    assert!(
        App::new(
            Config {
                rooms: HashMap::new()
            },
            Limits {
                peers_per_room: 0,
                ..Limits::default()
            }
        )
        .is_err()
    );
}
#[test]
fn only_bounded_datachannel_negotiation_shapes_are_accepted() {
    assert!(pboard_signaling::signals::negotiation(
        &json!({"type":"offer","sdp":common::sdp()})
    ));
    assert!(pboard_signaling::signals::negotiation(
        &json!({"type":"answer","sdp":common::sdp()})
    ));
    assert!(pboard_signaling::signals::negotiation(
        &json!({"candidate":{"candidate":common::ICE,"sdpMid":"0","sdpMLineIndex":0}})
    ));
    for value in [
        json!({"documents":[]}),
        json!({"url":"https://example.test/proxy"}),
        json!({"type":"offer","sdp":common::sdp(),"data":"blob"}),
        json!({"type":"offer","sdp":"arbitrary blob"}),
        json!({"candidate":{"candidate":format!("{} arbitrary application-data",common::ICE)}}),
        json!({"candidate":{"candidate":"candidate:1 1 UDP 1 https://example.test 42 typ host"}}),
        json!({"renegotiate":true,"data":"blob"}),
        json!({"type":"offer","sdp":format!("{}a=unknown:arbitrary-data\r\n",common::sdp())}),
    ] {
        assert!(!pboard_signaling::signals::negotiation(&value));
    }
}
#[test]
fn origin_filter_is_defense_in_depth_and_tls_header_is_unambiguous() {
    let policy = TransportPolicy {
        require_tls_proxy: true,
        allowed_origins: HashSet::from(["https://app.example.test".into()]),
        ..TransportPolicy::default()
    };
    let mut headers = HeaderMap::new();
    assert!(!policy.permits(&headers));
    headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
    assert!(policy.permits(&headers));
    for origin in [
        "https://app.example.test",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "moz-extension://d93d6119-4704-4e24-9561-b7c02f7ed803",
    ] {
        headers.insert("origin", HeaderValue::from_str(origin).unwrap());
        assert!(policy.permits(&headers));
    }
    for origin in [
        "null",
        "https://evil.example.test",
        "http://127.0.0.1:5173",
        "moz-extension://bad",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.evil",
    ] {
        headers.insert("origin", HeaderValue::from_str(origin).unwrap());
        assert!(!policy.permits(&headers));
    }
    headers.insert(
        "origin",
        HeaderValue::from_static("https://app.example.test"),
    );
    headers.append(
        "origin",
        HeaderValue::from_static("https://evil.example.test"),
    );
    assert!(!policy.permits(&headers));
    headers.remove("origin");
    headers.append("x-forwarded-proto", HeaderValue::from_static("http"));
    assert!(!policy.permits(&headers));
}
#[tokio::test]
async fn proxy_tls_origin_and_spoofed_extension_origin_never_grant_admission() {
    let (base, task) = server(
        Limits::default(),
        TransportPolicy {
            require_tls_proxy: true,
            ..TransportPolicy::default()
        },
    )
    .await;
    let url = base.replace("http:", "ws:") + "/ws";
    assert!(connect_async(&url).await.is_err());
    let mut request = url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("x-forwarded-proto", HeaderValue::from_static("https"));
    request.headers_mut().insert(
        "origin",
        HeaderValue::from_static("https://evil.example.test"),
    );
    assert!(connect_async(request).await.is_err());
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("x-forwarded-proto", HeaderValue::from_static("https"));
    request.headers_mut().insert(
        "origin",
        HeaderValue::from_static("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    );
    let (mut ws, _) = connect_async(request).await.unwrap();
    ws.next().await.unwrap().unwrap();
    ws.send(Message::Text("{\"type\":\"join\"}".into()))
        .await
        .unwrap();
    let text = ws.next().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(text.to_text().unwrap()).unwrap()["code"],
        "invalid_state"
    );
    task.abort();
}
#[tokio::test]
async fn rejects_ambiguous_unknown_and_pre_auth_payloads() {
    let (base, task) = server(Limits::default(), TransportPolicy::default()).await;
    let url = base.replace("http:", "ws:") + "/ws";
    for text in [
        "{\"type\":\"unknown\"}",
        "{\"type\":\"join\",\"data\":\"blob\"}",
        "{\"type\":\"signal\",\"to\":\"x\",\"session\":\"x\",\"data\":{\"x\":1,\"x\":2}}",
        "{\"type\":\"ping\"}",
    ] {
        let (mut ws, _) = connect_async(&url).await.unwrap();
        ws.next().await.unwrap().unwrap();
        ws.send(Message::Text(text.into())).await.unwrap();
        let frame = ws.next().await.unwrap().unwrap();
        let reply: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        assert_eq!(reply["type"], "error");
    }
    task.abort();
}
#[tokio::test]
async fn global_traffic_and_http_slow_body_concurrency_are_bounded_before_parsing() {
    let (base, task) = server(
        Limits {
            global_messages_per_second: 1,
            ..Limits::default()
        },
        TransportPolicy::default(),
    )
    .await;
    for index in 0..2 {
        let (mut ws, _) = connect_async(base.replace("http:", "ws:") + "/ws")
            .await
            .unwrap();
        ws.next().await.unwrap().unwrap();
        ws.send(Message::Text("{\"type\":\"ping\"}".into()))
            .await
            .unwrap();
        let frame = ws.next().await.unwrap().unwrap();
        let reply: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        assert_eq!(
            reply["code"],
            if index == 0 {
                "invalid_state"
            } else {
                "traffic_limit"
            }
        );
    }
    task.abort();
    let (base, task) = server(
        Limits {
            http_concurrency: 1,
            ..Limits::default()
        },
        TransportPolicy::default(),
    )
    .await;
    let address = base.strip_prefix("http://").unwrap();
    let mut slow = tokio::net::TcpStream::connect(address).await.unwrap();
    slow.write_all(b"POST /grants/challenge HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{").await.unwrap();
    // A one-thread scheduling yield lets the deliberately incomplete request
    // occupy the only pre-parse permit, without a long timeout or large payload.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let http = reqwest::Client::new();
    assert_eq!(
        http.post(format!("{base}/grants/challenge"))
            .json(&json!({"version":2}))
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    drop(slow);
    task.abort();
}

#[tokio::test]
async fn unauthenticated_socket_flood_is_capped_and_auth_timeouts_release_capacity() {
    let (base, task) = server(
        Limits {
            connections: 2,
            auth: Duration::from_millis(250),
            ..Limits::default()
        },
        TransportPolicy::default(),
    )
    .await;
    let url = base.replace("http:", "ws:") + "/ws";
    for _round in 0..3 {
        let mut waiting = Vec::new();
        for _ in 0..2 {
            let (mut ws, _) = connect_async(&url).await.unwrap();
            let welcome = ws.next().await.unwrap().unwrap();
            let value: serde_json::Value =
                serde_json::from_str(welcome.to_text().unwrap()).unwrap();
            assert_eq!(value["type"], "welcome");
            waiting.push(ws);
        }
        // All capacity is occupied before anyone authenticates. A burst cannot
        // create more WebSocket session state or bypass the same admission cap.
        for _ in 0..6 {
            match connect_async(&url).await.unwrap_err() {
                tokio_tungstenite::tungstenite::Error::Http(response) => {
                    assert_eq!(response.status(), 503);
                }
                other => panic!("unexpected flood response: {other}"),
            }
        }
        assert_eq!(
            reqwest::get(format!("{base}/healthz"))
                .await
                .unwrap()
                .status(),
            200
        );
        for mut ws in waiting {
            let frame = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let error: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(error["code"], "auth_timeout");
            // Complete the close handshake instead of waiting for the server's
            // bounded slow-consumer close timeout.
            ws.close(None).await.ok();
        }
        tokio::task::yield_now().await;
    }
    task.abort();
}

#[tokio::test]
async fn abrupt_pre_auth_disconnect_releases_the_reserved_socket_slot() {
    let (base, task) = server(
        Limits {
            connections: 1,
            ..Limits::default()
        },
        TransportPolicy::default(),
    )
    .await;
    let url = base.replace("http:", "ws:") + "/ws";
    let (mut first, _) = connect_async(&url).await.unwrap();
    first.next().await.unwrap().unwrap();
    drop(first);
    let (mut next, _) = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match connect_async(&url).await {
                Ok(socket) => break socket,
                Err(tokio_tungstenite::tungstenite::Error::Http(response))
                    if response.status() == 503 =>
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("unexpected reconnect error: {error}"),
            }
        }
    })
    .await
    .unwrap();
    let frame = next.next().await.unwrap().unwrap();
    let value: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(value["type"], "welcome");
    task.abort();
}
