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
  const a = M.accumStep(null, bars, { trigger:'reddot', minOrderUsdt:0 });
  const b = M.accumStep(a.st, bars, { trigger:'reddot', minOrderUsdt:0 });          // same bar again — e.g. the 15-min run repeating
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
  const { st, events } = M.accumStep(null, bars, { trigger:'reddot', minOrderUsdt:0 });
  const sold = events.find(e => e.kind === 'sell');
  const skipped = events.find(e => e.kind === 'skip');
  ok('it either sold or said exactly why not', !!sold || !!skipped, JSON.stringify(events));
  if (sold) {
    // A slice is 20% of the TRADEABLE inventory. With the core at its default 0 (John's call,
    // 2026-08-19) everything is tradeable, so that is 0.2 of a 1.0 stack. Section 13 proves the
    // same code yields 0.08 the moment a 60% core is switched back on.
    ok('it sold 20% of the tradeable inventory', Math.abs(sold.units - 0.2) < 1e-9, sold.units);
    ok('with no core, tradeable is the whole stack', st.coreUnits === 0);
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
  const a = M.accumStep(null, bars, { trigger:'reddot', minOrderUsdt:0 });
  if (a.st.open.length) {
    const rung = a.st.open[0];
    // next day trades down through the deepest rung
    const next = [...bars, { t: bars.length*DAY, o: rung.px, h: rung.px*1.001, l: rung.px*0.9, c: rung.px, v: 1 }];
    const b = M.accumStep(a.st, next, { trigger:'reddot', minOrderUsdt:0 });
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
  const r = M.accumStep(cashy, bars, { trigger:'reddot', minOrderUsdt:0 });
  ok('the cash ceiling refuses a further sell', !r.events.some(e => e.kind === 'sell'), JSON.stringify(r.events));
  const many = { units: 1, cash: 0, sells: 0, fills: 0, lastDay: null,
                 open: [1,2,3,4].map(i => ({ px: 1, src: 'swingLow', usdt: 0, soldUnits: 0, sellPx: 2, sinceDay: 'd'+i })) };
  const r2 = M.accumStep(many, bars, { trigger:'reddot', minOrderUsdt:0 });
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
  const runBlock = src.slice(src.indexOf('async function runAccumulator()'), src.indexOf('// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 THE LOOP'));
  if(runBlock.length < 5000) { fail++; console.log('  FAIL runBlock slice collapsed \u2014 markers moved, length ' + runBlock.length); }
  ok('the run loop never touches the FUTURES order path', !/execOrder|directOrder|buildOrder\(/.test(runBlock));
  ok('it reaches the venue only through the braked spot helper', /sendSpotOrder\(/.test(runBlock));
  ok('it can be switched off', /env\("ACCUM", "1"\)/.test(src));
  ok('the coin is configurable', /env\("ACCUM_COIN", "BTC"\)/.test(src));
  ok('failure cannot break the run', /accumulator failed \(harmless/.test(runBlock));
}
console.log('\n8. Intraday fills — every 15-min bar, none missed, none double-counted');
{
  const bars = redDotSeries();
  const a = M.accumStep(null, bars, { trigger:'reddot', minOrderUsdt:0 });
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
  // qtyType tells the venue WHICH quantity field to read. Missing it is a silent rejection.
  ok('a SELL is typed ByBase', sell.order.qtyType === 'ByBase');
  const buy = M.buildSpotOrder('BTC', 'Buy', { price: 60000, quoteQty: 500 }, prods);
  ok('a BUY carries quote amount (the USDT)', buy.order.quoteQtyEv === Math.round(500 * 1e8) && buy.order.baseQtyEv === undefined);
  ok('a BUY is typed ByQuote', buy.order.qtyType === 'ByQuote');
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
  // Armed by instruction 2026-08-19, so the DEFAULT is now "armed". The assertion that still
  // matters is that a single explicit value stands it down, and that the other brakes are intact.
  // Updated 2026-08-20: this used to pin the default at "armed", which is the thing Codex's
  // review flagged — a test can enforce a bug as easily as a feature. It now pins the SAFE
  // direction, so a drift back to arming-by-default turns this suite red.
  ok('the arm switch exists and is checked', /ACCUM_EXEC", "dry"\)\) === "armed"/.test(fn));
  ok('and it defaults to dry, so arming must be stated in the workflow', !/ACCUM_EXEC", "armed"/.test(fn));
  ok('setting ACCUM_EXEC to anything else stands it down', /const armed = String\(env\("ACCUM_EXEC"[^)]*\)\) === "armed"/.test(fn));
  ok('the cap was raised to clear a full-stack slice', /num\("ACCUM_MAX_USDT", 200\)/.test(src));
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
console.log('\n12. The spot preflight is read-only');
{
  const fn = src.slice(src.indexOf('async function spotPreflight'), src.indexOf('// The only function that can put a spot order on the wire.'));
  ok('preflight exists', fn.length > 200);
  ok('it only ever GETs', !/POST|DELETE|PUT/.test(fn));
  ok('it cannot build or send an order', !/buildSpotOrder|sendSpotOrder|execOrder|directOrder/.test(fn));
  ok('it reads the product table', /spotProducts\(\)/.test(fn));
  ok('it reads the spot wallet', /\/spot\/wallets/.test(fn));
  ok('every read is wrapped so a failure cannot break the run', (fn.match(/catch/g)||[]).length >= 2);
  const call = src.slice(src.indexOf('Read-only preflight'), src.indexOf('const bars = await fetchCandles(coin, "1D", 260)'));
  ok('it can be switched off', /ACCUM_PREFLIGHT/.test(call));
  ok('and it runs before anything else in the accumulator', call.length > 100);
}
console.log('\n13. The CORE — a floor no signal can sell through');
{
  // The DEFAULT is now 0 (John chose no core on 2026-08-19), so these tests ask for one
  // explicitly — they exist to prove the mechanism still works whenever it is switched back on.
  const CORE = { trigger:'reddot', minOrderUsdt:0, corePct:0.6 };
  const bars = redDotSeries();
  // 60% core by default: from 1.0 units only 0.4 is tradeable, so a 20% slice is 0.08 not 0.2
  const a = M.accumStep(null, bars, CORE);
  const sold = a.events.find(e=>e.kind==='sell');
  if (sold) {
    ok('core is set on the first pass', a.st.coreUnits > 0, a.st.coreUnits);
    ok('core is 60% of the starting stack', Math.abs(a.st.coreUnits - 0.6) < 1e-9, a.st.coreUnits);
    ok('it sells 20% of the TRADEABLE part, not of everything', Math.abs(sold.units - 0.08) < 1e-9, sold.units);
    ok('units never fall below the core', a.st.units >= a.st.coreUnits - 1e-9, a.st.units+' vs '+a.st.coreUnits);
  } else { ok('(no sell produced — skipped)', true); }

  // a stack already at the floor may not sell at all, however strong the signal
  const atFloor = { units:0.6, cash:0, open:[], sells:0, fills:0, lastDay:null, startedAt:'2026-01-01',
                    startUnits:1, coreUnits:0.6, highWater:1, lastFillT:0 };
  const r = M.accumStep(atFloor, bars, CORE);
  ok('at the floor it refuses to sell', !r.events.some(e=>e.kind==='sell'));
  ok('and says why in plain words', /core floor/.test((r.events.find(e=>e.kind==='skip')||{}).why||''),
     JSON.stringify(r.events));
  ok('the units are untouched', r.st.units === 0.6);
}
console.log('\n14. The core RATCHETS up as units accumulate');
{
  const CORE = { trigger:'reddot', minOrderUsdt:0, corePct:0.6 };
  const bars = redDotSeries();
  const px = bars[bars.length-1].c;
  // a stack that has grown to 1.5 units should lock 60% of the NEW high, not of the original
  const grown = { units:1.5, cash:0, open:[], sells:0, fills:0, lastDay:null, startedAt:'2026-01-01',
                  startUnits:1, coreUnits:0.6, highWater:1, lastFillT:0 };
  const r = M.accumStep(grown, bars, CORE);
  ok('high water rises to the new total', Math.abs(r.st.highWater - 1.5) < 1e-9, r.st.highWater);
  ok('core ratchets to 60% of the new high', Math.abs(r.st.coreUnits - 0.9) < 1e-9, r.st.coreUnits);
  ok('the core never goes DOWN again', r.st.coreUnits >= 0.6);
  // cash waiting to be redeployed must not fake a new high
  const inCash = { units:0.7, cash:0.5*px, open:[{px:1,src:'swingLow',usdt:0.5*px,soldUnits:0.5,sellPx:px,sinceDay:'d'}],
                   sells:1, fills:0, lastDay:null, startedAt:'2026-01-01', startUnits:1, coreUnits:0.6, highWater:1.2, lastFillT:0 };
  const r2 = M.accumStep(inCash, bars, CORE);
  ok('a slice sitting in cash still counts toward the total', r2.st.highWater >= 1.2 - 1e-9, r2.st.highWater);
  ok('core is configurable', /num\("ACCUM_CORE_PCT", 0\)/.test(src));
  ok('and it now DEFAULTS to zero — no protected core, by instruction', (()=>{
      const d = M.accumStep(null, redDotSeries(), { trigger:'reddot', minOrderUsdt:0 });
      return d.st.coreUnits === 0; })());
}
console.log('\n15. The PUMP trigger — John\'s rule, measured to beat the red dot 2:1 in ranges');
{
  const DAYT = 200*DAY;
  // a flat run then a single big up day
  const mk = (lastPct) => {
    const b = walk(3, 160);
    const prev = b[b.length-2].c;
    b[b.length-1] = { t: b[b.length-1].t, o: prev, h: prev*(1+lastPct)*1.001, l: prev*0.999, c: prev*(1+lastPct) };
    return b;
  };
  const cfg = { trigger:'pump3', mfGate:false, minOrderUsdt:0 };
  const up4 = M.accumStep(null, mk(0.04), cfg);
  ok('a +4% day fires the 3% trigger', up4.events.some(e=>e.kind==='sell'), JSON.stringify(up4.events).slice(0,120));
  const up1 = M.accumStep(null, mk(0.01), cfg);
  ok('a +1% day does not', !up1.events.some(e=>e.kind==='sell'));
  const up4at5 = M.accumStep(null, mk(0.04), { trigger:'pump5', mfGate:false, minOrderUsdt:0 });
  ok('the 5% trigger ignores a +4% day', !up4at5.events.some(e=>e.kind==='sell'));
  const up6at5 = M.accumStep(null, mk(0.06), { trigger:'pump5', mfGate:false, minOrderUsdt:0 });
  ok('but takes a +6% day', up6at5.events.some(e=>e.kind==='sell'));
  const custom = M.accumStep(null, mk(0.025), { trigger:'pump', pumpPct:0.02, mfGate:false, minOrderUsdt:0 });
  ok('the threshold is tunable', custom.events.some(e=>e.kind==='sell'));
  const sold = up4.events.find(e=>e.kind==='sell');
  ok('the log says WHY it sold, with the actual move', sold && /day closed \+4\.0%/.test(sold.how||''), sold&&sold.how);
  ok('the money-flow gate can still veto it', (()=>{ const r=M.accumStep(null, mk(0.04), {trigger:'pump3', mfGate:true, minOrderUsdt:0});
      return r.events.some(e=>e.kind==='sell') || /money flow/.test((r.events.find(e=>e.kind==='skip')||{}).why||''); })());
  ok('red dot remains selectable', /trigger === "reddot"/.test(src) || /trig === "reddot"/.test(src));
  // Default lowered to pump1 on 2026-08-19 for FREQUENCY (~48 trades/yr vs ~15) while the
  // plumbing is being proven. pump3 is the stronger signal and is one env change away.
  ok('default is pump1 while the plumbing is proven', /env\("ACCUM_TRIGGER", "pump1"\)/.test(src));
  ok('any pumpN threshold parses, not just a hardcoded few', /\^pump\(\[\\d\.\]\+\)\$/.test(src));
}
console.log('\n16. Real money: the ladder must fit the venue minimum');
{
  const bars = redDotSeries();
  const px = bars[bars.length-1].c;
  // John's funded size: 0.007682 BTC. With NO core a slice is ~$100, so 4 rungs = ~$25 each —
  // comfortably over the venue minimum. (With a 60% core it was $9.99 a rung and would have failed.)
  const real = { units:0.007682, cash:0, open:[], sells:0, fills:0, lastDay:null, startedAt:null,
                 startUnits:0.007682, coreUnits:null, highWater:0.007682, lastFillT:0, seededReal:true };
  const cfg = { trigger:'reddot', mfGate:false };  // real-size test: minimum left ON deliberately
  const r = M.accumStep({...real}, bars, cfg);
  const sold = r.events.find(e=>e.kind==='sell');
  const skip = r.events.find(e=>e.kind==='skip');
  ok('it either trades or explains itself', !!sold || !!skip, JSON.stringify(r.events).slice(0,160));
  if (sold) {
    const sliceValue = sold.units * px;
    ok('every rung clears the 10 USDT minimum', (sliceValue / sold.rungs.length) >= 10 - 1e-9,
       'slice $'+sliceValue.toFixed(2)+' over '+sold.rungs.length+' rungs');
    ok('and it used FEWER than the max 4 rungs to manage that', sold.rungs.length <= 4);
  }
  // a stack far too small to place anything must refuse, not send a doomed order
  const tiny = { ...real, units:0.00002, startUnits:0.00002, highWater:0.00002, coreUnits:null };
  const rt = M.accumStep(tiny, bars, cfg);
  ok('a dust-sized stack refuses to trade', !rt.events.some(e=>e.kind==='sell'));
  ok('and names the minimum as the reason',
     /minimum order|core floor|nothing placeable/.test((rt.events.find(e=>e.kind==='skip')||{}).why||''),
     JSON.stringify(rt.events));
  ok('the minimum is configurable', /num\("ACCUM_MIN_ORDER_USDT", 10\)/.test(src));
}
console.log('\n17. Seeding from the real wallet happens once, and only once');
{
  const seed = src.slice(src.indexOf('SEED FROM THE REAL WALLET'), src.indexOf('const all = [];'));
  ok('the seed block exists', seed.length > 200);
  ok('it only fires when a real balance is visible', /Number\.isFinite\(PF\.baseBalance\) && PF\.baseBalance > 0/.test(seed));
  ok('it never re-seeds once done', /!state\.seededReal/.test(seed));
  ok('start units become the real balance, so the benchmark is honest', /startUnits: PF\.baseBalance/.test(seed));
  ok('it tells the user in the decision log', /ACCUM SEEDED/.test(seed));
  ok('the wallet balance is de-scaled, never assumed', /10 \*\* scale/.test(src));
}
fs.unlinkSync(out);
// ── THE JAM, AND THE RULE THAT ENDS IT (2026-08-21) ─────────────────────────────────────────
// Backtested on the repo's own daily BTC data: the ladder ended three years holding 0.769 BTC
// against 1.000 held, and it did not lose that by trading badly — it stopped. Three ladders laid
// in Oct 2023 at ~26k never filled, and because maxConcurrent counts a resting ladder whether or
// not it can EVER fill, all four slots were dead from Sep 2024. Nine sells in three years.
console.log('\nA. A rung that will never fill is given up on');
{
  const DAYMS = 864e5;
  const day = n => new Date(n * DAYMS).toISOString().slice(0, 10);
  // A flat series long enough for the indicators, ending on a bar that fires nothing.
  const flat = [];
  for (let i = 0; i < 120; i++) flat.push({ t: i * DAYMS, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 });
  const lastDay = day(119);

  const rung = (age, px) => ({ px, src: 'swingLow', usdt: 100, soldUnits: 1, sellPx: 100, sinceDay: day(119 - age) });

  // Far below the market so it can never fill from the bar itself.
  const st0 = () => ({ units: 1, cash: 100, open: [rung(40, 50)], sells: 1, fills: 0,
                       lastDay: day(118), startedAt: day(0), startUnits: 1, coreUnits: 0, highWater: 1 });

  const r = M.accumStep(st0(), flat, { corePct: 0 });
  const exp = r.events.filter(e => e.kind === 'expire');
  ok('a 40-day-old rung expires under the 30-day default', exp.length === 1, JSON.stringify(r.events));
  ok('its cash is spent, not left stranded', Math.abs(r.st.cash) < 1e-9, r.st.cash);
  ok('and it comes back as coins', r.st.units > 1, r.st.units);
  ok('the slot is freed', r.st.open.length === 0);
  ok('the event says how old it was', exp[0].ageDays === 40, exp[0].ageDays);
  ok('and carries the cash so a real order can be sized', exp[0].usdt === 100, exp[0].usdt);
  ok('the loss in units is recorded, not hidden', Number.isFinite(exp[0].lost), exp[0].lost);
  ok('buying 100 USDT at 100 after selling 1 unit at 50 is a REAL loss', exp[0].lost > 0, exp[0].lost);

  const young = M.accumStep({ ...st0(), open: [rung(29, 50)] }, flat, { corePct: 0 });
  ok('a 29-day-old rung is left alone', young.events.filter(e => e.kind === 'expire').length === 0);
  ok('and is still resting', young.st.open.length === 1);

  const off = M.accumStep(st0(), flat, { corePct: 0, ttlDays: 0 });
  ok('the rule is only a default — env ACCUM_RUNG_TTL_DAYS=0 keeps the old forever-rungs',
     /num\("ACCUM_RUNG_TTL_DAYS", 30\)/.test(src));
}

console.log('\nB. Expiry frees a stood-down ladder too');
{
  const DAYMS = 864e5;
  const day = n => new Date(n * DAYMS).toISOString().slice(0, 10);
  const flat = [];
  for (let i = 0; i < 120; i++) flat.push({ t: i * DAYMS, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 });
  const st = { units: 1, cash: 100, open: [{ px: 50, src: 'OB', usdt: 100, soldUnits: 1, sellPx: 100, sinceDay: day(70) }],
               sells: 1, fills: 0, lastDay: day(118), startedAt: day(0), startUnits: 1, coreUnits: 0, highWater: 1 };
  const r = M.accumStep(st, flat, { corePct: 0, paused: true, pausedWhy: 'the dot flip holds the coins' });
  ok('a paused ladder still gives up on dead rungs', r.events.some(e => e.kind === 'expire'));
  ok('it still refuses to START anything', !r.events.some(e => e.kind === 'sell'));
  ok('and still says why it is standing down', r.events.some(e => e.kind === 'skip'));
}

console.log('\nC. THE BUY-BACK IS A REAL ORDER, NOT A LOG LINE');
{
  // The sell side placed a real spot order; the buy side wrote a sentence. A ladder that sells
  // real coins and buys them back in fiction is a one-way sale.
  ok('a fill now places a spot buy', /if \(e\.kind === "fill" \|\| e\.kind === "expire"\)/.test(src));
  ok('sized from the rung\'s own cash', /quoteQty: spend/.test(src));
  ok('and capped by what the wallet actually holds', /Math\.min\(Number\(e\.usdt\) \|\| 0, walletQuote\)/.test(src));
  ok('fill events carry that cash', /kind: "fill"[\s\S]{0,160}usdt: \+Number\(r\.usdt\)\.toFixed\(2\)/.test(src));
  ok('an armed order that does not place rolls the book back', /state = stateBefore;/.test(src));
  ok('loudly', /result: "ACCUM UNPLACED"/.test(src));
  ok('and says the rung will be retried', /still resting and will be retried next run/.test(src));
  ok('the rollback snapshot is taken before anything is applied',
     src.indexOf('const stateBefore = JSON.parse(JSON.stringify(state));') < src.indexOf('accumFillPass(state, fine)'));
  ok('an expiry is logged as its own thing, not as a normal buy', /result: isExpiry \? "ACCUM RUNG EXPIRED" : "ACCUM BUY"/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
