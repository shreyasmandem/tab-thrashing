const SERVER = 'http://127.0.0.1:4870';
const DEFAULTS = { policy: 'off', k: 8 };
const $ = (id) => document.getElementById(id);

async function status() {
  let ok = false, n = 0;
  try {
    const r = await fetch(SERVER + '/api/health');
    if (r.ok) { ok = true; n = (await r.json()).events; }
  } catch (e) {}
  $('st').classList.toggle('on', ok);
  $('stTxt').textContent = ok ? 'Connected' : 'Server offline';
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  $('queue').innerHTML = ok
    ? `${n.toLocaleString()} events recorded on this computer.${outbox.length ? ` ${outbox.length} waiting to send.` : ''}`
    : `Start the server with <code>node live/server.js</code>. ${outbox.length.toLocaleString()} events are queued and will send when it is back.`;
}

async function load() {
  const st = { ...DEFAULTS, ...((await chrome.storage.local.get('settings')).settings || {}) };
  $('policy').value = st.policy;
  $('k').value = st.k;
}
async function save() {
  const settings = { policy: $('policy').value, k: Math.max(2, Math.min(64, parseInt($('k').value, 10) || 8)) };
  await chrome.storage.local.set({ settings });
}
for (const id of ['policy', 'k']) $(id).addEventListener('change', save);
$('open').addEventListener('click', () => chrome.tabs.create({ url: SERVER }));

load();
status();
