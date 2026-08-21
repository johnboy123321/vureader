import fs from 'node:fs';
import { mean, ci95 } from './lib/report.mjs';
const T = JSON.parse(fs.readFileSync('trades.json','utf8'));
const show=(lab,f)=>{const s=T.filter(f);if(s.length<30)return console.log(lab.padEnd(44)+'n='+s.length+' (too few)');const r=s.map(t=>t.netR);const c=ci95(r);console.log(lab.padEnd(44)+('n='+s.length).padStart(8)+('  '+c.m.toFixed(3)+'R').padStart(11)+'  ['+c.lo.toFixed(3)+', '+c.hi.toFixed(3)+']  total '+r.reduce((a,b)=>a+b,0).toFixed(0)+'R');};
console.log('SINGLE FILTERS');
show('everything as it runs today', ()=>true);
show('longs only', t=>t.dir==='long');
show('drop stops tighter than 2%', t=>t.stopPct>=0.02);
show('detectors only (no confluence)', t=>t.detector!=='confluence');
show('divergence detector only', t=>t.detector==='divergence');
show('drop FVG stops', t=>t.stopKind!=='FVG');
console.log('\nSTACKED');
show('longs + stop>=2%', t=>t.dir==='long'&&t.stopPct>=0.02);
show('longs + no confluence', t=>t.dir==='long'&&t.detector!=='confluence');
show('longs + divergence only', t=>t.dir==='long'&&t.detector==='divergence');
show('longs + no confluence + stop>=2%', t=>t.dir==='long'&&t.detector!=='confluence'&&t.stopPct>=0.02);
const half=[...T].sort((a,b)=>a.exitAt-b.exitAt)[Math.floor(T.length/2)].exitAt;
console.log('\nDOES THE SURVIVOR HOLD IN BOTH HALVES?');
const f=t=>t.dir==='long'&&t.detector!=='confluence'&&t.stopPct>=0.02;
for(const [h,g] of [['first half',t=>t.exitAt<half],['second half',t=>t.exitAt>=half]]){
  const s=T.filter(x=>f(x)&&g(x)); const c=ci95(s.map(t=>t.netR));
  console.log(('  '+h).padEnd(44)+('n='+s.length).padStart(8)+('  '+c.m.toFixed(3)+'R').padStart(11)+'  ['+c.lo.toFixed(3)+', '+c.hi.toFixed(3)+']');
}
console.log('\nSHORTS BY YEAR');
for(const y of [2023,2024,2025,2026]){const s=T.filter(t=>t.year===y&&t.dir==='short');console.log('  '+y+'  n='+String(s.length).padStart(4)+'  '+mean(s.map(t=>t.netR)).toFixed(3)+'R');}
console.log('\nLONGS BY YEAR');
for(const y of [2023,2024,2025,2026]){const s=T.filter(t=>t.year===y&&t.dir==='long');console.log('  '+y+'  n='+String(s.length).padStart(4)+'  '+mean(s.map(t=>t.netR)).toFixed(3)+'R');}
