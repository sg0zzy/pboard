use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use pboard_signaling::{App, Config, Limits, PublicKey, admission, now_ms};
use rand_core::OsRng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
mod common;
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
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
        x: B64.encode(point.x().unwrap()),
        y: B64.encode(point.y().unwrap()),
    };
    Device {
        id: public.fingerprint(),
        public,
        key,
    }
}
fn jwk(d: &Device) -> Value {
    json!({"kty":d.public.kty,"crv":d.public.crv,"x":d.public.x,"y":d.public.y})
}
fn payload(authority: &Device, members: &[&Device]) -> Value {
    json!({"protocol":2,"boardId":"board","driveProjectFileId":"file","driveFolderId":"folder","authorityKeyId":authority.id,"epoch":1,"issuedAt":now_ms(),"expiresAt":now_ms()+60_000,
        "devices":members.iter().enumerate().map(|(i,d)|json!({"deviceKeyId":d.id,"publicKey":jwk(d),"role":if i==0 {"owner"} else {"editor"}})).collect::<Vec<_>>()})
}
#[derive(Clone)]
struct Ticket {
    topic: String,
    room: String,
    authorization: Value,
    digest: String,
}
fn raw_ticket(authority: &Device, bytes: &[u8], topic: &str, file: &str, folder: &str) -> Ticket {
    let mut signed = b"pboard-manifest-v2".to_vec();
    signed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    signed.extend_from_slice(bytes);
    let sig: Signature = authority.key.sign(&signed);
    Ticket {
        topic: topic.into(),
        room: admission::room_name(&authority.id, topic, file, folder),
        digest: B64.encode(Sha256::digest(bytes)),
        authorization: json!({"topic":topic,"authority":jwk(authority),"manifestPayload":B64.encode(bytes),"manifestSignature":B64.encode(sig.to_bytes())}),
    }
}
fn ticket(authority: &Device, value: &Value, topic: &str) -> Ticket {
    raw_ticket(
        authority,
        &serde_json::to_vec(value).unwrap(),
        topic,
        value["driveProjectFileId"].as_str().unwrap(),
        value["driveFolderId"].as_str().unwrap(),
    )
}
async fn server(limits: Limits, enabled: bool) -> (App, String, tokio::task::JoinHandle<()>) {
    let app = App::new(
        Config {
            rooms: HashMap::new(),
        },
        limits,
    )
    .unwrap()
    .with_automatic_admission(enabled);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let router = app.clone().router();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (app, url, task)
}
async fn recv(ws: &mut Socket) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}
async fn send(ws: &mut Socket, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
fn proof(d: &Device, welcome: &Value, t: &Ticket) -> Value {
    let signature: Signature = d.key.sign(&admission::auth_bytes(
        welcome["challenge"].as_str().unwrap(),
        welcome["session"].as_str().unwrap(),
        &t.room,
        &d.id,
        &t.digest,
    ));
    json!({"type":"authenticate","version":2,"room":t.room,"deviceKeyId":d.id,"signature":B64.encode(signature.to_bytes()),"authorization":t.authorization})
}

fn publication(authority: &Device, member: &Device, history: &[Ticket]) -> Value {
    let latest = history.last().unwrap();
    let signature: Signature = member.key.sign(&admission::auth_bytes(
        "publish",
        "publish",
        &latest.room,
        &member.id,
        &latest.digest,
    ));
    json!({"bundle":{"version":1,"authority":jwk(authority),"history":history.iter().map(|t|json!({"payload":t.authorization["manifestPayload"],"signature":t.authorization["manifestSignature"]})).collect::<Vec<_>>()},"deviceKeyId":member.id,"signature":B64.encode(signature.to_bytes())})
}
async fn publication_body(
    http: &reqwest::Client,
    base: &str,
    authority: &Device,
    mut body: Value,
) -> Value {
    let hello = http
        .post(format!("{base}/grants/challenge"))
        .json(&json!({"version":2}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let last = body["bundle"]["history"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    let raw = B64.decode(last["payload"].as_str().unwrap()).unwrap();
    let payload: Value = serde_json::from_slice(&raw).unwrap();
    let digest = B64.encode(Sha256::digest(&raw));
    let signature: Signature = authority.key.sign(
        &serde_json::to_vec(&json!([
            "pboard-grant-publish-v2",
            hello["challenge"],
            authority.id,
            payload["boardId"],
            digest
        ]))
        .unwrap(),
    );
    body["version"] = json!(2);
    body["challenge"] = hello["challenge"].clone();
    body["authoritySignature"] = json!(B64.encode(signature.to_bytes()));
    body
}
async fn post_publication(
    http: &reqwest::Client,
    base: &str,
    authority: &Device,
    body: Value,
) -> reqwest::Response {
    let body = publication_body(http, base, authority, body).await;
    http.post(format!("{base}/grants/publish"))
        .json(&body)
        .send()
        .await
        .unwrap()
}
fn signed(device: &Device, domain: &str, payload: Value) -> Value {
    let bytes = serde_json::to_vec(&payload).unwrap();
    let mut signed = domain.as_bytes().to_vec();
    signed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    signed.extend(bytes);
    let signature: Signature = device.key.sign(&signed);
    json!({"payload":payload,"signature":B64.encode(signature.to_bytes())})
}
fn manifest_value(t: &Ticket) -> Value {
    serde_json::from_slice(
        &B64.decode(t.authorization["manifestPayload"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap()
}
fn manifest_hash(t: &Ticket) -> String {
    let bytes = B64
        .decode(t.authorization["manifestPayload"].as_str().unwrap())
        .unwrap();
    let mut signed = b"pboard-manifest-v2".to_vec();
    signed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    signed.extend(bytes);
    pboard_signaling::signals::hex(&signed)
}
fn presence(d: &Device, t: &Ticket, logical: &str) -> Value {
    let m = manifest_value(t);
    let now = now_ms();
    let p = signed(
        d,
        "pboard-presence-v2",
        json!({"protocol":2,"boardId":m["boardId"],"collection":"cards","manifestHash":manifest_hash(t),"epoch":m["epoch"],"deviceKeyId":d.id,"sessionId":logical,"issuedAt":now,"expiresAt":now+120_000}),
    );
    json!({"kind":"pboard-presence","envelope":{"manifest":m,"presence":p}})
}
fn signal(
    d: &Device,
    target: &Device,
    t: &Ticket,
    from: &str,
    to: &str,
    index: u64,
    inner: Value,
) -> Value {
    let m = manifest_value(t);
    let now = now_ms();
    signed(
        d,
        "pboard-signal-v2",
        json!({"protocol":2,"boardId":m["boardId"],"collection":"cards","manifestHash":manifest_hash(t),"epoch":m["epoch"],"fromDeviceKeyId":d.id,"fromSessionId":from,"toDeviceKeyId":target.id,"toSessionId":to,"signalId":format!("signal-{index}"),"issuedAt":now,"expiresAt":now+60_000,"sequence":index,"signal":inner}),
    )
}

#[tokio::test]
async fn independent_board_grants_publish_renew_revoke_and_recover_without_google() {
    let app = App::new(
        Config {
            rooms: HashMap::new(),
        },
        Limits::default(),
    )
    .unwrap()
    .with_board_grants(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let ws = base.replace("http:", "ws:") + "/ws";
    let task = tokio::spawn(axum::serve(listener, app.clone().router()).into_future());
    let authority = device();
    let owner = device();
    let editor = device();
    let outsider = device();
    let mut value = payload(&authority, &[&owner, &editor]);
    value["driveProjectFileId"] = json!("");
    value["driveFolderId"] = json!("");
    let first = ticket(&authority, &value, "pboard-collab-board-cards");
    let http = reqwest::Client::new();
    let post = |body| post_publication(&http, &base, &authority, body);
    assert_eq!(
        post(publication(
            &authority,
            &owner,
            std::slice::from_ref(&first)
        ))
        .await
        .status(),
        204
    );
    let path = format!(
        "{base}/grants/{}",
        pboard_signaling::board_grants::scope(&authority.id, "board")
    );
    let response = http.get(&path).send().await.unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        response.json::<Value>().await.unwrap()["history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (mut old, _) = join(&ws, &editor, &first).await;
    let (_, _, denied) = authenticate(&ws, &outsider, &first).await;
    assert_eq!(denied["type"], "error");
    let mut forged = publication(&authority, &outsider, std::slice::from_ref(&first));
    assert_eq!(post(forged.clone()).await.status(), 403);
    forged["bundle"]["history"][0]["signature"] = json!("forged");
    assert_eq!(post(forged).await.status(), 403);
    value["epoch"] = json!(2);
    value["devices"] = json!([{"deviceKeyId":owner.id,"publicKey":jwk(&owner),"role":"owner"}]);
    let second = ticket(&authority, &value, "pboard-collab-board-cards");
    assert_eq!(
        post(publication(
            &authority,
            &owner,
            std::slice::from_ref(&second)
        ))
        .await
        .status(),
        403
    );
    assert_eq!(
        post(publication(
            &authority,
            &owner,
            &[first.clone(), second.clone()]
        ))
        .await
        .status(),
        204
    );
    assert_eq!(error(&mut old).await, "authorization_changed");
    assert_eq!(authenticate(&ws, &editor, &first).await.2["type"], "error");
    assert_eq!(
        post(publication(
            &authority,
            &owner,
            std::slice::from_ref(&first)
        ))
        .await
        .status(),
        403
    );
    // Another issuer gets a distinct namespace, even with the same board id.
    let rogue = device();
    value["authorityKeyId"] = json!(rogue.id);
    let isolated = ticket(&rogue, &value, "pboard-collab-board-cards");
    assert_ne!(isolated.room, second.room);
    // Capture a real, once-accepted publication. It cannot be replayed here or
    // reseed an empty restarted server, despite an unexpired device grant.
    let captured = publication_body(
        &http,
        &base,
        &authority,
        publication(&authority, &owner, &[first.clone(), second.clone()]),
    )
    .await;
    assert_eq!(
        http.post(format!("{base}/grants/publish"))
            .json(&captured)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        http.post(format!("{base}/grants/publish"))
            .json(&captured)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    task.abort();
    let restarted = App::new(
        Config {
            rooms: HashMap::new(),
        },
        Limits::default(),
    )
    .unwrap()
    .with_board_grants(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let new_base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(axum::serve(listener, restarted.router()).into_future());
    let scope = pboard_signaling::board_grants::scope(&authority.id, "board");
    assert_eq!(
        http.get(format!("{new_base}/grants/{scope}"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let new_ws = new_base.replace("http:", "ws:") + "/ws";
    assert_eq!(
        authenticate(&new_ws, &owner, &second).await.2["code"],
        "authorization_unavailable"
    );
    assert_eq!(
        authenticate(&new_ws, &editor, &first).await.2["code"],
        "authorization_unavailable"
    );
    assert_eq!(
        http.post(format!("{new_base}/grants/publish"))
            .json(&captured)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        post_publication(
            &http,
            &new_base,
            &outsider,
            publication(&authority, &owner, &[first.clone(), second.clone()])
        )
        .await
        .status(),
        403
    );
    assert_eq!(
        post_publication(
            &http,
            &new_base,
            &authority,
            publication(&authority, &owner, &[first, second])
        )
        .await
        .status(),
        204
    );
    task.abort();
}
async fn authenticate(url: &str, d: &Device, t: &Ticket) -> (Socket, Value, Value) {
    let (mut ws, _) = connect_async(url).await.unwrap();
    let welcome = recv(&mut ws).await;
    send(&mut ws, proof(d, &welcome, t)).await;
    let reply = recv(&mut ws).await;
    (ws, welcome, reply)
}
async fn join(url: &str, d: &Device, t: &Ticket) -> (Socket, Value) {
    let (mut ws, w, reply) = authenticate(url, d, t).await;
    assert_eq!(reply["type"], "authenticated");
    send(&mut ws, json!({"type":"join"})).await;
    assert_eq!(recv(&mut ws).await["type"], "joined");
    (ws, w)
}
async fn error(ws: &mut Socket) -> String {
    for _ in 0..5 {
        let value = recv(ws).await;
        if value["type"] == "error" {
            return value["code"].as_str().unwrap().into();
        }
    }
    panic!("Expected error");
}

#[tokio::test]
async fn automatic_admission_needs_no_operator_grants_and_forwards_signals() {
    let root = device();
    let a = device();
    let b = device();
    let p = payload(&root, &[&a, &b]);
    let t = ticket(&root, &p, "pboard-collab-board-cards");
    let (app, url, task) = server(Limits::default(), true).await;
    let (mut first, wa) = join(&url, &a, &t).await;
    let (mut second, wb) = join(&url, &b, &t).await;
    assert_eq!(recv(&mut first).await["type"], "peer_joined");
    for (from, device, target, w, logical) in [
        (&mut first, &a, &b, &wb, "logical-a"),
        (&mut second, &b, &a, &wa, "logical-b"),
    ] {
        let data = presence(device, &t, logical);
        send(
            from,
            json!({"type":"signal","to":target.id,"session":w["session"],"data":data}),
        )
        .await;
    }
    recv(&mut first).await;
    recv(&mut second).await;
    for (index, (forward, inner)) in [
        (true, json!({"type":"offer","sdp":common::sdp()})),
        (false, json!({"type":"answer","sdp":common::sdp()})),
        (true, json!({"candidate":{"candidate":common::ICE}})),
    ]
    .into_iter()
    .enumerate()
    {
        let (from, to, device, target, w, logical, remote) = if forward {
            (
                &mut first,
                &mut second,
                &a,
                &b,
                &wb,
                "logical-a",
                "logical-b",
            )
        } else {
            (
                &mut second,
                &mut first,
                &b,
                &a,
                &wa,
                "logical-b",
                "logical-a",
            )
        };
        let data = signal(device, target, &t, logical, remote, index as u64, inner);
        send(
            from,
            json!({"type":"signal","to":target.id,"session":w["session"],"data":data}),
        )
        .await;
        assert_eq!(recv(to).await["data"], data);
    }
    drop(second);
    assert_eq!(recv(&mut first).await["type"], "peer_left");
    let (_, new_w) = join(&url, &b, &t).await;
    assert_ne!(new_w["session"], wb["session"]);
    app.shutdown();
    task.abort();
    let (app, url, task) = server(Limits::default(), false).await;
    assert_eq!(authenticate(&url, &a, &t).await.2["code"], "unauthorized");
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn another_authority_cannot_claim_an_existing_board_or_account_room() {
    let root = device();
    let attacker = device();
    let a = device();
    let p = payload(&root, &[&a]);
    let t = ticket(&root, &p, "pboard-collab-board-cards");
    let (app, url, task) = server(Limits::default(), true).await;
    let (_first, _) = join(&url, &a, &t).await;
    let attacker_p = payload(&attacker, &[&attacker]);
    let own = ticket(&attacker, &attacker_p, &t.topic);
    let mut forged = own.clone();
    forged.room = t.room.clone();
    assert_eq!(
        authenticate(&url, &attacker, &forged).await.2["code"],
        "unauthorized"
    );
    assert_ne!(own.room, t.room);
    let (_other, _) = join(&url, &attacker, &own).await;
    let mut wrong = t.clone();
    wrong.authorization["topic"] = json!("pboard-account-board-order");
    assert_eq!(
        authenticate(&url, &a, &wrong).await.2["code"],
        "unauthorized"
    );
    let mut account = p.clone();
    account["boardId"] = json!("account:account-hash");
    account["driveProjectFileId"] = json!("");
    account["driveFolderId"] = json!("");
    let account_t = ticket(&root, &account, "pboard-account-account-hash-order");
    let (_account, _) = join(&url, &a, &account_t).await;
    assert_ne!(t.room, account_t.room);
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn rejects_forgery_nonmembers_expiry_bad_bindings_and_ambiguous_payloads() {
    let root = device();
    let a = device();
    let outsider = device();
    let p = payload(&root, &[&a]);
    let topic = "pboard-collab-board-cards";
    let (app, url, task) = server(
        Limits {
            automatic_auth_per_second: 128,
            http_per_second: 128,
            ..Limits::default()
        },
        true,
    )
    .await;
    let t = ticket(&root, &p, topic);
    assert_eq!(
        authenticate(&url, &outsider, &t).await.2["code"],
        "unauthorized"
    );
    let mut invalid = Vec::new();
    for (field, value) in [
        ("protocol", json!(3)),
        ("authorityKeyId", json!(outsider.id)),
        ("expiresAt", json!(now_ms() - 1)),
        ("issuedAt", json!(now_ms() + 60_000)),
        ("expiresAt", json!(now_ms() + 400_000)),
        ("driveProjectFileId", json!("file/other")),
        ("extra", json!("unexpected")),
        ("epoch", json!(9_007_199_254_740_992u64)),
    ] {
        let mut v = p.clone();
        v[field] = value;
        invalid.push(ticket(&root, &v, topic));
    }
    let mut no_owner = p.clone();
    no_owner["devices"][0]["role"] = json!("viewer");
    invalid.push(ticket(&root, &no_owner, topic));
    let mut role = p.clone();
    role["devices"][0]["role"] = json!("admin");
    invalid.push(ticket(&root, &role, topic));
    let mut duplicate = p.clone();
    duplicate["devices"]
        .as_array_mut()
        .unwrap()
        .push(p["devices"][0].clone());
    invalid.push(ticket(&root, &duplicate, topic));
    let mut bad_key = p.clone();
    bad_key["devices"][0]["publicKey"]["x"] = json!("bad");
    invalid.push(ticket(&root, &bad_key, topic));
    let mut private = p.clone();
    private["devices"][0]["publicKey"]["d"] = json!("never-allowed");
    invalid.push(ticket(&root, &private, topic));
    let bytes = serde_json::to_string(&p).unwrap();
    let duplicated = bytes.replacen('{', "{\"epoch\":1,", 1);
    invalid.push(raw_ticket(
        &root,
        duplicated.as_bytes(),
        topic,
        "file",
        "folder",
    ));
    let mut tampered = t.clone();
    tampered.authorization["manifestSignature"] = json!(B64.encode([0; 64]));
    invalid.push(tampered);
    let mut changed = t.clone();
    changed.authorization["manifestPayload"] = json!(B64.encode(b"{}"));
    invalid.push(changed);
    for value in invalid {
        assert_eq!(
            authenticate(&url, &a, &value).await.2["code"],
            "unauthorized"
        );
    }
    // Challenge proofs cannot be reused against a new session or another payload.
    let (mut first, _) = connect_async(&url).await.unwrap();
    let w = recv(&mut first).await;
    let old = proof(&a, &w, &t);
    let (mut second, _) = connect_async(&url).await.unwrap();
    recv(&mut second).await;
    send(&mut second, old).await;
    assert_eq!(recv(&mut second).await["code"], "unauthorized");
    let mut forged = proof(&a, &w, &t);
    forged["signature"] = json!(B64.encode([0; 64]));
    send(&mut first, forged).await;
    assert_eq!(recv(&mut first).await["code"], "unauthorized");
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn higher_epochs_close_old_sessions_across_collections_and_reject_rollback_or_forks() {
    let root = device();
    let a = device();
    let b = device();
    let p = payload(&root, &[&a, &b]);
    let cards = ticket(&root, &p, "pboard-collab-board-cards");
    let projects = ticket(&root, &p, "pboard-collab-board-projects");
    let (app, url, task) = server(Limits::default(), true).await;
    let (mut first, _) = join(&url, &a, &cards).await;
    let (mut second, _) = join(&url, &b, &projects).await;
    let mut revoked = payload(&root, &[&a]);
    revoked["epoch"] = json!(2);
    revoked["expiresAt"] = json!(now_ms() + 500);
    let current = ticket(&root, &revoked, &cards.topic);
    let (mut new, _, reply) = authenticate(&url, &a, &current).await;
    assert_eq!(reply["type"], "authenticated");
    assert_eq!(error(&mut first).await, "authorization_changed");
    assert_eq!(error(&mut second).await, "authorization_changed");
    assert_eq!(
        authenticate(&url, &b, &projects).await.2["code"],
        "authorization_stale"
    );
    let mut fork = revoked.clone();
    fork["expiresAt"] = json!(revoked["expiresAt"].as_u64().unwrap() + 1);
    assert_eq!(
        authenticate(&url, &a, &ticket(&root, &fork, &cards.topic))
            .await
            .2["code"],
        "authorization_stale"
    );
    send(&mut new, json!({"type":"join"})).await;
    assert_eq!(recv(&mut new).await["type"], "joined");
    assert_eq!(error(&mut new).await, "grant_expired");
    // The newer, shorter-lived proof expiring must not resurrect the revoked
    // older manifest, which remains correctly signed and unexpired for a minute.
    assert_eq!(
        authenticate(&url, &b, &projects).await.2["code"],
        "authorization_stale"
    );
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn automatic_admission_enforces_global_auth_scope_and_expiry_limits() {
    let root = device();
    let a = device();
    let b = device();
    let p = payload(&root, &[&a, &b]);
    let topic = "pboard-collab-board-cards";
    let t = ticket(&root, &p, topic);
    let (app, url, task) = server(
        Limits {
            automatic_auth_per_second: 1,
            ..Limits::default()
        },
        true,
    )
    .await;
    let (_first, _) = join(&url, &a, &t).await;
    assert_eq!(authenticate(&url, &b, &t).await.2["code"], "server_busy");
    app.shutdown();
    task.abort();
    let (app, url, task) = server(
        Limits {
            authorization_scopes: 1,
            ..Limits::default()
        },
        true,
    )
    .await;
    let mut short = p.clone();
    short["expiresAt"] = json!(now_ms() + 300);
    let t = ticket(&root, &short, topic);
    let (mut first, _) = join(&url, &a, &t).await;
    let mut other = p.clone();
    other["boardId"] = json!("other");
    let other = ticket(&root, &other, "pboard-collab-other-cards");
    assert_eq!(
        authenticate(&url, &a, &other).await.2["code"],
        "server_busy"
    );
    assert_eq!(error(&mut first).await, "grant_expired");
    // Expiry does not evict revocation tombstones before older proofs expire.
    assert_eq!(
        authenticate(&url, &a, &other).await.2["code"],
        "server_busy"
    );
    assert_eq!(authenticate(&url, &b, &t).await.2["code"], "unauthorized");
    app.shutdown();
    task.abort();
}

#[tokio::test]
async fn rejects_signed_application_payloads_forgery_and_cross_board_or_logical_sessions() {
    for scenario in [
        "raw",
        "documents",
        "metadata",
        "cross_board",
        "cross_collection",
        "from",
        "to",
        "logical",
        "expiry",
        "future",
        "signature",
        "unknown_sdp",
        "media_sdp",
    ] {
        let root = device();
        let a = device();
        let b = device();
        let p = payload(&root, &[&a, &b]);
        let t = ticket(&root, &p, "pboard-collab-board-cards");
        let (app, url, task) = server(Limits::default(), true).await;
        let (mut first, wa) = join(&url, &a, &t).await;
        let (mut second, wb) = join(&url, &b, &t).await;
        recv(&mut first).await;
        send(&mut first,json!({"type":"signal","to":b.id,"session":wb["session"],"data":presence(&a,&t,"logical-a")})).await;
        recv(&mut second).await;
        send(&mut second,json!({"type":"signal","to":a.id,"session":wa["session"],"data":presence(&b,&t,"logical-b")})).await;
        recv(&mut first).await;
        let mut data = signal(
            &a,
            &b,
            &t,
            "logical-a",
            "logical-b",
            0,
            json!({"type":"offer","sdp":common::sdp()}),
        );
        match scenario {
            "raw" => data = json!({"type":"offer","sdp":common::sdp()}),
            "documents" => data["payload"]["signal"] = json!({"documents":[{"private":"content"}]}),
            "metadata" => data["payload"]["extra"] = json!("arbitrary-data"),
            "cross_board" => data["payload"]["boardId"] = json!("other-board"),
            "cross_collection" => data["payload"]["collection"] = json!("projects"),
            "from" => data["payload"]["fromDeviceKeyId"] = json!(b.id),
            "to" => data["payload"]["toDeviceKeyId"] = json!(a.id),
            "logical" => data["payload"]["toSessionId"] = json!("stale-logical-session"),
            "expiry" => {
                data["payload"]["issuedAt"] = json!(now_ms() - 100_000);
                data["payload"]["expiresAt"] = json!(now_ms() - 1);
            }
            "future" => {
                data["payload"]["issuedAt"] = json!(now_ms() + 120_000);
                data["payload"]["expiresAt"] = json!(now_ms() + 180_000);
            }
            "signature" => data["signature"] = json!("forged"),
            "unknown_sdp" => {
                data["payload"]["signal"]["sdp"] =
                    json!(format!("{}a=x-application-data:private\r\n", common::sdp()))
            }
            "media_sdp" => {
                data["payload"]["signal"]["sdp"] = json!(common::sdp().replace(
                    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
                    "m=audio 9 UDP/TLS/RTP/SAVPF 111"
                ))
            }
            _ => unreachable!(),
        }
        if !matches!(scenario, "raw" | "signature") {
            data = signed(&a, "pboard-signal-v2", data["payload"].clone());
        }
        send(
            &mut first,
            json!({"type":"signal","to":b.id,"session":wb["session"],"data":data}),
        )
        .await;
        assert_eq!(
            error(&mut first).await,
            "invalid_signal",
            "scenario {scenario}"
        );
        assert_eq!(
            recv(&mut second).await["type"],
            "peer_left",
            "no invalid payload may be forwarded"
        );
        app.shutdown();
        task.abort();
    }
}

#[tokio::test]
async fn rejects_signal_replay_and_invalid_presence_before_forwarding() {
    let root = device();
    let a = device();
    let b = device();
    let p = payload(&root, &[&a, &b]);
    let t = ticket(&root, &p, "pboard-collab-board-cards");
    let (app, url, task) = server(Limits::default(), true).await;
    let (mut first, wa) = join(&url, &a, &t).await;
    let (mut second, wb) = join(&url, &b, &t).await;
    recv(&mut first).await;
    for (from, target, w, data) in [
        (&mut first, &b, &wb, presence(&a, &t, "logical-a")),
        (&mut second, &a, &wa, presence(&b, &t, "logical-b")),
    ] {
        send(
            from,
            json!({"type":"signal","to":target.id,"session":w["session"],"data":data}),
        )
        .await;
    }
    recv(&mut first).await;
    recv(&mut second).await;
    let data = signal(
        &a,
        &b,
        &t,
        "logical-a",
        "logical-b",
        1,
        json!({"candidate":{"candidate":common::ICE}}),
    );
    send(
        &mut first,
        json!({"type":"signal","to":b.id,"session":wb["session"],"data":data}),
    )
    .await;
    assert_eq!(recv(&mut second).await["type"], "signal");
    send(
        &mut first,
        json!({"type":"signal","to":b.id,"session":wb["session"],"data":data}),
    )
    .await;
    assert_eq!(error(&mut first).await, "signal_replay");
    recv(&mut second).await;
    let (mut fresh, _) = join(&url, &a, &t).await;
    recv(&mut second).await;
    let mut forged = presence(&b, &t, "forged");
    forged["envelope"]["presence"]["payload"]["deviceKeyId"] = json!(a.id);
    send(
        &mut fresh,
        json!({"type":"signal","to":b.id,"session":wb["session"],"data":forged}),
    )
    .await;
    assert_eq!(error(&mut fresh).await, "invalid_signal");
    app.shutdown();
    task.abort();
}
