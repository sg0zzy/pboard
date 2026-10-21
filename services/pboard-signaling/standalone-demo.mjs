/** Disposable native-extension UI; never included in the normal application. */
const element = id => document.getElementById(id);
let active = false, rendering = false;
const views = new Map();
async function action(work) {
  element('error').textContent = '';
  try { await work(); }
  catch (error) { element('error').textContent = error instanceof Error ? error.message : 'Test action failed'; }
}
async function render() {
  if (!active || rendering) return;
  rendering = true;
  try {
    const { rx, runtime, stats } = window.secureProbe;
    const state = runtime.collaborationManager.state();
    element('connection').textContent = state.error ? `Collaboration blocked: ${state.error}`
      : state.connectedPeers.length ? `Connected to ${state.connectedPeers.length} authorized device` : 'Waiting for the other device…';
    element('boundary').textContent = `Signaling frames: ${stats.frames}. Google requests: ${stats.google}. Content boundary: ${stats.leaked ? 'FAILED' : 'passed'}.`;
    const cards = await rx.listCards('standalone-board');
    for (const [id, view] of views) if (!cards.some(card => card.id === id)) { view.form.remove(); views.delete(id); }
    for (const card of cards) {
      let view = views.get(card.id);
      if (!view) {
        const form = document.createElement('form'); form.className = 'demo-card';
        const label = document.createElement('label'); label.textContent = 'Card text';
        const input = document.createElement('textarea'); input.rows = 3; label.append(input);
        const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save edit';
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete card';
        form.append(label, save, remove); element('cards').append(form);
        view = { form, input }; views.set(card.id, view);
        form.addEventListener('submit', event => { event.preventDefault(); void action(() => rx.updateItem(card.id, { content: input.value })); });
        remove.addEventListener('click', () => { void action(() => rx.deleteItem(card.id)); });
      }
      if (document.activeElement !== view.input) view.input.value = card.content;
    }
  } finally { rendering = false; }
}
element('add-card').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const input = element('add-card').elements.namedItem('content');
    if (!input.value.trim()) return;
    await window.secureProbe.rx.addItem({ projectId: 'standalone-board', content: input.value }); input.value = '';
  });
});
element('disconnect').addEventListener('click', () => { void action(() => window.secureProbe.stop()); });
element('reconnect').addEventListener('click', () => { void action(() => window.secureProbe.start()); });
window.secureDemo = {
  ready(identity) {
    document.title = `Pboard test — ${identity}`;
    element('identity').textContent = identity;
    element('setup').textContent = 'PASS: owner approval, authenticated WebRTC, two-way signed card replication and reconnect.';
    element('controls').disabled = false;
    active = true;
    void action(render);
  }
};
setInterval(() => { void action(render); }, 500);
// Mirrors the normal sidebar's grant-refresh lifecycle while these pages stay open.
setInterval(() => { if (active) void action(() => window.secureProbe.runtime.collaborationManager.refreshRole()); }, 10_000);
