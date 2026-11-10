//! Protocol v3: several rooms on one connection.
//!
//! Everything here exercises the property the single-room protocol could not
//! express — that one authenticated socket can hold several boards, each with its
//! own authorization and its own role, and that losing one room (a refusal, a
//! revocation, a budget) is not losing the connection. The v2 half of the file is
//! a regression: v3 shipped first, so a v2 client's frames must behave exactly as
//! they did before v3 existed.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use pboard_signaling::{App, Config, Limits, PublicKey, admission, now_ms};
use rand_core::OsRng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Device {
    key: SigningKey,
    public: PublicKey,
    id: String,
}

fn device() -> Device {
    let key = SigningKey::random(&mut OsRng);
    let point = key.verifying_key().to_encoded_point(false);
    let public = PublicKey {
        kty: "EC".into(),
        crv: "P-256".into(),
        x: B64.encode(point.x().expect("x")),
        y: B64.encode(point.y().expect("y")),
    };
    Device { id: public.fingerprint(), public, key }
}

fn jwk(d: &Device) -> Value {
    json!({"kty":d.public.kty,"crv":d.public.crv,"x":d.public.x,"y":d.public.y})
}

/// A signed membership manifest for one board, at one epoch.
///
/// `roles` is `(device, role)` so a test can put the same device in a viewer
/// seat on one board and an editor seat on another, which is the case that made
/// a per-connection role flag wrong.
fn manifest(authority: &Device, board: &str, epoch: u64, roles: &[(&Device, &str)]) -> Value {
    json!({
        "protocol": 2,
        "boardId": board,
        "driveProjectFileId": "",
        "driveFolderId": "",
        "authorityKeyId": authority.id,
        "epoch": epoch,
        "issuedAt": now_ms(),
        "expiresAt": now_ms() + 60_000,
        "devices": roles.iter().map(|(d, role)| json!({"deviceKeyId": d.id, "publicKey": jwk(d), "role": role})).collect::<Vec<_>>(),
    })
}

/// The cards topic for a board. `admission::verify` derives the room from
/// `pboard-collab-<boardId>-cards`, so a ticket whose topic disagrees with its
/// board id is a manifest the server refuses — which is the test harness's job
/// to get right, not the thing under test.
fn cards_topic(board: &str) -> String {
    format!("pboard-collab-{board}-cards")
}

/// A manifest for `board` at `epoch` with the given seats, packaged as a ticket
/// this relay will accept.
fn board_ticket(authority: &Device, board: &str, epoch: u64, roles: &[(&Device, &str)]) -> Ticket {
    let topic = cards_topic(board);
    ticket(authority, &manifest(authority, board, epoch, roles), &topic)
}

#[derive(Clone)]
struct Ticket {
    room: String,
    authorization: Value,
    digest: String,
}

fn ticket(authority: &Device, value: &Value, topic: &str) -> Ticket {
    let bytes = serde_json::to_vec(value).expect("manifest");
    let mut signed = b"pboard-manifest-v2".to_vec();
    signed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    signed.extend_from_slice(&bytes);
    let signature: Signature = authority.key.sign(&signed);
    Ticket {
        room: admission::room_name(&authority.id, topic, "", ""),
        digest: B64.encode(Sha256::digest(&bytes)),
        authorization: json!({
            "topic": topic,
            "authority": jwk(authority),
            "manifestPayload": B64.encode(bytes),
            "manifestSignature": B64.encode(signature.to_bytes()),
        }),
    }
}

/// The `authenticate` frame for a v3 connection's *first* room.
fn authenticate_frame(d: &Device, welcome: &Value, t: &Ticket, version: u8) -> Value {
    let signature: Signature = d.key.sign(&admission::auth_bytes(
        welcome["challenge"].as_str().expect("challenge"),
        welcome["session"].as_str().expect("session"),
        &t.room,
        &d.id,
        &t.digest,
    ));
    json!({
        "type": "authenticate",
        "version": version,
        "room": t.room,
        "deviceKeyId": d.id,
        "signature": B64.encode(signature.to_bytes()),
        "authorization": t.authorization,
    })
}

/// The `attach` frame for a *further* room, signed over that room's own digest
/// with the same challenge and session. This is what makes per-room
/// authorization survive multiplexing: the proof is bound to the room it names.
fn attach_frame(d: &Device, welcome: &Value, t: &Ticket) -> Value {
    let signature: Signature = d.key.sign(&admission::auth_bytes(
        welcome["challenge"].as_str().expect("challenge"),
        welcome["session"].as_str().expect("session"),
        &t.room,
        &d.id,
        &t.digest,
    ));
    json!({
        "type": "attach",
        "room": t.room,
        "signature": B64.encode(signature.to_bytes()),
        "authorization": t.authorization,
    })
}

fn unique() -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos();
    std::env::temp_dir().join(format!("pboard-v3-{}-{nanos}-{n}", std::process::id()))
}

/// Serves the app with board grants and a durable sync log, so attach and the
/// operation log are both live. `limits` is a closure so a test can shape the
/// byte accounting without every other test inheriting it.
async fn serve(limits: Limits) -> (App, String, String, tokio::task::JoinHandle<std::io::Result<()>>) {
    let directory = unique();
    std::fs::create_dir_all(&directory).expect("data directory");
    let app = App::new(Config { rooms: HashMap::new() }, limits)
        .expect("config")
        .with_board_grants(true)
        .with_sync(&directory)
        .expect("sync log");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let task = tokio::spawn(axum::serve(listener, app.clone().router()).into_future());
    (app, base.clone(), base.replace("http:", "ws:") + "/ws", task)
}

async fn recv(socket: &mut Socket) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("receive timeout")
        .expect("stream")
        .expect("websocket");
    serde_json::from_str(frame.to_text().expect("text")).expect("json")
}

/// Reads until a frame of `kind` arrives, ignoring anything else.
async fn recv_type(socket: &mut Socket, kind: &str) -> Value {
    for _ in 0..32 {
        let frame = recv(socket).await;
        if frame["type"] == kind {
            return frame;
        }
        if frame["type"] == "error" {
            panic!("socket closed with {} while waiting for {kind}", frame["code"]);
        }
    }
    panic!("no {kind} frame");
}

async fn recv_sync(socket: &mut Socket, action: &str) -> Value {
    for _ in 0..64 {
        let frame = recv(socket).await;
        if frame["type"] == "sync" && frame["action"] == action {
            return frame;
        }
        if frame["type"] == "error" {
            panic!("socket closed with {} while waiting for sync/{action}", frame["code"]);
        }
    }
    panic!("no sync/{action} frame");
}

/// Asserts that nothing arrives for `window`, and returns what did if anything
/// did — the assertion message then names it.
async fn expect_quiet(socket: &mut Socket, window: Duration) -> Option<Value> {
    match tokio::time::timeout(window, socket.next()).await {
        Err(_) => None,
        Ok(Some(Ok(Message::Text(text)))) => Some(serde_json::from_str(&text).expect("json")),
        Ok(other) => Some(json!({"unexpected": format!("{other:?}")})),
    }
}

async fn send(socket: &mut Socket, value: Value) {
    socket.send(Message::Text(value.to_string().into())).await.expect("send");
}

fn operation(op_id: &str) -> Value {
    json!({ "opId": op_id, "protocolVersion": 1, "logicalClock": 1, "payload": format!("sealed:{op_id}") })
}

async fn subscribe(socket: &mut Socket, board: &str, after_seq: u64) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"subscribe","board":board,"afterSeq":after_seq}})).await;
    recv_sync(socket, "window").await
}

async fn submit(socket: &mut Socket, board: &str, ops: Vec<Value>) -> Value {
    send(socket, json!({"type":"sync","request":{"action":"submit","board":board,"operations":ops}})).await;
    recv_sync(socket, "accepted").await
}

/// Connects, authenticates to `first` as a v3 client, and returns the socket and
/// the welcome frame (which carries the challenge every later attach signs).
async fn connect_v3(url: &str, d: &Device, first: &Ticket) -> (Socket, Value) {
    let (mut socket, _) = connect_async(url).await.expect("connect");
    let welcome = recv(&mut socket).await;
    assert_eq!(welcome["type"], "welcome");
    assert!(
        welcome["supportedVersions"].as_array().expect("versions").contains(&json!(3)),
        "a v3 server must advertise 3: {welcome}"
    );
    send(&mut socket, authenticate_frame(d, &welcome, first, 3)).await;
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "authenticated", "{reply}");
    (socket, welcome)
}

async fn attach(socket: &mut Socket, d: &Device, welcome: &Value, t: &Ticket) -> Value {
    send(socket, attach_frame(d, welcome, t)).await;
    recv_type(socket, "attached").await
}

/// Publishes a manifest into the board-grant cache, which is what makes an
/// epoch bump observable to a live connection.
///
/// The last entry of `history` is the current manifest; earlier entries are
/// retained because the cache refuses a bundle whose epochs do not strictly
/// increase, which is what makes an epoch bump an append rather than a fork. The last entry is the current
/// manifest; earlier entries are retained because the cache refuses a bundle
/// whose epochs do not strictly increase, which is what makes an epoch bump an
/// append rather than a fork.
async fn publish(http: &reqwest::Client, base: &str, authority: &Device, t: &Ticket) {
    publish_history(http, base, authority, std::slice::from_ref(t)).await;
}

async fn publish_history(http: &reqwest::Client, base: &str, authority: &Device, history: &[Ticket]) {
    // The publishing device must hold an owner seat in the manifest being
    // published: the authority signs both the manifest and the publication, and
    // `verify` requires an owner to be present. Every manifest here lists the
    // authority as owner, so the authority is the signer.
    let t = history.last().expect("history");
    let hello = http
        .post(format!("{base}/grants/challenge"))
        .json(&json!({"version": 2}))
        .send()
        .await
        .expect("challenge")
        .json::<Value>()
        .await
        .expect("challenge body");
    let raw = B64.decode(t.authorization["manifestPayload"].as_str().expect("payload")).expect("payload");
    let payload: Value = serde_json::from_slice(&raw).expect("manifest json");
    let digest = B64.encode(Sha256::digest(&raw));
    let signature: Signature = authority.key.sign(
        &serde_json::to_vec(&json!([
            "pboard-grant-publish-v2",
            hello["challenge"],
            authority.id,
            payload["boardId"],
            digest,
        ]))
        .expect("canonical"),
    );
    // The publishing device signs the same binding an `authenticate` would.
    let device_signature: Signature = authority.key.sign(&admission::auth_bytes(
        "publish",
        "publish",
        &t.room,
        &authority.id,
        &t.digest,
    ));
    let body = json!({
        "version": 2,
        "challenge": hello["challenge"],
        "authoritySignature": B64.encode(signature.to_bytes()),
        "bundle": {
            "version": 1,
            "authority": jwk(authority),
            "history": history.iter().map(|entry| json!({"payload": entry.authorization["manifestPayload"], "signature": entry.authorization["manifestSignature"]})).collect::<Vec<_>>(),
        },
        "deviceKeyId": authority.id,
        "signature": B64.encode(device_signature.to_bytes()),
    });
    let response = http
        .post(format!("{base}/grants/publish"))
        .json(&body)
        .send()
        .await
        .expect("publish");
    let status = response.status();
    let refusal = response.text().await.unwrap_or_default();
    assert_eq!(status, 204, "publication refused ({status}): {refusal}");
}

/// (a) Three board rooms on one connection, each receiving only its own traffic.
///
/// This is the acceptance criterion that makes "one socket per session" real: if
/// the fan-out leaked across rooms, a single socket would merge three boards'
/// streams into one and the per-room cursor would be meaningless.
#[tokio::test]
async fn one_connection_attaches_three_rooms_and_filters_each_one() {
    let authority = device();
    let user = device();
    let (app, base, url, task) = serve(Limits::default()).await;
    let http = reqwest::Client::new();
    let boards = ["board-one", "board-two", "board-three"];
    let mut tickets = Vec::new();
    for board in boards {
        let t = board_ticket(&authority, board, 1, &[(&authority, "owner"), (&user, "editor")]);
        publish(&http, &base, &authority, &t).await;
        tickets.push(t);
    }

    let (mut socket, welcome) = connect_v3(&url, &user, &tickets[0]).await;
    for (index, t) in tickets.iter().enumerate().skip(1) {
        let attached = attach(&mut socket, &user, &welcome, t).await;
        assert_eq!(attached["type"], "attached", "attach {:?} refused: {attached}", boards[index]);
        assert_eq!(attached["room"], t.room);
        assert_eq!(attached["role"], "editor");
    }
    for (index, t) in tickets.iter().enumerate() {
        let window = subscribe(&mut socket, &t.room, 0).await;
        assert_eq!(window["synced"], json!(true), "board {index} did not sync");
    }

    // One submission per room, and each room receives exactly its own.
    for (index, t) in tickets.iter().enumerate() {
        let accepted = submit(&mut socket, &t.room, vec![operation(&format!("op-{index}"))]).await;
        assert_eq!(accepted["results"][0]["duplicate"], json!(false));
        assert_eq!(accepted["board"], t.room);
        let live = recv_sync(&mut socket, "operation").await;
        assert_eq!(live["board"], t.room);
        assert_eq!(live["opId"], format!("op-{index}"));
        // Nothing leaks from the other rooms: the socket must be quiet now.
        let stray = expect_quiet(&mut socket, Duration::from_millis(250)).await;
        assert!(stray.is_none(), "cross-room leak after submitting to {index}: {stray:?}");
    }

    // The three logs stayed separate: each has exactly its own operation.
    for (index, t) in tickets.iter().enumerate() {
        let window = subscribe(&mut socket, &t.room, 0).await;
        let operations = window["operations"].as_array().expect("operations");
        assert_eq!(operations.len(), 1, "board {index} has {operations:?}");
        assert_eq!(operations[0]["opId"], format!("op-{index}"));
    }
    app.shutdown();
    task.abort();
}

/// (b) A viewer seat on one board and an editor seat on another, one connection.
///
/// The single-room protocol carried the role in a connection-level `writer` flag.
/// That flag cannot describe this connection, which is exactly why the role moved
/// onto the room.
#[tokio::test]
async fn one_connection_can_be_viewer_in_one_room_and_editor_in_another() {
    let authority = device();
    let user = device();
    let (app, base, url, task) = serve(Limits::default()).await;
    let http = reqwest::Client::new();
    let editor_room = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&user, "editor")]);
    let viewer_room = board_ticket(&authority, "board-readonly", 1, &[(&authority, "owner"), (&user, "viewer")]);
    publish(&http, &base, &authority, &editor_room).await;
    publish(&http, &base, &authority, &viewer_room).await;

    let (mut socket, welcome) = connect_v3(&url, &user, &editor_room).await;
    let attached = attach(&mut socket, &user, &welcome, &viewer_room).await;
    assert_eq!(attached["role"], "viewer");
    subscribe(&mut socket, &editor_room.room, 0).await;
    subscribe(&mut socket, &viewer_room.room, 0).await;

    // The editor room accepts a write.
    let accepted = submit(&mut socket, &editor_room.room, vec![operation("op-editor")]).await;
    assert_eq!(accepted["results"][0]["seq"], 1);
    recv_sync(&mut socket, "operation").await;

    // The viewer room refuses it, on the same socket, without collateral.
    send(&mut socket, json!({"type":"sync","request":{"action":"submit","board":viewer_room.room,"operations":[operation("op-viewer")]}})).await;
    let refused = recv_sync(&mut socket, "error").await;
    assert_eq!(refused["code"], "read_only");
    assert_eq!(refused["board"], viewer_room.room);

    // A viewer may still read, and the editor room still writes: neither the
    // role of one room nor the socket bled into the other.
    let window = subscribe(&mut socket, &viewer_room.room, 0).await;
    assert_eq!(window["operations"].as_array().expect("operations").len(), 0);
    let again = submit(&mut socket, &editor_room.room, vec![operation("op-editor-2")]).await;
    assert_eq!(again["results"][0]["seq"], 2);
    app.shutdown();
    task.abort();
}

/// (c) A room this connection may not hold is refused, and nothing else dies.
#[tokio::test]
async fn an_unauthorized_attach_is_refused_without_closing_the_socket() {
    let authority = device();
    let user = device();
    let outsider = device();
    let (app, base, url, task) = serve(Limits::default()).await;
    let http = reqwest::Client::new();
    let mine = board_ticket(&authority, "board-mine", 1, &[(&authority, "owner"), (&user, "editor")]);
    // A manifest that does not name this device at all: a valid proof, correctly
    // signed, for a room this connection has no seat in.
    let foreign = board_ticket(&authority, "board-foreign", 1, &[(&authority, "owner"), (&outsider, "editor")]);
    publish(&http, &base, &authority, &mine).await;
    publish(&http, &base, &authority, &foreign).await;

    let (mut socket, welcome) = connect_v3(&url, &user, &mine).await;
    subscribe(&mut socket, &mine.room, 0).await;

    send(&mut socket, attach_frame(&user, &welcome, &foreign)).await;
    // The refusal is a targeted answer, not a disconnect.
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "refused", "expected a refusal frame, got {reply}");
    assert_eq!(reply["code"], "unauthorized");

    // The attached room is untouched and still serves frames.
    let accepted = submit(&mut socket, &mine.room, vec![operation("op-after-refusal")]).await;
    assert_eq!(accepted["results"][0]["duplicate"], json!(false));
    // And the refused room is not reachable through the sync protocol either.
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":foreign.room,"afterSeq":0}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");
    app.shutdown();
    task.abort();
}

/// (d) An epoch bump on one room detaches only that room.
///
/// The revocation machinery already existed; what it could not do was scope. A
/// bumped manifest now ends one attachment and leaves the connection — and every
/// other board's cursor — alone.
#[tokio::test]
async fn an_epoch_bump_detaches_only_the_bumped_room() {
    let authority = device();
    let user = device();
    let (app, base, url, task) = serve(Limits::default()).await;
    let http = reqwest::Client::new();
    let bumped = board_ticket(&authority, "board-bumped", 1, &[(&authority, "owner"), (&user, "editor")]);
    let stable = board_ticket(&authority, "board-stable", 1, &[(&authority, "owner"), (&user, "editor")]);
    publish(&http, &base, &authority, &bumped).await;
    publish(&http, &base, &authority, &stable).await;

    let (mut socket, welcome) = connect_v3(&url, &user, &bumped).await;
    attach(&mut socket, &user, &welcome, &stable).await;
    subscribe(&mut socket, &bumped.room, 0).await;
    subscribe(&mut socket, &stable.room, 0).await;

    // Epoch 2 of the same board, same members: the authority has reissued the
    // grant, which is what a revocation looks like from the server's side.
    let next = board_ticket(&authority, "board-bumped", 2, &[(&authority, "owner"), (&user, "editor")]);
    publish_history(&http, &base, &authority, &[bumped.clone(), next]).await;

    let detached = recv_type(&mut socket, "detached").await;
    assert_eq!(detached["room"], bumped.room);
    assert_eq!(detached["code"], "authorization_changed");

    // The bumped room is gone from this connection...
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":bumped.room,"afterSeq":0}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");
    // ...and the stable room still works, on the same socket, with its cursor.
    let accepted = submit(&mut socket, &stable.room, vec![operation("op-stable")]).await;
    assert_eq!(accepted["results"][0]["seq"], 1);
    let live = recv_sync(&mut socket, "operation").await;
    assert_eq!(live["board"], stable.room);
    app.shutdown();
    task.abort();
}

/// (e) A v2 client sees exactly the v2 protocol: unknown *fields* tolerated,
/// unknown *actions* still fatal, and a foreign board still refused.
#[tokio::test]
async fn a_v2_client_behaves_exactly_as_before_v3() {
    let authority = device();
    let user = device();
    let directory = unique();
    std::fs::create_dir_all(&directory).expect("data directory");
    let app = App::new(Config { rooms: HashMap::new() }, Limits::default())
        .expect("config")
        .with_automatic_admission(true)
        .with_sync(&directory)
        .expect("sync log");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("ws://{}/ws", listener.local_addr().expect("addr"));
    let task = tokio::spawn(axum::serve(listener, app.clone().router()).into_future());

    let mine = board_ticket(&authority, "board-v2", 1, &[(&authority, "owner"), (&user, "editor")]);
    let other = board_ticket(&authority, "board-other", 1, &[(&authority, "owner"), (&user, "editor")]);

    let (mut socket, _) = connect_async(&url).await.expect("connect");
    let welcome = recv(&mut socket).await;
    // The capability list grew; the negotiated version is still whatever the
    // client asked for, and v2 is still offered.
    assert!(welcome["supportedVersions"].as_array().expect("versions").contains(&json!(2)));
    send(&mut socket, authenticate_frame(&user, &welcome, &mine, 2)).await;
    let authenticated = recv(&mut socket).await;
    assert_eq!(authenticated["type"], "authenticated");
    assert_eq!(authenticated["version"], 2);

    // A v2 client cannot attach: the frame does not exist in its vocabulary, so
    // it is a state violation and closes the socket, exactly as an unknown frame
    // always did. (This is the reason the *server* had to ship first.)
    // A sync frame carrying an extra field is tolerated, as it always was.
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":mine.room,"afterSeq":0,"extraField":true}})).await;
    let window = recv_sync(&mut socket, "window").await;
    assert_eq!(window["synced"], json!(true));

    // A board the connection was not admitted to is still `board_mismatch`,
    // not a new room.
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":other.room,"afterSeq":0}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");

    // An unknown action still closes a v2 connection.
    send(&mut socket, json!({"type":"nonsense","whatever":1})).await;
    let closed = recv(&mut socket).await;
    assert_eq!(closed["type"], "error");
    assert_eq!(closed["code"], "malformed");
    app.shutdown();
    task.abort();
}

/// A v2 client that tries the v3 vocabulary is a state violation, not a newer
/// client: it negotiated v2, so it gets v2's answer. This is the byte-for-byte
/// guarantee that lets the server ship before the client.
#[tokio::test]
async fn a_v2_connection_cannot_attach_a_second_room() {
    let authority = device();
    let user = device();
    let directory = unique();
    std::fs::create_dir_all(&directory).expect("data directory");
    let app = App::new(Config { rooms: HashMap::new() }, Limits::default())
        .expect("config")
        .with_automatic_admission(true)
        .with_sync(&directory)
        .expect("sync log");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("ws://{}/ws", listener.local_addr().expect("addr"));
    let task = tokio::spawn(axum::serve(listener, app.clone().router()).into_future());

    let first = board_ticket(&authority, "board-v2-a", 1, &[(&authority, "owner"), (&user, "editor")]);
    let second = board_ticket(&authority, "board-v2-b", 1, &[(&authority, "owner"), (&user, "editor")]);
    let (mut socket, _) = connect_async(&url).await.expect("connect");
    let welcome = recv(&mut socket).await;
    send(&mut socket, authenticate_frame(&user, &welcome, &first, 2)).await;
    assert_eq!(recv(&mut socket).await["type"], "authenticated");
    send(&mut socket, attach_frame(&user, &welcome, &second)).await;
    let closed = recv(&mut socket).await;
    assert_eq!(closed["type"], "error");
    // `malformed`, exactly as any unknown frame closes a v1/v2 connection: a
    // v2 client gets v2's answer, not a new one invented by the v3 build.
    assert_eq!(closed["code"], "malformed");
    app.shutdown();
    task.abort();
}

/// (f) A long-lived multiplexed connection is not killed by cumulative bytes.
///
/// The old `session_bytes` was a lifetime total that never reset, so a socket
/// that carried 4 MiB over its life died on its own history. Here the connection
/// deliberately moves well past that figure and keeps working; the budget it is
/// held to is a rolling window, which it satisfies.
#[tokio::test]
async fn a_long_lived_connection_survives_past_the_old_lifetime_cap() {
    let authority = device();
    let user = device();
    let (app, base, url, task) = serve(Limits {
        // Room for the test to be about the *lifetime* property rather than the
        // window: 8 MiB per window, which is twice the old lifetime cap.
        bytes_per_window: 8 * 1024 * 1024,
        room_bytes_per_window: 8 * 1024 * 1024,
        // The *per-second* ceilings describe pacing, not lifetime volume, and a
        // real client is nowhere near them; they are raised here so the test can
        // move 4.8 MiB quickly without being cut off for going fast.
        messages_per_second: 120,
        bytes_per_second: 1024 * 1024,
        global_bytes_per_second: 16 * 1024 * 1024,
        global_messages_per_second: 1024,
        ..Limits::default()
    })
    .await;
    let http = reqwest::Client::new();
    let board = board_ticket(&authority, "board-long", 1, &[(&authority, "owner"), (&user, "editor")]);
    publish(&http, &base, &authority, &board).await;

    let (mut socket, _) = connect_v3(&url, &user, &board).await;
    subscribe(&mut socket, &board.room, 0).await;

    // ~48 KiB of payload per submit, so 100 of them is comfortably more than the
    // 4 MiB the old cap allowed for the whole life of the socket.
    let payload = "x".repeat(48 * 1024);
    let mut bytes = 0usize;
    for index in 0..100 {
        // Pace under the per-second ceiling. What is under test is the lifetime
        // total, so pacing must not be what ends this connection.
        // 48 KiB every 60 ms is ~800 KiB/s, comfortably under the 1 MiB/s
        // per-second ceiling this test configures.
        tokio::time::sleep(Duration::from_millis(60)).await;
        let op = json!({
            "opId": format!("op-{index}"),
            "protocolVersion": 1,
            "logicalClock": index,
            "payload": payload,
        });
        bytes += payload.len();
        let accepted = submit(&mut socket, &board.room, vec![op]).await;
        assert_eq!(accepted["results"][0]["seq"], index as u64 + 1, "submit {index} was not accepted");
        recv_sync(&mut socket, "operation").await;
    }
    assert!(bytes > 4 * 1024 * 1024, "the test must exceed the old cap, moved {bytes}");

    // Still a working connection: a fresh operation is acknowledged and the log
    // still answers from the beginning.
    let after = submit(&mut socket, &board.room, vec![operation("op-after-cap")]).await;
    assert_eq!(after["results"][0]["seq"], 101);
    let window = subscribe(&mut socket, &board.room, 99).await;
    assert_eq!(window["operations"].as_array().expect("operations").len(), 2);
    app.shutdown();
    task.abort();
}

/// The window really renews: a connection that spends its budget, waits out the
/// window and spends it again is not closed.
#[tokio::test]
async fn the_byte_budget_renews_instead_of_accumulating() {
    let authority = device();
    let user = device();
    let (app, base, url, task) = serve(Limits {
        // Small enough that one frame's worth of traffic spends it, and short
        // enough that the test does not wait a minute to see the renewal.
        bytes_per_window: 8 * 1024,
        room_bytes_per_window: 8 * 1024,
        byte_window: Duration::from_millis(250),
        messages_per_second: 120,
        bytes_per_second: 1024 * 1024,
        global_bytes_per_second: 16 * 1024 * 1024,
        global_messages_per_second: 1024,
        ..Limits::default()
    })
    .await;
    let http = reqwest::Client::new();
    let board = board_ticket(&authority, "board-window", 1, &[(&authority, "owner"), (&user, "editor")]);
    publish(&http, &base, &authority, &board).await;

    let (mut socket, _) = connect_v3(&url, &user, &board).await;
    subscribe(&mut socket, &board.room, 0).await;
    // Two rounds of traffic separated by more than one window. The first spends
    // the budget; the second would be impossible if the total accumulated.
    for round in 0..2 {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let accepted = submit(&mut socket, &board.room, vec![operation(&format!("op-{round}"))]).await;
        assert_eq!(accepted["results"][0]["seq"], round as u64 + 1, "round {round} was cut off");
        recv_sync(&mut socket, "operation").await;
    }
    app.shutdown();
    task.abort();
}

/// Session identity: one server-minted id per connection, carrying that
/// connection's device and its attached rooms, absent after disconnect, and
/// never reused by a reconnect.
#[tokio::test]
async fn the_session_registry_tracks_rooms_and_cleans_up_on_disconnect() {
    let authority = device();
    let user = device();
    let (app, base, url, task) = serve(Limits::default()).await;
    let http = reqwest::Client::new();
    let first = board_ticket(&authority, "board-reg-one", 1, &[(&authority, "owner"), (&user, "editor")]);
    let second = board_ticket(&authority, "board-reg-two", 1, &[(&authority, "owner"), (&user, "editor")]);
    publish(&http, &base, &authority, &first).await;
    publish(&http, &base, &authority, &second).await;

    let (mut socket, welcome) = connect_v3(&url, &user, &first).await;
    let session = welcome["session"].as_str().expect("session").to_string();
    // One entry, one room, this device — and no duplicate entry per room.
    {
        let registry = app.sessions();
        let registry = registry.lock().expect("registry");
        assert_eq!(registry.len(), 1, "{registry:?}");
        let record = registry.get(&session).expect("registered session");
        assert_eq!(record.device, user.id);
        assert_eq!(record.rooms.len(), 1);
        assert!(record.rooms.contains(&first.room));
    }
    attach(&mut socket, &user, &welcome, &second).await;
    {
        let registry = app.sessions();
        let registry = registry.lock().expect("registry");
        // Still one session: attaching a room must not mint a second one.
        assert_eq!(registry.len(), 1);
        let record = registry.get(&session).expect("registered session");
        assert_eq!(record.rooms.len(), 2);
        assert!(record.rooms.contains(&second.room));
    }

    // A second tab is a second session id, with the same device.
    let (other, other_welcome) = connect_v3(&url, &user, &first).await;
    let other_session = other_welcome["session"].as_str().expect("session").to_string();
    assert_ne!(session, other_session);
    assert_eq!(app.sessions().lock().expect("registry").len(), 2);

    // Disconnect removes exactly that session, and only after the socket ends.
    drop(other);
    for _ in 0..50 {
        if !app.sessions().lock().expect("registry").contains_key(&other_session) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    {
        let registry = app.sessions();
        let registry = registry.lock().expect("registry");
        assert!(!registry.contains_key(&other_session), "disconnected session lingered");
        assert!(registry.contains_key(&session), "the live session was evicted");
    }
    app.shutdown();
    task.abort();
}
