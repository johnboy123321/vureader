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
  for (let i = 0; i < 60; i++) recs.push(rec('long', 'bear', i < 30 ? 8.1 : -0.5, 1000 + i));
  const v = M.regimeVerdict(recs);
  ok('the full-sample mean does look good', v.boxes['long|bear'].meanR > 3, v.boxes['long|bear'].meanR);
  ok('but the halves disagree', v.boxes['long|bear'].firstHalf > 0 && v.boxes['long|bear'].secondHalf < 0);
  ok('so it is NOT believed', v.trustworthy.length === 0);
  ok('and the experiment reports itself as not ready', v.ready === false);
}

console.log('\n3. A box that holds in both halves is believed');
{
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(rec('short', 'bull', i % 3 === 0 ? 2.25 : -0.4, 1000 + i));
  const v = M.regimeVerdict(recs);
  const t = v.trustworthy.find(x => x.box === 'short|bull');
  ok('it is picked up', !!t);
  ok('both halves agree on the sign', t && (t.firstHalf > 0) === (t.secondHalf > 0));
  ok('and it is labelled by what it does', t && (t.meanR > 0 ? t.sign === 'pays' : t.sign === 'costs'));
}

console.log('\n4. Sample-size floor');
{
  const recs = [];
  for (let i = 0; i < M.REGIME_MIN_PER_BOX * 2 - 1; i++) recs.push(rec('long', 'bull', 2.0, 1000 + i));
  ok('one short of the floor is not believed, however good', M.regimeVerdict(recs).trustworthy.length === 0);
  recs.push(rec('long', 'bull', 2.0, 9999));
  ok('at the floor it is', M.regimeVerdict(recs).trustworthy.length === 1);
}

console.log('\n5. Only real, resolved, live-rule decisions count');
{
  const recs = [
    ...Array.from({ length: 60 }, (_, i) => rec('long', 'bull', 1, i)),
    ...Array.from({ length: 60 }, (_, i) => ({ ...rec('long', 'bull', 1, i), arm: 'variant' })),
    ...Array.from({ length: 20 }, (_, i) => rec('long', 'bull', null, i)),      // ungraded
    ...Array.from({ length: 20 }, (_, i) => rec('long', null, 1, i)),           // no regime known
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
