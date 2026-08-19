// THE LIVE FLIP ARM (2026-08-19) — John: "I want toggles to switch to those timeframes."
//
// One of the eight paper dot-flip arms may be promoted to the real spot balance. Everything
// dangerous about that promotion lives in the seams rather than the strategy, so that is what
// these test: no replay on arming, a switch being treated as a fresh arm, the coins only ever
// belonging to one book, and the cap/rollback guards that stop the strategy's book drifting
// away from what the wallet actually holds.
//
// Pure functions only — no venue, no clock, no network.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = fs.readFileSync('cipher-agent-valtown.js', 'utf8');
const out = path.join(process.cwd(), '.liveflip-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { liveFlipStep, accumFlipStep, accumStep, applyLiveConfig, CFG, FLIP_TFS, aggregateBars, waveTrend };\n');
const M = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + x : ''))); };
const H = 36e5;

// Same seeded walk the other accumulator suites use: hand-shaped ramps make wt1 and wt2 equal to
// the last decimal, so cross tests fail on floating-point noise rather than on logic.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function walk(seed, n, step = 0.02) {
  const rnd = mulberry32(seed);
  const b = []; let px = 60000;
  for (let i = 0; i < n; i++) {
    px = px * (1 + (rnd() - 0.5) * step);
    const h = px * (1 + rnd() * 0.004), l = px * (1 - rnd() * 0.004);
    b.push({ t: i * H, o: px, h, l, c: px, v: 1 });
  }
  return b;
}
const BARS = walk(7, 400);

console.log('\n  ARMING — the no-replay guarantee');
{
  // The whole risk: accumFlipStep acts on every bar newer than lastT. A fresh arm with lastT 0
  // against a 400-bar fetch would fire every dot in the history as a live order in one run.
  const r = M.liveFlipStep(null, BARS, '1H', { seedUnits: 0.00767931, seedCash: 0 });
  ok('arming places no orders at all', r.events.filter(e => e.kind !== 'flip-armed').length === 0,
     JSON.stringify(r.events.map(e => e.kind)));
  ok('arming emits exactly one flip-armed event', r.events.length === 1 && r.events[0].kind === 'flip-armed');
  ok('cursor is planted on the NEWEST bar, not zero', r.st.lastT === BARS[BARS.length - 1].t,
     `${r.st.lastT} vs ${BARS[BARS.length - 1].t}`);
  ok('seeded units are the real balance', r.st.units === 0.00767931, r.st.units);
  ok('benchmark is what it started with', Math.abs(r.st.startUnits - 0.00767931) < 1e-12, r.st.startUnits);
  ok('records which timeframe it is on', r.st.tf === '1H', r.st.tf);
  ok('records when it was armed', typeof r.st.armedAt === 'string' && r.st.armedAt.length > 10);
  ok('trip and sell counters start clean', r.st.trips === 0 && r.st.sells === 0);
}

console.log('\n  ARMING — a second run on the same bars does nothing');
{
  const a = M.liveFlipStep(null, BARS, '1H', { seedUnits: 1 });
  const b = M.liveFlipStep(a.st, BARS, '1H', {});
  ok('no events when no new bar has closed', b.events.length === 0, JSON.stringify(b.events.map(e => e.kind)));
  ok('units untouched', b.st.units === a.st.units);
  ok('cursor untouched', b.st.lastT === a.st.lastT);
}

console.log('\n  IT DOES TRADE ONCE NEW BARS ARRIVE');
{
  // Arm on a prefix, then hand it the full series: only the bars after the cursor may act.
  const armed = M.liveFlipStep(null, BARS.slice(0, 300), '1H', { seedUnits: 1 });
  const run = M.liveFlipStep(armed.st, BARS, '1H', {});
  ok('acts on the bars that closed after arming', run.events.length > 0, run.events.length);
  ok('every event is a flip sell or buy',
     run.events.every(e => e.kind === 'flip-sell' || e.kind === 'flip-buy'),
     JSON.stringify([...new Set(run.events.map(e => e.kind))]));
  ok('no event predates the arming cursor',
     run.events.every(e => e.at > armed.st.lastT));
  ok('cursor advanced to the newest bar', run.st.lastT === BARS[BARS.length - 1].t);
  const sells = run.events.filter(e => e.kind === 'flip-sell');
  ok('a sell carries the proceeds a buy-back would spend',
     sells.length === 0 || sells.every(e => e.cash > 0), JSON.stringify(sells[0] || {}));
  ok('a sell sizes in coins, a buy sizes in money',
     run.events.every(e => e.units > 0 && e.cash > 0));
  ok('never holds coins and cash at once (it is a flip, not a ladder)',
     !(run.st.units > 0 && run.st.cash > 0), `${run.st.units} / ${run.st.cash}`);
}

console.log('\n  SWITCHING TIMEFRAME IS A FRESH ARM, NOT A CONTINUATION');
{
  const armed = M.liveFlipStep(null, BARS.slice(0, 300), '1H', { seedUnits: 1 });
  const run = M.liveFlipStep(armed.st, BARS, '1H', {});
  const four = M.aggregateBars(BARS, 4);
  const sw = M.liveFlipStep(run.st, four, '4H', {});
  ok('switching places no orders', sw.events.filter(e => e.kind !== 'flip-armed').length === 0);
  ok('switching re-arms', sw.events.length === 1 && sw.events[0].kind === 'flip-armed');
  ok('the previous timeframe is named in the event', sw.events[0].prev === '1H', sw.events[0].prev);
  ok('cursor moves to the new timeframe\'s newest bar', sw.st.lastT === four[four.length - 1].t);
  ok('counters reset for the new strategy', sw.st.trips === 0 && sw.st.sells === 0);
  ok('the position carries across untouched', sw.st.units === run.st.units && sw.st.cash === run.st.cash);
  ok('the benchmark is re-struck at the switch',
     Math.abs(sw.st.startUnits - (run.st.units + run.st.cash / four[four.length - 1].c)) < 1e-9);
}

console.log('\n  SWITCHING WHILE SITTING IN CASH');
{
  // The nastiest handover: mid-cycle, sold, waiting for a green dot that the new timeframe may
  // put somewhere else entirely. The cash must not evaporate.
  const inCash = { tf: '1H', units: 0, cash: 500, trips: 3, sells: 4, lastT: 10, startUnits: 0.008 };
  const sw = M.liveFlipStep(inCash, BARS, '4H', {});
  ok('cash survives the switch', sw.st.cash === 500, sw.st.cash);
  ok('still flat in coins', sw.st.units === 0);
  ok('benchmark counts the cash at the current price',
     Math.abs(sw.st.startUnits - 500 / BARS[BARS.length - 1].c) < 1e-9, sw.st.startUnits);
}

console.log('\n  NOT ENOUGH DATA');
{
  const r = M.liveFlipStep(null, BARS.slice(0, 10), '1H', { seedUnits: 1 });
  ok('refuses to arm on a short series', r.events.length === 0 && !!r.why, r.why);
  ok('and does not claim a timeframe', !r.st.tf);
}

console.log('\n  THE LADDER STANDS DOWN — one book owns the coins');
{
  // A day that WOULD have triggered a pump sell, with the ladder paused.
  const daily = [];
  let px = 100;
  for (let i = 0; i < 120; i++) {
    px = px * (1 + (mulberry32(3 + i)() - 0.5) * 0.03);
    daily.push({ t: i * 864e5, o: px, h: px * 1.02, l: px * 0.98, c: px, v: 1 });
  }
  const last = daily[daily.length - 1];
  last.c = daily[daily.length - 2].c * 1.05;          // a +5% day: pump1 fires on this
  last.h = last.c * 1.001;

  const base = { units: 1, cash: 0, open: [], sells: 0, fills: 0, lastDay: null, startUnits: 1 };
  const free = M.accumStep(JSON.parse(JSON.stringify(base)), daily, { mfGate: false });
  const held = M.accumStep(JSON.parse(JSON.stringify(base)), daily,
    { mfGate: false, paused: true, pausedWhy: 'the 1H dot flip holds the coins' });

  ok('unpaused, the ladder still sells on the pump',
     free.events.some(e => e.kind === 'sell'), JSON.stringify(free.events.map(e => e.kind)));
  ok('paused, it places no sell', !held.events.some(e => e.kind === 'sell'),
     JSON.stringify(held.events.map(e => e.kind)));
  ok('paused, it says why rather than going quiet',
     held.events.some(e => e.kind === 'skip' && /dot flip/.test(e.why)),
     JSON.stringify(held.events));
  ok('paused, it opens no rungs', held.st.open.length === 0);
  ok('paused, the stack is untouched', held.st.units === 1, held.st.units);
}

console.log('\n  A PAUSED LADDER STILL FINISHES WHAT IT STARTED');
{
  // Standing down must stop it STARTING things, not stop it finishing them. Abandoning a resting
  // rung would strand its cash — the exact failure this whole strategy exists to avoid.
  const daily = [];
  let px = 100;
  for (let i = 0; i < 120; i++) { px = px * 1.001; daily.push({ t: i * 864e5, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1 }); }
  const bar = daily[daily.length - 1];
  const rungPx = bar.l * 1.005;                        // sits above today's low, so it fills
  const st = { units: 1, cash: 50, open: [{ px: rungPx, src: 'swingLow', usdt: 50, soldUnits: 0.5, sinceDay: 1 }],
               sells: 1, fills: 0, lastDay: null, startUnits: 1 };
  const r = M.accumStep(st, daily, { paused: true, pausedWhy: 'flip holds the coins' });
  ok('a resting rung still fills while stood down',
     r.events.some(e => e.kind === 'fill'), JSON.stringify(r.events.map(e => e.kind)));
  ok('the rung leaves the book', r.st.open.length === 0);
  ok('and the coins come back', r.st.units > 1, r.st.units);
}

console.log('\n  LIVE CONFIG — the toggle travels, and only valid values do');
{
  const reset = () => { CFGset('off'); };
  const CFGset = v => { M.CFG.accumFlipTf = () => v; };

  reset();
  const a = M.applyLiveConfig({ accumFlipTf: '4H' });
  ok('a real timeframe is applied', M.CFG.accumFlipTf() === '4H', M.CFG.accumFlipTf());
  ok('and is reported as applied', a.some(s => s === 'accumFlipTf=4H'), JSON.stringify(a));

  reset();
  M.applyLiveConfig({ accumFlipTf: '1h' });
  ok('lower case matches and is canonicalised', M.CFG.accumFlipTf() === '1H', M.CFG.accumFlipTf());

  reset();
  M.applyLiveConfig({ accumFlipTf: 'off' });
  ok('off is a valid setting', M.CFG.accumFlipTf() === 'off');

  CFGset('1H');
  M.applyLiveConfig({ accumFlipTf: '7 minutes' });
  ok('nonsense is ignored, not stored', M.CFG.accumFlipTf() === '1H', M.CFG.accumFlipTf());

  CFGset('1H');
  M.applyLiveConfig({ accumFlipTf: '' });
  ok('an empty value leaves the setting alone', M.CFG.accumFlipTf() === '1H');

  CFGset('1H');
  M.applyLiveConfig({});
  ok('an absent key leaves the setting alone', M.CFG.accumFlipTf() === '1H');

  CFGset('1H');
  M.applyLiveConfig(null);
  ok('a failed config read changes nothing', M.CFG.accumFlipTf() === '1H');

  reset();
  ok('every offered timeframe is one applyLiveConfig accepts',
     M.FLIP_TFS.every(t => { M.CFG.accumFlipTf = () => 'off'; M.applyLiveConfig({ accumFlipTf: t }); return M.CFG.accumFlipTf() === t; }));
  reset();
}

console.log('\n  THE SHAPE THE PANEL AND THE RELAY BOTH HAVE TO AGREE ON');
{
  const relay = fs.readFileSync('phemex-relay-valtown.js', 'utf8');
  const m = /const ACCUM_FLIP_TFS = \[([^\]]+)\]/.exec(relay);
  ok('the relay whitelists a timeframe list', !!m);
  const relayList = m ? m[1].split(',').map(s => s.trim().replace(/["']/g, '')) : [];
  ok('relay list is the agent list plus off',
     JSON.stringify(relayList) === JSON.stringify(['off', ...M.FLIP_TFS]),
     JSON.stringify(relayList));
  ok('the relay defaults to off', /accumFlipTf:\s*"off"/.test(relay));
  ok('the relay validates rather than passes through', /accumFlipTf must be one of/.test(relay));
}

console.log('\n  GUARDS PRESENT IN THE DRIVER');
{
  // These live in the run loop rather than in a pure function, so assert on the source: each one
  // is a defect that already bit once, or would have.
  ok('the ladder is stood down when a flip owns the coins', /paused:\s*true,\s*pausedWhy/.test(src));
  ok('arming is refused while ladder rungs are still resting',
     /flipBlocked\s*=\s*flipTf && state\.open && state\.open\.length > 0/.test(src));
  ok("the whole-stack notional is checked against the cap BEFORE arming",
     /stackUsdt > capUsdt/.test(src));
  ok('an unplaced order rolls the book back', /if \(placeFailed\)/.test(src) && /lfBefore/.test(src));
  ok('the ladder book mirrors the flip while the flip is driving',
     /state\.units = lf\.units; state\.cash = lf\.cash \|\| 0;/.test(src));
  ok('switching off hands the real position back to the ladder',
     /state\.units = Number\(lf\.units\) \|\| 0;/.test(src));
  ok('paper arms keep running for every timeframe regardless of what is armed',
     /for \(const ftf of FLIP_TFS\)/.test(src));
  ok('the live arm is stored apart from the paper arms', /LIVE_FLIP_KEY = "cipher_accum_liveflip"/.test(src));
  ok('the live arm books at the real fee, not the paper 1bp',
     /feeBps = num\("ACCUM_FEE_BPS", 10\)/.test(src));
}

fs.unlinkSync(out);
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
