// Exports the four synthetic persona traces to sim/samples/ and checks that the
// Python port (sim.py) reproduces the JavaScript core's fault counts exactly.
//   node crosscheck.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../lab/core.js');

const os = require('os');
const dir = path.join(__dirname, 'samples');
fs.mkdirSync(dir, { recursive: true });
// Python runs from a temp copy: the Microsoft Store build of Python cannot read some AppData folders.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-thrashing-'));
fs.copyFileSync(path.join(__dirname, 'sim.py'), path.join(stage, 'sim.py'));
let mismatches = 0;

for (const [id, P] of Object.entries(T.PERSONAS)) {
  const tr = T.generateTrace(P);
  const events = tr.events.map((e) => (e.type === 'activate' ? { ...e, label: tr.labels[e.tab] } : e));
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: 'tab-thrashing/v1', name: P.name, synthetic: true, events }));

  const D = T.prepare(P.name, events, null);
  const A = T.analyze(D);
  const sIn = path.join(stage, `${id}.json`), sOut = path.join(stage, `${id}.result.json`);
  fs.copyFileSync(file, sIn);
  execFileSync('python', [path.join(stage, 'sim.py'), sIn, '--json', sOut], { stdio: 'pipe' });
  fs.copyFileSync(sOut, path.join(dir, `${id}.result.json`));
  const py = JSON.parse(fs.readFileSync(sOut, 'utf8'));

  let bad = 0;
  for (const a of T.ALGO_IDS) {
    for (let k = 1; k <= D.K; k++) if (A.curves[a][k].faults !== py.curves[a][k - 1]) bad++;
  }
  for (let i = 0; i < T.WS_DELTAS.length; i++) if (A.ws[i].faults !== py.ws[i].faults) bad++;
  if (A.kneeK !== py.knee) bad++;
  mismatches += bad;
  console.log(`${P.name.padEnd(11)} ${D.N} switches  knee JS=${A.kneeK} PY=${py.knee}  ${T.ALGO_IDS.length * D.K + T.WS_DELTAS.length} curve points  ${bad ? bad + ' MISMATCHES' : 'identical'}`);
}
console.log(mismatches ? `\nFAILED: ${mismatches} mismatches` : '\nJS core and Python port agree on every fault count.');
process.exit(mismatches ? 1 : 0);
