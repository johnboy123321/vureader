import fs from 'node:fs';
import { ci95 } from './lib/report.mjs';
const rows=[];
const add=(tR,T)=>{
  const rs=T.map(t=>t.netR); const c=ci95(rs);
  const closed=T.filter(t=>t.how!=='marked-to-market');
  const green=closed.filter(t=>t.netR>0).length;
  rows.push({tR,n:T.length,win:green/closed.length,exp:c.m,lo:c.lo,hi:c.hi,tot:rs.reduce((a,b)=>a+b,0)});
};
for(const f of fs.readdirSync('.').filter(f=>/^sweep-.*\.json$/.test(f)))
  add(parseFloat(f.match(/sweep-(.*)\.json/)[1]), JSON.parse(fs.readFileSync(f,'utf8')));
const main=JSON.parse(fs.readFileSync('trades.json','utf8'));
add(2.25, main);
rows.sort((a,b)=>a.tR-b.tR);
console.log('target'.padEnd(9)+'trades'.padStart(8)+'green%'.padStart(9)+'expectancy'.padStart(13)+'95% CI'.padStart(20)+'total'.padStart(10));
console.log('-'.repeat(70));
for(const r of rows)
  console.log((r.tR+'R').padEnd(9)+String(r.n).padStart(8)+((r.win*100).toFixed(1)+'%').padStart(9)+
    ((r.exp>=0?'+':'')+r.exp.toFixed(3)+'R').padStart(13)+
    ('['+r.lo.toFixed(3)+', '+r.hi.toFixed(3)+']').padStart(20)+(r.tot.toFixed(0)+'R').padStart(10));
