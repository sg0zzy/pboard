import NodeDataChannel from "node-datachannel/polyfill";
import Peer from "simple-peer";
import { createSimplePeerWrtc } from "rxdb/plugins/replication-webrtc";

const wrtc = createSimplePeerWrtc(NodeDataChannel);
const a = new Peer({ initiator: true, wrtc, trickle: false });
const b = new Peer({ initiator: false, wrtc, trickle: false });
a.on("signal", (s) => b.signal(s));
b.on("signal", (s) => a.signal(s));
a.on("connect", () => { console.log("A connected"); a.send(JSON.stringify({ hello: "from A" })); });
b.on("connect", () => { console.log("B connected"); b.send(JSON.stringify({ hello: "from B" })); });
a.on("data", (d) => { console.log("A got:", String(d)); });
b.on("data", (d) => { console.log("B got:", String(d)); });
a.on("error", (e) => console.log("A error:", String(e)));
b.on("error", (e) => console.log("B error:", String(e)));
setTimeout(() => { console.log("TIMEOUT: no data channel"); process.exit(1); }, 15000);
