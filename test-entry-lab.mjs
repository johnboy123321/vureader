// THE FOUR-WAY SPLIT AND THE ENTRY LAB (2026-08-20)
// John and Codex: "data hygiene, do it now" — execution failures and hand-closed positions must
// not pollute signal statistics or trip the circuit breaker as though the strategy was wrong.
// Then three entry arms, shadow only, to answer one question: bad signals or late entries?
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js', 'utf8');
const out = path.join(process.cwd(), '.lab-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { classifyResolution, resolvedSince, entryArmPlan, entryArmResolve, breakerStep, ENTRY_ARMS };\n');
const M = await import(pathToFileURL(out).href);
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+JSON.stringify(x):'')));};

const LONG = { coin:'SOL', dir:'long', plan:{ entry:100, stop:95, target:110 } };
const SHORT = { coin:'SOL', dir:'short', plan:{ entry:100, stop:105, target:90 } };

console.log('\n  1. THE FOUR-WAY SPLIT');
{
  const t = M.classifyResolution(LONG, 111, { hi:112, lo:99 });
  ok('a target the price traded through is a strategy WIN', t.how==='target' && t.outcome==='win' && t.klass==='strategy');
  ok('and it counts', t.countsForStreak && t.countsForStats);

  const st = M.classifyResolution(LONG, 94, { hi:101, lo:93 });
  ok('a stop that was traded through is a strategy LOSS', st.how==='stop' && st.outcome==='loss' && st.klass==='strategy');
  ok('and it counts', st.countsForStreak);

  // THE BUG THIS FIXES: closed by hand in profit, price then slipped under entry.
  const hand = M.classifyResolution(LONG, 99, { hi:104, lo:98 });
  ok('an exit at neither level is closed_by_hand', hand.how==='closed_by_hand', hand.how);
  ok('it is an EXECUTION ARTIFACT, not a loss', hand.klass==='execution_artifact' && hand.outcome==='unattributed');
  ok('it does NOT feed the loss streak', hand.countsForStreak===false);
  ok('it does NOT feed the strategy record', hand.countsForStats===false);
  ok('it still says which way it was when we looked', /was in loss when we looked/.test(hand.why), hand.why);

  const noPlan = M.classifyResolution({ coin:'SOL', dir:'long' }, 99, null);
  ok('a plan-less position grades nothing', noPlan.klass==='execution_artifact' && noPlan.countsForStreak===false);
  ok('and says why', /nothing to grade it against/.test(noPlan.why));

  const both = M.classifyResolution(LONG, 100, { hi:112, lo:94 });
  ok('both levels touched is admitted as unrecoverable', both.how==='ambiguous' && both.klass==='execution_artifact');
  ok('rather than guessed at', both.outcome==='unattributed' && both.countsForStreak===false);

  const sh = M.classifyResolution(SHORT, 89, { hi:101, lo:88 });
  ok('shorts are graded the right way round', sh.how==='target' && sh.outcome==='win');
  const shs = M.classifyResolution(SHORT, 106, { hi:107, lo:99 });
  ok('and their stops too', shs.how==='stop' && shs.outcome==='loss');
}

console.log('\n  2. NO RANGE? SAY SO, DO NOT PRETEND');
{
  const snap = M.classifyResolution(LONG, 111, null);
  ok('with no range it falls back to the snapshot', snap.how==='target');
  const missed = M.classifyResolution(LONG, 100, null);
  ok('and a mid-price snapshot is an artifact, not a coin toss', missed.klass==='execution_artifact');
}

console.log('\n  3. THE BREAKER ONLY EATS REAL LOSSES');
{
  // three hand-closes in a row must NOT pause trading
  let st = {};
  const artifacts = ['closed_by_hand','closed_by_hand','closed_by_hand','ambiguous','closed'];
  let b = M.breakerStep(st, { now: Date.now(), equity: null, resolvedHows: artifacts });
  ok('artifacts never trip the streak', !b.trips.includes('streak'), b.trips);
  ok('and never increment it', !(b.st.streak > 0), b.st.streak);
  // three real stops must
  b = M.breakerStep({}, { now: Date.now(), equity: null, resolvedHows: ['stop','stop','stop'] });
  ok('three real stops still trip it', b.trips.includes('streak'));
}

console.log('\n  4. THE THREE ENTRY ARMS');
{
  // a rising series with a pullback, so a retest has something to fill against
  const bars = [];
  let px = 100;
  for (let i=0;i<80;i++){ px += (i%7===0?-1.2:0.5); bars.push({t:i*36e5,o:px,h:px*1.004,l:px*0.996,c:px,v:1}); }
  const sig = { coin:'SOL', dir:'long', entry: px, stop: px*0.96, target: px*1.08, tf:'1H', at: bars[79].t, triggerPx: px*0.995 };
  const plan = M.entryArmPlan(sig, bars, { chaseAtr: 1.0, expireBars: 12 });
  ok('a plan is produced', !!plan);
  ok('exactly three arms', plan.arms.length===3, plan.arms.map(a=>a.arm));
  ok('the arm names match the agreed three', JSON.stringify(plan.arms.map(a=>a.arm))===JSON.stringify(M.ENTRY_ARMS));
  ok('only the live arm is marked live', plan.arms.filter(a=>a.live).length===1);
  ok('the live arm is immediate_marketable', plan.arms.find(a=>a.live).arm==='immediate_marketable');
  ok('the retest arm carries an expiry', Number.isFinite(plan.arms[1].expireBars));
  ok('the no-chase arm records how far price had run', Number.isFinite(plan.arms[2].travelledAtr));
}

console.log('\n  5. NO-CHASE RECORDS THE SKIP, IT DOES NOT VANISH');
{
  const bars = [];
  let px = 100;
  for (let i=0;i<80;i++){ px *= 1.001; bars.push({t:i*36e5,o:px,h:px*1.002,l:px*0.998,c:px,v:1}); }
  // entry a long way above the trigger = chased
  const far = { coin:'X', dir:'long', entry: px*1.15, stop: px*0.98, target: px*1.3, triggerPx: px };
  const plan = M.entryArmPlan(far, bars, { chaseAtr: 0.5 });
  const nc = plan.arms.find(a=>a.arm==='no_chase_filter');
  ok('a chased entry is skipped', nc.skipped===true);
  ok('with the distance recorded', nc.travelledAtr > 0.5, nc.travelledAtr);
  ok('and a reason a human can read', /already run/.test(nc.note), nc.note);
  const r = M.entryArmResolve({ ...nc, dir:'long' }, bars);
  ok('the resolver keeps it as a skip, not a miss', r.skipped===true && r.wouldFill===false);
}

console.log('\n  6. STRUCTURE RETESTS EXPIRE');
{
  const fwd = [];
  let px = 100;
  for (let i=0;i<40;i++){ px += 0.4; fwd.push({t:i*36e5,o:px,h:px*1.002,l:px*0.999,c:px,v:1}); }  // never comes back
  const intent = { arm:'structure_retest', dir:'long', wants: 95, stop: 92, target: 110, expireBars: 12 };
  const r = M.entryArmResolve(intent, fwd);
  ok('a retest that never fills expires', r.expired===true);
  ok('and is NOT counted as a fill', r.wouldFill===false);
  ok('an expiry is not a win and not a loss', !r.hitTarget && !r.hitStop);

  const back = [{t:0,o:100,h:100,l:94,c:96},{t:1,o:96,h:112,l:96,c:111}];
  const r2 = M.entryArmResolve({ ...intent, wants:95 }, back);
  ok('a retest that does fill is recorded with its bar', r2.wouldFill===true && r2.fillBar===0);
  ok('and its price is the level, not the close', r2.fillPx===95);
  ok('and it can then reach target', r2.hitTarget===true);
}

console.log('\n  7. EVERY ARM LOGS FILL / NO-FILL AND EXCURSIONS');
{
  const fwd = [{t:0,o:100,h:104,l:99,c:103},{t:1,o:103,h:106,l:97,c:98}];
  const r = M.entryArmResolve({ arm:'immediate_marketable', dir:'long', wants:100, stop:95, target:120 }, fwd);
  ok('wouldFill is always present', typeof r.wouldFill==='boolean');
  ok('MFE is recorded in R', r.mfeR > 0, r.mfeR);
  ok('MAE is recorded in R', r.maeR > 0, r.maeR);
  ok('MAE is measured from the entry, not the low of the series', r.maeR === +((100-97)/5).toFixed(3), r.maeR);
}

console.log('\n  8. THE PATTERN TAXONOMY IS REFERENCE-ONLY');
{
  ok('no pattern tags are wired into the agent', !/bull_flag|head_shoulders_top|dragonfly_doji|golden_cross/.test(src));
  ok('the lab does not filter, score or size', !/ENTRY_ARMS[\s\S]{0,4000}sizeFor|promote\(/.test(src.slice(src.indexOf('const ENTRY_ARMS'), src.indexOf('const ENTRY_ARMS')+4000)));
  ok('only one arm is ever live', (src.match(/live: true/g)||[]).length===1);
}

fs.unlinkSync(out);
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
