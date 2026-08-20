// The three fixes that came out of reading the LIVE state file on 2026-08-18.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const out = path.join(process.cwd(), '.audit-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { shadowJudge, shadowSlot, gradeOne, planValid, GRADE_TF_BELOW, SHADOW_MIN_RESOLVED, SHADOW_MARGIN_R };\n');
const M = await import(pathToFileURL(out).href);
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};
const recs=(arm,n,R)=>Array.from({length:n},(_,i)=>({arm,R,at:i}));

console.log('\n1. Beating a loser is not winning');
{
  // the exact live numbers that wrongly promoted on 2026-08-18
  const sh={}; const slot=M.shadowSlot(sh,'x');
  slot.records=[...recs('baseline',77,-0.789), ...recs('variant',33,-0.705)];
  const v=M.shadowJudge(sh,'x');
  ok('the variant does beat the baseline', v.edge >= M.SHADOW_MARGIN_R, v.edge);
  ok('but it is NOT promoted, because it loses money', v.promoted === false);
  ok('and no promotion is recorded', v.changed === null, v.changed);
}
console.log('\n2. A variant that actually pays is promoted');
{
  const sh={}; const slot=M.shadowSlot(sh,'y');
  slot.records=[...recs('baseline',40,-0.20), ...recs('variant',40,0.15)];
  const v=M.shadowJudge(sh,'y');
  ok('promoted', v.promoted === true && v.changed === 'promoted');
}
console.log('\n3. A promotion granted before the floor existed is unwound');
{
  const sh={}; const slot=M.shadowSlot(sh,'z');
  slot.promoted=true;                                    // as found in the live state file
  slot.records=[...recs('baseline',77,-0.789), ...recs('variant',33,-0.705)];
  const v=M.shadowJudge(sh,'z');
  ok('demoted on the next run', v.promoted === false && v.changed === 'demoted');
}
console.log('\n4. Grading happens BELOW the signal timeframe');
{
  ok('1D grades on 4H', M.GRADE_TF_BELOW['1D']==='4H');
  ok('4H grades on 1H', M.GRADE_TF_BELOW['4H']==='1H');
  ok('1H grades on 30m', M.GRADE_TF_BELOW['1H']==='30m');
  ok('15m has nowhere finer to go', M.GRADE_TF_BELOW['15m']==='15m');
  ok('the fetch asks for the finer timeframe', /fetchCandles\(coin, gtf, 600\)/.test(src));
  ok('the time cap scales with it', /SHADOW_TIMEOUT_BARS \* \(rec\.tfMult \|\| 4\)/.test(src));
}
console.log('\n5. A candle holding BOTH levels still scores as a stop — but is counted');
{
  const rec={ at:0, dir:'long', entry:100, stop:95, target:111 };
  const bars=[{t:0,o:100,h:112,l:94,c:100,v:1}];         // contains stop AND target
  ok('scored as a loss', M.gradeOne(rec,bars) === -1);
  ok('and the ambiguity is recorded on the record', rec.ambiguous === 1);
  const clean={ at:0, dir:'long', entry:100, stop:95, target:111 };
  ok('a clean winner is unaffected', M.gradeOne(clean,[{t:0,o:100,h:112,l:99,c:110,v:1}]) > 2);
  ok('and carries no ambiguity flag', !clean.ambiguous);
}
console.log('\n6. The stop floor');
{
  const t=(en,sl,dir)=>M.planValid({entry:en,sl,dir,tp1:dir==='short'?en*0.9:en*1.1});
  ok('a 0.4% stop is refused (BNB 604/601.71 was rejected by the exchange)', !!t(604,601.71,'long'));
  ok('a 0.5% stop is refused (LTC 44.45/44.69 was rejected)', !!t(44.45,44.69,'short'));
  ok('a 0.8% stop is refused (FIL 0.6727/0.67804 was rejected)', !!t(0.6727,0.67804,'short'));
  ok('a 3% stop passes', t(100,97,'long') === null, t(100,97,'long'));
  ok('a 2.5% stop passes', t(100,97.5,'long') === null);
  ok('the message says what it would have cost', /costs would eat/.test(String(t(100,99.5,'long'))), t(100,99.5,'long'));
  ok('the floor is configurable', /num\("MIN_STOP_PCT", 0\.022\)/.test(src));
  ok('an inverted stop is still caught first', /is not below entry/.test(String(t(100,101,'long'))));
}
fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
