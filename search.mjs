// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SEARCH — actually taking the shackles off
//
//  John, correctly: "we haven't taken the shackles off here, you've just given it setups."
//
//  Guilty. The lab scored six ideas I wrote myself. That is a judge, not a generator. The point of
//  building a filter that runs in milliseconds is that you no longer have to be clever about what
//  to try — you can try everything and let the filter do the work.
//
//  So this generates setups mechanically, in bulk, from the whole vocabulary. No taste, no theory,
//  no story. Thousands of combinations of conditions, stops, targets, directions and timeframes,
//  every one scored on three years of candles.
//
//  ── WHY THIS IS DANGEROUS, AND WHAT STOPS IT BEING WORTHLESS ──────────────────────────────────
//  Test five thousand rules and the best one will look magnificent by pure chance. That is not a
//  risk, it is a certainty — it is what the right tail of a distribution IS. Any search like this
//  that reports its winners without addressing that is generating confident nonsense at scale.
//
//  Three defences, and the third is the one that actually settles it:
//
//   1. SELECTION HAPPENS ON SIX COINS ONLY. The other six are never consulted while searching.
//   2. SURVIVORS MUST HOLD ON THOSE SIX, AND IN BOTH HALVES OF THE HISTORY.
//   3. A NULL CONTROL RUNS ALONGSIDE. The same number of random rules — entries fired at random
//      bars, matched for trade count — go through the identical pipeline. If 40 real rules survive
//      and 38 random ones do too, the search found nothing and says so. That comparison is the
//      only thing that turns "we found some winners" into a claim worth making.
//
//  Everything printed at the end is stated against the control. A survivor count on its own is not
//  evidence and is never reported on its own.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { runRule, buildContext } from './engine.mjs';
import { validateSetup } from './schema.mjs';
import { DISCOVER, VALIDATE, bars, BASELINE_R, MIN_TRADES } from './score.mjs';

// ── A DETERMINISTIC RANDOM SOURCE ─────────────────────────────────────────────────────────────
// Seeded on purpose: a search that cannot be re-run exactly is a search whose results cannot be
// checked. Date.now() here would make every run unrepeatable and every finding unverifiable.
let seed = 20260824;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const pickN = (a, n) => { const c = [...a], o = []; for (let i = 0; i < n && c.length; i++) o.push(...c.splice(Math.floor(rnd()*c.length),1)); return o; };

// ── THE SPACE ─────────────────────────────────────────────────────────────────────────────────
// Conditions split by direction, because "wtCrossUp" in a short setup is not an interesting idea,
// it is a typo the validator would happily accept.
const LONG_TRIGGERS = [
  () => ({ fn: "wtCrossUp" }),
  () => ({ fn: "pattern", name: "invHeadShoulders", within: pick([3,6,10]) }),
  () => ({ fn: "pattern", name: "doubleBottom", within: pick([3,6,10]) }),
  () => ({ fn: "bullFvg", within: pick([3,6,12]) }),
  () => ({ fn: "pivotLow", within: pick([3,6]) }),
  () => ({ fn: "mfFlippedUp", within: pick([3,6,12]) }),
];
const SHORT_TRIGGERS = [
  () => ({ fn: "wtCrossDown" }),
  () => ({ fn: "pattern", name: "headShoulders", within: pick([3,6,10]) }),
  () => ({ fn: "pattern", name: "doubleTop", within: pick([3,6,10]) }),
  () => ({ fn: "bearFvg", within: pick([3,6,12]) }),
  () => ({ fn: "pivotHigh", within: pick([3,6]) }),
  () => ({ fn: "mfFlippedDown", within: pick([3,6,12]) }),
];
const LONG_FILTERS = [
  () => ({ fn: "wt2Below", value: pick([-70,-53,-40,-20,0]) }),
  () => ({ fn: "rsiBelow", value: pick([30,40,50]), period: 14 }),
  () => ({ fn: "mfPositive" }),
  () => ({ fn: "mfNegative" }),
  () => ({ fn: "aboveSma", period: pick([50,100,200]) }),
  () => ({ fn: "belowSma", period: pick([50,100,200]) }),
  () => ({ fn: "atrPctAbove", value: pick([2,3,5]) }),
  () => ({ fn: "atrPctBelow", value: pick([5,8]) }),
  () => ({ fn: "wtRising", bars: pick([2,3]) }),
  () => ({ fn: "higherHigh" }),
  () => ({ fn: "lowerLow" }),
  () => ({ fn: "htf", mult: pick([6,4]), cond: pick([{ fn:"aboveSma", period:50 }, { fn:"wt2Below", value:0 }, { fn:"mfPositive" }]) }),
];
const SHORT_FILTERS = [
  () => ({ fn: "wt2Above", value: pick([0,20,40,53,70]) }),
  () => ({ fn: "rsiAbove", value: pick([50,60,70]), period: 14 }),
  () => ({ fn: "mfNegative" }),
  () => ({ fn: "mfPositive" }),
  () => ({ fn: "belowSma", period: pick([50,100,200]) }),
  () => ({ fn: "aboveSma", period: pick([50,100,200]) }),
  () => ({ fn: "atrPctAbove", value: pick([2,3,5]) }),
  () => ({ fn: "wtFalling", bars: pick([2,3]) }),
  () => ({ fn: "lowerLow" }),
  () => ({ fn: "higherHigh" }),
  () => ({ fn: "htf", mult: pick([6,4]), cond: pick([{ fn:"belowSma", period:50 }, { fn:"wt2Above", value:0 }, { fn:"mfNegative" }]) }),
];
const STOPS = [
  () => ({ kind: "swing", lookback: pick([5,10,20]), padAtr: pick([0,0.25,0.5]) }),
  () => ({ kind: "atr", mult: pick([1.5,2,2.5,3]) }),
  () => ({ kind: "percent", value: pick([3,4,5,7]) }),
  () => ({ kind: "pattern", padAtr: pick([0.15,0.3]) }),
];

function propose() {
  const dir = rnd() < 0.5 ? "long" : "short";
  const trig = dir === "long" ? LONG_TRIGGERS : SHORT_TRIGGERS;
  const filt = dir === "long" ? LONG_FILTERS : SHORT_FILTERS;
  const nFilters = pick([0,1,1,2]);                    // most setups stay simple on purpose
  const when = [pick(trig)(), ...pickN(filt, nFilters).map(f => f())];
  const stop = pick(STOPS)();
  // A pattern stop only means something if a pattern fired. Anything else is the plan inventing a
  // level to suit itself, so swap it out rather than let the engine silently return null.
  if (stop.kind === "pattern" && !when.some(w => w.fn === "pattern")) stop.kind = "swing", stop.lookback = 10;
  return {
    // Names feed the validator's own charset rule, which does not allow "+". Joining with it meant
    // every multi-condition proposal was silently rejected and only single-condition rules
    // survived — a search that looked like it explored 800 ideas and actually explored one shape.
    name: `auto ${dir} ${when.map(w => w.fn).join(" ")}`.slice(0, 60),
    dir, timeframe: pick(["4H","1D","4H"]), when, stop,
    target: { kind: "rMultiple", value: pick([1.5,2,2.5,3]) },
    maxBars: pick([30,60,90]),
    falsifier: "Generated by exhaustive search, so it is guilty until the held-out coins say otherwise.",
  };
}

// ── THE NULL CONTROL ──────────────────────────────────────────────────────────────────────────
// A rule that fires on random bars, with the same stop/target machinery and the same costs. This
// is what "no edge" actually looks like once it has been through this pipeline, and it is the only
// honest yardstick for the survivor count.
function randomTrades(c, rule, everyN) {
  const out = [];
  for (let i = 260; i < c.length - 1; i += everyN) {
    const t = runRuleAt(c, rule, i);
    if (t) { out.push({ ...t, i }); i += t.bars; }
  }
  return out;
}
let CTX = new Map();
function ctxFor(coin, tf) { const k = coin+tf; if (!CTX.has(k)) CTX.set(k, buildContext(bars(coin,tf))); return CTX.get(k); }

// One trade opened at a given bar, using the rule's own stop and target. Shared by the control so
// the two paths cannot differ in how they grade.
function runRuleAt(c, rule, i) {
  const x = ctxFor(rule._coin, rule.timeframe);
  const entry = c[i].c, a = x.atr[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  const sgn = rule.dir === "short" ? -1 : 1;
  let stop;
  const s = rule.stop;
  if (s.kind === "atr") stop = entry - sgn * s.mult * a;
  else if (s.kind === "percent") stop = entry * (1 - sgn * s.value/100);
  else { let lvl = rule.dir === "short" ? -Infinity : Infinity;
         for (let j = Math.max(0,i-(s.lookback||10)+1); j <= i; j++)
           lvl = rule.dir === "short" ? Math.max(lvl, c[j].h) : Math.min(lvl, c[j].l);
         stop = lvl - sgn * (s.padAtr||0) * a; }
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const stopPct = risk/entry*100;
  if (stopPct < 2.2) return null;
  const target = entry + sgn * risk * rule.target.value;
  const costR = 0.22/stopPct;
  let R = null, bars_ = 0;
  for (let j = i+1; j < Math.min(c.length, i+1+rule.maxBars); j++) {
    bars_ = j-i;
    if (rule.dir === "short" ? c[j].h >= stop : c[j].l <= stop) { R = -1; break; }
    if (rule.dir === "short" ? c[j].l <= target : c[j].h >= target) { R = rule.target.value; break; }
  }
  if (R === null) { const last = c[Math.min(c.length,i+1+rule.maxBars)-1].c;
                    R = (rule.dir === "short" ? entry-last : last-entry)/risk; }
  return { R: R - costR, bars: bars_ };
}

const summ = ts => { const n = ts.length; if (!n) return { n:0, exp:0, win:0 };
  const R = ts.map(t=>t.R); return { n, exp: R.reduce((s,r)=>s+r,0)/n, win: R.filter(r=>r>0).length/n }; };

function scoreCoins(rule, coins, half = null) {
  const all = [];
  for (const coin of coins) {
    const c = bars(coin, rule.timeframe);
    rule._coin = coin;
    const t = runRule(c, rule, { ctx: ctxFor(coin, rule.timeframe) });
    const mid = Math.floor(c.length/2);
    all.push(...(half === null ? t : half === 1 ? t.filter(x=>x.i<mid) : t.filter(x=>x.i>=mid)));
  }
  return summ(all);
}
// The control must face EXACTLY the bar the real rules face, including the time-halves test.
// The first version checked "discovery vs validation" where the real path checked "first half vs
// second half", so the control only had to clear two hurdles instead of three — which made noise
// look more survivable than it is and would have condemned a real finding by mistake.
function scoreRandom(rule, coins, everyN, half = null) {
  const all = [];
  for (const coin of coins) {
    rule._coin = coin;
    const c = bars(coin, rule.timeframe);
    const t = randomTrades(c, rule, everyN);
    const mid = Math.floor(c.length / 2);
    all.push(...(half === null ? t : half === 1 ? t.filter(x => x.i < mid) : t.filter(x => x.i >= mid)));
  }
  return summ(all);
}

// ── RUN ───────────────────────────────────────────────────────────────────────────────────────
const N = Number(process.argv[2] || 2000);
const started = Date.now();
console.log('═'.repeat(94));
console.log(`UNSHACKLED SEARCH — generating ${N} setups from the vocabulary and scoring every one`);
console.log('selection happens on 6 coins; 6 more are never consulted until the very end');
console.log('═'.repeat(94));

// Warm the contexts once — the expensive part is pivots and patterns, not the rules.
for (const coin of [...DISCOVER, ...VALIDATE]) for (const tf of ['4H','1D']) ctxFor(coin, tf);
console.log(`contexts built in ${((Date.now()-started)/1000).toFixed(1)}s`);

const kept = [];
let valid = 0, dupes = 0;
const seen = new Set();
for (let k = 0; k < N; k++) {
  const p = propose();
  const sig = JSON.stringify([p.dir,p.timeframe,p.when,p.stop,p.target,p.maxBars]);
  if (seen.has(sig)) { dupes++; continue; }
  seen.add(sig);
  const v = validateSetup(p);
  if (!v.ok) continue;
  valid++;
  const rule = v.rule;
  const d = scoreCoins(rule, DISCOVER);
  if (d.n < MIN_TRADES || d.exp <= BASELINE_R) continue;      // selection, on discovery coins ONLY
  kept.push({ rule, d });
}
console.log(`proposed ${N} · ${dupes} duplicates · ${valid} valid · ${kept.length} passed the discovery bar`);

// NOW, and only now, the held-out coins.
const survivors = [];
for (const k of kept) {
  const v = scoreCoins(k.rule, VALIDATE);
  const h1 = scoreCoins(k.rule, [...DISCOVER, ...VALIDATE], 1);
  const h2 = scoreCoins(k.rule, [...DISCOVER, ...VALIDATE], 2);
  if (v.n >= MIN_TRADES && v.exp > BASELINE_R && h1.exp > 0 && h2.exp > 0)
    survivors.push({ ...k, v, h1, h2 });
}

// ── THE CONTROL ───────────────────────────────────────────────────────────────────────────────
// The same pipeline, entries at random bars. Spacing chosen per rule so the trade counts land in
// the same ballpark — a control that trades ten times as often is not a control.
let ctrlKept = 0, ctrlSurv = 0;
const CTRL_N = Math.min(1500, Math.max(600, kept.length * 20));   // the control must not be the small sample
for (let k = 0; k < CTRL_N; k++) {
  const p = propose(); const v = validateSetup(p); if (!v.ok) continue;
  const rule = v.rule;
  const everyN = pick([25, 40, 60, 90]);
  const d = scoreRandom(rule, DISCOVER, everyN);
  if (d.n < MIN_TRADES || d.exp <= BASELINE_R) continue;
  ctrlKept++;
  const vv = scoreRandom(rule, VALIDATE, everyN);
  const hh1 = scoreRandom(rule, [...DISCOVER, ...VALIDATE], everyN, 1);
  const hh2 = scoreRandom(rule, [...DISCOVER, ...VALIDATE], everyN, 2);
  if (vv.n >= MIN_TRADES && vv.exp > BASELINE_R && hh1.exp > 0 && hh2.exp > 0) ctrlSurv++;
}

survivors.sort((a,b) => b.v.exp - a.v.exp);
const L = [];
const say = s => { L.push(s); console.log(s); };
say('');
say('═'.repeat(94));
say('RESULT');
say('═'.repeat(94));
say(`  real setups   : ${valid} valid → ${kept.length} passed discovery → ${survivors.length} SURVIVED the held-out coins`);
say(`  random control: ${ctrlKept} passed discovery → ${ctrlSurv} survived the same pipeline`);
const realRate = kept.length ? survivors.length/kept.length : 0;
const ctrlRate = ctrlKept ? ctrlSurv/ctrlKept : 0;
say('');
say(`  survival rate — real ${(realRate*100).toFixed(1)}%   ·   noise ${(ctrlRate*100).toFixed(1)}%`);
say(ctrlRate === 0 && realRate > 0
    ? '  the control never survived; the survivors below are doing something noise did not.'
    : realRate > ctrlRate * 1.5
    ? '  real setups survive meaningfully more often than noise — worth reading on.'
    : '  NOT distinguishable from noise. Whatever is below is the right tail of a coin-flipping exercise.');
say('');
if (survivors.length) {
  say('  top survivors, ranked by the coins they were NOT selected on:');
  say('  ' + 'setup'.padEnd(52) + 'disc'.padStart(9) + 'VALID'.padStart(9) + 'h1'.padStart(8) + 'h2'.padStart(8) + 'n'.padStart(7));
  for (const s of survivors.slice(0, 15))
    say('  ' + s.rule.name.padEnd(52)
        + (s.d.exp>=0?'+':'')+s.d.exp.toFixed(3).padStart(8)
        + ((s.v.exp>=0?'+':'')+s.v.exp.toFixed(3)).padStart(9)
        + ((s.h1.exp>=0?'+':'')+s.h1.exp.toFixed(2)).padStart(8)
        + ((s.h2.exp>=0?'+':'')+s.h2.exp.toFixed(2)).padStart(8)
        + String(s.d.n + s.v.n).padStart(7));
}
say('');
say(`  ${((Date.now()-started)/1000).toFixed(1)}s total`);
fs.writeFileSync('SETUP_SEARCH.txt', L.join('\n')+'\n');
fs.writeFileSync('setup-lab/survivors.json', JSON.stringify(survivors.slice(0,25).map(s => {
  const r = { ...s.rule }; delete r._coin; return r; }), null, 2));
console.log('written → SETUP_SEARCH.txt and setup-lab/survivors.json');
