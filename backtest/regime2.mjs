import fs from 'node:fs';
import { loadCoin, listCoins, closedBy } from './lib/data.mjs';
import { ci95 } from './lib/report.mjs';
const T = JSON.parse(fs.readFileSync('trades.json','utf8'));
const coins = new Map(); for (const c of listCoins()) coins.set(c, loadCoin(c));
const btc = coins.get('BTC').tfs['1D'];
const sma=(bars,n,upto)=>{const k=closedBy(bars,'1D',upto);if(k<n)return null;let s=0;for(let i=k-n;i<k;i++)s+=bars[i].c;return {ma:s/n,px:bars[k-1].c};};
for (const t of T) { const r = sma(btc,200,t.filledAt); t.reg = r ? (r.px>r.ma?'bull':'bear') : null; }
const G = T.filter(t=>t.reg);
const counter = t => (t.reg==='bull'&&t.dir==='short')||(t.reg==='bear'&&t.dir==='long');

const line=(lab,s)=>{ if(s.length<20) return console.log('  '+lab.padEnd(30)+('n='+s.length+'  too few').padStart(16));
  const m=s.map(t=>t.netGbp),c=ci95(m);
  console.log('  '+lab.padEnd(30)+('n='+s.length).padStart(7)+('£'+c.m.toFixed(2)).padStart(9)+('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(21)+('tot £'+m.reduce((a,b)=>a+b,0).toFixed(0)).padStart(12));};

console.log('IS "TRADE AGAINST THE 200D REGIME" REAL, OR ONE GOOD STRETCH?\n');
console.log('by year');
for (const y of [2023,2024,2025,2026]) line(y+'  counter-regime', G.filter(t=>t.year===y&&counter(t)));
console.log();
for (const y of [2023,2024,2025,2026]) line(y+'  with-regime', G.filter(t=>t.year===y&&!counter(t)));
console.log('\nsplit in half by date');
const srt=[...G].sort((a,b)=>a.exitAt-b.exitAt), mid=srt[Math.floor(srt.length/2)].exitAt;
line('counter — 1st half', G.filter(t=>counter(t)&&t.exitAt<mid));
line('counter — 2nd half', G.filter(t=>counter(t)&&t.exitAt>=mid));
console.log('\nthe four boxes, each split in half');
for (const [lab,f] of [['long in bull',t=>t.dir==='long'&&t.reg==='bull'],['long in bear',t=>t.dir==='long'&&t.reg==='bear'],
                       ['short in bull',t=>t.dir==='short'&&t.reg==='bull'],['short in bear',t=>t.dir==='short'&&t.reg==='bear']]) {
  line(lab+' — 1st half', G.filter(t=>f(t)&&t.exitAt<mid));
  line(lab+' — 2nd half', G.filter(t=>f(t)&&t.exitAt>=mid));
}
console.log('\ncounter-regime AND no confluence path');
line('all', G.filter(t=>counter(t)&&t.detector!=='confluence'));
line('  1st half', G.filter(t=>counter(t)&&t.detector!=='confluence'&&t.exitAt<mid));
line('  2nd half', G.filter(t=>counter(t)&&t.detector!=='confluence'&&t.exitAt>=mid));
