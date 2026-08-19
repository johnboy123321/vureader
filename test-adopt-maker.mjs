// The two builds of 2026-08-19: adopting plan-less positions, and the maker-entry shadow arm.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const out = path.join(process.cwd(), '.adopt-maker-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { walkFromBar, gradeMakerEntry, snapshotOpen, buildTradePlan, MAKER_FEE, TAKER_FEE };\n');
const M = await import(pathToFileURL(out).href);
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};
const H = 3600e3;
const near=(a,b,eps=1e-6)=>Math.abs(a-b)<eps;

console.log('\n1. walkFromBar — the same pessimism as gradeOne, without touching the record');
{
  const rec={ dir:'long', entry:100, stop:95, target:111.25 };
  ok('a clean winner scores +2.25R', near(M.walkFromBar(rec,[{t:0,l:99,h:101,c:100},{t:H,l:100,h:112,c:111}],0,100), 2.25));
  ok('a stop scores -1', M.walkFromBar(rec,[{t:0,l:94,h:101,c:95}],0,100) === -1);
  ok('stop AND target in one candle is a stop', M.walkFromBar(rec,[{t:0,l:94,h:112,c:100}],0,100) === -1);
  ok('still open returns null', M.walkFromBar(rec,[{t:0,l:99,h:101,c:100}],0,100) === null);
  const capped={ dir:'long', entry:100, stop:95, target:111.25, tfMult:0.05 };  // cap = 2 bars
  const bars=[{t:0,l:99,h:101,c:100},{t:H,l:99,h:102,c:101},{t:2*H,l:100,h:103,c:102}];
  ok('time cap marks to market', near(M.walkFromBar(capped,bars,0,100), 0.4));
  ok('the walk mutates nothing', !('ambiguous' in rec));
}
console.log('\n2. gradeMakerEntry — the fee arithmetic, on identical outcomes');
{
  // stop 5% wide: taker costs 2×0.06%/5% = 0.024R, maker entry costs (0.01%+0.06%)/5% = 0.014R
  const rec={ at:0, dir:'long', entry:100, stop:95, target:111.25, tf:'1D' };
  const bars=[{t:0,l:99,h:101,c:100},{t:H,l:100,h:112,c:111},{t:9*H,l:110,h:113,c:112}];
  const g=M.gradeMakerEntry(rec,bars,8);
  ok('both arms settle', !!g && g.filled === true);
  ok('taker nets gross minus two taker fees', near(g.takerR, 2.25-0.024, 1e-3), g && g.takerR);
  ok('maker nets gross minus maker+taker', near(g.makerR, 2.25-0.014, 1e-3), g && g.makerR);
  ok('the edge is exactly the fee saved', near(g.makerR-g.takerR, 0.01, 2e-3), g && (g.makerR-g.takerR));
}
console.log('\n3. A runaway trade is MISSED by the maker — and that costs the whole trade');
{
  const rec={ at:0, dir:'long', entry:100, stop:95, target:111.25, tf:'1D' };
  const bars=[]; // gaps up, never looks back, window closed by the 10th hour
  for (let i=0;i<=10;i++) bars.push({t:i*H,l:100.5+i,h:103+i,c:102+i});
  bars[9].h=112;                                     // taker reaches the target
  const g=M.gradeMakerEntry(rec,bars,8);
  ok('taker wins the trade', !!g && g.takerR > 2, g && g.takerR);
  ok('maker never fills', g && g.filled === false);
  ok('a missed trade is 0R, not a saved fee', g && g.makerR === 0);
}
console.log('\n4. An open window is waited out, never guessed');
{
  const rec={ at:0, dir:'long', entry:100, stop:95, target:111.25, tf:'1D' };
  // taker already resolved on bar 0, but the maker could still fill until hour 8
  const g=M.gradeMakerEntry(rec,[{t:0,l:100.2,h:112,c:111},{t:H,l:101,h:105,c:104}],8);
  ok('returns null until the expiry window is over', g === null);
  const still=M.gradeMakerEntry(rec,[{t:0,l:99,h:101,c:100}],8);
  ok('and null while the taker leg is still open', still === null);
}
console.log('\n5. A maker fill can still be a loser — pessimism survives the better entry');
{
  const rec={ at:0, dir:'short', entry:100, stop:105, target:88.75, tf:'1D' };
  const bars=[{t:0,l:98,h:99.5,c:99},{t:H,l:94,h:106,c:95},{t:9*H,l:94,h:96,c:95}];
  const g=M.gradeMakerEntry(rec,bars,8);   // fills short at 100 on bar 1, same bar holds the stop
  ok('short fills on the touch and stops in the same bar', !!g && g.filled && g.makerR < -1, g && g.makerR);
}
console.log('\n6. snapshotOpen carries the exchange\'s average entry');
{
  const pos=[{symbol:'XRPUSDT',posSide:'Long',size:361,avgEntryPriceRp:'3.05'}];
  const snap=M.snapshotOpen(pos,{},{});
  ok('avgEntry is read from the position', snap['XRP|long'] && snap['XRP|long'].avgEntry === 3.05);
  const prev={'XRP|long':{avgEntry:2.9,adopted:123}};
  const snap2=M.snapshotOpen([{symbol:'XRPUSDT',posSide:'Long',size:361}],{},prev);
  ok('and kept from the previous snapshot when the venue omits it', snap2['XRP|long'].avgEntry === 2.9);
  ok('an adoption stamp survives re-snapshotting', snap2['XRP|long'].adopted === 123);
}
console.log('\n7. Adoption is bookkeeping, never trading');
{
  const body = src.slice(src.indexOf('async function adoptOrphans'), src.indexOf('\n}', src.indexOf('async function adoptOrphans')));
  ok('adoptOrphans exists', body.length > 100);
  ok('it places no orders', !/execOrder|directOrder|buildOrder|relay\(/.test(body));
  ok('the stop is anchored to today\'s price, not the stale entry', /buildTradePlan\(bars, pos\.dir, cur\)/.test(body));
  ok('the recorded entry is the real average entry', /pos\.avgEntry.*>\s*0\s*\?\s*pos\.avgEntry\s*:\s*cur/.test(body));
  ok('adopted positions land in the swing book', /pos\.book = pos\.book \|\| "swing"/.test(body));
  ok('the log entry says so', /result: "ADOPTED"/.test(body));
  ok('it runs in the resolution pass before resolvedSince',
     src.indexOf('await adoptOrphans(nowOpen, bookMap)') > 0 &&
     src.indexOf('await adoptOrphans(nowOpen, bookMap)') < src.indexOf('const resolved = resolvedSince'));
}
console.log('\n8. The maker experiment measures and decides nothing');
{
  const block = src.slice(src.indexOf('MAKER-ENTRY EXPERIMENT'), src.indexOf('const v = shadowJudge'));
  ok('it is present in the shadow pass', block.length > 100);
  ok('no order function appears in it', !/execOrder|directOrder|buildOrder\(/.test(block));
  ok('it grades on the timeframe below the signal', /GRADE_TF_BELOW\[rec\.tf/.test(block));
  ok('each decision is scored once', /meSlot\.seen\.includes/.test(block));
  ok('fees are configurable', /num\("MAKER_FEE", 0\.0001\)/.test(src) && /num\("TAKER_FEE", 0\.0006\)/.test(src));
  ok('it reports fills and misses separately', /filled, .*missed/.test(block) || /filled.*missed/.test(block));
}
fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
