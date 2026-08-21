// The 2026-08-19 safety build: the circuit breaker that watches the MONEY, and the insight
// scanner that watches the FEATURES. One may stop trades; the other may only ever report.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const out = path.join(process.cwd(), '.breaker-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { breakerStep, insightScan, findAccount, INSIGHT_MIN_N, dayKeyOf, weekKeyOf, nextDayStart, nextWeekStart };\n');
const M = await import(pathToFileURL(out).href);
const T0 = 1787000000000;
// A fixture has to span what the gate now asks for — a fortnight, not a run of milliseconds.
// Both halves of one afternoon are still one afternoon (see BOX_MIN_SPAN_H).
const spread = (i, n = 60) => T0 + i * (14 * 864e5 / Math.max(1, n - 1));
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};
const CFG={dayDD:0.05,weekDD:0.10,streakN:3,streakPauseH:12};
const DAY=864e5;
// a Wednesday mid-week, mid-day, so day and week boundaries are both ahead of us
const NOW=Date.UTC(2026,7,19,10,0,0);

console.log('\n1. Day drawdown trips at the line, not before');
{
  let r=M.breakerStep({}, {now:NOW, equity:1000}, CFG);
  ok('first sight of the day anchors equity', r.st.dayEq===1000 && !r.paused);
  r=M.breakerStep(r.st, {now:NOW+3600e3, equity:951}, CFG);
  ok('down 4.9% — still trading', !r.paused && r.trips.length===0);
  r=M.breakerStep(r.st, {now:NOW+7200e3, equity:950}, CFG);
  ok('down 5.0% — tripped', r.paused && r.trips.includes('dayDD'));
  ok('paused until the next UTC day', r.st.pausedUntil===M.nextDayStart(NOW+7200e3));
  ok('the reason names the numbers', /5\.0% today/.test(r.st.pausedWhy), r.st.pausedWhy);
  const next=M.breakerStep(r.st, {now:M.nextDayStart(NOW)+60e3, equity:950}, CFG);
  ok('a new day releases the pause and re-anchors', !next.paused && next.st.dayEq===950);
}
console.log('\n2. Week drawdown outlasts the day');
{
  let r=M.breakerStep({}, {now:NOW, equity:1000}, CFG);
  r=M.breakerStep(r.st, {now:NOW+3600e3, equity:899}, CFG);
  ok('down 10.1% on the week — tripped', r.paused && r.trips.includes('weekDD'));
  ok('pause reaches Monday, past tomorrow', r.st.pausedUntil>=M.nextWeekStart(NOW) && M.nextWeekStart(NOW)>M.nextDayStart(NOW));
  const tomorrow=M.breakerStep(r.st, {now:M.nextDayStart(NOW)+60e3, equity:899}, CFG);
  ok('still paused the next day', tomorrow.paused);
}
console.log('\n3. Three consecutive losses pause; a win resets the count');
{
  let r=M.breakerStep({}, {now:NOW, equity:null, resolvedHows:['stop','closed at a loss']}, CFG);
  ok('two losses — counting, not paused', r.st.streak===2 && !r.paused);
  r=M.breakerStep(r.st, {now:NOW, equity:null, resolvedHows:['target']}, CFG);
  ok('a target hit resets the streak', r.st.streak===0);
  r=M.breakerStep(r.st, {now:NOW, equity:null, resolvedHows:['stop','stop','closed at a loss']}, CFG);
  ok('three in a row trips', r.paused && r.trips.includes('streak'));
  ok('for the configured hours', r.st.pausedUntil===NOW+12*3600e3);
  r=M.breakerStep(r.st, {now:NOW, equity:null, resolvedHows:['closed']}, CFG);
  ok('a neutral close neither counts nor resets', r.st.streak===0 && r.paused);
}
console.log('\n4. No balance visible = drawdown arms hold their fire');
{
  let r=M.breakerStep({}, {now:NOW, equity:null}, CFG);
  ok('no anchor is invented', r.st.dayEq==null && !r.paused);
  r=M.breakerStep(r.st, {now:NOW+3600e3, equity:1000}, CFG);
  ok('the anchor is taken the moment a balance appears', r.st.dayEq===1000);
  const r2=M.breakerStep({dayKey:M.dayKeyOf(NOW),dayEq:0,weekKey:M.weekKeyOf(NOW),weekEq:0}, {now:NOW, equity:500}, CFG);
  ok('a zero anchor can never divide-by-zero into a trip', !r2.paused);
}
console.log('\n5. The breaker only ever blocks NEW entries');
{
  ok('the skip sits in the placement branch, after planValid', src.indexOf('CIRCUIT BREAKER — ') > src.indexOf('const bad = planValid(t)'));
  ok('and before the order is built', src.indexOf('if (BREAKER.paused)') < src.indexOf('const built = buildOrder(t);'));
  const breakerFn = src.slice(src.indexOf('function breakerStep'), src.indexOf('\n}', src.indexOf('function breakerStep')));
  ok('breakerStep touches no order function', !/execOrder|directOrder|buildOrder|cancelOrder|closeOrderFor/.test(breakerFn));
  ok('exits/expiry/de-hedge run before the breaker check', src.indexOf('resolveHedges(positions)') < src.indexOf('let BREAKER'));
  ok('a breaker skip does not burn the coin for the day', src.indexOf('if (BREAKER.paused)') < src.indexOf('fired[key] = Date.now()'));
  ok('thresholds are configurable', /num\("BREAKER_DAY_DD_PCT", 5\)/.test(src) && /num\("BREAKER_WEEK_DD_PCT", 10\)/.test(src) && /num\("BREAKER_STREAK_N", 3\)/.test(src));
}
console.log('\n6. findAccount digs the balance out of a nested venue response');
{
  const resp={data:{data:{account:{accountBalanceRv:'987.65',userID:1},positions:[]}}};
  const a=M.findAccount(resp);
  ok('found at depth', a && a.accountBalanceRv==='987.65');
  ok('absent balance returns null, never a guess', M.findAccount({data:{positions:[]}})===null);
}
console.log('\n7. Insight scanner — stability is the bar, same as everything else');
{
  const rec=(over,{dir='long',tf='1D',note='rollover',quality=5.5,breadth=0.5,regDist=5,R=1})=>
    Array.from({length:over},(_,i)=>({arm:'baseline',at:spread(i,over),dir,tf,note,quality,breadth,regDist,R}));
  // 40 winners on 4H vs 40 losers on 1H — both stable, opposite signs
  const rows=M.insightScan([...rec(40,{tf:'4H',R:0.5}), ...rec(40,{tf:'1H',R:-0.5})]);
  const h4=rows.find(r=>r.feature==='timeframe'&&r.bucket==='4H');
  const h1=rows.find(r=>r.feature==='timeframe'&&r.bucket==='1H');
  ok('a stable winner is flagged', h4 && h4.stable && h4.meanR>0);
  ok('a stable loser is flagged too — losers are insights', h1 && h1.stable && h1.meanR<0);
  // sign flips across halves = not an insight, however good the full-sample mean looks
  // The second group must come AFTER the first in time, not overlap it — otherwise the two
  // sets interleave when sorted and each half ends up holding a mix, which is not a flip.
  const flip=[...rec(20,{note:'divergence',R:2}), ...rec(20,{note:'divergence',R:-1}).map(r=>({...r,at:r.at+15*864e5}))];
  const f=M.insightScan(flip).find(r=>r.feature==='detector'&&r.bucket==='divergence');
  ok('a bucket that flips halves is never stable', f && !f.stable && f.meanR>0);
  const thin=M.insightScan(rec(29,{R:1})).find(r=>r.feature==='timeframe');
  ok('n=29 is below the bar however clean it looks', thin && !thin.stable);
  const ungraded=M.insightScan([{arm:'baseline',at:0,dir:'long',R:null}]);
  ok('ungraded records are excluded entirely', ungraded.every(r=>r.n===0)||ungraded.length===0);
  const variant=M.insightScan(rec(40,{R:1}).map(r=>({...r,arm:'variant'})));
  ok('variant-arm records never leak in', variant.every(r=>r.n===0)||variant.length===0);
}
console.log('\n8. The scanner measures and decides nothing');
{
  const block=src.slice(src.indexOf('INSIGHT SCAN ─'), src.indexOf('await saveShadow(SHADOW);', src.indexOf('INSIGHT SCAN ─')));
  ok('present in the shadow pass', block.length>100);
  ok('no order function appears in it', !/execOrder|directOrder|buildOrder\(/.test(block));
  ok('features are pre-registered as a fixed list', /const INSIGHT_FEATURES = \[/.test(src));
  ok('a change in the stable set is logged as evidence', /shadow: "insight_scan", result: "EVIDENCE"/.test(src));
  ok('the log entry says it filters nothing', /Still advisory — nothing is filtered/.test(block));
}
fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
