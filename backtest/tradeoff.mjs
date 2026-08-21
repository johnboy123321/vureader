import fs from 'node:fs';
import { ci95, mean } from './lib/report.mjs';
const T = JSON.parse(fs.readFileSync('trades-featured.json','utf8')).filter(t=>t.f);
const s=a=>a.reduce((x,y)=>x+y,0);
const B=[['quiet  ATR<2%',t=>t.f.atrPct<2],['mid    ATR 2-5%',t=>t.f.atrPct>=2&&t.f.atrPct<5],['lively ATR>5%',t=>t.f.atrPct>=5]];
console.log('DOES A WIDER STOP JUST MEAN THE TARGET IS FURTHER AWAY?\n');
console.log('  bucket'.padEnd(20)+'n'.padStart(6)+'win%'.padStart(7)+'stop%'.padStart(8)+'bars held'.padStart(11)+'gross/tr'.padStart(10)+'fees/tr'.padStart(9)+'net/tr'.padStart(8));
for (const [lab,f] of B) {
  const q=T.filter(f), closed=q.filter(t=>t.how!=='marked-to-market');
  const w=closed.filter(t=>t.netGbp>0).length;
  console.log('  '+lab.padEnd(18)+String(q.length).padStart(6)+((w/closed.length*100).toFixed(1)+'%').padStart(7)
    +((mean(q.map(t=>t.stopPct))*100).toFixed(1)+'%').padStart(8)
    +mean(q.map(t=>t.barsHeld)).toFixed(0).padStart(11)
    +('£'+(s(q.map(t=>t.grossGbp))/q.length).toFixed(2)).padStart(10)
    +('£'+(s(q.map(t=>-t.feeGbp))/q.length).toFixed(2)).padStart(9)
    +('£'+(s(q.map(t=>t.netGbp))/q.length).toFixed(2)).padStart(8));
}
console.log('\nSPLITTING THE TWO EFFECTS APART\n');
const q1=T.filter(t=>t.f.atrPct<2), q3=T.filter(t=>t.f.atrPct>=5);
const g1=s(q1.map(t=>t.grossGbp))/q1.length, g3=s(q3.map(t=>t.grossGbp))/q3.length;
const f1=s(q1.map(t=>-t.feeGbp))/q1.length, f3=s(q3.map(t=>-t.feeGbp))/q3.length;
console.log('  moving quiet → lively is worth £'+((g3-g1)+(f1-f3)).toFixed(2)+' a trade in total:');
console.log('    £'+(g3-g1).toFixed(2)+' of it is the SIGNAL working better  (gross '+g1.toFixed(2)+' → '+g3.toFixed(2)+')');
console.log('    £'+(f1-f3).toFixed(2)+' of it is COSTS falling             (fees '+f1.toFixed(2)+' → '+f3.toFixed(2)+')');
console.log('\nHOW BIG IS THE RAW EDGE, REALLY?\n');
const gAll=s(T.map(t=>t.grossGbp))/T.length;
console.log('  gross per trade, everything:            £'+gAll.toFixed(3)+' on £10 risked = '+(gAll/10*100).toFixed(1)+'% per trade');
const cAll=ci95(T.map(t=>t.grossGbp));
console.log('  95% CI on that gross edge:             [£'+cAll.lo.toFixed(2)+', £'+cAll.hi.toFixed(2)+']');
const cLively=ci95(q3.map(t=>t.grossGbp));
console.log('  gross per trade, lively coins only:     £'+g3.toFixed(2)+'  CI [£'+cLively.lo.toFixed(2)+', £'+cLively.hi.toFixed(2)+']  n='+q3.length);
