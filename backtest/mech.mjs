import fs from 'node:fs';
import { ci95, mean } from './lib/report.mjs';
const T = JSON.parse(fs.readFileSync('trades-featured.json','utf8')).filter(t=>t.f);
const sorted=[...T].sort((a,b)=>a.exitAt-b.exitAt), mid=sorted[Math.floor(sorted.length/2)].exitAt;
const s=a=>a.reduce((x,y)=>x+y,0);
const row=(lab,f)=>{const q=T.filter(f); if(q.length<80) return console.log('  '+lab.padEnd(46)+'n='+q.length+' too few');
  const m=q.map(t=>t.netGbp),c=ci95(m);
  const h1=ci95(q.filter(t=>t.exitAt<mid).map(t=>t.netGbp)), h2=ci95(q.filter(t=>t.exitAt>=mid).map(t=>t.netGbp));
  console.log('  '+lab.padEnd(46)+('n='+q.length).padStart(7)+('£'+c.m.toFixed(2)).padStart(8)+('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(20)
    +('tot £'+s(m).toFixed(0)).padStart(12)+('  halves '+h1.m.toFixed(2)+' / '+h2.m.toFixed(2)).padStart(22)+(((h1.m>0)===(h2.m>0))?'  ✓':'  ✗'));};

console.log('IS THE VOLATILITY FINDING JUST THE COST FINDING?\n');
for (const [lab,f] of [['ATR under 2% of price',t=>t.f.atrPct<2],['ATR 2-5%',t=>t.f.atrPct>=2&&t.f.atrPct<5],['ATR over 5%',t=>t.f.atrPct>=5]]) {
  const q=T.filter(f);
  console.log('  '+lab.padEnd(24)+'mean stop '+(mean(q.map(t=>t.stopPct))*100).toFixed(2)+'% of price'
    +'   fees '+ (s(q.map(t=>-t.feeGbp))/q.length).toFixed(2).padStart(5) + ' per trade'
    +'   gross £'+(s(q.map(t=>t.grossGbp))/q.length).toFixed(2).padStart(5)
    +'   net £'+(s(q.map(t=>t.netGbp))/q.length).toFixed(2).padStart(5));
}
console.log('\n  → fees are a FIXED % of notional. A tight stop means a big position for the same');
console.log('    £10 risk, so the same fee eats a bigger share of a smaller reward.\n');

console.log('WHAT A SINGLE MECHANICAL FILTER WOULD HAVE DONE\n');
row('everything (today)', ()=>true);
row('skip coins with ATR under 2% of price', t=>t.f.atrPct>=2);
row('only when volatility is expanding (>=1.3x)', t=>t.f.volExpansion>=1.3);
row('skip signal bars with volume over 1.2x average', t=>t.f.volRatio<1.2);
console.log();
row('ATR>=2% AND volatility expanding', t=>t.f.atrPct>=2&&t.f.volExpansion>=1.3);
row('ATR>=2% AND quiet entry bar (vol<1.2x)', t=>t.f.atrPct>=2&&t.f.volRatio<1.2);
row('all three', t=>t.f.atrPct>=2&&t.f.volExpansion>=1.3&&t.f.volRatio<1.2);
console.log('\nAND WITH MAKER FEES ON TOP (1bp instead of 6bp each way)\n');
const makerNet=t=>t.grossGbp+t.fundGbp+t.feeGbp*(2/12);
const rowM=(lab,f)=>{const q=T.filter(f); if(q.length<80) return; const m=q.map(makerNet),c=ci95(m);
  console.log('  '+lab.padEnd(46)+('n='+q.length).padStart(7)+('£'+c.m.toFixed(2)).padStart(8)+('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(20)+('tot £'+s(m).toFixed(0)).padStart(12));};
rowM('everything', ()=>true);
rowM('ATR>=2% only', t=>t.f.atrPct>=2);
rowM('ATR>=2% AND expanding', t=>t.f.atrPct>=2&&t.f.volExpansion>=1.3);
