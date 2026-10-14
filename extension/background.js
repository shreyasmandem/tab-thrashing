// Tab Thrashing — service worker.
// Streams tab events to the local server (http://127.0.0.1:4870). Nothing leaves this computer.
// Events: activate (a memory reference), close (frees a frame), create, discard (the browser evicted a tab).
// An activate into a tab the browser had discarded is flagged `faulted`: a real, measured page fault.

const SERVER = 'http://127.0.0.1:4870';
const DEFAULTS = { policy: 'off', k: 8 };

const hostOf = (url) => { try { return new URL(url).hostname || new URL(url).protocol.replace(':', ''); } catch (e) { return ''; } };

/* ---------- outbox: survives service-worker restarts and server downtime ---------- */
let flushing = false;
async function emit(ev) {
  ev.ts = Date.now();
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  outbox.push(ev);
  if (outbox.length > 50000) outbox.splice(0, outbox.length - 50000);
  await chrome.storage.local.set({ outbox });
  flush();
}
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const { outbox = [] } = await chrome.storage.local.get('outbox');
    if (!outbox.length) return;
    const batch = outbox.slice(0, 2000);
    const r = await fetch(SERVER + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const cur = (await chrome.storage.local.get('outbox')).outbox || [];
    await chrome.storage.local.set({ outbox: cur.slice(batch.length), connected: true, lastSent: Date.now() });
    if (cur.length > batch.length) setTimeout(flush, 50);
  } catch (e) {
    await chrome.storage.local.set({ connected: false });
  } finally {
    flushing = false;
  }
}

/* ---------- snapshots of every open tab ---------- */
let snapTimer = null;
function snapshotSoon() { clearTimeout(snapTimer); snapTimer = setTimeout(snapshot, 400); }
async function snapshot() {
  const tabs = await chrome.tabs.query({});
  const body = {
    tabs: tabs.map((t) => ({
      id: t.id, win: t.windowId, host: hostOf(t.url || t.pendingUrl || ''), title: t.title || '',
      icon: t.favIconUrl || '', active: t.active, discarded: t.discarded, pinned: t.pinned, audible: !!t.audible,
      lastAccessed: t.lastAccessed || 0,
    })),
  };
  for (const t of tabs) if (t.discarded) discarded.add(t.id);
  try {
    const r = await fetch(SERVER + '/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await chrome.storage.local.set({ connected: r.ok });
  } catch (e) {
    await chrome.storage.local.set({ connected: false });
  }
}

/* ---------- discard tracking ---------- */
// tabs.get() may already report discarded:false by the time onActivated fires, so remember discards ourselves.
const discarded = new Set();
chrome.storage.session.get('discarded').then((s) => (s.discarded || []).forEach((id) => discarded.add(id)));
const saveDiscarded = () => chrome.storage.session.set({ discarded: [...discarded] });

async function activated(tabId) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
  const faulted = discarded.has(tabId) || !!tab.discarded;
  discarded.delete(tabId); saveDiscarded();
  const ev = { type: 'activate', tab: tabId, win: tab.windowId, host: hostOf(tab.url || tab.pendingUrl || '') };
  if (faulted) ev.faulted = true;
  lastUse.set(tabId, Date.now()); refBit.set(tabId, 1);
  await emit(ev);
  snapshotSoon();
  enforce(tabId);
}

chrome.tabs.onActivated.addListener(({ tabId }) => activated(tabId));

chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
  if (tab) activated(tab.id); // the server-side trace drops repeats of the same tab
});

chrome.tabs.onCreated.addListener((tab) => { emit({ type: 'create', tab: tab.id, win: tab.windowId }); snapshotSoon(); });

chrome.tabs.onRemoved.addListener((tabId) => {
  discarded.delete(tabId); saveDiscarded();
  lastUse.delete(tabId); refBit.delete(tabId);
  emit({ type: 'close', tab: tabId });
  snapshotSoon();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.discarded === true) {
    discarded.add(tabId); saveDiscarded();
    emit({ type: 'discard', tab: tabId, win: tab.windowId, host: hostOf(tab.url || '') });
  }
  if (info.discarded !== undefined || info.title || info.url || info.status === 'complete' || info.favIconUrl) snapshotSoon();
});

chrome.tabs.onReplaced.addListener(() => snapshotSoon());

/* ---------- heartbeat ---------- */
chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'heartbeat') { flush(); snapshot(); } });
chrome.runtime.onStartup.addListener(() => { flush(); snapshot(); });
chrome.runtime.onInstalled.addListener(() => { flush(); snapshot(); });

/* ---------- optional experiment: enforce a live-tab budget ---------- */
const lastUse = new Map();
const refBit = new Map();
let hand = 0;
async function enforce(activeId) {
  const st = { ...DEFAULTS, ...((await chrome.storage.local.get('settings')).settings || {}) };
  if (st.policy === 'off') return;
  const live = (await chrome.tabs.query({})).filter((t) => !t.discarded && !t.pinned && !t.audible);
  let excess = live.length - st.k;
  const pool = live.filter((t) => t.id !== activeId && !t.active);
  while (excess > 0 && pool.length) {
    let victim;
    if (st.policy === 'lru') {
      pool.sort((a, b) => (lastUse.get(a.id) || a.lastAccessed || 0) - (lastUse.get(b.id) || b.lastAccessed || 0));
      victim = pool.shift();
    } else {
      pool.sort((a, b) => a.id - b.id);
      for (let spins = 0; spins < pool.length * 2 && !victim; spins++) {
        const i = hand % pool.length, t = pool[i];
        if (refBit.get(t.id)) { refBit.set(t.id, 0); hand++; } else { victim = t; pool.splice(i, 1); }
      }
      if (!victim) victim = pool.shift();
    }
    try { await chrome.tabs.discard(victim.id); excess--; } catch (e) { /* tab may be gone */ }
  }
}
