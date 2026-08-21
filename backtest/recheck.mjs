import fs from 'node:fs';
import { ci95, mean, bootstrapPositive } from './lib/report.mjs';
const T = JSON.parse(fs.readFileSync('trades.json','utf8'));

// R measured against the risk the bot BUDGETED (~£10), not the risk it happened to end up with.
// riskReal can collapse toward zero when a limit fills right next to its own stop, and dividing
// by that manufactures a +106R trade out of a £24 profit.
for (const t of T) t.R = t.netGbp / t.riskBudget;

const money = T.map(t => t.netGbp), Rb = T.map(t => t.R), Rr = T.map(t => t.netR);
const cM = ci95(money), cB = ci95(Rb), cR = ci95(Rr);
console.log('THE SAME 3,229 TRADES, THREE WAYS OF COUNTING\n');
console.log('  R on risk-at-fill (what I reported)   ' + cR.m.toFixed(3) + 'R   total ' + Rr.reduce((a,b)=>a+b,0).toFixed(0) + 'R');
console.log('  R on risk BUDGETED (~£10)             ' + cB.m.toFixed(3) + 'R   total ' + Rb.reduce((a,b)=>a+b,0).toFixed(0) + 'R   [' + cB.lo.toFixed(3) + ', ' + cB.hi.toFixed(3) + ']');
console.log('  actual money                          £' + cM.m.toFixed(2) + '     total £' + money.reduce((a,b)=>a+b,0).toFixed(0) + '   [£' + cM.lo.toFixed(2) + ', £' + cM.hi.toFixed(2) + ']');
console.log('  P(true edge > 0), on money: ' + (bootstrapPositive(money)*100).toFixed(0) + '%');
console.log();
const top = [...T].sort((a,b)=>b.netR-a.netR)[0];
console.log('  the trade that distorted it: ' + top.coin + ' ' + top.dir + ' — £' + top.netGbp.toFixed(2) + ' profit on £' + top.riskReal.toFixed(2) + ' at risk = ' + top.netR.toFixed(0) + 'R');
console.log();
console.log('CORRECTED BREAKDOWNS (money per trade, and total £)\n');
const grp=(lab,key)=>{
  const m=new Map();
  for(const t of T){const k=typeof key==='function'?key(t):t[key]; if(!m.has(k))m.set(k,[]); m.get(k).push(t);}
  console.log('  '+lab.padEnd(24)+'n'.padStart(7)+'green'.padStart(7)+'£/trade'.padStart(10)+'95% CI'.padStart(22)+'total'.padStart(10));
  for(const [k,s] of [...m].sort((a,b)=>b[1].length-a[1].length)){
    const mm=s.map(t=>t.netGbp), c=ci95(mm), g=s.filter(t=>t.netGbp>0).length;
    console.log('  '+String(k).padEnd(24)+String(s.length).padStart(7)+((g/s.length*100).toFixed(0)+'%').padStart(7)+
      ('£'+c.m.toFixed(2)).padStart(10)+('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(22)+('£'+mm.reduce((a,b)=>a+b,0).toFixed(0)).padStart(10));
  }
  console.log();
};
grp('detector','detector');
grp('quality band', t=>t.quality===undefined||t.quality===null?'(confluence)':'q'+t.quality);
grp('direction','dir');
grp('timeframe','tf');
grp('year','year');

console.log('WHAT IS LEFT IF YOU REMOVE THE THINGS THAT LOSE\n');
const f=(lab,fn)=>{const s=T.filter(fn);const m=s.map(t=>t.netGbp),c=ci95(m);
  console.log('  '+lab.padEnd(38)+String(s.length).padStart(6)+' trades'+('£'+c.m.toFixed(2)).padStart(9)+
  ('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(22)+('total £'+m.reduce((a,b)=>a+b,0).toFixed(0)).padStart(15)+
  ('  P(>0) '+(bootstrapPositive(m)*100).toFixed(0)+'%').padStart(13));};
f('everything (today)', ()=>true);
f('drop the confluence path', t=>t.detector!=='confluence');
f('drop shorts', t=>t.dir==='long');
f('drop confluence AND shorts', t=>t.detector!=='confluence'&&t.dir==='long');
f('rollover only', t=>t.detector==='rollover');
f('rollover, longs only', t=>t.detector==='rollover'&&t.dir==='long');
console.log('\n  same, split in half by date (does it hold up?)');
const srt=[...T].sort((a,b)=>a.exitAt-b.exitAt); const mid=srt[Math.floor(srt.length/2)].exitAt;
for(const [lab,fn] of [['drop confluence',t=>t.detector!=='confluence'],['drop confluence AND shorts',t=>t.detector!=='confluence'&&t.dir==='long']])
 for(const [h,g] of [['1st half',t=>t.exitAt<mid],['2nd half',t=>t.exitAt>=mid]]){
  const s=T.filter(x=>fn(x)&&g(x)),m=s.map(t=>t.netGbp),c=ci95(m);
  console.log('    '+(lab+' — '+h).padEnd(38)+String(s.length).padStart(6)+' trades'+('£'+c.m.toFixed(2)).padStart(9)+('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(22));
 }
