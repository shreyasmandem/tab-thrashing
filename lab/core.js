/* Tab Thrashing — simulation core.
 * Shared by the lab page (browser) and the Node cross-check against sim/sim.py.
 * A trace is a list of events {t, type: 'activate' | 'close', tab, label?}.
 * Each activation is one memory reference; a tab is a page; a frame is a live (non-discarded) tab.
 */
(function (root) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- Synthetic personas: a seeded locality model ---------- */
  const PERSONAS = {
    researcher: {
      name: 'Researcher', seed: 11, n: 1200, meanGap: 19,
      blurb: 'Literature review. A few anchor tabs, long reading phases, many papers opened and abandoned.',
      anchors: ['Mail', 'Reference manager', 'Draft on Overleaf', 'Calendar'],
      labels: ['Paper', 'Preprint', 'Survey', 'Thread', 'Dataset', 'Blog post'],
      pNew: 0.10, pAnchor: 0.17, pPhase: 0.02, phaseKeep: 0.35, phaseSize: [6, 11], zipf: 1.05, pClose: 0.045, revisit: 0.3, loop: null,
    },
    developer: {
      name: 'Developer', seed: 23, n: 1200, meanGap: 14,
      blurb: 'Debugging session. Tight ping-pong between docs, localhost and the pull request.',
      anchors: ['localhost:3000', 'Pull request', 'Team chat', 'API reference'],
      labels: ['Docs', 'Error search', 'Issue', 'Changelog', 'Gist'],
      pNew: 0.07, pAnchor: 0.30, pPhase: 0.016, phaseKeep: 0.5, phaseSize: [4, 7], zipf: 1.45, pClose: 0.05, revisit: 0.35, loop: null,
    },
    shopper: {
      name: 'Shopper', seed: 37, n: 1200, meanGap: 16,
      blurb: 'Comparison shopping. Many new listings, short attention, weak reuse.',
      anchors: ['Cart', 'Price tracker'],
      labels: ['Listing', 'Review', 'Comparison', 'Coupon', 'Video review'],
      pNew: 0.21, pAnchor: 0.07, pPhase: 0.03, phaseKeep: 0.25, phaseSize: [8, 14], zipf: 0.7, pClose: 0.11, revisit: 0.2, loop: null,
    },
    student: {
      name: 'Student', seed: 51, n: 1200, meanGap: 21,
      blurb: 'Exam prep. Cycles the same lecture, notes and problem tabs in order. Loops are LRU’s worst case.',
      anchors: ['Lecture video', 'Notes', 'Group chat'],
      labels: ['Slides', 'Textbook ch.', 'Problem set', 'Forum', 'Wiki'],
      pNew: 0.06, pAnchor: 0.12, pPhase: 0.012, phaseKeep: 0.45, phaseSize: [5, 8], zipf: 1.0, pClose: 0.05, revisit: 0.3,
      loop: { p: 0.38, size: [6, 9] },
    },
  };

  function generateTrace(P) {
    const r = mulberry32(P.seed);
    const ri = (a, b) => a + Math.floor(r() * (b - a + 1));
    const labels = [];
    const open = new Set();
    const lastUse = new Map();
    const counts = {};
    const events = [];
    const mk = (label) => { const id = labels.length; labels.push(label); open.add(id); return id; };
    const anchors = P.anchors.map(mk);
    const anchorSet = new Set(anchors);
    const newTab = () => {
      const base = P.labels[Math.floor(r() * P.labels.length)];
      counts[base] = (counts[base] || 0) + 1;
      return mk(base + ' ' + counts[base]);
    };
    let phase = [];
    let loop = [];
    let li = 0;
    const fillPhase = (keep) => {
      const kept = phase.filter((id) => open.has(id) && r() < keep);
      const size = ri(P.phaseSize[0], P.phaseSize[1]);
      while (kept.length < size) {
        const old = [...open].filter((id) => !anchorSet.has(id) && !kept.includes(id) && lastUse.has(id));
        if (old.length && r() < P.revisit) kept.push(old[Math.floor(r() * old.length)]);
        else kept.push(newTab());
      }
      phase = kept;
      if (P.loop) {
        const n = ri(P.loop.size[0], P.loop.size[1]);
        const pool = [anchors[0], anchors[1], ...phase];
        loop = pool.slice(0, n);
        while (loop.length < n) loop.push(newTab());
        li = 0;
      }
    };
    fillPhase(0);
    let t = 0, cur = -1, acts = 0;
    while (acts < P.n) {
      t += -Math.log(1 - r()) * P.meanGap;
      if (r() < 0.008) t += 600 + r() * 1800; // a break
      if (r() < P.pPhase) fillPhase(P.phaseKeep);
      if (r() < P.pClose) {
        const prot = new Set([...phase, ...loop, cur]);
        const cand = [...open].filter((id) => !anchorSet.has(id) && !prot.has(id) && lastUse.has(id))
          .sort((a, b) => lastUse.get(a) - lastUse.get(b));
        if (cand.length) {
          const id = cand[Math.floor(r() * Math.min(5, cand.length))];
          open.delete(id);
          events.push({ t: Math.round(t), type: 'close', tab: id });
        }
      }
      const x = r();
      let id;
      if (x < P.pNew) {
        id = newTab(); phase.push(id);
        if (phase.length > P.phaseSize[1] + 3) {
          phase.sort((a, b) => (lastUse.get(b) ?? 1e9) - (lastUse.get(a) ?? 1e9));
          phase.pop();
        }
      } else if (x < P.pNew + P.pAnchor) {
        const w = anchors.map((_, i) => 1 / (i + 1));
        let s = r() * w.reduce((a, b) => a + b), j = 0;
        while (s > w[j]) { s -= w[j]; j++; }
        id = anchors[j];
      } else if (P.loop && x < P.pNew + P.pAnchor + P.loop.p) {
        id = loop[li++ % loop.length];
      } else {
        const ranked = phase.filter((p) => p !== cur && open.has(p))
          .sort((a, b) => (lastUse.get(b) ?? -1) - (lastUse.get(a) ?? -1));
        if (!ranked.length) continue;
        const w = ranked.map((_, i) => Math.pow(i + 1, -P.zipf));
        let s = r() * w.reduce((a, b) => a + b), j = 0;
        while (j < w.length - 1 && s > w[j]) { s -= w[j]; j++; }
        id = ranked[j];
      }
      if (id === cur || !open.has(id)) continue;
      events.push({ t: Math.round(t), type: 'activate', tab: id });
      lastUse.set(id, acts);
      cur = id; acts++;
    }
    return { name: P.name, events, labels };
  }

  /* ---------- Normalise any trace into reference-string form ---------- */
  function prepare(name, events, labels) {
    const idMap = new Map();
    const names = [];
    const named = [];
    const idOf = (raw, label) => {
      const key = String(raw);
      if (!idMap.has(key)) {
        idMap.set(key, names.length);
        const given = label || (labels && labels[raw]);
        names.push(given || 'Tab ' + (names.length + 1));
        named.push(!!given);
      }
      const id = idMap.get(key);
      // A 'create' event carries no label; take the first label seen later.
      if (label && !named[id]) { names[id] = label; named[id] = true; }
      return id;
    };
    const refs = [], times = [], closeAt = [], openN = [];
    const open = new Set();
    let pending = [];
    for (const e of events) {
      if (e == null || e.tab == null) continue;
      const id = idOf(e.tab, e.label);
      if (e.type === 'close' || e.type === 'removed') {
        if (open.has(id)) { open.delete(id); pending.push(id); }
      } else if (e.type === 'activate' || e.type === 'activated' || e.type === undefined) {
        if (refs.length && refs[refs.length - 1] === id) continue;
        closeAt[refs.length] = pending.length ? pending : null;
        pending = [];
        open.add(id);
        refs.push(id);
        times.push(typeof e.t === 'number' ? e.t : refs.length * 20);
        openN.push(open.size);
      }
    }
    const N = refs.length;
    const next = new Float64Array(N);
    const seenAt = new Map();
    for (let i = N - 1; i >= 0; i--) {
      next[i] = seenAt.has(refs[i]) ? seenAt.get(refs[i]) : Infinity;
      seenAt.set(refs[i], i);
    }
    let maxOpen = 0;
    for (const v of openN) if (v > maxOpen) maxOpen = v;
    const t0 = times[0] || 0;
    const hours = Math.max((times[N - 1] - t0) / 3600, 1 / 60);
    return { name, refs, times, closeAt, openN, next, names, N, maxOpen, K: Math.max(3, Math.min(32, maxOpen)), hours, t0 };
  }

  /* ---------- Fixed-allocation pager ---------- */
  const ALGO_IDS = ['opt', 'lru', 'clock', 'lfu', 'fifo', 'rand'];

  class Pager {
    constructor(D, k, algo, seed) {
      this.D = D; this.k = k; this.algo = algo;
      this.slots = new Int32Array(k).fill(-1);
      this.where = new Map();
      this.loadT = new Float64Array(k);
      this.last = new Float64Array(k);
      this.nextAt = new Float64Array(k);
      this.ref = new Uint8Array(k);
      this.hand = 0;
      this.freq = new Map();
      this.seen = new Set();
      this.rng = mulberry32(seed || 7);
      this.i = 0; this.faults = 0; this.comp = 0; this.hits = 0; this.resSum = 0;
    }
    step() {
      const D = this.D, i = this.i;
      const cl = D.closeAt[i];
      if (cl) for (const c of cl) {
        const s = this.where.get(c);
        if (s !== undefined) { this.slots[s] = -1; this.where.delete(c); }
      }
      const tab = D.refs[i];
      this.freq.set(tab, (this.freq.get(tab) || 0) + 1);
      let s = this.where.get(tab), kind = 0, ev = -1;
      if (s !== undefined) {
        this.hits++;
      } else {
        if (this.seen.has(tab)) { kind = 1; this.faults++; } else { kind = 2; this.comp++; }
        s = this.slots.indexOf(-1);
        if (s < 0) {
          s = this.victim();
          ev = this.slots[s];
          this.where.delete(ev);
          if (this.algo === 'clock') this.hand = (s + 1) % this.k;
        }
        this.slots[s] = tab; this.where.set(tab, s); this.loadT[s] = i;
      }
      this.seen.add(tab);
      this.last[s] = i; this.ref[s] = 1; this.nextAt[s] = D.next[i];
      this.resSum += this.where.size;
      this.i++;
      return { i, tab, kind, slot: s, ev };
    }
    victim() {
      const k = this.k;
      let b = 0;
      switch (this.algo) {
        case 'fifo': for (let j = 1; j < k; j++) if (this.loadT[j] < this.loadT[b]) b = j; return b;
        case 'lru': for (let j = 1; j < k; j++) if (this.last[j] < this.last[b]) b = j; return b;
        case 'lfu': {
          let bf = this.freq.get(this.slots[0]);
          for (let j = 1; j < k; j++) {
            const f = this.freq.get(this.slots[j]);
            if (f < bf || (f === bf && this.last[j] < this.last[b])) { b = j; bf = f; }
          }
          return b;
        }
        case 'opt':
          for (let j = 1; j < k; j++) {
            if (this.nextAt[j] > this.nextAt[b] || (this.nextAt[j] === this.nextAt[b] && this.last[j] < this.last[b])) b = j;
          }
          return b;
        case 'rand': return Math.floor(this.rng() * k);
        case 'clock':
          while (this.ref[this.hand]) { this.ref[this.hand] = 0; this.hand = (this.hand + 1) % k; }
          return this.hand;
      }
      return 0;
    }
  }

  function simulate(D, k, algo) {
    const p = new Pager(D, k, algo);
    for (let i = 0; i < D.N; i++) p.step();
    return { faults: p.faults, comp: p.comp, hits: p.hits, hp: (p.faults / D.N) * 100, res: p.resSum / D.N };
  }

  function record(D, k, algo) {
    const p = new Pager(D, k, algo);
    const frames = new Int32Array(D.N * k);
    const kind = new Uint8Array(D.N), slot = new Int16Array(D.N), ev = new Int32Array(D.N);
    for (let i = 0; i < D.N; i++) {
      const r = p.step();
      frames.set(p.slots, i * k);
      kind[i] = r.kind; slot[i] = r.slot; ev[i] = r.ev;
    }
    return { k, algo, frames, kind, slot, ev, faults: p.faults };
  }

  /* ---------- Variable allocation: Denning's working set ---------- */
  function workingSet(D, delta, keepSeries) {
    const cnt = new Map(), last = new Map(), closed = new Set();
    let distinct = 0, faults = 0, sum = 0;
    const W = keepSeries ? new Uint16Array(D.N) : null;
    for (let i = 0; i < D.N; i++) {
      const cl = D.closeAt[i];
      if (cl) for (const c of cl) { closed.add(c); if ((cnt.get(c) || 0) > 0) distinct--; }
      const tab = D.refs[i];
      if (last.has(tab) && i - last.get(tab) > delta) faults++;
      last.set(tab, i);
      const c0 = cnt.get(tab) || 0;
      if (c0 === 0) distinct++;
      cnt.set(tab, c0 + 1);
      if (i - delta >= 0) {
        const old = D.refs[i - delta];
        const c1 = cnt.get(old) - 1;
        cnt.set(old, c1);
        if (c1 === 0 && !closed.has(old)) distinct--;
      }
      sum += distinct;
      if (W) W[i] = distinct;
    }
    return { delta, faults, hp: (faults / D.N) * 100, meanW: sum / D.N, W };
  }

  /* ---------- LRU stack distance (Mattson) ---------- */
  function stackDistances(D) {
    const stack = [];
    const dist = new Float64Array(D.N);
    for (let i = 0; i < D.N; i++) {
      const cl = D.closeAt[i];
      if (cl) for (const c of cl) { const j = stack.indexOf(c); if (j >= 0) stack.splice(j, 1); }
      const tab = D.refs[i];
      const j = stack.indexOf(tab);
      dist[i] = j < 0 ? Infinity : j + 1;
      if (j >= 0) stack.splice(j, 1);
      stack.unshift(tab);
    }
    return dist;
  }

  function knee(ys, k0) {
    // Kneedle on a decreasing curve: farthest point below the chord.
    const n = ys.length;
    if (n < 3) return k0;
    let mn = Infinity, mx = -Infinity;
    for (const v of ys) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const span = mx - mn || 1;
    let best = 0, bd = -Infinity;
    for (let i = 0; i < n; i++) {
      const xn = i / (n - 1), yn = (ys[i] - mn) / span;
      const d = (1 - xn) - yn;
      if (d > bd) { bd = d; best = i; }
    }
    return best + k0;
  }

  const WS_DELTAS = [2, 3, 4, 5, 6, 8, 10, 13, 16, 20, 25, 32, 40, 50, 65, 80, 100, 130, 160, 200, 260];

  function analyze(D) {
    if (D.A) return D.A;
    const curves = {};
    for (const a of ALGO_IDS) {
      curves[a] = [null];
      for (let k = 1; k <= D.K; k++) curves[a].push(simulate(D, k, a));
    }
    const ws = WS_DELTAS.map((d) => workingSet(D, d, false));
    const dist = stackDistances(D);
    const kneeK = knee(curves.lru.slice(1).map((c) => c.hp), 1);
    const anomalies = {};
    for (const a of ALGO_IDS) {
      let n = 0;
      for (let k = 1; k < D.K; k++) if (curves[a][k + 1].faults > curves[a][k].faults) n++;
      anomalies[a] = n;
    }
    let reuse = 0, near4 = 0;
    for (let i = 0; i < D.N; i++) if (dist[i] !== Infinity) { reuse++; if (dist[i] <= 4) near4++; }
    D.A = { curves, ws, dist, kneeK, anomalies, locality4: reuse ? near4 / reuse : 0, reuse };
    return D.A;
  }

  const api = { mulberry32, PERSONAS, generateTrace, prepare, Pager, simulate, record, workingSet, stackDistances, knee, analyze, ALGO_IDS, WS_DELTAS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
