/** Local DevTools smoke helper for a throwaway Chromium extension profile. */
const port = Number(process.argv[2] ?? 9224);
const action = process.argv[3] ?? "probe";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const sidebar = targets.find((target) => target.url?.startsWith("chrome-extension://") && target.url.endsWith("/sidebar.html"));
if (!sidebar) throw new Error("Open the extension sidebar.html target before running this helper");
const ws = new WebSocket(sidebar.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const waiting = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!waiting.has(message.id)) return;
  const { resolve, reject } = waiting.get(message.id);
  waiting.delete(message.id);
  if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
};
function send(method, params = {}) {
  const next = ++id;
  return new Promise((resolve, reject) => {
    waiting.set(next, { resolve, reject });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function pause(ms = 400) { await new Promise((resolve) => setTimeout(resolve, ms)); }
try {
  if (action === "enable") {
    await evaluate('chrome.storage.local.set({pboardStorageBackend:"rxdb"})');
    await send("Page.reload");
    await pause(1000);
  }
  if (action === "create") {
    await evaluate('([...document.querySelectorAll("button")].find(button=>button.textContent.includes("Create your first project"))||null)?.click()');
    await pause();
    const fields = await evaluate('({inputs:[...document.querySelectorAll("input")].map(input=>({placeholder:input.placeholder,outer:input.outerHTML})),buttons:[...document.querySelectorAll("button")].map(button=>button.textContent)})');
    console.log(JSON.stringify(fields));
  }
  if (action === "submit") {
    await evaluate('(()=>{const input=document.querySelector("input[placeholder]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"RxDB smoke board");input.dispatchEvent(new Event("input",{bubbles:true}));return input.value})()');
    await pause(100);
    await evaluate('([...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Create")||null)?.click()');
    await pause(1000);
  }
  if (action === "image") {
    await evaluate('(()=>{const raw=atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bQAAAABJRU5ErkJggg==");const file=new File([Uint8Array.from(raw,char=>char.charCodeAt(0))],"smoke.png",{type:"image/png"});const transfer=new DataTransfer();transfer.items.add(file);document.querySelector(".board").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer}));return file.size})()');
    await pause(1200);
  }
  if (action === "largeimage") {
    await evaluate('(async()=>{const canvas=document.createElement("canvas");canvas.width=1400;canvas.height=700;const context=canvas.getContext("2d");context.fillStyle="#a9b7c9";context.fillRect(0,0,1400,700);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));const file=new File([blob],"wide.png",{type:"image/png"});const transfer=new DataTransfer();transfer.items.add(file);document.querySelector(".board").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer}));return file.size})()');
    await pause(1200);
  }
  if (action === "widthfixture") {
    await evaluate('(async()=>{const canvas=document.createElement("canvas");canvas.width=1400;canvas.height=700;const context=canvas.getContext("2d");context.fillStyle="#a9b7c9";context.fillRect(0,0,1400,700);const time=new Date().toISOString();await chrome.storage.local.set({projectBoardState:{version:3,currentProjectId:"width-project",projects:[{id:"width-project",name:"Narrow width",template:"project",revision:1,createdAt:time,updatedAt:time}],boardItems:[{id:"wide-image",projectId:"width-project",type:"reference",title:"Wide image",content:"Wide capture",status:"candidate",displayMode:"expanded",image:{dataUrl:canvas.toDataURL("image/webp",.82),mimeType:"image/webp",width:1400,height:700},source:{provider:"web",conversationUrl:"https://example.com/very-long-source",sourceText:"Source"},order:0,createdAt:time,updatedAt:time}]}});return true})()');
    await pause(500);
  }
  if (action === "measure") {
    for (const width of [220, 260, 300, 360]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await pause(100);
      const geometry = await evaluate('(()=>{const card=[...document.querySelectorAll(".card")].at(-1);const trash=card?.querySelector(".card-icon-button.danger");const image=card?.querySelector("img.card-image");const rect=element=>element?({left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,width:element.getBoundingClientRect().width}):null;return {viewport:innerWidth,bodyWidth:document.body.scrollWidth,card:rect(card),trash:rect(trash),image:rect(image)}})()');
      console.log(JSON.stringify(geometry));
    }
  }
  if (action === "diagnosewidth") {
    await send("Emulation.setDeviceMetricsOverride", { width: 260, height: 800, deviceScaleFactor: 1, mobile: false });
    const details = await evaluate('(()=>{const card=document.querySelector(".card");const image=card.querySelector(".card-image");const rect=element=>({width:element.getBoundingClientRect().width,scrollWidth:element.scrollWidth,flex: getComputedStyle(element).flex,minWidth:getComputedStyle(element).minWidth});const before={body:document.body.scrollWidth,card:rect(card),topline:rect(card.querySelector(".card-topline")),actions:rect(card.querySelector(".card-actions")),image:rect(image)};image.style.display="none";const withoutImage={body:document.body.scrollWidth,card:rect(card),topline:rect(card.querySelector(".card-topline"))};image.style.display="";return {before,withoutImage}})()');
    console.log(JSON.stringify(details, null, 2));
  }
  if (action === "reload") { await send("Page.reload"); await pause(1000); }
  const probe = await evaluate('(async()=>({text:document.body.innerText.slice(0,1000),backendSetting:(await chrome.storage.local.get("pboardStorageBackend")).pboardStorageBackend??null,migrationError:(await chrome.storage.local.get("pboardRxMigrationError")).pboardRxMigrationError??null,legacyPresent:!!(await chrome.storage.local.get("projectBoardState")).projectBoardState,images:[...document.querySelectorAll("img.card-image")].map(image=>({complete:image.complete,width:image.naturalWidth,blobUrl:image.src.startsWith("blob:")})),databases:await indexedDB.databases()}))()');
  console.log(JSON.stringify(probe, null, 2));
} finally { ws.close(); }
