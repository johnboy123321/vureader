// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  ACCUMULATOR BACKTEST — the question the whole spot strategy rests on
//
//  Does "sell a slice after a pump, buy it back lower" end up holding MORE BTC than holding BTC?
//
//  Runs the LIVE accumStep out of cipher-agent-valtown.js — not a re-implementation — over the
//  repo's own daily BTC data, one closed bar at a time, exactly as the agent sees it. Also runs
//  accumFillPass so intraday rung fills are handled the way the bot handles them.
//
//  The number that matters is UNITS, marked with resting cash converted back to coins at the
//  final price. Dollars are not the objective and are not reported as if they were.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = fs.readFileSync('cipher-agent-valtown.js', 'utf8');
const out = path.join(process.cwd(), '.accum-backtest.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { accumStep, accumFillPass, accumLevels, waveTrend, vmcMoneyFlow };\n');
const M = await import(pathToFileURL(out).href);

const raw = JSON.parse(fs.readFileSync('bt/BTC.json', 'utf8'));
const bars = raw.tfs['1D'].map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const day = t => new Date(t).toISOString().slice(0, 10);

function run(cfg, label) {
  let state = { units: 1, cash: 0, open: [], sells: 0, fills: 0, lastDay: null,
                startedAt: null, lastFillT: 0, startUnits: 1, coreUnits: null, highWater: null };
  const events = [];
  // Warm up the indicators before acting — accumStep needs 60 bars of history.
  for (let i = 60; i < bars.length; i++) {
    const hist = bars.slice(0, i + 1);
    // Intraday fill pass first, the same order as the live run: rungs resting from yesterday can
    // be hit by today's bar before today's trigger is considered.
    const f = M.accumFillPass(state, [bars[i]], cfg);
    state = f.st;
    for (const e of f.events) events.push({ ...e, day: day(bars[i].t) });
    const r = M.accumStep(state, hist, cfg);
    state = r.st;
    for (const e of r.events) events.push({ ...e, day: day(bars[i].t) });
  }
  const last = bars[bars.length - 1].c;
  const unitsTotal = state.units + (state.cash || 0) / last;
  const sells = events.filter(e => e.kind === 'sell').length;
  const fills = events.filter(e => e.kind === 'fill').length;
  const stranded = state.open.length;
  const strandedCash = state.open.reduce((s, r) => s + r.usdt, 0);
  return { label, unitsTotal, vsHold: unitsTotal - 1, sells, fills, stranded, strandedCash,
           cash: state.cash, units: state.units, events };
}

const from = day(bars[60].t), to = day(bars[bars.length - 1].t);
console.log(`\n  BTC daily · ${from} → ${to} · ${bars.length - 60} bars acted on · start 1.00000000 BTC\n`);

const runs = [
  ['pump1  + MF gate  (LIVE CONFIG)', { trigger: 'pump1',   mfGate: true  }],
  ['pump1  no gate',                  { trigger: 'pump1',   mfGate: false }],
  ['pump2  + MF gate',                { trigger: 'pump2',   mfGate: true  }],
  ['pump3  + MF gate',                { trigger: 'pump3',   mfGate: true  }],
  ['pump5  + MF gate',                { trigger: 'pump5',   mfGate: true  }],
  ['reddot + MF gate',                { trigger: 'reddot',  mfGate: true  }],
];

const results = [];
for (const [label, cfg] of runs) results.push(run({ ...cfg, feeBps: 10, corePct: 0 }, label));

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n, d = 6) => String(v.toFixed(d)).padStart(n);
console.log('  ' + pad('config', 34) + 'end units'.padStart(12) + 'vs hold'.padStart(10)
          + 'sells'.padStart(7) + 'fills'.padStart(7) + 'stranded'.padStart(10) + '  cash left');
console.log('  ' + '─'.repeat(96));
for (const r of results) {
  console.log('  ' + pad(r.label, 34) + num(r.unitsTotal, 12) + (((r.vsHold) * 100).toFixed(2) + '%').padStart(10)
    + String(r.sells).padStart(7) + String(r.fills).padStart(7)
    + String(r.stranded).padStart(10) + '  $' + r.strandedCash.toFixed(0));
}

// The failure mode worth naming: a slice sold that never gets bought back. Its cash is then worth
// ever fewer coins as price runs away. Show it explicitly rather than letting it hide in the total.
const live = results[0];
console.log(`\n  LIVE CONFIG detail — ${live.label}`);
console.log(`    completed round trips : ${live.fills}`);
console.log(`    rungs still resting   : ${live.stranded}  ($${live.strandedCash.toFixed(0)} not in coins)`);
console.log(`    coins held outright   : ${live.units.toFixed(8)}`);
console.log(`    coins if cash bought in at the last price : ${live.unitsTotal.toFixed(8)}`);
console.log(`    verdict               : ${live.vsHold >= 0 ? 'BEATS' : 'LOSES TO'} holding by ${(Math.abs(live.vsHold) * 100).toFixed(2)}%`);

const sellDays = live.events.filter(e => e.kind === 'sell');
if (sellDays.length) {
  console.log(`\n    first 5 sells:`);
  for (const s of sellDays.slice(0, 5)) console.log(`      ${s.day}  ${s.how}  → ${s.rungs.join(', ')}`);
}
const gates = live.events.filter(e => e.kind === 'skip' && /money flow/.test(e.why || ''));
console.log(`\n    times the pump fired but the money-flow gate blocked it: ${gates.length}`);
console.log();
fs.unlinkSync(out);
