/* Tab Thrashing — live dashboard. Reads the local server's event stream and replays your
 * real tab switches through every replacement policy in ../lab/core.js. */
(function () {
  'use strict';
  const T = window.TT;
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const RELOAD_S = 2.4;
  const MIN_SWITCHES = 12;

  const ALGOS = [
    { id: 'lru', name: 'LRU', full: 'least recently used', c: '--s-lru' },
    { id: 'clock', name: 'Clock', full: 'second chance', c: '--s-clock' },
    { id: 'lfu', name: 'LFU', full: 'least frequently used', c: '--s-lfu' },
    { id: 'fifo', name: 'FIFO', full: 'first in, first out', c: '--s-fifo' },
    { id: 'rand', name: 'Random', full: 'baseline', c: '--s-rand', dash: '2 3' },
    { id: 'opt', name: 'OPT', full: 'optimal, needs the future', c: '--s-opt', dash: '5 4' },
  ];
  const AL = Object.fromEntries(ALGOS.map((a) => [a.id, a]));
  const col = (id) => `var(${AL[id].c})`;

  const S = { events: [], snap: { tabs: [], ts: 0 }, sys: [], extSeen: 0, extPath: '', server: false, k: 8, algo: 'lru', platform: '' };
  try { const s = JSON.parse(localStorage.getItem('tt-live') || '{}'); if (s.k) S.k = s.k; if (AL[s.algo]) S.algo = s.algo; } catch (e) {}
  const persist = () => { try { localStorage.setItem('tt-live', JSON.stringify({ k: S.k, algo: S.algo })); } catch (e) {} };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gb = (b) => (b / 1073741824).toFixed(b >= 10 * 1073741824 ? 1 : 2);
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  function S_(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function ticks(min, max, n) {
    const span = max - min || 1, s0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(s0))), e = s0 / mag;
    const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag, out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }
  const hue = (id) => ((id * 137.508) % 360).toFixed(1);
  const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const tabColor = (id) => `hsl(${hue(id)} ${dark() ? '55%' : '62%'} ${dark() ? '55%' : '56%'})`;
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  /* ---------- incremental LRU stack for the log ---------- */
  let stack = [], prevTab = null;
  const lastAct = new Map(), hostOf = new Map();
  function ingest(ev) {
    if (ev.host) hostOf.set(ev.tab, ev.host);
    if (ev.type === 'close') {
      const j = stack.indexOf(ev.tab); if (j >= 0) stack.splice(j, 1);
    } else if (ev.type === 'activate') {
      if (ev.tab === prevTab) { ev._dup = true; return; }
      prevTab = ev.tab;
      const j = stack.indexOf(ev.tab);
      ev._dist = j < 0 ? Infinity : j + 1;
      if (j >= 0) stack.splice(j, 1);
      stack.unshift(ev.tab);
      lastAct.set(ev.tab, ev.ts);
    }
  }
  function resetDerived() { stack = []; prevTab = null; lastAct.clear(); hostOf.clear(); }

  /* ---------- analysis (debounced) ---------- */
  let D = null, A = null, realFault = [], rec = null, recKey = '';
  let anaTimer = null;
  const scheduleAnalysis = () => { clearTimeout(anaTimer); anaTimer = setTimeout(analyze, 600); };
  function analyze() {
    const evs = S.events.slice(-40000);
    if (!evs.length) { D = A = rec = null; renderAnalysis(); return; }
    const t0 = evs[0].ts;
    const mapped = evs.map((e) => ({ t: (e.ts - t0) / 1000, type: e.type, tab: e.tab, label: e.host }));
    const d = T.prepare('Your browser', mapped, null);
    realFault = []; let prev = null;
    for (const e of evs) if (e.type === 'activate') { if (e.tab === prev) continue; prev = e.tab; realFault.push(!!e.faulted); }
    d.t0ms = t0;
    D = d;
    A = d.N >= MIN_SWITCHES ? T.analyze(d) : null;
    recKey = '';
    renderAnalysis();
  }
  function getRec() {
    if (!A) return null;
    const k = Math.min(S.k, D.K), key = `${D.N}|${k}|${S.algo}`;
    if (key !== recKey) { rec = T.record(D, k, S.algo); recKey = key; }
    return rec;
  }

  /* ---------- connection ---------- */
  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('hello', (m) => {
      const h = JSON.parse(m.data);
      S.server = true; S.events = h.events; S.snap = h.snapshot; S.sys = h.sys; S.extSeen = h.extSeen; S.extPath = h.extensionPath; S.platform = h.platform;
      resetDerived(); S.events.forEach(ingest);
      renderAll(); analyze();
    });
    es.addEventListener('events', (m) => {
      const evs = JSON.parse(m.data);
      for (const e of evs) { S.events.push(e); ingest(e); }
      renderLog(evs.length); renderTabs(); renderMeters(); scheduleAnalysis();
    });
    es.addEventListener('snapshot', (m) => { S.snap = JSON.parse(m.data); renderTabs(); renderMeters(); });
    es.addEventListener('sys', (m) => { S.sys.push(JSON.parse(m.data)); if (S.sys.length > 1440) S.sys.shift(); renderMeters(); renderMem(); });
    es.addEventListener('ext', (m) => { S.extSeen = JSON.parse(m.data).extSeen; renderConn(); });
    es.addEventListener('cleared', () => { S.events = []; resetDerived(); renderAll(); analyze(); });
    es.onopen = () => { S.server = true; renderConn(); };
    es.onerror = () => { S.server = false; renderConn(); };
  }

  /* ---------- title bar ---------- */
  function renderConn() {
    const led = $('#led'), txt = $('#connTxt');
    const extOk = S.extSeen && Date.now() - S.extSeen < 75000;
    led.className = 'led ' + (!S.server ? 'bad' : extOk ? 'on' : '');
    txt.textContent = !S.server ? 'Server offline. Run: node live/server.js'
      : extOk ? `Extension connected · heard from ${ago(S.extSeen)}`
      : S.extSeen ? `Extension silent since ${ago(S.extSeen)}` : 'Server running · waiting for the extension';
  }

  /* ---------- meters ---------- */
  function switches() { let n = 0; for (const e of S.events) if (e.type === 'activate' && !e._dup) n++; return n; }
  function renderMeters() {
    const last = S.sys[S.sys.length - 1];
    const tabs = S.snap.tabs, live = tabs.filter((t) => !t.discarded).length, disc = tabs.length - live;
    const n = D && A ? D.N : switches();
    let real = 0; for (const e of S.events) if (e.type === 'activate' && e.faulted && !e._dup) real++;
    const first = S.events.length ? S.events[0].ts : 0;
    let bName = '—', bWs = 0, bN = 0, bList = '';
    if (last) {
      const bs = Object.entries(last.browsers || {}).sort((a, b) => b[1].ws - a[1].ws);
      if (bs.length) { bName = bs[0][0]; bWs = bs[0][1].ws; bN = bs[0][1].n; bList = bs.slice(1).map(([k, v]) => `${k} ${gb(v.ws)} GB`).join(' · '); }
    }
    const k = S.k;
    const sim = A ? A.curves.lru[Math.min(k, D.K)].faults : null;
    $('#meters').innerHTML = `
      <div class="m"><div class="l">System memory</div><div class="v">${last ? gb(last.used) : '—'}<small> / ${last ? gb(last.total) : '—'} GB</small></div><div class="gauge"><i style="width:${last ? (last.used / last.total * 100).toFixed(1) : 0}%"></i></div></div>
      <div class="m"><div class="l">${esc(bName)} working set</div><div class="v">${bWs ? gb(bWs) : '—'}<small> GB</small></div><div class="gauge"><i class="b" style="width:${last && bWs ? (bWs / last.total * 100).toFixed(1) : 0}%"></i></div><div class="s">${bN ? `${bN} processes` : 'browser not detected'}${bList ? ' · ' + esc(bList) : ''}</div></div>
      <div class="m"><div class="l">Tabs open</div><div class="v">${tabs.length || '—'}</div><div class="s">${tabs.length ? `${live} live · ${disc} discarded by the browser` : 'no snapshot yet'}</div></div>
      <div class="m"><div class="l">Tab switches recorded</div><div class="v">${n.toLocaleString()}</div><div class="s">${first ? 'since ' + new Date(first).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : 'nothing recorded yet'}</div></div>
      <div class="m"><div class="l">Real reloads (discarded tab reopened)</div><div class="v" style="color:${real ? 'var(--fault)' : 'inherit'}">${real}</div><div class="s">${n ? f1(real / n * 100) + ' per 100 switches' : '—'}</div></div>
      <div class="m"><div class="l">LRU with ${k} live tabs would reload</div><div class="v">${sim == null ? '—' : sim}</div><div class="s">${A ? `${f1(sim / D.N * 100)} per 100 · knee at k = ${A.kneeK}` : `needs ${MIN_SWITCHES} switches`}</div></div>`;
  }

  /* ---------- open tabs as an LRU stack ---------- */
  function renderTabs() {
    const box = $('#tabsBox');
    const tabs = S.snap.tabs.slice();
    if (!tabs.length) { box.innerHTML = setupHtml(); bindCopy(); $('#agree').textContent = ''; return; }
    const rec = (t) => Math.max(lastAct.get(t.id) || 0, t.lastAccessed || 0);
    tabs.sort((a, b) => (b.active - a.active) || rec(b) - rec(a));
    const k = S.k;
    const visits = new Map();
    for (const e of S.events) if (e.type === 'activate' && !e._dup) visits.set(e.tab, (visits.get(e.tab) || 0) + 1);
    let h = '<thead><tr><th class="n">#</th><th>Tab</th><th>Site</th><th>State</th><th class="n">Last used</th><th class="n">Visits</th><th>LRU at k</th></tr></thead><tbody>';
    tabs.forEach((t, i) => {
      if (i === k) h += `<tr class="line"><td colspan="7"><div><span>k = ${k}</span></div></td></tr>`;
      const out = i >= k;
      const st = t.active ? '<span class="state act">● active</span>' : t.discarded ? '<span class="state disc">○ discarded</span>' : '<span class="state live">● live</span>';
      const icon = t.icon ? `<img src="${esc(t.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'fi'}))">` : '<span class="fi"></span>';
      const r = rec(t);
      h += `<tr class="${out ? 'out' : ''}${t.active ? ' cur' : ''}"><td class="n">${i + 1}</td><td><div class="ttl">${icon}<span title="${esc(t.title)}">${esc(t.title || '(untitled)')}</span></div></td><td><div class="host">${esc(t.host)}</div></td><td>${st}</td><td class="n">${r ? ago(r) : '—'}</td><td class="n">${visits.get(t.id) || 0}</td><td class="mono" style="font-size:11.5px;color:${out ? 'var(--fault)' : 'var(--dim)'}">${out ? 'discard' : 'keep'}</td></tr>`;
    });
    box.innerHTML = '<table class="t">' + h + '</tbody></table>';
    const disc = tabs.map((t, i) => ({ t, i })).filter((x) => x.t.discarded);
    const agree = disc.filter((x) => x.i >= k).length;
    $('#agree').textContent = disc.length ? `Browser discarded ${disc.length} · ${agree} of them are below the LRU line` : 'Browser has not discarded any tab yet';
  }
  function setupHtml() {
    const browser = /edg/i.test(navigator.userAgent) ? 'edge' : 'chrome';
    return `<div class="setup">
      <h3>Connect your browser</h3>
      <p>The server is running. Load the companion extension once and this page will fill in as you use your tabs.</p>
      <ol>
        <li>Open <code>${browser}://extensions</code> in a new tab. <button class="btn" data-copy="${browser}://extensions" type="button">Copy</button></li>
        <li>Turn on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> and choose this folder:
          <div class="path"><span>${esc(S.extPath || '…/tab-thrashing/extension')}</span><button class="btn" data-copy="${esc(S.extPath)}" type="button">Copy</button></div></li>
        <li>Switch between a few tabs. Every switch appears in the event log within a second.</li>
      </ol></div>`;
  }
  function bindCopy() {
    document.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select and copy'; }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    });
  }

  /* ---------- event log ---------- */
  function renderLog(newCount) {
    const k = S.k, ol = $('#log');
    const titleOf = new Map(S.snap.tabs.map((t) => [t.id, t.title]));
    const rows = [];
    for (let i = S.events.length - 1; i >= 0 && rows.length < 300; i--) {
      const e = S.events[i];
      if (e._dup) continue;
      const what = esc(titleOf.get(e.tab) || hostOf.get(e.tab) || `tab ${e.tab}`);
      const host = esc(e.host || hostOf.get(e.tab) || '');
      let kind = e.type, tags = '';
      if (e.type === 'activate') {
        kind = 'switch';
        tags = e._dist === Infinity ? '<span class="tag">first visit</span>' : e._dist <= k ? `<span class="tag hit">hit</span>` : `<span class="tag miss">miss · depth ${e._dist}</span>`;
        if (e.faulted) tags = '<span class="tag fault">reloaded</span> ' + tags;
      } else if (e.type === 'discard') { kind = 'discard'; tags = '<span class="tag disc">by browser</span>'; }
      else if (e.type === 'create') { kind = 'open'; }
      const isNew = rows.length < (newCount || 0);
      rows.push(`<li${isNew ? ' class="new"' : ''}><span class="tm">${clock(e.ts)}</span><span class="k">${kind}</span><span class="w">${what}${host && what !== host ? ` <em>${host}</em>` : ''}</span><span>${tags}</span></li>`);
    }
    ol.innerHTML = rows.length ? rows.join('') : '<li style="display:block;color:var(--dim);padding:18px 14px;font-family:var(--ui)">Waiting for the first tab switch.</li>';
    $('#logSub').textContent = `hit / miss = LRU keeping ${k} live tabs · depth = LRU stack distance`;
  }

  /* ---------- charts ---------- */
  function frame(el, h, m, xd, yd, xt, yt, xf, yf, label) {
    el.innerHTML = '';
    const W = Math.max(280, el.clientWidth);
    const svg = S_('svg', { viewBox: `0 0 ${W} ${h}`, width: W, height: h, class: 'c', role: 'img', 'aria-label': label }, el);
    const pw = W - m.l - m.r, ph = h - m.t - m.b;
    const x = (v) => m.l + (v - xd[0]) / (xd[1] - xd[0] || 1) * pw;
    const y = (v) => m.t + ph - (v - yd[0]) / (yd[1] - yd[0] || 1) * ph;
    for (const t of yt) { S_('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === yd[0] ? 'ax' : 'g' }, svg); S_('text', { x: m.l - 6, y: y(t) + 3.5, 'text-anchor': 'end' }, svg).textContent = yf(t); }
    for (const t of xt) S_('text', { x: x(t), y: h - m.b + 15, 'text-anchor': 'middle' }, svg).textContent = xf(t);
    return { svg, x, y, W, h, m, pw, ph };
  }
  const line = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');

  function renderCurve() {
    const el = $('#curve');
    if (!A) {
      el.innerHTML = `<div class="empty">Needs at least ${MIN_SWITCHES} tab switches to draw curves. ${D ? D.N : switches()} so far.</div>`;
      $('#curveKey').innerHTML = ''; $('#kneeTxt').textContent = ''; return;
    }
    const K = D.K;
    let ymax = 1; for (const a of ALGOS) for (let k = 1; k <= K; k++) ymax = Math.max(ymax, A.curves[a.id][k].hp);
    const real = realFault.filter(Boolean).length / D.N * 100;
    ymax = Math.max(ymax, real) * 1.05;
    const c = frame(el, 250, { l: 36, r: 12, t: 12, b: 24 }, [1, K], [0, ymax], ticks(1, K, 8).filter((v) => v >= 1), ticks(0, ymax, 4), String, (v) => v, 'Refault rate by live-tab budget');
    S_('text', { x: c.W - c.m.r, y: c.m.t + 10, 'text-anchor': 'end' }, c.svg).textContent = 'x: live tabs k · y: reloads / 100';
    const kx = c.x(Math.min(S.k, K));
    S_('line', { x1: kx, x2: kx, y1: c.m.t, y2: c.m.t + c.ph, style: 'stroke:var(--live);stroke-dasharray:3 3' }, c.svg);
    for (const a of [...ALGOS].reverse()) {
      const pts = []; for (let k = 1; k <= K; k++) pts.push([c.x(k), c.y(A.curves[a.id][k].hp)]);
      S_('path', { d: line(pts), style: `fill:none;stroke:${col(a.id)};stroke-width:${a.id === S.algo ? 2.4 : 1.5};${a.dash ? 'stroke-dasharray:' + a.dash : ''}` }, c.svg);
    }
    const nx = c.x(A.kneeK), ny = c.y(A.curves.lru[A.kneeK].hp);
    S_('circle', { cx: nx, cy: ny, r: 4, style: 'fill:var(--pane);stroke:var(--s-lru);stroke-width:2' }, c.svg);
    // the browser, measured: its live tab count now vs its real reload rate
    const liveNow = S.snap.tabs.filter((t) => !t.discarded).length;
    if (liveNow) {
      const bx = c.x(Math.max(1, Math.min(K, liveNow))), by = c.y(real);
      S_('rect', { x: bx - 4.5, y: by - 4.5, width: 9, height: 9, transform: `rotate(45 ${bx} ${by})`, style: 'fill:var(--s-chrome)' }, c.svg);
      const tx = S_('text', { x: bx + 9, y: by - 7, style: 'fill:var(--ink)' }, c.svg); tx.textContent = `your browser ${f1(real)}`;
      if (bx > c.W - 120) { tx.setAttribute('text-anchor', 'end'); tx.setAttribute('x', bx - 9); }
    }
    $('#kneeTxt').textContent = `thrashing point (LRU knee): k = ${A.kneeK}`;
    $('#curveKey').innerHTML = ALGOS.map((a) => `<span><i style="background:${col(a.id)}"></i>${a.name}</span>`).join('') + '<span><i class="d" style="background:var(--s-chrome)"></i>your browser, measured (at current live tabs)</span>';
  }

  function renderMem() {
    const el = $('#mem');
    const now = Date.now();
    const pts = S.sys.filter((s) => s.ts >= now - 30 * 60000);
    if (pts.length < 2) { el.innerHTML = '<div class="empty">Collecting samples…</div>'; return; }
    const from = pts[0].ts; // fill the width while the first 30 minutes accumulate
    const total = pts[pts.length - 1].total;
    const tg = total / 1073741824;
    const span = now - from, xt = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * span);
    const c = frame(el, 250, { l: 36, r: 16, t: 12, b: 24 }, [from, now], [0, tg], xt, ticks(0, tg, 4),
      (v) => { const s = Math.round((now - v) / 1000); return s < 1 ? 'now' : s < 120 ? `−${s} s` : `−${Math.round(s / 60)} min`; }, (v) => v, 'Memory over time');
    S_('text', { x: c.m.l + 4, y: c.m.t + 10 }, c.svg).textContent = `GB of ${f1(tg)}`;
    const used = pts.map((s) => [c.x(s.ts), c.y(s.used / 1073741824)]);
    S_('path', { d: line(used) + `L${used[used.length - 1][0]},${c.y(0)}L${used[0][0]},${c.y(0)}Z`, style: 'fill:var(--live-bg);stroke:none' }, c.svg);
    S_('path', { d: line(used), style: 'fill:none;stroke:var(--live);stroke-width:1.6' }, c.svg);
    const br = pts.map((s) => { let ws = 0; for (const v of Object.values(s.browsers || {})) ws += v.ws; return [c.x(s.ts), c.y(ws / 1073741824)]; });
    S_('path', { d: line(br), style: 'fill:none;stroke:var(--fault);stroke-width:1.6' }, c.svg);
    const lu = used[used.length - 1], lb = br[br.length - 1];
    S_('circle', { cx: lu[0], cy: lu[1], r: 3, style: 'fill:var(--live)' }, c.svg);
    S_('circle', { cx: lb[0], cy: lb[1], r: 3, style: 'fill:var(--fault)' }, c.svg);
  }

  function renderFrames() {
    const cv = $('#frames');
    const r = getRec();
    const W = Math.max(280, cv.parentElement.clientWidth - 28);
    if (!r) { cv.style.display = 'none'; $('#framesSub').textContent = `appears after ${MIN_SWITCHES} switches`; return; }
    cv.style.display = 'block';
    const k = r.k, gutter = 30, lane = 16;
    const rowH = Math.max(6, Math.min(18, Math.floor(220 / k)));
    const H = lane + k * rowH + 20;
    const win = Math.min(D.N, Math.floor((W - gutter) / 7));
    const start = D.N - win, cw = (W - gutter) / win;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const C = { sunk: cssVar('--sunk'), ink: cssVar('--ink'), fault: cssVar('--fault'), faint: cssVar('--faint'), dim: cssVar('--dim'), live: cssVar('--live') };
    ctx.font = `10px ${cssVar('--mono')}`; ctx.fillStyle = C.faint; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    if (rowH >= 10) for (let s = 0; s < k; s++) ctx.fillText('f' + s, gutter - 6, lane + s * rowH + rowH / 2);
    for (let j = 0; j < win; j++) {
      const i = start + j, x = gutter + j * cw;
      for (let s = 0; s < k; s++) {
        const tab = r.frames[i * k + s];
        ctx.fillStyle = tab < 0 ? C.sunk : tabColor(tab);
        ctx.fillRect(x + 0.5, lane + s * rowH + 0.5, Math.max(1, cw - 1), rowH - 1);
      }
      if (r.kind[i]) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.2; ctx.strokeRect(x + 1, lane + r.slot[i] * rowH + 1, Math.max(1, cw - 2), rowH - 2); }
      if (r.kind[i] === 1) { ctx.fillStyle = C.live; ctx.fillRect(x + 0.5, 2, Math.max(1, cw - 1), 5); }
      if (realFault[i]) { ctx.fillStyle = C.fault; ctx.fillRect(x + 0.5, 9, Math.max(1, cw - 1), 5); }
    }
    ctx.fillStyle = C.dim; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const t0 = D.t0ms;
    const every = Math.max(1, Math.ceil(win / Math.max(2, Math.floor((W - gutter) / 110))));
    for (let j = 0; j < win - every / 2; j += every) ctx.fillText(clock(t0 + D.times[start + j] * 1000), gutter + j * cw, H - 4);
    let sim = 0, real = 0; for (let j = 0; j < win; j++) { if (r.kind[start + j] === 1) sim++; if (realFault[start + j]) real++; }
    $('#framesSub').textContent = `${AL[S.algo].name}, ${k} frames, last ${win} switches · top row blue = simulated reload (${sim}), red = real reload by your browser (${real}) · outlined = tab loaded into that frame`;
  }

  function renderPolicies() {
    const t = $('#pol');
    if (!A) { t.innerHTML = `<tbody><tr><td class="empty">Needs ${MIN_SWITCHES} tab switches.</td></tr></tbody>`; return; }
    const k = Math.min(S.k, D.K), hours = Math.max(1 / 60, (D.times[D.N - 1] - D.times[0]) / 3600);
    const opt = A.curves.opt[k].hp;
    const xOpt = (hp) => (opt < 0.05 ? (hp < 0.05 ? '1.0' : '—') : f1(hp / opt));
    const realN = realFault.filter(Boolean).length;
    const rows = ALGOS.map((a) => ({ name: a.name, full: a.full, c: col(a.id), hp: A.curves[a.id][k].hp, f: A.curves[a.id][k].faults, live: f1(A.curves[a.id][k].res), sel: a.id === S.algo }));
    rows.push({ name: 'Your browser', full: 'measured, its own discard policy', c: 'var(--s-chrome)', hp: realN / D.N * 100, f: realN, live: `${S.snap.tabs.filter((x) => !x.discarded).length} now`, real: true });
    rows.sort((a, b) => a.hp - b.hp);
    const mx = Math.max(...rows.map((r) => r.hp)) || 1;
    t.innerHTML = `<thead><tr><th>Policy</th><th class="n">Reloads / 100 switches</th><th></th><th class="n">× OPT</th><th class="n">Reloads / hour</th><th class="n">Time lost / hour</th><th class="n">Avg live tabs</th></tr></thead><tbody>` +
      rows.map((r) => `<tr${r.sel ? ' class="cur"' : ''}><td><span style="display:inline-block;width:10px;height:10px;background:${r.c};margin-right:8px;vertical-align:-1px${r.real ? ';transform:rotate(45deg)' : ''}"></span><b style="font-weight:600">${r.name}</b> <span style="color:var(--dim)">${r.full}</span></td><td class="n">${f1(r.hp)}</td><td style="width:22%"><div style="height:6px;background:${r.c};width:${(r.hp / mx * 100).toFixed(1)}%;opacity:.75"></div></td><td class="n">${xOpt(r.hp)}</td><td class="n">${f1(r.f / hours)}</td><td class="n">${Math.round(r.f * RELOAD_S / hours)} s</td><td class="n">${r.live}</td></tr>`).join('') + '</tbody>';
  }

  function renderAnalysis() { renderMeters(); renderCurve(); renderFrames(); renderPolicies(); }
  function renderAll() { renderConn(); renderMeters(); renderTabs(); renderLog(0); renderMem(); renderAnalysis(); }

  /* ---------- controls ---------- */
  const kIn = $('#k');
  const setK = (v) => { S.k = Math.max(1, Math.min(64, v | 0 || 1)); kIn.value = S.k; persist(); renderTabs(); renderLog(0); renderAnalysis(); };
  kIn.value = S.k;
  kIn.addEventListener('change', () => setK(parseInt(kIn.value, 10)));
  $('#kDn').onclick = () => setK(S.k - 1);
  $('#kUp').onclick = () => setK(S.k + 1);
  const sel = $('#algo');
  for (const a of ALGOS) { const o = document.createElement('option'); o.value = a.id; o.textContent = `${a.name} (${a.full})`; sel.appendChild(o); }
  sel.value = S.algo;
  sel.onchange = () => { S.algo = sel.value; persist(); renderAnalysis(); };
  const clr = $('#clear');
  clr.onclick = async () => {
    if (!clr.classList.contains('armed')) {
      clr.classList.add('armed'); clr.textContent = 'Delete all recorded events?';
      setTimeout(() => { clr.classList.remove('armed'); clr.textContent = 'Clear'; }, 4000);
      return;
    }
    clr.classList.remove('armed'); clr.textContent = 'Clear';
    await fetch('/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  };

  setInterval(() => { renderConn(); renderMeters(); }, 1000);
  setInterval(() => { renderTabs(); renderMem(); }, 15000);
  let rw = 0;
  new ResizeObserver((es) => { const w = Math.round(es[0].contentRect.width); if (w !== rw) { rw = w; renderMem(); renderAnalysis(); } }).observe(document.body);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderMem(); renderAnalysis(); });

  renderAll();
  connect();
})();
