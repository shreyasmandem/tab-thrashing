"""Tab Thrashing simulator (Python port).

Replays a tab-switch trace through page-replacement policies and reports refault curves.

    python sim.py trace.json                  # table at the thrashing point
    python sim.py trace.json --csv curves.csv # full curves for plotting
    python sim.py trace.json --json out.json  # machine-readable results (used by the cross-check)

A trace is {"events": [{"t": seconds, "type": "activate" | "close", "tab": id, "label": str}, ...]}.
Each activation is a memory reference; a tab is a page; a live tab is a frame.
First visits are compulsory misses and are excluded from the refault rate.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
from dataclasses import dataclass, field

POLICIES = ["opt", "lru", "clock", "lfu", "fifo", "rand"]
WS_DELTAS = [2, 3, 4, 5, 6, 8, 10, 13, 16, 20, 25, 32, 40, 50, 65, 80, 100, 130, 160, 200, 260]
INF = math.inf


@dataclass
class Trace:
    name: str
    refs: list[int] = field(default_factory=list)
    times: list[float] = field(default_factory=list)
    close_at: dict[int, list[int]] = field(default_factory=dict)
    open_n: list[int] = field(default_factory=list)
    nxt: list[float] = field(default_factory=list)
    names: list[str] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.refs)

    @property
    def max_frames(self) -> int:
        return max(3, min(32, max(self.open_n, default=3)))


def prepare(name: str, events: list[dict]) -> Trace:
    tr = Trace(name)
    ids: dict[str, int] = {}
    open_tabs: set[int] = set()
    pending: list[int] = []

    named: list[bool] = []

    def id_of(raw, label):
        key = str(raw)
        if key not in ids:
            ids[key] = len(tr.names)
            tr.names.append(label or f"Tab {len(tr.names) + 1}")
            named.append(bool(label))
        tid = ids[key]
        # A 'create' event carries no label; take the first label seen later.
        if label and not named[tid]:
            tr.names[tid] = label
            named[tid] = True
        return tid

    for e in events:
        if e is None or e.get("tab") is None:
            continue
        tid = id_of(e["tab"], e.get("label"))
        kind = e.get("type", "activate")
        if kind in ("close", "removed"):
            if tid in open_tabs:
                open_tabs.discard(tid)
                pending.append(tid)
        elif kind in ("activate", "activated"):
            if tr.refs and tr.refs[-1] == tid:
                continue
            if pending:
                tr.close_at[len(tr.refs)] = pending
            pending = []
            open_tabs.add(tid)
            tr.refs.append(tid)
            tr.times.append(e.get("t", len(tr.refs) * 20))
            tr.open_n.append(len(open_tabs))

    seen: dict[int, int] = {}
    tr.nxt = [INF] * tr.n
    for i in range(tr.n - 1, -1, -1):
        tr.nxt[i] = seen.get(tr.refs[i], INF)
        seen[tr.refs[i]] = i
    return tr


def mulberry32(a: int):
    """Same PRNG as the JavaScript core, so Random eviction matches bit for bit."""
    state = [a & 0xFFFFFFFF]

    def imul(x, y):
        return ((x & 0xFFFFFFFF) * (y & 0xFFFFFFFF)) & 0xFFFFFFFF

    def rnd():
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        a0 = state[0]
        t = imul(a0 ^ (a0 >> 15), 1 | a0)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rnd


def simulate(tr: Trace, k: int, policy: str) -> dict:
    slots = [-1] * k
    where: dict[int, int] = {}
    load_t = [0.0] * k
    last = [0.0] * k
    next_at = [0.0] * k
    ref = [0] * k
    freq: dict[int, int] = {}
    seen: set[int] = set()
    rng = mulberry32(7)
    hand = 0
    faults = comp = hits = 0
    res_sum = 0

    for i, tab in enumerate(tr.refs):
        for c in tr.close_at.get(i, ()):
            s = where.pop(c, None)
            if s is not None:
                slots[s] = -1
        freq[tab] = freq.get(tab, 0) + 1
        s = where.get(tab)
        if s is not None:
            hits += 1
        else:
            if tab in seen:
                faults += 1
            else:
                comp += 1
            s = slots.index(-1) if -1 in slots else None
            if s is None:
                if policy == "fifo":
                    s = min(range(k), key=lambda j: (load_t[j], j))
                elif policy == "lru":
                    s = min(range(k), key=lambda j: (last[j], j))
                elif policy == "lfu":
                    s = min(range(k), key=lambda j: (freq[slots[j]], last[j], j))
                elif policy == "opt":
                    s = min(range(k), key=lambda j: (-next_at[j], last[j], j))
                elif policy == "rand":
                    s = int(rng() * k)
                elif policy == "clock":
                    while ref[hand]:
                        ref[hand] = 0
                        hand = (hand + 1) % k
                    s = hand
                del where[slots[s]]
                if policy == "clock":
                    hand = (s + 1) % k
            slots[s] = tab
            where[tab] = s
            load_t[s] = i
        seen.add(tab)
        last[s] = i
        ref[s] = 1
        next_at[s] = tr.nxt[i]
        res_sum += len(where)

    return {"faults": faults, "comp": comp, "hits": hits, "hp": faults / tr.n * 100, "res": res_sum / tr.n}


def working_set(tr: Trace, delta: int) -> dict:
    cnt: dict[int, int] = {}
    last: dict[int, int] = {}
    closed: set[int] = set()
    distinct = faults = total = 0
    for i, tab in enumerate(tr.refs):
        for c in tr.close_at.get(i, ()):
            closed.add(c)
            if cnt.get(c, 0) > 0:
                distinct -= 1
        if tab in last and i - last[tab] > delta:
            faults += 1
        last[tab] = i
        if cnt.get(tab, 0) == 0:
            distinct += 1
        cnt[tab] = cnt.get(tab, 0) + 1
        if i - delta >= 0:
            old = tr.refs[i - delta]
            cnt[old] -= 1
            if cnt[old] == 0 and old not in closed:
                distinct -= 1
        total += distinct
    return {"delta": delta, "faults": faults, "hp": faults / tr.n * 100, "meanW": total / tr.n}


def knee(ys: list[float], k0: int = 1) -> int:
    """Kneedle on a decreasing curve: the farthest point below the chord."""
    lo, hi = min(ys), max(ys)
    span = (hi - lo) or 1
    n = len(ys)
    best = max(range(n), key=lambda i: ((1 - i / (n - 1)) - (ys[i] - lo) / span, -i))
    return best + k0


def analyze(tr: Trace) -> dict:
    curves = {p: [simulate(tr, k, p) for k in range(1, tr.max_frames + 1)] for p in POLICIES}
    kk = knee([c["hp"] for c in curves["lru"]])
    anomalies = {p: sum(1 for k in range(len(cs) - 1) if cs[k + 1]["faults"] > cs[k]["faults"]) for p, cs in curves.items()}
    return {
        "name": tr.name,
        "switches": tr.n,
        "tabs": len(tr.names),
        "K": tr.max_frames,
        "knee": kk,
        "curves": {p: [c["faults"] for c in cs] for p, cs in curves.items()},
        "hp_at_knee": {p: round(curves[p][kk - 1]["hp"], 4) for p in POLICIES},
        "anomalies": anomalies,
        "ws": [working_set(tr, d) for d in WS_DELTAS],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trace")
    ap.add_argument("--csv", help="write refault curves (k x policy) to this CSV")
    ap.add_argument("--json", help="write full results to this JSON file")
    args = ap.parse_args(argv)

    with open(args.trace, encoding="utf-8") as f:
        data = json.load(f)
    events = data if isinstance(data, list) else data["events"]
    tr = prepare(data.get("name", args.trace) if isinstance(data, dict) else args.trace, events)
    if tr.n < 30:
        print(f"Only {tr.n} tab switches in {args.trace}; at least 30 are needed.", file=sys.stderr)
        return 1
    res = analyze(tr)

    print(f"{res['name']}: {tr.n} switches, {len(tr.names)} tabs, frames 1..{res['K']}")
    print(f"Thrashing point (LRU knee): k = {res['knee']}\n")
    print(f"{'policy':<8}{'refaults/100':>14}{'x OPT':>8}{'anomalies':>11}")
    opt = max(res["hp_at_knee"]["opt"], 0.05)
    for p in sorted(POLICIES, key=lambda p: res["hp_at_knee"][p]):
        v = res["hp_at_knee"][p]
        print(f"{p:<8}{v:>14.2f}{v / opt:>8.1f}{res['anomalies'][p]:>11}")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["k"] + [f"{p}_refaults_per_100" for p in POLICIES])
            for i in range(res["K"]):
                w.writerow([i + 1] + [round(res["curves"][p][i] / tr.n * 100, 4) for p in POLICIES])
        print(f"\nwrote {args.csv}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1)
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
