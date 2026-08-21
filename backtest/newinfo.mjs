// Is there room in the SIGNAL? Two information sources the system has never used — neither of
// them another price oscillator computed from the same candles it already reads.
//
//   1. FUNDING RATE — what the crowd is paying to hold its positions. Positioning, not price.
//      Three years of it is already sitting in the data files, unused except as a cost.
//   2. RELATIVE STRENGTH — where this coin ranks against the other 24 right now. The system
//      looks at every coin in isolation and has no idea whether it is the strongest or weakest
//      thing on the board.
//
// Same discipline as before: buckets fixed in advance, and a bucket only counts if it keeps its
// sign in BOTH halves of the sample.
import fs from 'node:fs';
import { loadCoin, listCoins, closedBy } from './lib/data.mjs';
import { ci95 } from './lib/report.mjs';

const T = JSON.parse(fs.readFileSync('trades-featured.json','utf8')).filter(t=>t.f);
const coins = new Map();
for (const c of listCoins()) coins.set(c, loadCoin(c));

// 7-day return for every coin, on a daily grid, so a trade can be ranked against its peers
const retGrid = new Map();
for (const [name, d] of coins) {
  const bars = d.tfs['1D'], m = new Map();
  for (let i = 7; i < bars.length; i++) m.set(bars[i].t, bars[i].c / bars[i-7].c - 1);
  retGrid.set(name, m);
}
const dayKeys = [...retGrid.get('BTC').keys()].sort((a,b)=>a-b);
const dayOf = (ts) => { let lo=0, hi=dayKeys.length-1, best=dayKeys[0];
  while (lo<=hi) { const m=(lo+hi)>>1; if (dayKeys[m]<=ts) { best=dayKeys[m]; lo=m+1; } else hi=m-1; } return best; };

for (const t of T) {
  const d = coins.get(t.coin); if (!d) continue;
  // funding actually paid over the 3 days before the decision, annualised as a %
  const from = t.placedAt - 3*864e5;
  const f = d.funding.filter(x => x.t > from && x.t <= t.placedAt);
  t.g = {};
  if (f.length >= 6) {
    const mean = f.reduce((a,x)=>a+x.rate,0)/f.length;
    t.g.fundAnnPct = mean * 3 * 365 * 100;
    // signed with the trade: positive = the crowd is paying to be on YOUR side (crowded with you)
    t.g.fundWith = t.g.fundAnnPct * (t.dir === 'long' ? 1 : -1);
  }
  const dk = dayOf(t.placedAt);
  const rows = [];
  for (const [name, m] of retGrid) { const r = m.get(dk); if (Number.isFinite(r)) rows.push([name, r]); }
  if (rows.length >= 15) {
    rows.sort((a,b)=>b[1]-a[1]);
    const idx = rows.findIndex(r => r[0] === t.coin);
    if (idx >= 0) {
      t.g.rank = idx / (rows.length - 1);                       // 0 = strongest, 1 = weakest
      t.g.rankWith = t.dir === 'long' ? 1 - t.g.rank : t.g.rank; // 1 = trading the leader in your direction
    }
  }
}

const sorted=[...T].sort((a,b)=>a.exitAt-b.exitAt), mid=sorted[Math.floor(sorted.length/2)].exitAt;
function report(name, bucketer) {
  const g=new Map();
  for (const t of sorted) { const k=bucketer(t); if(k==null) continue; if(!g.has(k)) g.set(k,[]); g.get(k).push(t); }
  console.log('  ' + name);
  for (const [k,s] of [...g].sort((a,b)=>String(a[0]).localeCompare(String(b[0])))) {
    if (s.length < 120) { console.log(`    ${String(k).padEnd(18)} n=${String(s.length).padStart(4)}   (too few)`); continue; }
    const c=ci95(s.map(t=>t.netGbp));
    const h1=ci95(s.filter(t=>t.exitAt<mid).map(t=>t.netGbp)), h2=ci95(s.filter(t=>t.exitAt>=mid).map(t=>t.netGbp));
    const gross=s.reduce((a,t)=>a+t.grossGbp,0)/s.length;
    const agree=(h1.m>0)===(h2.m>0);
    console.log(`    ${String(k).padEnd(18)} n=${String(s.length).padStart(4)}  net £${c.m.toFixed(2).padStart(6)}  gross £${gross.toFixed(2).padStart(6)}  [${c.lo.toFixed(2)}, ${c.hi.toFixed(2)}]  halves ${h1.m.toFixed(2)}/${h2.m.toFixed(2)} ${agree?'✓':'✗'}`);
  }
  console.log();
}
const band=(v,e)=>{ if(v==null||!Number.isFinite(v)) return null;
  for(let i=0;i<e.length;i++) if(v<e[i]) return `${String.fromCharCode(97+i)}. <${e[i]}`;
  return `${String.fromCharCode(97+e.length)}. >=${e[e.length-1]}`; };

console.log('\n1. FUNDING — is the crowd already on your side? (annualised %, signed with the trade)\n');
report('crowded WITH you  →  against you', t => band(t.g.fundWith, [-10, 0, 10, 25]));
console.log('2. FUNDING — raw level, regardless of direction\n');
report('annualised funding', t => band(t.g.fundAnnPct, [0, 10, 30]));
console.log('3. RELATIVE STRENGTH — is this the leader or the laggard? (1 = leader in your direction)\n');
report('rank in the field', t => band(t.g.rankWith, [0.25, 0.5, 0.75]));
fs.writeFileSync('trades-featured.json', JSON.stringify(T));
