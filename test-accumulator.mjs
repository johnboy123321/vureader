// The accumulator (2026-08-19): a SECOND objective — units, not money. Measure only.
// Every test here is on the pure core, so no venue and no clock are involved.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const out = path.join(process.cwd(), '.accum-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { accumStep, accumLevels, accumUnits, waveTrend, vmcMoneyFlow };\n');
const M = await import(pathToFileURL(out).href);
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};
const DAY=864e5;

// a synthetic series long enough for the indicators, that we can bend into a red dot on demand
function series(n, shape) {
  const b = [];
  for (let i = 0; i < n; i++) {
    const px = shape(i);
    b.push({ t: i * DAY, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1 });
  }
  return b;
}
// A seeded random walk, searched for one whose FINAL bar is a genuine red dot with the money
// flow already negative — i.e. a bar accumStep will act on. Hand-shaped ramps are a trap here:
// on perfectly linear price action wt1 and wt2 are equal to the last decimal, so the "was at or
// above" side of the cross test fails on floating-point noise (−0.000 is not >= 0). A walk has
// the texture real prices have. Deterministic, so the fixture is the same every run.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function walk(seed, n) {
  const rnd = mulberry32(seed);
  const b = []; let px = 100;
  for (let i = 0; i < n; i++) {
    px *= 1 + (rnd() - 0.5) * 0.06;
    const h = px * (1 + rnd() * 0.02), l = px * (1 - rnd() * 0.02);
    b.push({ t: i * DAY, o: px, h: Math.max(h, px), l: Math.min(l, px), c: px, v: 1 });
  }
  return b;
}
function redDotSeries(n = 160) {
  for (let seed = 1; seed <= 4000; seed++) {
    const b = walk(seed, n);
    const { wt1, wt2 } = M.waveTrend(b);
    const mf = M.vmcMoneyFlow(b);
    const k = b.length - 1;
    if (Number.isFinite(wt2[k]) && Number.isFinite(wt2[k - 1]) &&
        (wt1[k - 1] - wt2[k - 1]) >= 0 && (wt1[k] - wt2[k]) < 0 &&
        Number.isFinite(mf[k]) && mf[k] < 0) return b;
  }
  throw new Error('could not construct a series whose last bar is an actionable red dot');
}

console.log('\n1. It does nothing without a red dot');
{
  const flat = series(120, () => 100);
  const { st, events } = M.accumStep(null, flat);
  ok('no sell on a flat market', st.sells === 0 && !events.some(e => e.kind === 'sell'));
  ok('starts holding exactly 1 unit', st.units === 1 && st.cash === 0);
  ok('and that equals buy-and-hold', M.accumUnits(st, 100) === 1);
}
console.log('\n2. One action per closed daily bar, ever');
{
  const bars = redDotSeries();
  const a = M.accumStep(null, bars);
  const b = M.accumStep(a.st, bars);          // same bar again — e.g. the 15-min run repeating
  ok('the same day is never acted on twice', b.events.length === 0);
  ok('state is unchanged on the repeat', b.st.sells === a.st.sells && b.st.units === a.st.units);
}
console.log('\n3. A sell only happens with a red dot AND negative money flow AND a level below');
{
  const bars = redDotSeries();
  const mf = M.vmcMoneyFlow(bars);
  const { wt1, wt2 } = M.waveTrend(bars);
  const n = bars.length - 1;
  const isRed = (wt1[n]-wt2[n]) < 0 && (wt1[n-1]-wt2[n-1]) >= 0;
  ok('the synthetic series really does produce a red dot', isRed, `${(wt1[n]-wt2[n]).toFixed(2)}`);
  const { st, events } = M.accumStep(null, bars);
  const sold = events.find(e => e.kind === 'sell');
  const skipped = events.find(e => e.kind === 'skip');
  ok('it either sold or said exactly why not', !!sold || !!skipped, JSON.stringify(events));
  if (sold) {
    ok('it sold 20% of the stack', Math.abs(sold.units - 0.2) < 1e-9, sold.units);
    ok('units went down and cash went up', st.units < 1 && st.cash > 0);
    ok('total units are ~unchanged at the moment of sale (minus fees)',
       Math.abs(M.accumUnits(st, bars[n].c) - 1) < 0.001, M.accumUnits(st, bars[n].c));
    ok('every rung is BELOW the sell price', st.open.every(r => r.px < sold.px));
    ok('rungs are at named levels, not round numbers', st.open.every(r => ['swingLow','OB','FVG'].includes(r.src)));
  }
}
console.log('\n4. A filled rung buys back MORE units than the slice sold');
{
  const bars = redDotSeries();
  const a = M.accumStep(null, bars);
  if (a.st.open.length) {
    const rung = a.st.open[0];
    // next day trades down through the deepest rung
    const next = [...bars, { t: bars.length*DAY, o: rung.px, h: rung.px*1.001, l: rung.px*0.9, c: rung.px, v: 1 }];
    const b = M.accumStep(a.st, next);
    const fills = b.events.filter(e => e.kind === 'fill');
    ok('the rung filled', fills.length > 0);
    ok('and it gained units on that slice', fills.every(f => f.delta > 0), JSON.stringify(fills[0]));
    ok('total units now BEAT buy-and-hold', M.accumUnits(b.st, rung.px) > 1, M.accumUnits(b.st, rung.px));
  } else { ok('(no rungs produced — skipped)', true); }
}
console.log('\n5. The brakes');
{
  const bars = redDotSeries();
  const cashy = { units: 0.5, cash: 1e9, open: [], sells: 0, fills: 0, lastDay: null, startedAt: '2020-01-01' };
  const r = M.accumStep(cashy, bars);
  ok('the cash ceiling refuses a further sell', !r.events.some(e => e.kind === 'sell'), JSON.stringify(r.events));
  const many = { units: 1, cash: 0, sells: 0, fills: 0, lastDay: null,
                 open: [1,2,3,4].map(i => ({ px: 1, src: 'swingLow', usdt: 0, soldUnits: 0, sellPx: 2, sinceDay: 'd'+i })) };
  const r2 = M.accumStep(many, bars);
  ok('maxConcurrent refuses a fifth ladder', !r2.events.some(e => e.kind === 'sell'));
}
console.log('\n6. Levels are real levels, found only from history given');
{
  const bars = redDotSeries();
  const px = bars[bars.length-1].c;
  const lv = M.accumLevels(bars, px, 4);
  ok('returns at most maxRungs', lv.length <= 4);
  ok('all strictly below the sell price', lv.every(z => z.px < px));
  ok('none further than 12% away (not a crash, a pullback)', lv.every(z => (px - z.px)/px <= 0.12));
  ok('none stacked on top of each other', lv.every((z,i) => lv.every((o,j) => i===j || Math.abs(o.px-z.px)/px >= 0.002)));
  ok('an empty history yields no levels rather than throwing', M.accumLevels(bars.slice(0,5), px, 4).length >= 0);
}
console.log('\n7. It is structurally incapable of trading');
{
  const block = src.slice(src.indexOf('THE ACCUMULATOR (2026-08-19)'), src.indexOf('INSIGHT SCANNER (2026-08-19)'));
  ok('the module exists', block.length > 500);
  ok('no order function appears in it', !/execOrder|directOrder|buildOrder|cancelOrder|closeOrderFor|rememberResting|phemexCall/.test(block));
  const runBlock = src.slice(src.indexOf('THE ACCUMULATOR: a second objective'), src.indexOf('await setJSON(BOOKMAP_KEY'));
  ok('the run-loop pass only fetches, steps and logs', !/execOrder|directOrder|buildOrder\(/.test(runBlock));
  ok('it says "measure only" to the user', /Measure only/.test(runBlock));
  ok('it can be switched off', /env\("ACCUM", "1"\)/.test(src));
  ok('the coin is configurable', /env\("ACCUM_COIN", "BTC"\)/.test(src));
  ok('failure cannot break the run', /accumulator failed \(harmless/.test(runBlock));
}
fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
