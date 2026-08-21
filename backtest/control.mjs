// The publicly-described core of that framework is RSI with an EMA on it, plus "control zones" —
// levels that decide who is in control. The exact parameters are closed-source and paywalled, so
// this does NOT test his method. It tests the generic IDEA the method is built around, on John's
// own trades: does higher-timeframe RSI control predict anything?
import fs from 'node:fs';
import { loadCoin, listCoins, closedBy } from './lib/data.mjs';
import { loadRules } from './lib/rules.mjs';
import { ci95 } from './lib/report.mjs';
const { M } = await loadRules();
const T = JSON.parse(fs.readFileSync('trades-featured.json','utf8')).filter(t=>t.f);
const coins = new Map(); for (const c of listCoins()) coins.set(c, loadCoin(c));

for (const t of T) {
  const d = coins.get(t.coin); if (!d) continue;
  const n = closedBy(d.tfs['1D'], '1D', t.placedAt);
  const bars = d.tfs['1D'].slice(Math.max(0, n-260), n);
  if (bars.length < 60) continue;
  const r = M.rsiArr(bars), i = r.length-1;
  const rsi = r[i];
  if (!Number.isFinite(rsi)) continue;
  const ema = M.emaArr(r.slice(20).filter(Number.isFinite), 14);
  t.k = {
    dRsi: rsi,
    dRsiEma: ema[ema.length-1],
    // "control": for a long, daily RSI holding above 50; for a short, below 50
    control: t.dir === 'long' ? rsi > 50 : rsi < 50,
    // the stronger reading: RSI above its own EMA (momentum of momentum) in your direction
    rsiOverEma: t.dir === 'long' ? rsi > ema[ema.length-1] : rsi < ema[ema.length-1],
  };
}
const S = T.filter(t=>t.k);
const sorted=[...S].sort((a,b)=>a.exitAt-b.exitAt), mid=sorted[Math.floor(sorted.length/2)].exitAt;
const s=a=>a.reduce((x,y)=>x+y,0);
const row=(lab,f,min=120)=>{const q=S.filter(f); if(q.length<min) return console.log('  '+lab.padEnd(40)+'n='+q.length+' too few');
  const m=q.map(t=>t.netGbp),c=ci95(m),g=s(q.map(t=>t.grossGbp))/q.length;
  const h1=ci95(q.filter(t=>t.exitAt<mid).map(t=>t.netGbp)),h2=ci95(q.filter(t=>t.exitAt>=mid).map(t=>t.netGbp));
  console.log('  '+lab.padEnd(40)+('n='+q.length).padStart(7)+('net £'+c.m.toFixed(2)).padStart(11)+('gross £'+g.toFixed(2)).padStart(13)
   +('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(20)+('  '+h1.m.toFixed(2)+'/'+h2.m.toFixed(2)).padStart(14)+(((h1.m>0)===(h2.m>0))?' ✓':' ✗'));};

console.log('DOES HIGHER-TIMEFRAME RSI "CONTROL" PREDICT ANYTHING? ('+S.length+' trades)\n');
row('daily RSI in your favour (control)', t=>t.k.control);
row('daily RSI against you', t=>!t.k.control);
console.log();
row('RSI above its own EMA, your way', t=>t.k.rsiOverEma);
row('RSI below its own EMA, your way', t=>!t.k.rsiOverEma);
console.log();
console.log('  daily RSI band, signed with the trade direction:');
const band=(t)=>{const v=t.dir==='long'?t.k.dRsi:100-t.k.dRsi;
  return v<35?'a. deeply against':v<45?'b. against':v<55?'c. neutral':v<65?'d. in favour':'e. strongly in favour';};
const g=new Map(); for(const t of sorted){const k=band(t); if(!g.has(k))g.set(k,[]); g.get(k).push(t);}
for(const [k,q] of [...g].sort()) row('    '+k, t=>band(t)===k, 100);
console.log('\nSTACKED WITH WHAT ALREADY WORKS\n');
row('rank>=0.75 + ATR>=2%', t=>t.g&&t.g.rankWith>=0.75&&t.f.atrPct>=2, 100);
row('...and daily RSI control', t=>t.g&&t.g.rankWith>=0.75&&t.f.atrPct>=2&&t.k.control, 80);
