#!/usr/bin/env node
/* Tab Thrashing — local live server.
 *
 *   node live/server.js            then open http://127.0.0.1:4870
 *
 * Receives tab events from the companion extension, stores them in live/data/events.jsonl,
 * samples system and browser memory, and streams everything to the dashboard over SSE.
 * Binds to 127.0.0.1 only. No dependencies.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 4870;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const LOG = path.join(DATA, 'events.jsonl');
const CORE = path.join(ROOT, '..', 'lab', 'core.js');
const EXTENSION = path.resolve(ROOT, '..', 'extension');
const TYPES = new Set(['activate', 'close', 'create', 'discard']);
const BROWSERS = { 'chrome.exe': 'Chrome', 'msedge.exe': 'Edge', 'brave.exe': 'Brave', 'opera.exe': 'Opera', 'vivaldi.exe': 'Vivaldi', 'firefox.exe': 'Firefox',
  chrome: 'Chrome', 'google chrome': 'Chrome', 'google chrome helper': 'Chrome', 'microsoft edge': 'Edge', msedge: 'Edge', brave: 'Brave', firefox: 'Firefox' };

fs.mkdirSync(DATA, { recursive: true });

/* ---------- state ---------- */
const state = {
  events: [],
  snapshot: { tabs: [], ts: 0 },
  sys: [],          // { ts, used, total, browsers: { Chrome: { ws, n } } }
  extSeen: 0,
  startedAt: Date.now(),
};
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { state.events.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
  }
}

const clients = new Set();
function send(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(type, data) { for (const res of clients) send(res, type, data); }

/* ---------- validation ---------- */
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
function cleanEvent(e) {
  if (!e || !TYPES.has(e.type) || !Number.isInteger(e.tab)) return null;
  const out = { ts: Number.isFinite(e.ts) ? Math.round(e.ts) : Date.now(), type: e.type, tab: e.tab };
  if (Number.isInteger(e.win)) out.win = e.win;
  const host = str(e.host, 253); if (host) out.host = host;
  if (e.faulted === true) out.faulted = true;
  return out;
}
function cleanTab(t) {
  if (!t || !Number.isInteger(t.id)) return null;
  return {
    id: t.id, win: Number.isInteger(t.win) ? t.win : 0,
    host: str(t.host, 253) || '', title: str(t.title, 300) || '',
    icon: /^(https?:|data:image\/)/.test(t.icon || '') ? str(t.icon, 4000) : '',
    active: !!t.active, discarded: !!t.discarded, pinned: !!t.pinned, audible: !!t.audible,
    lastAccessed: Number.isFinite(t.lastAccessed) ? t.lastAccessed : 0,
  };
}

/* ---------- memory sampling ---------- */
function sampleBrowsers(cb) {
  const done = (map) => cb(map);
  if (process.platform === 'win32') {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      const map = {};
      if (!err) for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)","[^"]*","[^"]*","([\d.,\s]+)\s*K"/i);
        if (!m) continue;
        const name = BROWSERS[m[1].toLowerCase()];
        if (!name) continue;
        const kb = Number(m[3].replace(/[^\d]/g, '')) || 0;
        (map[name] = map[name] || { ws: 0, n: 0 }).ws += kb * 1024;
        map[name].n++;
      }
      done(map);
    });
  } else {
    execFile('ps', ['-axo', 'rss=,comm='], { maxBuffer: 8 << 20 }, (err, out) => {
      const map = {};
      if (!err) for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const base = path.basename(m[2]).toLowerCase();
        const name = BROWSERS[base] || (base.startsWith('google chrome') ? 'Chrome' : base.startsWith('microsoft edge') ? 'Edge' : null);
        if (!name) continue;
        (map[name] = map[name] || { ws: 0, n: 0 }).ws += Number(m[1]) * 1024;
        map[name].n++;
      }
      done(map);
    });
  }
}
function tick() {
  sampleBrowsers((browsers) => {
    const s = { ts: Date.now(), used: os.totalmem() - os.freemem(), total: os.totalmem(), browsers };
    state.sys.push(s);
    if (state.sys.length > 1440) state.sys.splice(0, state.sys.length - 1440); // 2 h at 5 s
    broadcast('sys', s);
  });
}
tick();
setInterval(tick, 5000);

/* ---------- export ---------- */
function exportTrace(hash) {
  const salt = crypto.randomBytes(8).toString('hex');
  const t0 = state.events.length ? state.events[0].ts : Date.now();
  const label = (h) => (hash ? 'site-' + crypto.createHash('sha256').update(salt + (h || '')).digest('hex').slice(0, 4) : (h || 'other'));
  return {
    format: 'tab-thrashing/v1',
    exported: new Date().toISOString(),
    hashed: hash,
    events: state.events.map((e) => {
      const o = { t: (e.ts - t0) / 1000, type: e.type, tab: e.tab };
      if (e.type === 'activate') o.label = label(e.host);
      if (e.faulted) o.faulted = true;
      return o;
    }),
  };
}

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 4 << 20) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(e); } });
}
// Only this machine's dashboard and browser extensions may write. Blocks other websites and DNS rebinding.
const hostOk = (req) => new RegExp(`^(127\\.0\\.0\\.1|localhost):${PORT}$`).test(req.headers.host || '');
function originOk(req) {
  const o = req.headers.origin;
  return !o || /^(chrome|moz)-extension:\/\//.test(o) || o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`;
}

const server = http.createServer((req, res) => {
  if (!hostOk(req)) { res.writeHead(421); return res.end('Misdirected request'); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (p === '/app.js') return serveFile(res, path.join(PUBLIC, 'app.js'));
    if (p === '/core.js') return serveFile(res, CORE);
    if (p === '/api/health') return json(res, 200, { ok: true, events: state.events.length });
    if (p === '/api/export') {
      const hash = url.searchParams.get('hash') !== '0';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="tab-trace-${new Date().toISOString().slice(0, 10)}.json"` });
      return res.end(JSON.stringify(exportTrace(hash)));
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      send(res, 'hello', { events: state.events, snapshot: state.snapshot, sys: state.sys, extSeen: state.extSeen, extensionPath: EXTENSION, startedAt: state.startedAt, platform: process.platform });
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    res.writeHead(404); return res.end('Not found');
  }

  if (req.method === 'POST') {
    if (!originOk(req)) return json(res, 403, { error: 'Origin not allowed' });
    return readBody(req, (err, body) => {
      if (err) return json(res, 400, { error: 'Body must be JSON' });
      if (p === '/api/events') {
        const evs = (Array.isArray(body.events) ? body.events : []).map(cleanEvent).filter(Boolean);
        if (evs.length) {
          state.events.push(...evs);
          fs.appendFile(LOG, evs.map((e) => JSON.stringify(e)).join('\n') + '\n', () => {});
          broadcast('events', evs);
        }
        state.extSeen = Date.now(); broadcast('ext', { extSeen: state.extSeen });
        return json(res, 200, { ok: true, stored: evs.length });
      }
      if (p === '/api/snapshot') {
        const tabs = (Array.isArray(body.tabs) ? body.tabs : []).map(cleanTab).filter(Boolean);
        state.snapshot = { tabs, ts: Date.now() };
        state.extSeen = Date.now();
        broadcast('snapshot', state.snapshot); broadcast('ext', { extSeen: state.extSeen });
        return json(res, 200, { ok: true, tabs: tabs.length });
      }
      if (p === '/api/clear') {
        state.events = [];
        fs.writeFile(LOG, '', () => {});
        broadcast('cleared', {});
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    });
  }
  res.writeHead(405); res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Tab Thrashing live server on http://${HOST}:${PORT}`);
  console.log(`  ${state.events.length} stored events in ${LOG}`);
  console.log(`  Extension folder: ${EXTENSION}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is the server already running? Set PORT=xxxx to use another.`);
  else console.error(e);
  process.exit(1);
});
