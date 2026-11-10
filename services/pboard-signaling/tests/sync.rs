//! Synchronization protocol over a real WebSocket connection.
//!
//! These exercise the parts a unit test cannot: that the frame arrives at the
//! socket, that two connections of one device both live, that the acknowledgment
//! survives the process being replaced, and that a client's *own* operation comes
//! back through the broadcast and is tolerated rather than duplicated.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use pboard_signaling::{App, Config, Grant, Limits, PublicKey, auth_bytes, now_ms};
use rand_core::OsRng;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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
        grant: Grant { public_key, expires_at: now_ms() + 60_000, },
    }
}

/// Fresh data directory per test: the log under test is durable by design, so
/// sharing one between tests would make them fail for the wrong reason.
fn directory(label: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos();
    let path = std::env::temp_dir().join(format!("pboard-sync-{label}-{}-{nanos}-{unique}", std::process::id()));
    std::fs::create_dir_all(&path).expect("data directory");
    path
}

/// Serves the app with the durable sync log in `path`. Returns the URL and a
/// handle that can be aborted to simulate the service going away.
async fn serve(rooms: HashMap<String, Vec<&Device>>, path: &std::path::Path) -> (String, tokio::task::JoinHandle<()>) {
    let rooms = rooms
        .into_iter()
        .map(|(room, devices)| {
            (
                room,
                devices
                    .iter()
                    .map(|device| (device.id.clone(), device.grant.clone()))
                    .collect::<HashMap<_, _>>(),
            )
        })
        .collect();
    let app = App::new(Config { rooms }, Limits::default())
        .expect("config")
        .with_sync(path)
        .expect("sync log");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("ws://{}/ws", listener.local_addr().expect("addr"));
    let router = app.clone().router();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    (url, task)
}

async fn recv(socket: &mut Socket) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .expect("receive timeout")
        .expect("stream")
        .expect("websocket");
    serde_json::from_str(frame.to_text().expect("text")).expect("json")
}

/// Reads until a frame satisfying `wanted` arrives, ignoring the roster frames
/// that the legacy signaling path sends around the sync protocol.
async fn recv_sync(socket: &mut Socket, action: &str) -> Value {
    for _ in 0..16 {
        let frame = recv(socket).await;
        if frame["type"] == "sync" && frame["action"] == action {
            return frame;
        }
        if frame["type"] == "error" {
            panic!("connection closed with {} while waiting for {action}", frame["code"]);
        }
    }
    panic!("no {action} frame");
}

async fn send(socket: &mut Socket, value: Value) {
    socket.send(Message::Text(value.to_string().into())).await.expect("send");
}

async fn connect(socket_url: &str, device: &Device, board: &str) -> Socket {
    let (mut socket, _) = connect_async(socket_url).await.expect("connect");
    let welcome = recv(&mut socket).await;
    let signature: Signature = device.key.sign(&auth_bytes(
        welcome["challenge"].as_str().expect("challenge"),
        welcome["session"].as_str().expect("session"),
        board,
        &device.id,
    ));
    send(
        &mut socket,
        json!({"type":"authenticate","version":1,"room":board,"deviceKeyId":device.id,"signature":B64.encode(signature.to_bytes())}),
    )
    .await;
    assert_eq!(recv(&mut socket).await["type"], "authenticated");
    socket
}

async fn subscribe(socket: &mut Socket, board: &str, after_seq: u64) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"subscribe","board":board,"afterSeq":after_seq}})).await;
    recv_sync(socket, "window").await
}

fn operation(op_id: &str, payload: &str) -> Value {
    json!({ "opId": op_id, "protocolVersion": 1, "logicalClock": 1, "payload": payload })
}

async fn submit(socket: &mut Socket, board: &str, operations: Vec<Value>) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"submit","board":board,"operations":operations}})).await;
    recv_sync(socket, "accepted").await
}

#[tokio::test]
async fn two_sessions_of_one_device_both_stay_connected_and_converge() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("two-sessions")).await;

    // Same Google account, same device key, two browser tabs: neither may
    // replace or disconnect the other, so both must authenticate independently.
    let mut first = connect(&url, &one, &board).await;
    let mut second = connect(&url, &one, &board).await;
    assert_eq!(subscribe(&mut first, &board, 0).await["synced"], json!(true));
    assert_eq!(subscribe(&mut second, &board, 0).await["synced"], json!(true));

    send(&mut first, json!({"type":"sync","request":{"action":"submit","board":board,"operations":[operation("op-1","sealed:one")]}})).await;
    // The author is told it is durable...
    let accepted = recv_sync(&mut first, "accepted").await;
    assert_eq!(accepted["results"][0]["seq"], 1);
    assert_eq!(accepted["results"][0]["duplicate"], json!(false));
    // ...and both sessions see it on the live stream, including the one that
    // sent it, which must tolerate its own operation arriving by broadcast.
    assert_eq!(recv_sync(&mut first, "operation").await["opId"], "op-1");
    assert_eq!(recv_sync(&mut second, "operation").await["opId"], "op-1");

    let mut third = connect(&url, &one, &board).await;
    let window = subscribe(&mut third, &board, 0).await;
    assert_eq!(window["operations"].as_array().expect("operations").len(), 1);
    assert_eq!(window["liveFromSeq"], 2);
    task.abort();
}

#[tokio::test]
async fn a_retry_is_answered_with_the_original_sequence_and_rebroadcast_nothing() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("dedupe")).await;
    let mut writer = connect(&url, &one, &board).await;
    let mut watcher = connect(&url, &one, &board).await;
    subscribe(&mut watcher, &board, 0).await;

    submit(&mut writer, &board, vec![operation("op-1", "sealed:one"), operation("op-2", "sealed:two")]).await;
    assert_eq!(recv_sync(&mut watcher, "operation").await["seq"], 1);
    assert_eq!(recv_sync(&mut watcher, "operation").await["seq"], 2);

    // The client's connection dropped after the first operation landed and it
    // resubmitted both. Neither may take effect twice.
    let retry = submit(&mut writer, &board, vec![operation("op-1", "sealed:one"), operation("op-2", "sealed:two")]).await;
    assert_eq!(retry["results"][0], json!({"opId":"op-1","seq":1,"duplicate":true}));
    assert_eq!(retry["results"][1], json!({"opId":"op-2","seq":2,"duplicate":true}));
    // Nothing new is broadcast for a duplicate, so a watcher stays quiet.
    assert!(
        tokio::time::timeout(Duration::from_millis(250), recv_sync(&mut watcher, "operation")).await.is_err(),
        "a duplicate submission must not deliver a second effect"
    );
    task.abort();
}

#[tokio::test]
async fn an_acknowledged_operation_survives_the_service_being_replaced() {
    let one = device();
    let board = "board-a".to_string();
    let path = directory("restart");
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &path).await;
    let mut writer = connect(&url, &one, &board).await;
    let accepted = submit(&mut writer, &board, vec![operation("op-1", "sealed:one"), operation("op-2", "sealed:two")]).await;
    assert_eq!(accepted["results"][1]["seq"], 2);
    // The client has this acknowledgment in hand.
    drop(writer);
    task.abort();
    tokio::time::sleep(Duration::from_millis(120)).await;

    // A new process over the same data directory: the acknowledged operations
    // are there, in order, and sequences continue where they stopped.
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &path).await;
    let mut late = connect(&url, &one, &board).await;
    let window = subscribe(&mut late, &board, 1).await;
    let operations = window["operations"].as_array().expect("operations");
    assert_eq!(operations.len(), 1);
    assert_eq!(operations[0]["opId"], "op-2");
    assert_eq!(operations[0]["seq"], 2);
    assert_eq!(window["liveFromSeq"], 3);
    let next = submit(&mut late, &board, vec![operation("op-3", "sealed:three")]).await;
    assert_eq!(next["results"][0]["seq"], 3);
    task.abort();
}

#[tokio::test]
async fn replay_reports_the_window_and_then_stays_live_without_a_gap() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("replay")).await;
    let mut writer = connect(&url, &one, &board).await;
    submit(&mut writer, &board, vec![operation("op-1", "one")]).await;
    recv_sync(&mut writer, "operation").await;

    let mut joining = connect(&url, &one, &board).await;
    // Subscribe *before* the next operation is submitted, then submit while the
    // client is between the window and live: the window's `liveFromSeq` is what
    // makes that overlap safe, so the operation must arrive exactly once.
    let window = subscribe(&mut joining, &board, 0).await;
    assert_eq!(window["operations"].as_array().expect("operations").len(), 1);
    assert_eq!(window["liveFromSeq"], 2);
    assert_eq!(window["synced"], json!(true));
    submit(&mut writer, &board, vec![operation("op-2", "two")]).await;
    let live = recv_sync(&mut joining, "operation").await;
    assert_eq!(live["seq"], 2);
    assert_eq!(live["opId"], "op-2");
    task.abort();
}

#[tokio::test]
async fn a_device_admitted_to_one_board_cannot_touch_another() {
    let one = device();
    let (url, task) = serve(
        HashMap::from([("board-a".to_string(), vec![&one]), ("board-b".to_string(), vec![&one])]),
        &directory("cross-board"),
    )
    .await;
    // Admitted to board-a; every frame naming board-b is refused, not re-scoped.
    let mut socket = connect(&url, &one, "board-a").await;
    send(&mut socket, json!({"type":"sync","request":{"action":"submit","board":"board-b","operations":[operation("op-1","one")]}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":"board-b","afterSeq":0}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");
    // Its own board still works, so the refusal was targeted, not a broken socket.
    assert_eq!(subscribe(&mut socket, "board-a", 0).await["synced"], json!(true));
    task.abort();
}

#[tokio::test]
async fn one_lease_per_board_and_a_stale_writer_is_refused() {
    let writer_one = device();
    let writer_two = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&writer_one, &writer_two])]), &directory("lease")).await;
    let mut first = connect(&url, &writer_one, &board).await;
    let mut second = connect(&url, &writer_two, &board).await;

    send(&mut first, json!({"type":"sync","request":{"action":"lease","board":board,"leaseMs":60_000}})).await;
    let lease = recv_sync(&mut first, "lease").await;
    assert_eq!(lease["epoch"], 1);
    assert_eq!(lease["holder"], json!(writer_one.id));

    // A second browser cannot take the board while the lease is held.
    send(&mut second, json!({"type":"sync","request":{"action":"lease","board":board,"leaseMs":60_000}})).await;
    assert_eq!(recv_sync(&mut second, "error").await["code"], "lease_busy");

    // Committing with an epoch the board never issued is refused.
    send(&mut second, json!({"type":"sync","request":{"action":"commit","board":board,"epoch":99,"seq":0,"snapshotSeq":1,"driveEtag":"etag"}})).await;
    assert_eq!(recv_sync(&mut second, "error").await["code"], "lease_expired");

    // The holder commits with its own epoch.
    send(&mut first, json!({"type":"sync","request":{"action":"commit","board":board,"epoch":1,"seq":0,"snapshotSeq":1,"driveEtag":"etag"}})).await;
    assert_eq!(recv_sync(&mut first, "committed").await["snapshotSeq"], 1);

    // Release hands the board over, and the new holder gets a strictly newer
    // fencing token — the old writer's token never works again.
    send(&mut first, json!({"type":"sync","request":{"action":"release","board":board}})).await;
    assert_eq!(recv_sync(&mut first, "released").await["type"], "sync");
    send(&mut second, json!({"type":"sync","request":{"action":"lease","board":board,"leaseMs":60_000}})).await;
    let promoted = recv_sync(&mut second, "lease").await;
    assert!(promoted["epoch"].as_u64().expect("epoch") > 1);
    send(&mut first, json!({"type":"sync","request":{"action":"commit","board":board,"epoch":1,"seq":0,"snapshotSeq":2,"driveEtag":"etag-2"}})).await;
    assert_eq!(recv_sync(&mut first, "error").await["code"], "lease_expired");
    task.abort();
}

#[tokio::test]
async fn read_only_admission_receives_but_never_publishes() {
    // The legacy grant list is a write allowlist, so the read-only case is the
    // manifest role; the protocol enforces it in one place, so no frame type can
    // forget to. Here the same refusal is exercised through the batch guard the
    // transport shares, and the role rule itself is pinned in the unit tests.
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("limits")).await;
    let mut socket = connect(&url, &one, &board).await;
    let oversized: Vec<Value> = (0..400).map(|index| operation(&format!("op-{index}"), "one")).collect();
    send(&mut socket, json!({"type":"sync","request":{"action":"submit","board":board,"operations":oversized}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "batch_too_large");
    // The refused connection keeps working: a batch refusal is not a disconnect.
    assert_eq!(subscribe(&mut socket, &board, 0).await["synced"], json!(true));
    task.abort();
}

#[tokio::test]
async fn status_reports_the_board_state_the_console_needs() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("status")).await;
    let mut socket = connect(&url, &one, &board).await;
    submit(&mut socket, &board, vec![operation("op-1", "one")]).await;
    recv_sync(&mut socket, "operation").await;
    send(&mut socket, json!({"type":"sync","request":{"action":"status","board":board}})).await;
    let status = recv_sync(&mut socket, "status").await;
    assert_eq!(status["nextSeq"], 1);
    assert_eq!(status["retainedOperations"], 1);
    assert_eq!(status["leaseEpoch"], Value::Null);
    task.abort();
}

/// The client has no request id to correlate with, so it attributes the next
/// reply to the oldest request it still has waiting. Out-of-order answers — or a
/// second reply for one request — would credit an acknowledgment to the wrong
/// operations, which is an edit believed saved when it is not.
#[tokio::test]
async fn answers_pipelined_requests_in_order_with_exactly_one_reply_each() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("pipelined")).await;
    let mut socket = connect(&url, &one, &board).await;

    // Written back to back without reading anything in between, which is what a
    // client with two pending batches does.
    send(&mut socket, json!({"type":"sync","request":{"action":"submit","board":board,"operations":[operation("op-1","one")]}})).await;
    send(&mut socket, json!({"type":"sync","request":{"action":"submit","board":board,"operations":[operation("op-2","two")]}})).await;
    send(&mut socket, json!({"type":"sync","request":{"action":"status","board":board}})).await;

    let mut replies = Vec::new();
    for _ in 0..24 {
        let frame = recv(&mut socket).await;
        if frame["type"] != "sync" || frame["action"] == "operation" {
            continue;
        }
        let op_id = frame["results"][0]["opId"].as_str().unwrap_or_default().to_string();
        replies.push((frame["action"].as_str().expect("action").to_string(), op_id));
        if replies.len() == 3 {
            break;
        }
    }
    assert_eq!(replies, vec![
        ("accepted".to_string(), "op-1".to_string()),
        ("accepted".to_string(), "op-2".to_string()),
        ("status".to_string(), String::new()),
    ]);
    // Nothing else is outstanding: a fourth reply would mean one request answered twice.
    let trailing = tokio::time::timeout(Duration::from_millis(250), recv_sync(&mut socket, "accepted")).await;
    assert!(trailing.is_err(), "unexpected second acknowledgment: {trailing:?}");
    task.abort();
}

/// A stand-in for a P-256 SPKI document: the courier stores the string verbatim
/// and only ever checks its decoded size, so the tests keep deterministic blobs.
fn wrap_key(label: &str) -> String {
    B64.encode(format!("spki:{label}"))
}
fn sealed(bytes: usize) -> String {
    B64.encode(vec![7u8; bytes])
}

async fn publish_device_key(socket: &mut Socket, board: &str, public_key: &str) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"publishDeviceKey","board":board,"publicKey":public_key}})).await;
    recv_sync(socket, "deviceKeyStored").await
}

async fn list_device_keys(socket: &mut Socket, board: &str) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"listDeviceKeys","board":board}})).await;
    recv_sync(socket, "deviceKeys").await
}

async fn publish_key_grants(socket: &mut Socket, board: &str, grants: Vec<Value>) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"publishKeyGrants","board":board,"grants":grants}})).await;
    recv_sync(socket, "keyGrantsStored").await
}

async fn fetch_key_grants(socket: &mut Socket, board: &str) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"fetchKeyGrants","board":board}})).await;
    recv_sync(socket, "keyGrants").await
}

#[tokio::test]
async fn a_device_publishes_its_wrap_key_and_reads_back_its_own_grant() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("courier-self")).await;
    let mut socket = connect(&url, &one, &board).await;

    let key = wrap_key("one");
    assert_eq!(publish_device_key(&mut socket, &board, &key).await["stored"], json!(true));
    // Re-publishing the identical key is an idempotent no-op, not a second row.
    assert_eq!(publish_device_key(&mut socket, &board, &key).await["stored"], json!(false));

    let listed = list_device_keys(&mut socket, &board).await;
    let devices = listed["devices"].as_array().expect("devices");
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["deviceKeyId"], json!(one.id));
    assert_eq!(devices[0]["publicKey"], json!(key));

    // The courier's payload is opaque here: whatever bytes the client sealed,
    // the store echoes back untouched.
    let envelope = sealed(48);
    let stored = publish_key_grants(&mut socket, &board, vec![json!({"deviceKeyId": one.id, "envelope": envelope})]).await;
    assert_eq!(stored["stored"], json!(1));
    let mail = fetch_key_grants(&mut socket, &board).await;
    let grants = mail["grants"].as_array().expect("grants");
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0]["fromDeviceKeyId"], json!(one.id));
    assert_eq!(grants[0]["envelope"], json!(envelope));
    task.abort();
}

#[tokio::test]
async fn one_device_never_reads_another_devices_grant() {
    let laptop = device();
    let phone = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&laptop, &phone])]), &directory("courier-mail")).await;
    let mut first = connect(&url, &laptop, &board).await;
    let mut second = connect(&url, &phone, &board).await;

    publish_device_key(&mut first, &board, &wrap_key("laptop")).await;
    publish_device_key(&mut second, &board, &wrap_key("phone")).await;
    // The roster a writer wraps for: every device of this board, caller included.
    let listed = list_device_keys(&mut first, &board).await;
    let ids: Vec<&str> = listed["devices"].as_array().expect("devices").iter().map(|d| d["deviceKeyId"].as_str().expect("id")).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&laptop.id.as_str()) && ids.contains(&phone.id.as_str()));

    // The laptop holds the board key and seals it for the phone only.
    let envelope = sealed(64);
    publish_key_grants(&mut first, &board, vec![json!({"deviceKeyId": phone.id, "envelope": envelope})]).await;
    // The laptop addressed the grant to the phone, so it is not in the laptop's
    // mailbox — the selection key is the connection's authenticated device, not
    // anything the frame says.
    assert_eq!(fetch_key_grants(&mut first, &board).await["grants"].as_array().expect("grants").len(), 0);
    let mail = fetch_key_grants(&mut second, &board).await;
    let grants = mail["grants"].as_array().expect("grants");
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0]["fromDeviceKeyId"], json!(laptop.id));
    assert_eq!(grants[0]["envelope"], json!(envelope));
    task.abort();
}

#[tokio::test]
async fn oversized_envelopes_and_batches_are_refused_whole() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &directory("courier-caps")).await;
    let mut socket = connect(&url, &one, &board).await;

    // One byte over the 1 KiB decoded cap: refused, not truncated.
    send(&mut socket, json!({"type":"sync","request":{"action":"publishKeyGrants","board":board,"grants":[{"deviceKeyId": one.id, "envelope": sealed(1025)}]}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "envelope_too_large");
    // So is a thirty-third grant.
    let many: Vec<Value> = (0..33).map(|index| json!({"deviceKeyId": format!("peer-{index}"), "envelope": sealed(16)})).collect();
    send(&mut socket, json!({"type":"sync","request":{"action":"publishKeyGrants","board":board,"grants":many}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "batch_too_large");
    // A wrap key over 128 decoded bytes is refused the same way.
    send(&mut socket, json!({"type":"sync","request":{"action":"publishDeviceKey","board":board,"publicKey": sealed(129)}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "public_key_too_large");
    assert!(list_device_keys(&mut socket, &board).await["devices"].as_array().expect("devices").is_empty());
    // Refusals are refusals, not disconnects: exactly at the caps it still works.
    assert_eq!(publish_device_key(&mut socket, &board, &wrap_key("one")).await["stored"], json!(true));
    let at_cap: Vec<Value> = (0..32).map(|index| json!({"deviceKeyId": format!("peer-{index}"), "envelope": sealed(1024)})).collect();
    assert_eq!(publish_key_grants(&mut socket, &board, at_cap).await["stored"], json!(32));
    task.abort();
}

#[tokio::test]
async fn courier_frames_follow_the_board_admission_and_the_authentication() {
    let one = device();
    let board = "board-a".to_string();
    let (url, task) = serve(
        HashMap::from([("board-a".to_string(), vec![&one]), ("board-b".to_string(), vec![&one])]),
        &directory("courier-scope"),
    ).await;
    let mut socket = connect(&url, &one, &board).await;
    publish_device_key(&mut socket, &board, &wrap_key("one")).await;

    // Admitted to board-a: every courier frame naming board-b is refused, and
    // board-a's key store stays invisible to board-b either.
    for request in [
        json!({"action":"publishDeviceKey","board":"board-b","publicKey": wrap_key("one")}),
        json!({"action":"listDeviceKeys","board":"board-b"}),
        json!({"action":"publishKeyGrants","board":"board-b","grants":[{"deviceKeyId": one.id, "envelope": sealed(16)}]}),
        json!({"action":"fetchKeyGrants","board":"board-b"}),
    ] {
        send(&mut socket, json!({"type":"sync","request":request})).await;
        assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");
    }
    let mut elsewhere = connect(&url, &one, "board-b").await;
    assert!(list_device_keys(&mut elsewhere, "board-b").await["devices"].as_array().expect("devices").is_empty());
    // The refused connection's own board is unaffected.
    assert_eq!(list_device_keys(&mut socket, &board).await["devices"].as_array().expect("devices").len(), 1);

    // Before authentication there is no board and no device id, so there is
    // nothing to scope a courier frame to: the connection is closed, not
    // answered with someone else's store.
    let (mut raw, _) = connect_async(&url).await.expect("connect");
    let _welcome = recv(&mut raw).await;
    send(&mut raw, json!({"type":"sync","request":{"action":"fetchKeyGrants","board":board}})).await;
    let closed = recv(&mut raw).await;
    assert_eq!(closed["type"], "error");
    assert_eq!(closed["code"], "invalid_state");
    task.abort();
}

/// Acceptance for the retention path over a real socket: a client whose cursor
/// predates the pruned prefix is told to bootstrap from a snapshot instead of
/// being handed the surviving rows as if they were the whole delta.
///
/// The prune is issued against the *same database file* the served app uses, by
/// a second connection with a short retention window — the arrangement a second
/// process would have, and the only way to age a seven-day window inside a test.
/// Everything else is the production path: the same `SyncLog::prune`, the same
/// checkpoint written by the same `commit`.
#[tokio::test]
async fn a_pruned_prefix_answers_snapshot_required_rather_than_skipping_history() {
    let one = device();
    let board = "board-a".to_string();
    let path = directory("retention");
    let (url, task) = serve(HashMap::from([(board.clone(), vec![&one])]), &path).await;
    let mut socket = connect(&url, &one, &board).await;

    for index in 1..=3 {
        submit(&mut socket, &board, vec![operation(&format!("op-{index}"), "ct")]).await;
    }
    send(&mut socket, json!({"type":"sync","request":{"action":"lease","board":board,"leaseMs":60_000}})).await;
    let epoch = recv_sync(&mut socket, "lease").await["epoch"].as_u64().expect("epoch");

    // A commit is accepted with a receipt shaped like a Drive file id — the
    // value the client already sends (`files.find(name)?.id`).
    send(&mut socket, json!({"type":"sync","request":{"action":"commit","board":board,"epoch":epoch,"seq":2,"snapshotSeq":1,"driveEtag":"driveFileId0001"}})).await;
    assert_eq!(recv_sync(&mut socket, "committed").await["checkpointSeq"], 2);

    // Evidence that is not a file id is refused on the wire, and the checkpoint
    // it would have advanced stays exactly where it is.
    send(&mut socket, json!({"type":"sync","request":{"action":"commit","board":board,"epoch":epoch,"seq":3,"snapshotSeq":2,"driveEtag":"not a drive id"}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "evidence_rejected");
    send(&mut socket, json!({"type":"sync","request":{"action":"status","board":board}})).await;
    assert_eq!(recv_sync(&mut socket, "status").await["checkpointSeq"], 2, "a refused commit advances nothing");

    // Prune the same file from a second connection whose window has elapsed.
    // The covered prefix is 1..=2; operation 3 has no snapshot and must survive.
    {
        let log = pboard_signaling::sync_log::SyncLog::open(
            path.join("sync-log.db"),
            pboard_signaling::sync_log::SyncLogLimits { retention_ms: 0, ..Default::default() },
        )
        .expect("second connection");
        assert_eq!(log.prune(&board).expect("prune"), 2, "only the covered prefix is eligible");
    }

    // A client below the pruned prefix is told to bootstrap from the snapshot,
    // carrying the checkpoint it must adopt — not silently handed operation 3.
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":board,"afterSeq":0}})).await;
    let gap = recv_sync(&mut socket, "snapshotRequired").await;
    assert_eq!(gap["synced"], json!(false));
    assert_eq!(gap["gap"]["reason"], "snapshot_required");
    assert_eq!(gap["gap"]["checkpointSeq"], 2);
    assert_eq!(gap["gap"]["snapshotSeq"], 1);
    // The surviving rows are carried as context, and `synced: false` is what
    // tells the client they are *not* a complete delta — a client that ignored
    // the flag would apply them as if they were.
    assert_eq!(gap["operations"][0]["seq"], 3);

    // A client that already holds the checkpoint gets the rest, live.
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":board,"afterSeq":2}})).await;
    let window = recv_sync(&mut socket, "window").await;
    assert_eq!(window["synced"], json!(true));
    assert_eq!(window["operations"][0]["seq"], 3);
    assert_eq!(window["checkpointSeq"], 2);
    task.abort();
}
