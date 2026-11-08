//! Protocol v3: an `attach` may present *its own* device key.
//!
//! The single-device attach was the last thing that kept "one socket per session"
//! unreachable: the client signs each board's proof with that board's device key,
//! so a connection that could only ever present the key it authenticated with
//! could hold one board's rooms and no more. The tests here pin the property that
//! makes the widening safe — possession is proven *per attachment*, against the
//! key that attachment names, over a pre-image bound to this connection — and the
//! compatibility property that a frame without the new field means exactly what it
//! always did.

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

fn cards_topic(board: &str) -> String {
    format!("pboard-collab-{board}-cards")
}

#[derive(Clone)]
struct Ticket {
    room: String,
    authorization: Value,
    digest: String,
}

fn board_ticket(authority: &Device, board: &str, epoch: u64, roles: &[(&Device, &str)]) -> Ticket {
    let topic = cards_topic(board);
    ticket(authority, &manifest(authority, board, epoch, roles), &topic)
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

/// Signs one room's proof pre-image with `signer`, naming `presented` as the
/// device. A legitimate attach has them equal; every negative test here uses the
/// mismatch, because "I signed it" and "the key I named is mine" must both be
/// true for an admission.
fn proof(signer: &Device, presented: &Device, welcome: &Value, t: &Ticket) -> String {
    let signature: Signature = signer.key.sign(&admission::auth_bytes(
        welcome["challenge"].as_str().expect("challenge"),
        welcome["session"].as_str().expect("session"),
        &t.room,
        &presented.id,
        &t.digest,
    ));
    B64.encode(signature.to_bytes())
}

fn authenticate_frame(d: &Device, welcome: &Value, t: &Ticket) -> Value {
    json!({
        "type": "authenticate",
        "version": 3,
        "room": t.room,
        "deviceKeyId": d.id,
        "signature": proof(d, d, welcome, t),
        "authorization": t.authorization,
    })
}

/// The attach frame as a v3 client sends it *today*: no `deviceKeyId`, so the
/// connection's own device is the presented one.
fn attach_frame(d: &Device, welcome: &Value, t: &Ticket) -> Value {
    json!({
        "type": "attach",
        "room": t.room,
        "signature": proof(d, d, welcome, t),
        "authorization": t.authorization,
    })
}

/// The same frame naming a device explicitly.
fn attach_frame_as(presented: &Device, signer: &Device, welcome: &Value, t: &Ticket) -> Value {
    json!({
        "type": "attach",
        "room": t.room,
        "deviceKeyId": presented.id,
        "signature": proof(signer, presented, welcome, t),
        "authorization": t.authorization,
    })
}

fn unique() -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos();
    std::env::temp_dir().join(format!("pboard-attach-device-{}-{nanos}-{n}", std::process::id()))
}

async fn serve() -> (App, String, String, tokio::task::JoinHandle<std::io::Result<()>>) {
    let directory = unique();
    std::fs::create_dir_all(&directory).expect("data directory");
    let app = App::new(Config { rooms: HashMap::new() }, Limits::default())
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

async fn recv_type(socket: &mut Socket, kind: &str) -> Value {
    for _ in 0..64 {
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

async fn connect_v3(url: &str, d: &Device, first: &Ticket) -> (Socket, Value) {
    let (mut socket, _) = connect_async(url).await.expect("connect");
    let welcome = recv(&mut socket).await;
    assert_eq!(welcome["type"], "welcome");
    send(&mut socket, authenticate_frame(d, &welcome, first)).await;
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "authenticated", "{reply}");
    (socket, welcome)
}

async fn publish(http: &reqwest::Client, base: &str, authority: &Device, t: &Ticket) {
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
            "history": [{"payload": t.authorization["manifestPayload"], "signature": t.authorization["manifestSignature"]}],
        },
        "deviceKeyId": authority.id,
        "signature": B64.encode(device_signature.to_bytes()),
    });
    let response = http.post(format!("{base}/grants/publish")).json(&body).send().await.expect("publish");
    let status = response.status();
    let refusal = response.text().await.unwrap_or_default();
    assert_eq!(status, 204, "publication refused ({status}): {refusal}");
}

/// (a) One connection, three rooms, three *different* device keys.
///
/// This is the blocker the protocol change exists to fix: the client signs each
/// board's proof with that board's device key, so before `deviceKeyId` on
/// `attach` two boards could not share a socket. The attribution half is just as
/// important as the admission half — an operation appended through a room must be
/// recorded as that room's device, or a multiplexed socket would launder three
/// devices' writes into one identity.
#[tokio::test]
async fn one_connection_holds_three_rooms_under_three_device_keys() {
    let authority = device();
    let first = device();
    let second = device();
    let third = device();
    let (app, base, url, task) = serve().await;
    let http = reqwest::Client::new();

    let a = board_ticket(&authority, "board-alpha", 1, &[(&authority, "owner"), (&first, "editor")]);
    let b = board_ticket(&authority, "board-beta", 1, &[(&authority, "owner"), (&second, "editor")]);
    let c = board_ticket(&authority, "board-gamma", 1, &[(&authority, "owner"), (&third, "editor")]);
    for t in [&a, &b, &c] {
        publish(&http, &base, &authority, t).await;
    }

    // The connection authenticates as `first` on `first`'s board, then attaches
    // the other two rooms *as their own devices*.
    let (mut socket, welcome) = connect_v3(&url, &first, &a).await;
    let attached = recv_after_attach(&mut socket, attach_frame_as(&second, &second, &welcome, &b)).await;
    assert_eq!(attached["room"], b.room, "{attached}");
    assert_eq!(attached["role"], "editor");
    let attached = recv_after_attach(&mut socket, attach_frame_as(&third, &third, &welcome, &c)).await;
    assert_eq!(attached["room"], c.room, "{attached}");
    assert_eq!(attached["role"], "editor");

    // Each room's writes are attributed to the device that room admitted, not to
    // the device the socket authenticated with.
    for (index, (t, holder)) in [(&a, &first), (&b, &second), (&c, &third)].into_iter().enumerate() {
        subscribe(&mut socket, &t.room, 0).await;
        let accepted = submit(&mut socket, &t.room, vec![operation(&format!("op-{index}"))]).await;
        assert_eq!(accepted["board"], t.room);
        assert_eq!(accepted["results"][0]["duplicate"], json!(false));
        let live = recv_sync(&mut socket, "operation").await;
        assert_eq!(live["board"], t.room);
        assert_eq!(live["actorId"], holder.id, "room {index} attributed its operation to the wrong device");
        // And the durable log agrees, not just the broadcast.
        let window = subscribe(&mut socket, &t.room, 0).await;
        let operations = window["operations"].as_array().expect("operations");
        assert_eq!(operations.len(), 1, "board {index} carries {operations:?}");
        assert_eq!(operations[0]["opId"], format!("op-{index}"));
        assert_eq!(operations[0]["actorId"], holder.id);
        let stray = expect_quiet(&mut socket, Duration::from_millis(250)).await;
        assert!(stray.is_none(), "cross-room leak after submitting to {index}: {stray:?}");
    }

    // One session, three rooms, three recorded devices: the registry answers
    // "which device holds this room" from the admission, not from the socket.
    {
        let session = welcome["session"].as_str().expect("session").to_string();
        let registry = app.sessions();
        let registry = registry.lock().expect("registry");
        assert_eq!(registry.len(), 1);
        let record = registry.get(&session).expect("registered session");
        assert_eq!(record.device, first.id, "the connection's device is unchanged");
        assert_eq!(record.rooms.len(), 3);
        assert_eq!(record.room_devices.get(&a.room), Some(&first.id));
        assert_eq!(record.room_devices.get(&b.room), Some(&second.id));
        assert_eq!(record.room_devices.get(&c.room), Some(&third.id));
    }

    app.shutdown();
    task.abort();
}

async fn recv_after_attach(socket: &mut Socket, frame: Value) -> Value {
    send(socket, frame).await;
    recv_type(socket, "attached").await
}

/// (b) A named device whose signature does not verify is refused, and neither the
/// socket nor its existing rooms die.
#[tokio::test]
async fn an_attach_signed_by_the_wrong_key_is_refused_and_spares_the_socket() {
    let authority = device();
    let mine = device();
    let other = device();
    let (app, base, url, task) = serve().await;
    let http = reqwest::Client::new();
    let mine_room = board_ticket(&authority, "board-mine", 1, &[(&authority, "owner"), (&mine, "editor")]);
    let other_room = board_ticket(&authority, "board-other", 1, &[(&authority, "owner"), (&other, "editor")]);
    publish(&http, &base, &authority, &mine_room).await;
    publish(&http, &base, &authority, &other_room).await;

    let (mut socket, welcome) = connect_v3(&url, &mine, &mine_room).await;
    subscribe(&mut socket, &mine_room.room, 0).await;

    // Names `other`, signed by `mine`: the manifest lists `other`, so the device
    // is authorized — only possession is missing. That must still be refused.
    send(&mut socket, attach_frame_as(&other, &mine, &welcome, &other_room)).await;
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "refused", "{reply}");
    assert_eq!(reply["code"], "unauthorized");
    assert_eq!(reply["room"], other_room.room);

    // The socket is alive and the room that was already attached still works.
    let accepted = submit(&mut socket, &mine_room.room, vec![operation("op-still-here")]).await;
    assert_eq!(accepted["results"][0]["duplicate"], json!(false));
    let live = recv_sync(&mut socket, "operation").await;
    assert_eq!(live["actorId"], mine.id);
    // The refused room is not reachable through sync either.
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":other_room.room,"afterSeq":0}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");

    // And the same frame, correctly signed by the device it names, is accepted:
    // the refusal above was about the signature, not about the device.
    let attached = recv_after_attach(&mut socket, attach_frame_as(&other, &other, &welcome, &other_room)).await;
    assert_eq!(attached["room"], other_room.room);
    assert_eq!(attached["role"], "editor");
    app.shutdown();
    task.abort();
}

/// (c) A device the room's manifest does not name is refused, even with a
/// perfectly valid signature over the right pre-image.
#[tokio::test]
async fn an_attach_naming_a_device_outside_the_manifest_is_refused() {
    let authority = device();
    let mine = device();
    let stranger = device();
    let (app, base, url, task) = serve().await;
    let http = reqwest::Client::new();
    let mine_room = board_ticket(&authority, "board-mine", 1, &[(&authority, "owner"), (&mine, "editor")]);
    // `stranger` is nowhere in this manifest; `mine` is not in it either, which
    // is what makes the room unattachable by this connection.
    let closed = board_ticket(&authority, "board-closed", 1, &[(&authority, "owner")]);
    publish(&http, &base, &authority, &mine_room).await;
    publish(&http, &base, &authority, &closed).await;

    let (mut socket, welcome) = connect_v3(&url, &mine, &mine_room).await;
    send(&mut socket, attach_frame_as(&stranger, &stranger, &welcome, &closed)).await;
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "refused", "{reply}");
    assert_eq!(reply["code"], "unauthorized");
    assert_eq!(reply["room"], closed.room);

    // Nothing else moved.
    let accepted = submit(&mut socket, &mine_room.room, vec![operation("op-after")]).await;
    assert_eq!(accepted["board"], mine_room.room);
    assert_eq!(recv_sync(&mut socket, "operation").await["actorId"], mine.id);
    app.shutdown();
    task.abort();
}

/// (d) Compatibility: an attach with no `deviceKeyId` is exactly today's frame.
///
/// A v3 client that has not been updated must keep working, with the same
/// admission *and* the same attribution it had before the field existed.
#[tokio::test]
async fn an_attach_without_a_device_key_id_behaves_exactly_as_before() {
    let authority = device();
    let mine = device();
    let (app, base, url, task) = serve().await;
    let http = reqwest::Client::new();
    let first = board_ticket(&authority, "board-compat-one", 1, &[(&authority, "owner"), (&mine, "editor")]);
    let second = board_ticket(&authority, "board-compat-two", 1, &[(&authority, "owner"), (&mine, "viewer")]);
    publish(&http, &base, &authority, &first).await;
    publish(&http, &base, &authority, &second).await;

    let (mut socket, welcome) = connect_v3(&url, &mine, &first).await;
    let attached = recv_after_attach(&mut socket, attach_frame(&mine, &welcome, &second)).await;
    assert_eq!(attached["room"], second.room);
    assert_eq!(attached["role"], "viewer");

    // The room keeps the connection's device as its author.
    subscribe(&mut socket, &second.room, 0).await;
    send(&mut socket, json!({"type":"sync","request":{"action":"submit","board":second.room,"operations":[operation("op-viewer")]}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "read_only");

    // The registry records the connection's device for the room, exactly as an
    // authenticate would.
    {
        let session = welcome["session"].as_str().expect("session").to_string();
        let registry = app.sessions();
        let registry = registry.lock().expect("registry");
        assert_eq!(registry.get(&session).expect("session").room_devices.get(&second.room), Some(&mine.id));
    }

    // Re-attaching the same room without the field is still idempotent.
    let again = recv_after_attach(&mut socket, attach_frame(&mine, &welcome, &second)).await;
    assert_eq!(again["room"], second.room);
    assert_eq!(again["role"], "viewer");
    app.shutdown();
    task.abort();
}

/// (e) A connection cannot borrow another room's device key.
///
/// The cross-room case matters because it is the only one that looks legitimate
/// from the outside: the device is in the target room's manifest, and the
/// connection already holds it elsewhere. Without the signature being checked
/// against the *named* key, that would be a lateral move from one board to
/// another under an identity the socket never proved.
#[tokio::test]
async fn a_connection_cannot_borrow_another_rooms_device_key() {
    let authority = device();
    let mine = device();
    let colleague = device();
    let (app, base, url, task) = serve().await;
    let http = reqwest::Client::new();
    // Two boards this socket legitimately holds, one per device...
    let mine_room = board_ticket(&authority, "board-mine", 1, &[(&authority, "owner"), (&mine, "editor")]);
    let shared = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&colleague, "editor")]);
    // ...and a third that lists only `colleague`, whose seat the socket must not
    // be able to take with the key it happens to have attached next door.
    let target = board_ticket(&authority, "board-target", 1, &[(&authority, "owner"), (&colleague, "editor")]);
    for t in [&mine_room, &shared, &target] {
        publish(&http, &base, &authority, t).await;
    }

    let (mut socket, welcome) = connect_v3(&url, &mine, &mine_room).await;
    recv_after_attach(&mut socket, attach_frame_as(&colleague, &colleague, &welcome, &shared)).await;

    // Claim the colleague's identity on the third room, but sign with our key.
    send(&mut socket, attach_frame_as(&colleague, &mine, &welcome, &target)).await;
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "refused", "{reply}");
    assert_eq!(reply["code"], "unauthorized");
    assert_eq!(reply["room"], target.room);

    // The targeted room is still unreachable, and the two real attachments are
    // untouched with their own attribution.
    send(&mut socket, json!({"type":"sync","request":{"action":"subscribe","board":target.room,"afterSeq":0}})).await;
    assert_eq!(recv_sync(&mut socket, "error").await["code"], "board_mismatch");
    let accepted = submit(&mut socket, &shared.room, vec![operation("op-shared")]).await;
    assert_eq!(accepted["board"], shared.room);
    assert_eq!(recv_sync(&mut socket, "operation").await["actorId"], colleague.id);

    // Presenting the colleague's *own* signature over the same room is accepted:
    // the seat was always the colleague's, and possession is what decided it.
    recv_after_attach(&mut socket, attach_frame_as(&colleague, &colleague, &welcome, &target)).await;
    app.shutdown();
    task.abort();
}
