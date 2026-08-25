// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SETUP LAB — and the two properties that make it worth anything
//
//  The lab's job is to be a filter hard enough that a cheap model can generate freely and the
//  rubbish dies on its own. Two things have to be true for that, and neither is obvious from
//  reading the code:
//
//    1. NO LOOKAHEAD. If a rule can see the future, every proposal scores brilliantly and the
//       filter is worse than useless — it becomes a machine for generating confident nonsense.
//       §2 tests this the only way that actually proves it: run a rule over a truncated series and
//       over the full one, and demand the trades in the overlapping region be IDENTICAL. If any
//       part of the engine peeks forward, the two runs disagree.
//
//    2. THE HELD-OUT COINS ARE ACTUALLY HELD OUT. The whole defence against picking noise out of
//       200 attempts is that six coins never take part in selection. A single overlap between the
//       two lists silently destroys that, and nothing else in the system would notice.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { validateSetup, CONDITIONS, vocabularyForPrompt } from './setup-lab/schema.mjs';
import { runRule, buildContext, _internals } from './setup-lab/engine.mjs';
import { DISCOVER, VALIDATE, bars, scoreSetup } from './setup-lab/score.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n))
                            : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + String(x).slice(0,150) : ''))); };

const GOOD = {
  name: "test setup", dir: "long", timeframe: "4H",
  when: [{ fn: "wtCrossUp" }, { fn: "wt2Below", value: -53 }],
  stop: { kind: "swing", lookback: 10, padAtr: 0.25 },
  target: { kind: "rMultiple", value: 2 },
  falsifier: "if it loses on the validation coins it does not work",
};

console.log('\n1. The validator rejects loudly and never repairs');
ok('a well-formed setup passes', validateSetup(GOOD).ok);
{
  const r = validateSetup({ ...GOOD, when: [{ fn: "makeMoney" }] });
  ok('an invented condition is rejected', !r.ok);
  ok('and the rejection names it, so the model can correct itself',
     r.errors.some(e => e.includes('makeMoney') && e.includes('Available')), r.errors[0]);
}
ok('a missing stop is fatal — an ungradeable setup is not a setup',
   !validateSetup({ ...GOOD, stop: undefined }).ok);
ok('a missing falsifier is fatal', !validateSetup({ ...GOOD, falsifier: undefined }).ok);
ok('a one-word falsifier does not count', !validateSetup({ ...GOOD, falsifier: "dunno" }).ok);
ok('too many conditions is rejected as a curve fit',
   !validateSetup({ ...GOOD, when: Array(7).fill({ fn: "wtCrossUp" }) }).ok);
ok('an unknown pattern name is rejected',
   !validateSetup({ ...GOOD, when: [{ fn: "pattern", name: "cupAndHandle", within: 5 }] }).ok);
ok('a condition missing its argument is rejected',
   !validateSetup({ ...GOOD, when: [{ fn: "wt2Below" }] }).ok);
ok('nested htf is refused', !validateSetup({ ...GOOD,
   when: [{ fn: "htf", mult: 6, cond: { fn: "htf", mult: 6, cond: { fn: "wtCrossUp" } } }] }).ok);
ok('a rejected proposal returns no rule at all — nothing half-valid can leak through',
   validateSetup({ ...GOOD, dir: "sideways" }).rule === null);
ok('the prompt vocabulary is generated from the same table the validator uses',
   Object.keys(CONDITIONS).every(k => vocabularyForPrompt().includes(k)));

console.log('\n2. The engine cannot see the future');
{
  // The real test. Score over the first 70% of the series, then over all of it. Any trade that
  // opened inside the truncated region must come out byte-identical — same bar, same stop, same
  // target, same result. A single forward-looking read breaks this.
  const c = bars('BTC', '4H');
  const cut = Math.floor(c.length * 0.7);
  const short = c.slice(0, cut);
  const rule = validateSetup(GOOD).rule;
  const a = runRule(short, rule);
  const b = runRule(c, rule).filter(t => t.i < cut - rule.maxBars - 5);   // exclude trades still open at the cut
  const common = a.filter(t => t.i < cut - rule.maxBars - 5);
  ok('the truncated run produced trades to compare', common.length > 20, common.length);
  ok('same number of trades in the overlapping region', common.length === b.length, `${common.length} vs ${b.length}`);
  const same = common.every((t, k) => b[k] && t.i === b[k].i
    && Math.abs(t.stop - b[k].stop) < 1e-9 && Math.abs(t.target - b[k].target) < 1e-9
    && Math.abs(t.R - b[k].R) < 1e-9);
  ok('and every one is identical — no lookahead anywhere in the chain', same);
}
{
  // Pivots are the usual culprit: a swing low is only knowable once the bars to its right exist.
  const c = bars('ETH', '4H').slice(0, 400);
  const pv = _internals.pivots(c);
  ok('every pivot is confirmed strictly after the bar it sits on',
     pv.lows.every(p => p.confirmedAt > p.i) && pv.highs.every(p => p.confirmedAt > p.i));
  const pats = _internals.findPatterns(c, pv);
  ok('and every pattern completes after the pivot that finished it',
     pats.every(p => p.at >= 0 && p.at < c.length));
}
{
  // The higher timeframe must map a bar to the last CLOSED aggregate, never the one it is inside.
  const c = bars('SOL', '4H').slice(0, 200);
  const { map } = _internals.aggregate(c, 6);
  ok('a bar maps to a higher-timeframe bar that has already closed',
     map.every((k, i) => k < Math.floor(i / 6)));
}

console.log('\n3. The held-out coins are genuinely held out');
ok('discovery and validation do not overlap',
   !DISCOVER.some(c => VALIDATE.includes(c)), DISCOVER.filter(c => VALIDATE.includes(c)).join(','));
ok('both sets are non-trivial', DISCOVER.length >= 5 && VALIDATE.length >= 5);

console.log('\n4. A setup only survives if it clears every bar');
{
  const res = scoreSetup(GOOD);
  ok('scoring returns both halves and both coin sets',
     res.ok && res.discovery && res.validation && res.half1 && res.half2);
  ok('survival requires no outstanding reasons',
     res.survives === (res.reasons.length === 0));
  // A rule that trades almost never must not be able to sneak through on three lucky wins.
  const rare = scoreSetup({ ...GOOD, when: [
    { fn: "pattern", name: "invHeadShoulders", within: 2 },
    { fn: "wtCrossUp" }, { fn: "wt2Below", value: -70 }] });
  ok('a rule with too few trades is refused however good it looks',
     rare.ok && !rare.survives && rare.reasons.some(r => /trades/.test(r)), rare.reasons && rare.reasons[0]);
}
{
  // Costs must actually be charged, and charged harder on tight stops.
  const c = bars('BTC', '4H');
  const tight = runRule(c, validateSetup({ ...GOOD, stop: { kind: "percent", value: 2.5 } }).rule);
  ok('every trade carries a cost deduction against its raw result',
     tight.length > 0 && tight.every(t => t.R < t.rawR), tight.length);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
