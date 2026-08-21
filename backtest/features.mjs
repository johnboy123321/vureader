// WHERE TO LOOK FOR BETTER SETUPS — asked of John's own 3,229 trades.
//
// The features below were chosen BEFORE any of them was scored, and every one is computable at
// the moment of the decision from bars that had already closed. Each is bucketed, and each bucket
// must hold its sign in BOTH halves of the sample to count — the test the regime idea failed.
import fs from 'node:fs';
import { loadCoin, listCoins, closedBy, TF_MS } from './lib/data.mjs';
import { loadRules } from './lib/rules.mjs';
import { ci95 } from './lib/report.mjs';

const { M } = await loadRules();
const T = JSON.parse(fs.readFileSync('trades.json', 'utf8'));
const coins = new Map();
for (const c of listCoins()) coins.set(c, loadCoin(c));

const sma = (a, n) => { let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; };

let done = 0;
for (const t of T) {
  const d = coins.get(t.coin); if (!d) continue;
  const tf = d.tfs[t.tf] ? t.tf : '1D';
  const n = closedBy(d.tfs[tf], tf, t.placedAt);
  const bars = d.tfs[tf].slice(Math.max(0, n - 260), n);
  if (bars.length < 210) continue;
  const closes = bars.map(b => b.c), px = closes[closes.length - 1];
  const atr = M.atrArr(bars, 14), a = atr[atr.length - 1];
  const rsi = M.rsiArr(bars);
  const e200 = M.emaArr(closes, 200), e50 = M.emaArr(closes, 50);
  const vols = bars.map(b => b.v), v20 = sma(vols, 20);
  const hi30 = Math.max(...bars.slice(-30).map(b => b.h));
  const lo30 = Math.min(...bars.slice(-30).map(b => b.l));
  const atrPast = atr.slice(-60, -20).filter(Number.isFinite);
  const atrMed = atrPast.length ? atrPast.slice().sort((x, y) => x - y)[Math.floor(atrPast.length / 2)] : a;
  // daily trend, whatever timeframe the signal came from
  const dn = closedBy(d.tfs['1D'], '1D', t.placedAt);
  const dBars = d.tfs['1D'].slice(Math.max(0, dn - 260), dn);
  const dUp = dBars.length > 50 ? dBars[dBars.length - 1].c > M.emaArr(dBars.map(b => b.c), 50)[dBars.length - 1] : null;

  t.f = {
    atrPct: (a / px) * 100,                                     // how wild is this coin right now
    volExpansion: atrMed ? a / atrMed : 1,                      // is volatility rising or falling
    extension: ((px - e200[e200.length - 1]) / e200[e200.length - 1]) * 100 * (t.dir === 'short' ? -1 : 1),
    rsi: rsi[rsi.length - 1],
    volRatio: v20 ? bars[bars.length - 1].v / v20 : 1,          // volume on the signal bar
    rangePos: (hi30 - lo30) ? (px - lo30) / (hi30 - lo30) : 0.5, // where in the last 30 bars' range
    withDaily: dUp === null ? null : ((t.dir === 'long') === dUp),
    stopAtr: a ? Math.abs(t.fill - t.sl) / a : null,            // stop width in ATR, not %
    hourUTC: new Date(t.placedAt).getUTCHours(),
    aboveE50: px > e50[e50.length - 1] === (t.dir === 'long'),
  };
  done++;
}
console.log(`features computed for ${done} of ${T.length} trades\n`);

const sorted = [...T].filter(t => t.f).sort((a, b) => a.exitAt - b.exitAt);
const mid = sorted[Math.floor(sorted.length / 2)].exitAt;
const money = s => s.map(t => t.netGbp);

function report(name, bucketer) {
  const g = new Map();
  for (const t of sorted) { const k = bucketer(t); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
  const rows = [...g].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const lines = [], survivors = [];
  for (const [k, s] of rows) {
    if (s.length < 120) { lines.push(`    ${String(k).padEnd(16)} n=${String(s.length).padStart(4)}   (too few)`); continue; }
    const c = ci95(money(s));
    const h1 = ci95(money(s.filter(t => t.exitAt < mid))), h2 = ci95(money(s.filter(t => t.exitAt >= mid)));
    const agree = h1.n >= 40 && h2.n >= 40 && (h1.m > 0) === (h2.m > 0);
    lines.push(`    ${String(k).padEnd(16)} n=${String(s.length).padStart(4)}  £${c.m.toFixed(2).padStart(6)}  [${c.lo.toFixed(2)}, ${c.hi.toFixed(2)}]   halves ${h1.m.toFixed(2)} / ${h2.m.toFixed(2)}  ${agree ? '✓ same sign' : '✗ flips'}`);
    if (agree && c.m > 0 && c.lo > -0.15) survivors.push({ name, k, m: c.m, n: s.length, h1: h1.m, h2: h2.m });
  }
  console.log('  ' + name);
  console.log(lines.join('\n'));
  console.log();
  return survivors;
}

const band = (v, edges) => { if (v == null || !Number.isFinite(v)) return null;
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return `${String.fromCharCode(97+i)}. <${edges[i]}`;
  return `${String.fromCharCode(97+edges.length)}. >=${edges[edges.length-1]}`; };

const all = [];
all.push(...report('volatility (ATR as % of price)', t => band(t.f.atrPct, [2, 3.5, 5])));
all.push(...report('volatility expanding or calming', t => band(t.f.volExpansion, [0.8, 1.0, 1.3])));
all.push(...report('extension from the 200 EMA (%, signed with the trade)', t => band(t.f.extension, [-10, 0, 10, 25])));
all.push(...report('RSI at entry', t => band(t.f.rsi, [35, 45, 55, 65])));
all.push(...report('volume on the signal bar (x 20-bar average)', t => band(t.f.volRatio, [0.8, 1.2, 2])));
all.push(...report('position in the last 30 bars range', t => band(t.f.rangePos, [0.25, 0.5, 0.75])));
all.push(...report('does the DAILY trend agree?', t => t.f.withDaily == null ? null : (t.f.withDaily ? 'with daily' : 'against')));
all.push(...report('stop width in ATR', t => band(t.f.stopAtr, [1, 1.75, 2.5])));
all.push(...report('price on the right side of the 50 EMA', t => t.f.aboveE50 ? 'with 50EMA' : 'against'));
all.push(...report('hour of day (UTC)', t => band(t.f.hourUTC, [6, 12, 18])));

console.log('═'.repeat(78));
console.log('BUCKETS THAT ARE POSITIVE AND KEEP THEIR SIGN IN BOTH HALVES:\n');
if (!all.length) console.log('  none.');
for (const s of all) console.log(`  ${s.name}  →  ${s.k}   £${s.m.toFixed(2)}/trade over ${s.n}   (${s.h1.toFixed(2)} then ${s.h2.toFixed(2)})`);
console.log(`\n  ~34 buckets were tested. At a 1-in-20 false-positive rate you would expect about`);
console.log(`  1-2 to pass by chance alone, so treat anything here as a lead, not a finding.`);
fs.writeFileSync('trades-featured.json', JSON.stringify(T));
