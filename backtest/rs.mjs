import fs from 'node:fs';
import { ci95 } from './lib/report.mjs';
const T=JSON.parse(fs.readFileSync('trades-featured.json','utf8')).filter(t=>t.f&&t.g&&Number.isFinite(t.g.rankWith));
const sorted=[...T].sort((a,b)=>a.exitAt-b.exitAt), mid=sorted[Math.floor(sorted.length/2)].exitAt;
const s=a=>a.reduce((x,y)=>x+y,0);
const row=(lab,f,min=100)=>{const q=T.filter(f); if(q.length<min) return console.log('  '+lab.padEnd(44)+('n='+q.length).padStart(7)+'  too few');
  const m=q.map(t=>t.netGbp),c=ci95(m),g=s(q.map(t=>t.grossGbp))/q.length;
  const h1=ci95(q.filter(t=>t.exitAt<mid).map(t=>t.netGbp)),h2=ci95(q.filter(t=>t.exitAt>=mid).map(t=>t.netGbp));
  console.log('  '+lab.padEnd(44)+('n='+q.length).padStart(7)+('net £'+c.m.toFixed(2)).padStart(11)+('gross £'+g.toFixed(2)).padStart(13)
   +('[£'+c.lo.toFixed(2)+', £'+c.hi.toFixed(2)+']').padStart(20)+('  '+h1.m.toFixed(2)+'/'+h2.m.toFixed(2)).padStart(14)+(((h1.m>0)===(h2.m>0))?' ✓':' ✗'));};

console.log('IS RELATIVE STRENGTH JUST RE-SAYING SOMETHING I ALREADY TESTED?\n');
console.log('  (extension says: trade coins BELOW their 200 EMA. rank says: trade the 7-day LEADERS.)');
console.log('  If they were the same thing, the four boxes below would be empty in two corners.\n');
for (const [el,ef] of [['below 200EMA',t=>t.f.extension<0],['above 200EMA',t=>t.f.extension>=0]])
  for (const [rl,rf] of [['leader',t=>t.g.rankWith>=0.75],['laggard',t=>t.g.rankWith<0.25]])
    row(el+' + '+rl, t=>ef(t)&&rf(t), 60);

console.log('\nDOES RANK HOLD INSIDE EACH DETECTOR? (if it only works on one, it is noise)\n');
for (const d of ['rollover','confluence','divergence'])
  row(d+': leaders (rank>=0.75)', t=>t.detector===d&&t.g.rankWith>=0.75, 60);
for (const d of ['rollover','confluence','divergence'])
  row(d+': laggards (rank<0.25)', t=>t.detector===d&&t.g.rankWith<0.25, 60);

console.log('\nAND IN EACH DIRECTION?\n');
row('longs, leaders', t=>t.dir==='long'&&t.g.rankWith>=0.75, 60);
row('longs, laggards', t=>t.dir==='long'&&t.g.rankWith<0.25, 60);
row('shorts, leaders (weakest coins)', t=>t.dir==='short'&&t.g.rankWith>=0.75, 60);
row('shorts, laggards', t=>t.dir==='short'&&t.g.rankWith<0.25, 60);

console.log('\nSTACKED WITH THE VOLATILITY FILTER\n');
row('everything', ()=>true);
row('rank >= 0.75', t=>t.g.rankWith>=0.75);
row('ATR>=2% AND expanding', t=>t.f.atrPct>=2&&t.f.volExpansion>=1.3);
row('rank>=0.75 AND ATR>=2%', t=>t.g.rankWith>=0.75&&t.f.atrPct>=2);
row('rank>=0.75 AND ATR>=2% AND expanding', t=>t.g.rankWith>=0.75&&t.f.atrPct>=2&&t.f.volExpansion>=1.3, 60);
