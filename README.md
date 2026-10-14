# Tab Thrashing

An operating-systems study of browser tab replacement. Tabs are pages, live (non-discarded) tabs are frames,
and switching back to a discarded tab is a **human page fault**. The project replays tab-switch traces through
OPT, LRU, Clock, LFU, FIFO, Random and Denning's working-set model to answer four questions:

1. Does tab use show locality of reference?
2. Which replacement policy predicts the next tab best?
3. Is there a thrashing point, a live-tab count below which reloads explode, and does it differ between people?
4. Does Belady's anomaly appear in real tab behaviour?

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer and Chrome, Edge or Brave. The setup script checks for Node
and offers to install it, shows you where the extension folder is, can add a start-at-login entry, and starts the dashboard.

**Windows**

```bat
git clone https://github.com/shreyasmandem/tab-thrashing.git
cd tab-thrashing
setup.cmd
```

Or download the ZIP from GitHub, unzip it, and double-click `setup.cmd`. Afterwards, `start.cmd` starts the dashboard.

**macOS**

```bash
git clone https://github.com/shreyasmandem/tab-thrashing.git
cd tab-thrashing
./setup.sh
```

Afterwards, `./start.sh` starts the dashboard. If you downloaded the ZIP instead, run `bash setup.sh` the first time.

**Then, once:** open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click
**Load unpacked**, and choose the `extension` folder inside this repo. Browsers do not let scripts install
unpacked extensions, so this step is manual.

Setup options: `-Autostart` / `--autostart` adds start at login without asking, `-RemoveAutostart` /
`--remove-autostart` removes it, and `-NoStart` / `--no-start` sets up without starting the server.

## Live mode (your own browser, on localhost)

1. Start the server with `start.cmd` / `./start.sh`, or `npm start`. It serves http://127.0.0.1:4870.
2. Load the extension as above.
3. Use your browser. The dashboard shows, live:
   - your open tabs ordered as an LRU stack, with the line at the live-tab budget k and the browser's real discards;
   - an event log of every switch, tagged hit / miss under LRU and **reloaded** when you opened a tab the browser had discarded;
   - system memory and the browser's working set (sampled from the OS every 5 s);
   - refault curves for every policy replayed on your own switches, with your browser's measured reload rate plotted against them.

Events are stored in `live/data/events.jsonl` and never leave the machine. The server binds to 127.0.0.1 and
rejects writes from other websites. **Export trace** downloads a hashed copy for sharing.

Limits: browsers only discard tabs under memory pressure (or with Memory Saver / Sleeping Tabs on), so real reloads
are rare at first; the extension's popup can enforce an LRU or Clock budget to generate them. Extensions cannot read
per-tab memory, so memory figures are for the whole browser. On macOS, "system memory in use" counts file cache as used.
If the extension's popup says "Server offline", start the server; events queue in the browser until it is back.

## Layout

| Path | What it is |
|---|---|
| `lab/core.js` | Simulation core: persona generator, trace normaliser, pager (6 policies), working set, LRU stack distance, knee detection |
| `lab/index.html` | Interactive lab (dashboard). Loads `core.js` |
| `lab/build.js` | `node lab/build.js` inlines the core into `lab/dist/tab-thrashing.html`, a single shareable file |
| `live/server.js` | Zero-dependency local server: receives extension events, samples OS memory, streams to the dashboard |
| `live/public/` | Live dashboard (`index.html`, `app.js`) served at http://127.0.0.1:4870 |
| `extension/` | Manifest V3 Chrome/Edge extension that streams tab events to the server and can enforce a live LRU or Clock discard policy |
| `sim/sim.py` | Independent Python port of the simulator for batch analysis and CSV output |
| `sim/crosscheck.js` | Exports the synthetic traces to `sim/samples/` and verifies Python and JS agree on every fault count |

## Collecting data for the study

Run live mode for a few days, then click **Export trace**. Load the file into the lab with **Load trace**, or run
`python sim/sim.py tab-trace-YYYY-MM-DD.json --csv curves.csv`. Exports hash hostnames with a fresh salt; titles and URLs are never stored.

Experiment mode: in the extension popup set **Discard policy** to LRU or Clock and choose a budget k. The extension then keeps at most k tabs alive.
`faulted: true` events measure the real reload rate under that policy, which can be compared with the simulator's prediction.

## Definitions

- **Refault rate**: reloads of previously seen tabs per 100 tab switches. First visits are compulsory misses and are excluded.
- **Thrashing point**: knee of the LRU refault curve (Kneedle: the point farthest below the chord from k = 1 to k = 32).
- **Working set W(t, Δ)**: distinct open tabs touched in the last Δ switches.

## Validation

- LRU hit counts equal Mattson stack-distance counts on every trace (an exact identity for stack algorithms).
- `node sim/crosscheck.js`: the Python port matches the JS core on all 852 curve points across the four personas.
- FIFO on 1 2 3 4 1 2 5 1 2 3 4 5 gives 9 faults with 3 frames and 10 with 4 (Belady's anomaly).

The four personas (Researcher, Developer, Shopper, Student) are **synthetic**, seeded locality models used to
demonstrate the method. Findings must be re-run on real traces from volunteers before they are reported.
