import fs from 'node:fs';
import { loadCoin, listCoins, closedBy, TF_MS } from './lib/data.mjs';
import { ci95, mean } from './lib/report.mjs';

const T = JSON.parse(fs.readFileSync('trades.json','utf8'));
for (const t of T) t.R = t.netGbp;              // count in money

const coins = new Map();
for (const c of listCoins()) coins.set(c, loadCoin(c));
const btc = coins.get('BTC').tfs['1D'];

const sma = (bars, n, upto) => {
  const k = closedBy(bars, '1D', upto);
  if (k < n) return null;
  let s = 0; for (let i = k - n; i < k; i++) s += bars[i].c;
  return { ma: s / n, px: bars[k-1].c };
};

// Three candidate regime definitions, all standard and all decided BEFORE looking at results.
const REGIMES = {
  'BTC vs its 200D average': (t) => { const r = sma(btc, 200, t.filledAt); return r ? (r.px > r.ma ? 'bull' : 'bear') : null; },
  'BTC 50D vs 200D':         (t) => { const a = sma(btc, 50, t.filledAt), b = sma(btc, 200, t.filledAt); return (a&&b) ? (a.ma > b.ma ? 'bull' : 'bear') : null; },
  'breadth: most coins above their own 200D': (t) => {
    let up = 0, n = 0;
    for (const [, d] of coins) { const r = sma(d.tfs['1D'], 200, t.filledAt); if (r) { n++; if (r.px > r.ma) up++; } }
    return n < 10 ? null : (up / n > 0.5 ? 'bull' : 'bear');
  },
};

const cell = (s) => {
  if (s.length < 25) return ('n=' + s.length + ' —').padStart(26);
  const m = s.map(t => t.R), c = ci95(m);
  return (('n=' + s.length).padStart(7) + ('£' + c.m.toFixed(2)).padStart(8) + ('  tot £' + m.reduce((a,b)=>a+b,0).toFixed(0)).padStart(11)).padStart(26);
};

for (const [name, fn] of Object.entries(REGIMES)) {
  console.log('\n══ ' + name);
  for (const t of T) t.reg = fn(t);
  const got = T.filter(t => t.reg);
  const bull = got.filter(t => t.reg === 'bull').length;
  console.log('   ' + (bull/got.length*100).toFixed(0) + '% of trades happened in "bull", ' + (100-bull/got.length*100).toFixed(0) + '% in "bear"');
  console.log('   ' + 'direction'.padEnd(12) + 'IN BULL'.padStart(26) + 'IN BEAR'.padStart(26));
  for (const d of ['long','short'])
    console.log('   ' + d.padEnd(12) + cell(got.filter(t=>t.dir===d&&t.reg==='bull')) + cell(got.filter(t=>t.dir===d&&t.reg==='bear')));
  // the proposed rule: only trade WITH the regime
  const withReg  = got.filter(t => (t.reg==='bull'&&t.dir==='long') || (t.reg==='bear'&&t.dir==='short'));
  const against  = got.filter(t => (t.reg==='bull'&&t.dir==='short')|| (t.reg==='bear'&&t.dir==='long'));
  const w = withReg.map(t=>t.R), a = against.map(t=>t.R);
  console.log('   → trading WITH the regime   ' + ('n='+withReg.length).padStart(7) + ('  £'+ci95(w).m.toFixed(2)).padStart(9) +
              ('  [£'+ci95(w).lo.toFixed(2)+', £'+ci95(w).hi.toFixed(2)+']').padStart(20) + ('  total £'+w.reduce((x,y)=>x+y,0).toFixed(0)).padStart(14));
  console.log('   → trading AGAINST it        ' + ('n='+against.length).padStart(7) + ('  £'+ci95(a).m.toFixed(2)).padStart(9) +
              ('  [£'+ci95(a).lo.toFixed(2)+', £'+ci95(a).hi.toFixed(2)+']').padStart(20) + ('  total £'+a.reduce((x,y)=>x+y,0).toFixed(0)).padStart(14));
}
