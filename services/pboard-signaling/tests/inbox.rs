//! Cross-account board discovery over real sockets.
//!
//! Requirement 4.2 is "share a board with another Google account and that
//! account's connected sessions learn about it without a reload". That needs a
//! delivery path into an account the *sender* is not a member of, addressed by
//! account hash so the relay never holds an email. These tests drive that path
//! across separate sockets, because the property under test is fan-out: one
//! sender, another account, and *every* session of it.
//!
//! The board room here is an independent (Drive-binding-free) grant, published
//! into the grant cache exactly as the multiplex tests publish one. The account
//! room is a manifest whose board id is `account:<hash>`, which is how the
//! deployed client admits it.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64, engine::general_purpose::URL_SAFE_NO_PAD};
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

/// The account hash, exactly as `google_enrollment` derives it from the
/// lowercased verified email: SHA-256, lowercase hex. The relay never sees the
/// email, and these tests never give it one.
fn account_hash(email: &str) -> String {
    Sha256::digest(email.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
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

/// A board room ticket. Independent-grant mode requires an empty Drive binding,
/// which is what `manifest` produces.
fn board_ticket(authority: &Device, board: &str, epoch: u64, roles: &[(&Device, &str)]) -> Ticket {
    ticket(authority, &manifest(authority, board, epoch, roles), &format!("pboard-collab-{board}-cards"))
}

/// The account room ticket: board id `account:<hash>`, topic
/// `pboard-account-<hash>-order`. `admission::verify` accepts exactly this
/// pairing and nothing else, which is what keeps the inbox scope and the room
/// scope the same string.
fn account_ticket(authority: &Device, account: &str, epoch: u64, roles: &[(&Device, &str)]) -> Ticket {
    ticket(
        authority,
        &manifest(authority, &format!("account:{account}"), epoch, roles),
        &format!("pboard-account-{account}-order"),
    )
}

fn unique() -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_nanos();
    let path = std::env::temp_dir().join(format!("pboard-inbox-{}-{nanos}-{n}", std::process::id()));
    std::fs::create_dir_all(&path).expect("data directory");
    path
}

async fn serve_at(directory: &std::path::Path) -> (App, String, String, tokio::task::JoinHandle<std::io::Result<()>>) {
    serve_with(directory, Limits::default()).await
}

async fn serve_with(
    directory: &std::path::Path,
    limits: Limits,
) -> (App, String, String, tokio::task::JoinHandle<std::io::Result<()>>) {
    let app = App::new(Config { rooms: HashMap::new() }, limits)
        .expect("config")
        .with_board_grants(true)
        .with_sync(directory)
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

/// A v2 connection: one room, the deployed shape. The inbox fan-out must work
/// for exactly this client, because the deployed client is a v2 one and the
/// receiver side of cross-account discovery does not need multiplexing at all.
async fn connect_v2(url: &str, d: &Device, t: &Ticket) -> Socket {
    let (mut socket, _) = connect_async(url).await.expect("connect");
    let welcome = recv(&mut socket).await;
    assert_eq!(welcome["type"], "welcome");
    send(&mut socket, authenticate_frame(d, &welcome, t, 2)).await;
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "authenticated", "{reply}");
    socket
}

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

/// A v3 connection on its first room, plus the welcome that later attachers sign.
async fn connect_v3(url: &str, d: &Device, first: &Ticket) -> (Socket, Value) {
    let (mut socket, _) = connect_async(url).await.expect("connect");
    let welcome = recv(&mut socket).await;
    assert_eq!(welcome["type"], "welcome");
    send(&mut socket, authenticate_frame(d, &welcome, first, 3)).await;
    let reply = recv(&mut socket).await;
    assert_eq!(reply["type"], "authenticated", "{reply}");
    (socket, welcome)
}

/// Publishes a grant into the cache, which is what makes an independent-grant
/// board room admissible. Same shape the multiplex tests use.
async fn publish(http: &reqwest::Client, base: &str, authority: &Device, t: &Ticket) {
    publish_history(http, base, authority, std::slice::from_ref(t)).await;
}

/// Publishes a whole history, which is what an epoch bump is: the cache refuses
/// a bundle whose epochs do not strictly increase, so a reissue is an append.
async fn publish_history(http: &reqwest::Client, base: &str, authority: &Device, history: &[Ticket]) {
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

/// A payload "sealed by the client": base64 of something the relay must never
/// need to parse. The tests never ask it to either.
fn hint(label: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("iv+ct:{label}"))
}

async fn publish_hint(sender: &mut Socket, board_room: &str, to: &str, hint_id: &str, payload: &str) -> Value {
    send(
        sender,
        json!({"type":"sync","request":{
            "action":"publishAccountHint",
            "board": board_room,
            "to": to,
            "hintId": hint_id,
            "payload": payload
        }}),
    )
    .await;
    recv_sync(sender, "accountHintStored").await
}

async fn replay(socket: &mut Socket, account_room: &str, after_seq: u64) -> Value {
    send(
        socket,
        json!({"type":"sync","request":{"action":"replayAccountHints","board":account_room,"afterSeq":after_seq}}),
    )
    .await;
    recv_sync(socket, "accountHints").await
}

/// (a) An authorized sender reaches **every** session of the target account.
///
/// Two sessions, two separate sockets, one account: the whole point of routing
/// by account hash is that the relay does not have to know which of them is
/// "the" tab, and must not stop at the first one it finds.
#[tokio::test]
async fn an_authorized_sender_reaches_every_session_of_the_target_account() {
    let authority = device();
    let owner = device();
    let guest = device();
    let directory = unique();
    let (app, base, url, task) = serve_at(&directory).await;
    let http = reqwest::Client::new();

    // The owner holds `board-shared`; the guest's account is the target. The two
    // accounts share nothing at the relay: the owner is not in the guest's
    // account manifest and cannot be.
    let board = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&owner, "editor")]);
    publish(&http, &base, &authority, &board).await;
    let guest_account = account_hash("guest@example.test");
    let guest_authority = device();
    let guest_account_ticket = account_ticket(&guest_authority, &guest_account, 1, &[(&guest_authority, "owner"), (&guest, "editor")]);

    // Two sessions of the guest account, exactly as a browser with two tabs has.
    let mut first = connect_v2(&url, &guest, &guest_account_ticket).await;
    let mut second = connect_v2(&url, &guest, &guest_account_ticket).await;
    // And the owner, on the board's room, which is its whole authorization.
    let mut sender = connect_v2(&url, &owner, &board).await;

    let stored = publish_hint(&mut sender, &board.room, &guest_account, "hint-1", &hint("shared-with-you")).await;
    assert_eq!(stored["seq"], 1);
    assert_eq!(stored["duplicate"], json!(false));
    assert_eq!(stored["to"], guest_account);

    // Both sessions receive the same frame, addressed by account, naming the
    // board the *manifest* proved.
    for (label, socket) in [("first", &mut first), ("second", &mut second)] {
        let frame = recv_type(socket, "accountHint").await;
        assert_eq!(frame["inbox"], guest_account, "{label}");
        assert_eq!(frame["board"], "board-shared", "{label}");
        assert_eq!(frame["seq"], 1, "{label}");
        assert_eq!(frame["sender"], owner.id, "{label}");
        assert_eq!(frame["payload"], hint("shared-with-you"), "{label}");
        assert!(frame["hintId"].as_str() == Some("hint-1"), "{label}");
    }

    // A third session that connects *afterwards* still learns about it, from the
    // durable inbox rather than from the live fan-out.
    let mut third = connect_v2(&url, &guest, &guest_account_ticket).await;
    let missed = replay(&mut third, &guest_account_ticket.room, 0).await;
    assert_eq!(missed["inbox"], guest_account);
    assert_eq!(missed["highest"], 1);
    assert_eq!(missed["hints"].as_array().expect("hints").len(), 1);
    assert_eq!(missed["hints"][0]["board"], "board-shared");
    assert_eq!(missed["hints"][0]["payload"], hint("shared-with-you"));

    app.shutdown();
    task.abort();
    std::fs::remove_dir_all(&directory).expect("cleanup");
}

/// (b) An unauthorized sender is refused and nothing is stored.
///
/// Three shapes of "not authorized for this board": a connection holding no
/// board at all, a connection holding only *its own* account room (the case the
/// audit named), and a viewer seat on the board. None of them may leave a row
/// behind, and none may be answered with a `seq`.
#[tokio::test]
async fn an_unauthorized_sender_is_refused_and_nothing_is_stored() {
    let authority = device();
    let owner = device();
    let guest = device();
    let directory = unique();
    let (app, base, url, task) = serve_at(&directory).await;
    let http = reqwest::Client::new();

    let board = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&owner, "editor")]);
    let viewer_board = board_ticket(&authority, "board-readonly", 1, &[(&authority, "owner"), (&owner, "viewer")]);
    publish(&http, &base, &authority, &board).await;
    publish(&http, &base, &authority, &viewer_board).await;
    let guest_account = account_hash("guest@example.test");
    let guest_authority = device();
    let guest_account_ticket = account_ticket(&guest_authority, &guest_account, 1, &[(&guest_authority, "owner"), (&guest, "editor")]);
    let owner_account = account_hash("owner@example.test");
    let owner_account_ticket = account_ticket(&guest_authority, &owner_account, 1, &[(&guest_authority, "owner"), (&owner, "editor")]);

    // A sender that authenticated to its *own* account room and nothing else.
    // Its manifest proves `account:<hash>`, which is not a board.
    let mut own_account = connect_v2(&url, &owner, &owner_account_ticket).await;
    send(
        &mut own_account,
        json!({"type":"sync","request":{
            "action":"publishAccountHint","board":owner_account_ticket.room,
            "to":guest_account,"hintId":"hint-1","payload":hint("forged")
        }}),
    )
    .await;
    let refused = recv_sync(&mut own_account, "error").await;
    assert_eq!(refused["code"], "unauthorized");

    // A viewer seat on a real board: it may read the board, not speak for it.
    let mut viewer = connect_v2(&url, &owner, &viewer_board).await;
    send(
        &mut viewer,
        json!({"type":"sync","request":{
            "action":"publishAccountHint","board":viewer_board.room,
            "to":guest_account,"hintId":"hint-1","payload":hint("from-a-viewer")
        }}),
    )
    .await;
    assert_eq!(recv_sync(&mut viewer, "error").await["code"], "read_only");

    // A board this connection never attached: the frame is not re-scoped onto
    // the room it does hold.
    send(
        &mut viewer,
        json!({"type":"sync","request":{
            "action":"publishAccountHint","board":board.room,
            "to":guest_account,"hintId":"hint-1","payload":hint("via-another-room")
        }}),
    )
    .await;
    assert_eq!(recv_sync(&mut viewer, "error").await["code"], "board_mismatch");

    // Nothing reached the inbox, and it is still empty after all three attempts.
    let mut receiver = connect_v2(&url, &guest, &guest_account_ticket).await;
    let replay_answer = replay(&mut receiver, &guest_account_ticket.room, 0).await;
    assert_eq!(replay_answer["hints"].as_array().expect("hints").len(), 0);
    assert_eq!(replay_answer["highest"], 0);
    assert!(replay_answer.get("oldestRetained").is_none());
    // The refused attempts also produced no live frame.
    let stray = expect_quiet(&mut receiver, Duration::from_millis(250)).await;
    assert!(stray.is_none(), "a refused write must publish nothing: {stray:?}");

    app.shutdown();
    task.abort();
    std::fs::remove_dir_all(&directory).expect("cleanup");
}

/// (c) A receiver reads only its own account's inbox.
///
/// Two accounts, each with a hint waiting. Each connection can only ever name
/// the account room it holds, so the other account's mail is unreachable — not
/// "refused after a permission check" but absent from the wire vocabulary.
#[tokio::test]
async fn a_receiver_cannot_read_another_accounts_inbox() {
    let authority = device();
    let owner = device();
    let one = device();
    let two = device();
    let directory = unique();
    let (app, base, url, task) = serve_at(&directory).await;
    let http = reqwest::Client::new();

    let board = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&owner, "editor")]);
    publish(&http, &base, &authority, &board).await;
    let first_account = account_hash("one@example.test");
    let second_account = account_hash("two@example.test");
    let guest_authority = device();
    let first_ticket = account_ticket(&guest_authority, &first_account, 1, &[(&guest_authority, "owner"), (&one, "editor")]);
    let second_ticket = account_ticket(&guest_authority, &second_account, 1, &[(&guest_authority, "owner"), (&two, "editor")]);

    let mut sender = connect_v2(&url, &owner, &board).await;
    // Both receivers are live *before* the writes, so the assertions below can
    // distinguish a live fan-out from a replay. Delivered hints are still read
    // back through `replay`, which is the same accessor a reconnecting client
    // uses.
    let mut first = connect_v2(&url, &one, &first_ticket).await;
    let mut second = connect_v2(&url, &two, &second_ticket).await;
    publish_hint(&mut sender, &board.room, &first_account, "hint-1", &hint("first")).await;
    publish_hint(&mut sender, &board.room, &second_account, "hint-1", &hint("second")).await;

    // Live fan-out first, because a replay read would consume the same queue.
    // Each account's session heard exactly its own hint, once.
    let live = recv_type(&mut first, "accountHint").await;
    assert_eq!(live["inbox"], first_account);
    assert_eq!(live["payload"], hint("first"));
    assert_eq!(recv_type(&mut second, "accountHint").await["inbox"], second_account);

    let mine = replay(&mut first, &first_ticket.room, 0).await;
    assert_eq!(mine["inbox"], first_account);
    assert_eq!(mine["hints"].as_array().expect("hints").len(), 1);
    assert_eq!(mine["hints"][0]["inbox"], first_account);
    assert_eq!(mine["hints"][0]["payload"], hint("first"));

    // Naming the other account's room is a room this connection never attached.
    send(
        &mut first,
        json!({"type":"sync","request":{"action":"replayAccountHints","board":second_ticket.room,"afterSeq":0}}),
    )
    .await;
    let refused = recv_sync(&mut first, "error").await;
    assert_eq!(refused["code"], "board_mismatch");
    assert_eq!(refused["board"], second_ticket.room);

    // And the two inboxes did not bleed into each other in either direction.
    let theirs = replay(&mut second, &second_ticket.room, 0).await;
    assert_eq!(theirs["inbox"], second_account);
    assert_eq!(theirs["hints"].as_array().expect("hints").len(), 1);
    assert_eq!(theirs["hints"][0]["payload"], hint("second"));

    app.shutdown();
    task.abort();
    std::fs::remove_dir_all(&directory).expect("cleanup");
}

/// (d) Bounded retention: over-capacity writes evict the oldest first.
///
/// The answer is eviction, not refusal, and it is deterministic: sequence order
/// alone decides, so a receiver that missed the oldest hint can tell exactly
/// where retention now starts (`oldestRetained`) instead of believing an empty
/// or partial delta is the whole story.
#[tokio::test]
async fn over_capacity_writes_evict_the_oldest_hint_deterministically() {
    const CAP: u64 = 64;
    let authority = device();
    let owner = device();
    let guest = device();
    let directory = unique();
    // 66 writes in one second would trip the default 60-message budget; the
    // test is about storage retention, not about the rate limiter.
    let (app, base, url, task) = serve_with(
        &directory,
        Limits { messages_per_second: 120, global_messages_per_second: 512, ..Limits::default() },
    )
    .await;
    let http = reqwest::Client::new();

    let board = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&owner, "editor")]);
    publish(&http, &base, &authority, &board).await;
    let guest_account = account_hash("guest@example.test");
    let guest_authority = device();
    let guest_ticket = account_ticket(&guest_authority, &guest_account, 1, &[(&guest_authority, "owner"), (&guest, "editor")]);

    let mut sender = connect_v2(&url, &owner, &board).await;
    // CAP + 2 writes: the first two must be gone, the last CAP retained.
    for index in 0..(CAP + 2) {
        let stored = publish_hint(
            &mut sender,
            &board.room,
            &guest_account,
            &format!("hint-{index}"),
            &hint(&format!("payload-{index}")),
        )
        .await;
        assert_eq!(stored["seq"], index + 1);
    }

    let mut receiver = connect_v2(&url, &guest, &guest_ticket).await;
    let replay_answer = replay(&mut receiver, &guest_ticket.room, 0).await;
    let hints = replay_answer["hints"].as_array().expect("hints");
    assert_eq!(hints.len() as u64, CAP);
    assert_eq!(replay_answer["highest"], CAP + 2);
    assert_eq!(replay_answer["oldestRetained"], 3);
    // The two evicted writes are the two oldest, and the payload proves it is
    // these rows and not merely these counts.
    assert_eq!(hints[0]["seq"], 3);
    assert_eq!(hints[0]["payload"], hint("payload-2"));
    assert_eq!(hints[CAP as usize - 1]["seq"], CAP + 2);
    assert_eq!(hints[CAP as usize - 1]["payload"], hint("payload-65"));

    // A cursor already at the floor gets the same floor statement; one behind it
    // is told what it lost rather than handed a delta that looks complete.
    let at_floor = replay(&mut receiver, &guest_ticket.room, 3).await;
    assert_eq!(at_floor["oldestRetained"], 3);
    assert_eq!(at_floor["hints"].as_array().expect("hints").len(), CAP as usize - 1);
    let behind = replay(&mut receiver, &guest_ticket.room, 0).await;
    assert_eq!(behind["oldestRetained"], 3);
    assert_eq!(behind["hints"].as_array().expect("hints").len(), CAP as usize);

    app.shutdown();
    task.abort();
    std::fs::remove_dir_all(&directory).expect("cleanup");
}

/// (e) A restart preserves undelivered hints, and a reconnecting receiver gets
/// what it missed.
///
/// "Undelivered" here is literal: the hint is written while the target account
/// has no session at all, the service is then replaced, and only afterwards does
/// a session connect. Nothing about the delivery ever depended on the sender's
/// socket still being alive.
#[tokio::test]
async fn a_restart_preserves_undelivered_hints_and_a_reconnecting_receiver_gets_them() {
    let authority = device();
    let owner = device();
    let guest = device();
    let directory = unique();
    let http = reqwest::Client::new();
    let guest_account = account_hash("guest@example.test");
    let guest_authority = device();
    let guest_ticket = account_ticket(&guest_authority, &guest_account, 1, &[(&guest_authority, "owner"), (&guest, "editor")]);
    let board = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&owner, "editor")]);

    let (app, base, url, task) = serve_at(&directory).await;
    publish(&http, &base, &authority, &board).await;
    let mut sender = connect_v2(&url, &owner, &board).await;

    // Live delivery: a session is connected and receives both hints as they are
    // written, so its cursor ends at 2.
    let mut early = connect_v2(&url, &guest, &guest_ticket).await;
    publish_hint(&mut sender, &board.room, &guest_account, "hint-1", &hint("before-restart")).await;
    assert_eq!(recv_type(&mut early, "accountHint").await["seq"], 1);
    publish_hint(&mut sender, &board.room, &guest_account, "hint-2", &hint("delivered-live")).await;
    assert_eq!(recv_type(&mut early, "accountHint").await["seq"], 2);
    early.close(None).await.expect("close");

    // Undelivered: nobody is connected for this one, and then the process is
    // replaced. Nothing about it depended on a live socket.
    publish_hint(&mut sender, &board.room, &guest_account, "hint-3", &hint("undelivered")).await;
    drop(sender);
    app.shutdown();
    task.abort();
    // Give the first process a moment to release the database, then replace it.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let (app, base, url, task) = serve_at(&directory).await;
    // The grant cache is deliberately RAM-only, so a replaced service needs the
    // board's grant published again before its room is admissible. That is
    // normal operation, not part of what this test measures: the *inbox* is what
    // must survive untouched, and it does.
    publish(&http, &base, &authority, &board).await;

    // The reconnecting receiver asks from where it actually got to, and gets the
    // one it missed — not the two it already applied.
    let mut resumed = connect_v2(&url, &guest, &guest_ticket).await;
    let missed = replay(&mut resumed, &guest_ticket.room, 2).await;
    assert_eq!(missed["highest"], 3);
    let hints = missed["hints"].as_array().expect("hints");
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0]["seq"], 3);
    assert_eq!(hints[0]["payload"], hint("undelivered"));
    assert_eq!(hints[0]["board"], "board-shared");
    assert_eq!(hints[0]["sender"], owner.id);
    // And the whole inbox survived, which is what "durable under the operation
    // log's rules" means: nothing was lost by the process being replaced.
    let everything = replay(&mut resumed, &guest_ticket.room, 0).await;
    assert_eq!(everything["hints"].as_array().expect("hints").len(), 3);
    assert_eq!(everything["oldestRetained"], 1);

    // A hint written *after* the restart continues the same sequence, so a
    // cursor taken before it is never ambiguous across a restart.
    let mut sender = connect_v2(&url, &owner, &board).await;
    let stored = publish_hint(&mut sender, &board.room, &guest_account, "hint-4", &hint("after-restart")).await;
    assert_eq!(stored["seq"], 4);

    app.shutdown();
    task.abort();
    std::fs::remove_dir_all(&directory).expect("cleanup");
}

/// (f) A hint is a hint: the server guarantees delivery and *nothing else*.
///
/// The board in this hint does not exist as far as the receiver's relay view is
/// concerned, and it never will because the relay creates nothing on the strength
/// of a hint. What the server can guarantee is asserted here: the hint arrives
/// byte for byte, no room, log or authorization appears for the board it names,
/// and the receiver is still unable to reach that board's room. The client's own
/// Drive verification is what turns this into "nothing happened" on screen, and
/// that gate is already the only path to making a board interactive.
#[tokio::test]
async fn a_hint_never_creates_access_and_the_receiver_still_cannot_reach_the_board() {
    let authority = device();
    let owner = device();
    let guest = device();
    let directory = unique();
    let (app, base, url, task) = serve_at(&directory).await;
    let http = reqwest::Client::new();

    let board = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&owner, "editor")]);
    publish(&http, &base, &authority, &board).await;
    let guest_account = account_hash("guest@example.test");
    let guest_authority = device();
    let guest_ticket = account_ticket(&guest_authority, &guest_account, 1, &[(&guest_authority, "owner"), (&guest, "editor")]);

    let mut sender = connect_v2(&url, &owner, &board).await;
    // The receiver is live before the write: the frame asserted below is the live
    // fan-out, not a replay.
    let mut receiver = connect_v2(&url, &guest, &guest_ticket).await;
    // A board id that exists nowhere: no grant was published for it and no
    // manifest names it.
    let sealed = B64.encode(b"iv+ciphertext-the-relay-cannot-read");
    let stored = publish_hint(&mut sender, &board.room, &guest_account, "hint-1", &sealed).await;
    assert_eq!(stored["seq"], 1);

    let live = recv_type(&mut receiver, "accountHint").await;
    // Byte for byte, and with no field the server invented about the board.
    assert_eq!(live["payload"], sealed);
    assert_eq!(live["board"], "board-shared");
    assert_eq!(live["hintId"], "hint-1");
    let keys: Vec<&str> = live.as_object().expect("object").keys().map(String::as_str).collect();
    for key in &keys {
        assert!(
            ["type", "inbox", "board", "hintId", "sender", "seq", "createdAt", "expiresAt", "payload"].contains(key),
            "the hint frame must carry nothing but the stored row: {key}"
        );
    }

    // The relay did not make the board reachable: the guest's connection cannot
    // subscribe to that board's room, and the board's log is untouched by the
    // hint. This is the server-side half of "no local effect"; the client's
    // Drive verification gate is the other half and lives in `src/`, unchanged.
    let subscribe = json!({"type":"sync","request":{"action":"subscribe","board":board.room,"afterSeq":0}});
    send(&mut receiver, subscribe).await;
    assert_eq!(recv_sync(&mut receiver, "error").await["code"], "board_mismatch");
    let log = app.sync().expect("sync log");
    assert!(
        log.boards().expect("boards").is_empty(),
        "a hint must not create a board log: {:?}",
        log.boards().expect("boards")
    );
    assert!(app.account_inbox().is_some());

    app.shutdown();
    task.abort();
    std::fs::remove_dir_all(&directory).expect("cleanup");
}

/// Revocation on the sender side: the moment the sender's grant for the board is
/// superseded, it can no longer write, and the write it already made stays.
///
/// That combination is the honest answer to "what does revocation mean here". A
/// hint is a notification, not a capability: revoking the sender stops new hints
/// (the room's scope moved, so the connection's write path is gone) but cannot
/// and does not retract one already stored — the receiver's own Drive check is
/// what decides whether the board exists for it, and that check has already been
/// run by the time a delivered hint has any effect at all.
#[tokio::test]
async fn revoking_the_senders_grant_stops_new_hints_and_keeps_the_delivered_one() {
    let authority = device();
    let owner = device();
    let guest = device();
    let directory = unique();
    let (app, base, url, task) = serve_at(&directory).await;
    let http = reqwest::Client::new();

    let first = board_ticket(&authority, "board-shared", 1, &[(&authority, "owner"), (&owner, "editor")]);
    publish(&http, &base, &authority, &first).await;
    let guest_account = account_hash("guest@example.test");
    let guest_authority = device();
    let guest_ticket = account_ticket(&guest_authority, &guest_account, 1, &[(&guest_authority, "owner"), (&guest, "editor")]);
    // The sender's *own* account room: a real sender holds both its board and its
    // account channel. It is the room that must survive the revocation below.
    let owner_account = account_hash("owner@example.test");
    let owner_account_ticket = account_ticket(&guest_authority, &owner_account, 1, &[(&guest_authority, "owner"), (&owner, "editor")]);
    let own_room = owner_account_ticket.room.clone();

    // A v3 connection holds the board *and* its own account room, which is what a
    // real sender has. The board is the first room so its revocation is the one
    // this test drives.
    let (mut sender, welcome) = connect_v3(&url, &owner, &first).await;
    send(&mut sender, attach_frame(&owner, &welcome, &owner_account_ticket)).await;
    assert_eq!(recv_type(&mut sender, "attached").await["room"], own_room);

    // The hint lands while the grant is current.
    let stored = publish_hint(&mut sender, &first.room, &guest_account, "hint-1", &hint("while-current")).await;
    assert_eq!(stored["seq"], 1);

    // The authority reissues the same board at epoch 2. Same members, new
    // manifest: from the relay's point of view the sender's authorization for
    // that room has moved, which is exactly what a revocation looks like.
    let next = board_ticket(&authority, "board-shared", 2, &[(&authority, "owner"), (&owner, "editor")]);
    publish_history(&http, &base, &authority, &[first.clone(), next]).await;
    let detached = recv_type(&mut sender, "detached").await;
    assert_eq!(detached["room"], first.room);
    assert_eq!(detached["code"], "authorization_changed");

    // Writing again names a room this connection no longer holds: refused, and
    // nothing new is stored.
    send(
        &mut sender,
        json!({"type":"sync","request":{
            "action":"publishAccountHint","board":first.room,
            "to":guest_account,"hintId":"hint-2","payload":hint("after-revocation")
        }}),
    )
    .await;
    assert_eq!(recv_sync(&mut sender, "error").await["code"], "board_mismatch");

    // The already-delivered hint is still there — revocation is not a retraction
    // — and the client's Drive gate is what decides its effect on the receiver.
    let mut receiver = connect_v2(&url, &guest, &guest_ticket).await;
    let replay_answer = replay(&mut receiver, &guest_ticket.room, 0).await;
    assert_eq!(replay_answer["hints"].as_array().expect("hints").len(), 1);
    assert_eq!(replay_answer["hints"][0]["payload"], hint("while-current"));
    assert_eq!(replay_answer["highest"], 1);
    // The other room on the same connection survived: a per-room revocation does
    // not take the socket with it.
    send(&mut sender, json!({"type":"ping"})).await;
    assert_eq!(recv_type(&mut sender, "pong").await["type"], "pong");

    app.shutdown();
    task.abort();
    std::fs::remove_dir_all(&directory).expect("cleanup");
}
