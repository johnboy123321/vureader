// The regime experiment must MEASURE and never ACT, and it must refuse to believe a box that
// only looks good on the full sample — which is exactly how the idea failed when it was tested
// against three years of history on 2026-08-17.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'cipher-agent-valtown.js';
const src = fs.readFileSync(SRC, 'utf8');
const BOOT = /\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/;
if (!BOOT.test(src)) throw new Error('could not find the Node bootstrap to strip');
const out = path.join(process.cwd(), '.regime-under-test.mjs');
fs.writeFileSync(out, src.replace(BOOT, '\n') +
  '\nexport { regimeBoxes, regimeVerdict, regimeBreadthTally, smaAt, REGIME_MA, REGIME_MIN_PER_BOX, shadowRecord, shadowSlot };\n');
const M = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + x : ''))); };

const T0 = 1787000000000, DAY = 864e5;
// A fixture has to span what the gate now asks for — a fortnight, not a run of milliseconds.
// Both halves of one afternoon are still one afternoon (see BOX_MIN_SPAN_H).
const spread = (i, n = 60) => T0 + i * (14 * DAY / Math.max(1, n - 1));
const rec = (dir, reg, R, at) => ({ arm: 'baseline', dir, reg, R, at });

console.log('\n1. It cannot place, block or resize anything');
{
  // Every order path in the agent runs through buildOrder/execOrder. The regime block must not
  // appear anywhere near them, or "measurement only" is just a comment.
  // Boundary note: slice to the section that FOLLOWS the regime code, not to a distant marker.
  // A far-away end marker silently swallows whatever gets added in between later (it did — the
  // accumulator and spot rails landed inside this slice on 2026-08-19 and failed this assertion
  // for the right reason). The length guard makes a future reorder fail loudly rather than pass.
  const rStart = src.indexOf('MARKET REGIME (measurement only)');
  const rEnd = src.indexOf('THE ACCUMULATOR (2026-08-19)', rStart);
  const block = src.slice(rStart, rEnd > rStart ? rEnd : src.indexOf('const SHADOW_KEY', rStart));
  ok('the regime slice is sane (guards against a reorder)', block.length > 500 && block.length < 8000, block.length);
  ok('the regime section calls no order function', !/buildOrder|execOrder|directOrder|phemexCall|relay\(/.test(block));
  ok('and it is not referenced by any guard in the scan loop',
     !/(opposes|held\.has|sameDir|placedToday)[^\n]*REGIME/.test(src));
  const guardArea = src.slice(src.indexOf('const key = `${coin}|${sig.bias}|${day}`'), src.indexOf('const built = buildOrder(t)'));
  ok('no regime term sits between the signal and the order', !/REGIME|regime/i.test(guardArea), guardArea.match(/regime/i));
  ok('the run tags records but never filters rankPool', !/rankPool[^\n]*REGIME/.test(src));
}

console.log('\n2. The average alone is not enough');
{
  // A box that pays handsomely for its first half and gives it all back — the real 2024/25
  // pattern — must NOT be reported as trustworthy however good the overall mean looks.
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(rec('long', 'bear', i < 30 ? 8.1 : -0.5, spread(i)));
  const v = M.regimeVerdict(recs);
  ok('the full-sample mean does look good', v.boxes['long|bear'].meanR > 3, v.boxes['long|bear'].meanR);
  ok('but the halves disagree', v.boxes['long|bear'].firstHalf > 0 && v.boxes['long|bear'].secondHalf < 0);
  ok('so it is NOT believed', v.trustworthy.length === 0);
  ok('and the experiment reports itself as not ready', v.ready === false);
}

console.log('\n3. A box that holds in both halves is believed');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(rec('short', 'bull', i % 3 === 0 ? 2.25 : -0.4, spread(i)));
  const v = M.regimeVerdict(recs);
  const t = v.trustworthy.find(x => x.box === 'short|bull');
  ok('it is picked up', !!t);
  ok('both halves agree on the sign', t && (t.firstHalf > 0) === (t.secondHalf > 0));
  ok('and it is labelled by what it does', t && (t.meanR > 0 ? t.sign === 'pays' : t.sign === 'costs'));
}

console.log('\n4. Sample-size floor');
{
  const recs = [];
  const NEED = M.REGIME_MIN_PER_BOX * 2;
  for (let i = 0; i < NEED - 1; i++) recs.push(rec('long', 'bull', 2.0, spread(i, NEED)));
  ok('one short of the floor is not believed, however good', M.regimeVerdict(recs).trustworthy.length === 0);
  recs.push(rec('long', 'bull', 2.0, spread(NEED - 1, NEED)));
  ok('at the floor it is', M.regimeVerdict(recs).trustworthy.length === 1);
}

console.log('\n5. Only real, resolved, live-rule decisions count');
{
  const recs = [
    ...Array.from({ length: 60 }, (_, i) => rec('long', 'bull', 1, spread(i))),
    ...Array.from({ length: 60 }, (_, i) => ({ ...rec('long', 'bull', 1, spread(i)), arm: 'variant' })),
    ...Array.from({ length: 20 }, (_, i) => rec('long', 'bull', null, spread(i))),      // ungraded
    ...Array.from({ length: 20 }, (_, i) => rec('long', null, 1, spread(i))),           // no regime known
  ];
  const b = M.regimeBoxes(recs)['long|bull'];
  ok('variant-arm records are excluded', b.n === 60, b.n);
  ok('ungraded records are excluded', b.n === 60);
  ok('records with no regime are excluded', b.n === 60);
}

console.log('\n6. The regime reading itself');
{
  const up = Array.from({ length: 260 }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: 100 + i, v: 1 }));
  ok('a rising series sits above its 200D average', up[up.length-1].c > M.smaAt(up, M.REGIME_MA));
  const down = Array.from({ length: 260 }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: 400 - i, v: 1 }));
  ok('a falling series sits below it', down[down.length-1].c < M.smaAt(down, M.REGIME_MA));
  ok('too little history gives no reading, not a guess', M.smaAt(up.slice(0, 100), M.REGIME_MA) === null);

  const reg = { label: 'bull', breadth: null };
  M.regimeBreadthTally(reg, up);
  M.regimeBreadthTally(reg, down);
  ok('breadth counts one up and one down as 0.5', reg.breadth === 0.5, reg.breadth);
  M.regimeBreadthTally(reg, up.slice(0, 50));
  ok('a coin with too little history does not distort breadth', reg.breadth === 0.5, reg.breadth);
}

console.log('\n7. Records carry what the boxes need');
{
  const sh = {};
  M.shadowRecord(sh, 'rank_vs_threshold', 'baseline',
    { coin: 'SOL', dir: 'long', entry: 100, sl: 95, tp2: 111, planTf: '4H' },
    { quality: 5.5, note: 'divergence', reg: 'bear', regDist: -12.4, breadth: 0.32 });
  const r = sh['rank_vs_threshold'].records[0];
  ok('the regime is stamped on', r.reg === 'bear');
  ok('so is the distance from the line', r.regDist === -12.4);
  ok('and breadth', r.breadth === 0.32);
  ok('R starts empty — nothing is graded at decision time', r.R === null);
}

fs.unlinkSync(out);
console.log('\n7. BOTH HALVES OF ONE AFTERNOON ARE STILL ONE AFTERNOON (2026-08-21)');
{
  // The live book on 2026-08-21: every long won, every short lost, across 35 hours. Splitting
  // that down the middle gives two halves that agree perfectly — because they are the same
  // rally twice. "relative_strength" duly reported "fighting the field pays, 2.25R over 91".
  const oneAfternoon = [];
  for (let i = 0; i < 120; i++) oneAfternoon.push(rec('long', 'bull', 2.25, T0 + i * 1000));
  const v = M.regimeVerdict(oneAfternoon);
  const b = v.boxes['long|bull'];
  ok('the sample is plenty big', b.n === 120);
  ok('and both halves agree perfectly', b.firstHalf === b.secondHalf && b.firstHalf > 0);
  ok('the old gate would have believed it', b.n >= M.REGIME_MIN_PER_BOX * 2 && b.firstHalf > 0 === b.secondHalf > 0);
  ok('but it spans almost nothing', b.spanH < 1, b.spanH);
  ok('so it is NOT believed', v.trustworthy.length === 0);
  ok('and the box carries its span, so the reason is visible', Number.isFinite(b.spanH));

  // The same shape, spread over a month, IS evidence.
  const overAMonth = [];
  for (let i = 0; i < 120; i++) overAMonth.push(rec('long', 'bull', i % 3 === 0 ? 2.25 : -0.4, T0 + i * (30 * DAY / 119)));
  const v2 = M.regimeVerdict(overAMonth);
  ok('a month of the same evidence is believed', v2.trustworthy.length === 1, JSON.stringify(v2.boxes['long|bull']));
  ok('and its span is reported', v2.boxes['long|bull'].spanH > 168);

  // Exactly at the bar.
  const atBar = [];
  for (let i = 0; i < 120; i++) atBar.push(rec('short', 'bear', 1.5, T0 + i * (168 * 36e5 / 119)));
  ok('exactly one week qualifies', M.regimeVerdict(atBar).trustworthy.length === 1);
  const under = [];
  for (let i = 0; i < 120; i++) under.push(rec('short', 'bear', 1.5, T0 + i * (167 * 36e5 / 119)));
  ok('one hour short of a week does not', M.regimeVerdict(under).trustworthy.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
