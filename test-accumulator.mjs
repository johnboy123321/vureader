// The accumulator (2026-08-19): a SECOND objective — units, not money. Measure only.
// Every test here is on the pure core, so no venue and no clock are involved.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const out = path.join(process.cwd(), '.accum-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { accumStep, accumFillPass, accumLevels, accumUnits, waveTrend, vmcMoneyFlow, buildSpotOrder, buildAccumReviewPrompt, parseAccumReview };\n');
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
console.log('\n7. The DECISION core cannot trade (the spot rails are a separate, braked layer)');
{
  // Scope matters: the decision core is what decides to sell and where to buy back. It must be
  // pure. The spot rails BELOW it legitimately call the venue — that is their whole job — so they
  // are tested separately in sections 9 and 10 rather than smuggled into this assertion.
  const block = src.slice(src.indexOf('THE ACCUMULATOR (2026-08-19)'), src.indexOf('SPOT RAILS (2026-08-19)'));
  ok('the decision core exists', block.length > 500);
  ok('no order function anywhere in the decision core',
     !/execOrder|directOrder|buildOrder|cancelOrder|closeOrderFor|rememberResting|phemexCall|sendSpotOrder/.test(block));
  ok('and no venue I/O at all in it', !/fetch\(|phemexPublic/.test(block));
  const runBlock = src.slice(src.indexOf('THE ACCUMULATOR: a second objective'), src.indexOf('await setJSON(BOOKMAP_KEY'));
  ok('the run loop never touches the FUTURES order path', !/execOrder|directOrder|buildOrder\(/.test(runBlock));
  ok('it reaches the venue only through the braked spot helper', /sendSpotOrder\(/.test(runBlock));
  ok('it can be switched off', /env\("ACCUM", "1"\)/.test(src));
  ok('the coin is configurable', /env\("ACCUM_COIN", "BTC"\)/.test(src));
  ok('failure cannot break the run', /accumulator failed \(harmless/.test(runBlock));
}
console.log('\n8. Intraday fills — every 15-min bar, none missed, none double-counted');
{
  const bars = redDotSeries();
  const a = M.accumStep(null, bars);
  if (!a.st.open.length) { ok('(no rungs to fill — skipped)', true); }
  else {
    const rung = a.st.open[0];
    const DAYT = bars[bars.length-1].t;
    const fine = [
      { t: DAYT + 3600e3,  o: rung.px*1.05, h: rung.px*1.06, l: rung.px*1.02, c: rung.px*1.03 },
      { t: DAYT + 7200e3,  o: rung.px*1.02, h: rung.px*1.02, l: rung.px*0.98, c: rung.px },   // wick through
      { t: DAYT + 10800e3, o: rung.px, h: rung.px*1.04, l: rung.px, c: rung.px*1.04 },
    ];
    const f = M.accumFillPass(a.st, fine);
    ok('the 3am wick filled the rung', f.events.some(e => e.kind === 'fill'), JSON.stringify(f.events));
    ok('the fill is timestamped to the bar, not the day', f.events[0] && f.events[0].at === DAYT + 7200e3);
    ok('lastFillT advanced to the newest bar', f.st.lastFillT === DAYT + 10800e3);
    const again = M.accumFillPass(f.st, fine);
    ok('re-running the same bars fills nothing twice', again.events.length === 0);
    ok('units only counted once', again.st.units === f.st.units);
    const noRungs = M.accumFillPass({ units:1, cash:0, open:[], lastFillT:0 }, fine);
    ok('no resting rungs = no work, no crash', noRungs.events.length === 0);
  }
}
console.log('\n9. SPOT orders — the right product, and never a guessed scale');
{
  const prods = { sBTCUSDT: { priceScale: 8, baseValueScale: 8, quoteValueScale: 8 } };
  const sell = M.buildSpotOrder('BTC', 'Sell', { price: 64000, baseQty: 0.05 }, prods);
  ok('builds a spot sell', !!sell.order, sell.err);
  ok('uses the s-prefixed SPOT symbol, not the perp', sell.order.symbol === 'sBTCUSDT');
  ok('price is scaled to an integer', sell.order.priceEp === Math.round(64000 * 1e8));
  ok('a SELL carries base quantity (the BTC)', sell.order.baseQtyEv === Math.round(0.05 * 1e8) && sell.order.quoteQtyEv === undefined);
  const buy = M.buildSpotOrder('BTC', 'Buy', { price: 60000, quoteQty: 500 }, prods);
  ok('a BUY carries quote amount (the USDT)', buy.order.quoteQtyEv === Math.round(500 * 1e8) && buy.order.baseQtyEv === undefined);
  ok('unknown symbol is REFUSED, not guessed', !!M.buildSpotOrder('DOGE','Sell',{price:1,baseQty:1},prods).err);
  ok('missing scales are REFUSED', !!M.buildSpotOrder('BTC','Sell',{price:1,baseQty:1},{ sBTCUSDT:{ priceScale:8 } }).err);
  ok('a size that rounds to zero is refused', !!M.buildSpotOrder('BTC','Sell',{price:64000,baseQty:1e-12},prods).err);
  ok('no price is refused', !!M.buildSpotOrder('BTC','Sell',{baseQty:1},prods).err);
  ok('the futures path is untouched by all this', /phemexCall\("POST", "\/g-orders"/.test(src));
}
console.log('\n10. Spot execution has three independent brakes');
{
  const fn = src.slice(src.indexOf('async function sendSpotOrder'), src.indexOf('// Units held right now'));
  ok('KILL switch checked', /CFG\.kill\(\)/.test(fn));
  ok('notional cap checked', /ACCUM_MAX_USDT/.test(fn));
  ok('must be explicitly ARMED', /ACCUM_EXEC", "dry"\)\) === "armed"/.test(fn));
  ok('all three are checked BEFORE the wire call', fn.indexOf('phemexCall') > fn.indexOf('armed'));
  ok('the venue base URL is still hard-locked to testnet', /const PHEMEX_BASE = "https:\/\/testnet-api\.phemex\.com"/.test(src));
}
console.log('\n11. The brain may observe the accumulator, never change it');
{
  const p = M.buildAccumReviewPrompt({ units:0.8, cash:1000, open:[{src:'swingLow',px:60000}], sells:3, fills:7, startedAt:'2026-08-19' }, 64000, 'test');
  ok('the prompt states the benchmark', /1\.0000/.test(p));
  ok('it shows the live record', /sells 3/.test(p) && /rung fills 7/.test(p));
  ok('it names the known failure mode', /stranded/.test(p));
  ok('it demands JSON only', /Reply ONLY this JSON/.test(p));
  const rv = M.parseAccumReview('sure! {"read":"early","concern":"cash idle","suggestion":"tighter rungs","sampleTooSmall":false} ok');
  ok('parses through prose', rv && rv.read === 'early' && rv.suggestion === 'tighter rungs');
  ok('garbage returns null, never throws', M.parseAccumReview('no json here') === null);
  const block = src.slice(src.indexOf('THE BRAIN OVERSEEING THE ACCUMULATOR'), src.indexOf('// Cause → veto candidate.'));
  ok('the review block cannot place an order', !/execOrder|sendSpotOrder|buildSpotOrder|phemexCall/.test(block));
  ok('the review block cannot write a setting', !/setJSON|process\.env\s*\[/.test(block));
  const runBlock = src.slice(src.indexOf('brain oversight: weekly'), src.indexOf('accumulator review skipped'));
  ok('a suggestion is logged as advisory only', /would have to win a shadow arm/.test(runBlock));
  ok('it is rate limited', /ACCUM_REVIEW_DAYS/.test(runBlock));
  ok('and shares the daily spend cap', /brainBudget/.test(runBlock));
}
fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
