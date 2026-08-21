import fs from 'node:fs';
import { ci95, mean, bootstrapPositive } from './lib/report.mjs';
const T = JSON.parse(fs.readFileSync('trades.json','utf8'));
const line=(lab,rs)=>{const c=ci95(rs);const p=bootstrapPositive(rs,20000);
  console.log(lab.padEnd(42)+(c.m>=0?'+':'')+c.m.toFixed(3)+'R'+('  [' + c.lo.toFixed(3)+', '+c.hi.toFixed(3)+']').padStart(22)+'   P(edge>0) '+(p*100).toFixed(0)+'%'+('   total '+rs.reduce((a,b)=>a+b,0).toFixed(0)+'R').padStart(16));};

// feeR as recorded = -(entry notional + exit notional) * 6bps / riskReal  →  rescale the rate
const refee = (t, bps) => t.feeR * (bps / 6);

console.log('SAME 3,229 TRADES, DIFFERENT COST ASSUMPTIONS\n');
line('before fees (after slippage)',      T.map(t => t.grossR + t.fundR));
line('taker both ways, 6bps  [as it runs]', T.map(t => t.netR));
line('maker in, taker out  ~3.5bps',      T.map(t => t.grossR + refee(t,3.5) + t.fundR));
line('maker both ways, 1bp',              T.map(t => t.grossR + refee(t,1) + t.fundR));
console.log('\nHOW BIG IS THE COST PROBLEM');
console.log('  mean fee drag        ' + mean(T.map(t=>t.feeR)).toFixed(3) + 'R per trade');
console.log('  mean notional / risk ' + mean(T.map(t=>t.notional/t.riskReal)).toFixed(0) + 'x  → every 1bp of cost = ' + (mean(T.map(t=>t.notional/t.riskReal))*1e-4).toFixed(3) + 'R');
console.log('  median stop distance ' + (T.map(t=>t.stopPct).sort((a,b)=>a-b)[Math.floor(T.length/2)]*100).toFixed(1) + '% of price');
