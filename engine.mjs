// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE RULE ENGINE — turning a proposed setup into trades, without cheating
//
//  Everything in this file exists to stop one thing: the engine knowing something on bar i that
//  nobody could have known on bar i. Lookahead is the reason most backtests are fiction, and it
//  arrives quietly — through a pivot that needs future bars to confirm, an indicator computed over
//  the whole series, or a fill taken at a price that had already gone.
//
//  Three defences, applied everywhere:
//
//   1. INDICATORS ARE COMPUTED ONCE OVER THE WHOLE SERIES, AND READ ONLY AT OR BEFORE i.
//      WaveTrend, RSI, ATR and the money flow are all causal — value[i] depends only on bars ≤ i —
//      so computing them up front is not cheating and is enormously faster than re-slicing.
//
//   2. PIVOTS MUST BE CONFIRMED. A swing low is only a swing low once RIGHT bars have printed
//      after it. So a pivot at bar p is invisible until bar p + RIGHT. Every pattern is built from
//      confirmed pivots only, which is why a head and shoulders here is always found LATE — as it
//      is in real life, and unlike almost every chart-pattern backtest ever published.
//
//   3. ENTRY IS THE CLOSE OF THE SIGNAL BAR. Not the open of it, not the low of it.
//
//  The exit model matches the live classifier: stop checked before target on a bar that covers
//  both, because we cannot know the order within a bar and guessing in our own favour is how a
//  losing rule reports a profit.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { CONDITIONS } from './schema.mjs';

// ── Indicator plumbing (VuManChu settings identical to the live agent) ────────────────────────
const VMC = { chlen: 9, avg: 12, malen: 3, mfiPeriod: 60, mfiMult: 150, mfiPosY: 2.5 };

const smaArr = (a, n) => {
  const out = new Array(a.length).fill(NaN);
  let s = 0, c = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (Number.isFinite(v)) { s += v; c++; }
    if (i >= n) { const old = a[i - n]; if (Number.isFinite(old)) { s -= old; c--; } }
    if (i >= n - 1 && c) out[i] = s / c;
  }
  return out;
};
const emaArr = (a, n) => {
  const out = new Array(a.length).fill(NaN), k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v)) continue;
    prev = Number.isFinite(prev) ? v * k + prev * (1 - k) : v;
    out[i] = prev;
  }
  return out;
};

function waveTrend(c) {
  const src = c.map(x => (x.h + x.l + x.c) / 3);
  const esa = emaArr(src, VMC.chlen);
  const de = emaArr(src.map((v, i) => Math.abs(v - esa[i])), VMC.chlen);
  const ci = src.map((v, i) => de[i] === 0 ? 0 : (v - esa[i]) / (0.015 * de[i]));
  const wt1 = emaArr(ci, VMC.avg);
  return { wt1, wt2: smaArr(wt1, VMC.malen) };
}
function moneyFlow(c) {
  const raw = c.map(x => { const r = x.h - x.l; return r === 0 ? 0 : ((x.c - x.o) / r) * VMC.mfiMult; });
  return smaArr(raw, VMC.mfiPeriod).map(v => v - VMC.mfiPosY);
}
function rsiArr(c, p = 14) {
  const cl = c.map(x => x.c), out = new Array(cl.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1], up = Math.max(0, d), dn = Math.max(0, -d);
    if (i <= p) { g += up / p; l += dn / p; if (i === p) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
function atrArr(c, p = 14) {
  const out = new Array(c.length).fill(NaN);
  let prev = NaN;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    prev = Number.isFinite(prev) ? (prev * (p - 1) + tr) / p : tr;
    if (i >= p) out[i] = prev;
  }
  return out;
}

// ── CONFIRMED PIVOTS ──────────────────────────────────────────────────────────────────────────
// `confirmedAt` is the bar on which this pivot became knowable. Everything downstream filters on
// that, never on the pivot's own index. Get this wrong and every pattern in the file becomes a
// prophecy.
const LEFT = 3, RIGHT = 3;
function pivots(c) {
  const lows = [], highs = [];
  for (let i = LEFT; i < c.length - RIGHT; i++) {
    let lo = true, hi = true;
    for (let j = i - LEFT; j <= i + RIGHT; j++) {
      if (j === i) continue;
      if (c[j].l <= c[i].l) lo = false;
      if (c[j].h >= c[i].h) hi = false;
    }
    if (lo) lows.push({ i, px: c[i].l, confirmedAt: i + RIGHT });
    if (hi) highs.push({ i, px: c[i].h, confirmedAt: i + RIGHT });
  }
  return { lows, highs };
}

// ── PATTERNS, from confirmed pivots only ──────────────────────────────────────────────────────
// Each returns events { at, kind, level, invalidate } where `at` is the bar the pattern was
// COMPLETE and knowable. `level` is the neckline (or the second low/high) and `invalidate` is the
// far side of the structure — which is what a "pattern" stop is measured against.
function findPatterns(c, pv) {
  const out = [];
  const near = (a, b, tol) => Math.abs(a - b) / ((a + b) / 2) <= tol;

  // Head and shoulders / inverse. Three pivots of the right shape, the middle one the extreme,
  // the two shoulders within 8% of each other, and the pattern only counts once price CLOSES
  // through the neckline — which is the event a trader could actually act on.
  const scan = (piv, inverse) => {
    for (let k = 2; k < piv.length; k++) {
      const [a, b, cc] = [piv[k - 2], piv[k - 1], piv[k]];
      const ok = inverse ? (b.px < a.px && b.px < cc.px) : (b.px > a.px && b.px > cc.px);
      if (!ok || !near(a.px, cc.px, 0.08)) continue;
      // The neckline is the extreme BETWEEN the shoulders, on the other side of the pivots used.
      let neck = inverse ? -Infinity : Infinity;
      for (let j = a.i; j <= cc.i; j++) neck = inverse ? Math.max(neck, c[j].h) : Math.min(neck, c[j].l);
      if (!Number.isFinite(neck)) continue;
      // Wait for the break, but only from the bar the last shoulder was CONFIRMED.
      for (let j = cc.confirmedAt; j < Math.min(c.length, cc.confirmedAt + 30); j++) {
        const broke = inverse ? c[j].c > neck : c[j].c < neck;
        if (!broke) continue;
        out.push({ at: j, kind: inverse ? "invHeadShoulders" : "headShoulders",
                   level: neck, invalidate: cc.px });
        break;
      }
    }
  };
  scan(pv.lows, true);
  scan(pv.highs, false);

  // Double bottom / top: two pivots within 3% of each other, 5–60 bars apart, then a close through
  // the high (or low) that sat between them.
  const dbl = (piv, isBottom) => {
    for (let k = 1; k < piv.length; k++) {
      const a = piv[k - 1], b = piv[k];
      if (!near(a.px, b.px, 0.03)) continue;
      const gap = b.i - a.i; if (gap < 5 || gap > 60) continue;
      let mid = isBottom ? -Infinity : Infinity;
      for (let j = a.i; j <= b.i; j++) mid = isBottom ? Math.max(mid, c[j].h) : Math.min(mid, c[j].l);
      for (let j = b.confirmedAt; j < Math.min(c.length, b.confirmedAt + 30); j++) {
        const broke = isBottom ? c[j].c > mid : c[j].c < mid;
        if (!broke) continue;
        out.push({ at: j, kind: isBottom ? "doubleBottom" : "doubleTop",
                   level: mid, invalidate: Math.min(a.px, b.px) * (isBottom ? 1 : 1) });
        break;
      }
    }
  };
  dbl(pv.lows, true);
  dbl(pv.highs, false);
  return out;
}

// Fair value gaps: a three-bar imbalance, recorded at the bar it completes.
function findFvgs(c) {
  const out = [];
  for (let i = 2; i < c.length; i++) {
    if (c[i].l > c[i - 2].h) out.push({ at: i, dir: "bull", top: c[i].l, bottom: c[i - 2].h });
    if (c[i].h < c[i - 2].l) out.push({ at: i, dir: "bear", top: c[i - 2].l, bottom: c[i].h });
  }
  return out;
}

// Aggregate for the multi-timeframe condition. Built from the SAME bars, so the two series cannot
// disagree about what time it is — the classic MTF backtest bug.
function aggregate(c, mult) {
  const out = [], map = new Array(c.length).fill(-1);
  for (let i = 0; i < c.length; i++) {
    const k = Math.floor(i / mult);
    if (!out[k]) out[k] = { t: c[i].t, o: c[i].o, h: c[i].h, l: c[i].l, c: c[i].c };
    else { const b = out[k]; b.h = Math.max(b.h, c[i].h); b.l = Math.min(b.l, c[i].l); b.c = c[i].c; }
    // A higher-timeframe bar is only usable once it has CLOSED, so bar i maps to the previous
    // completed aggregate, never the one it is still inside.
    map[i] = k - 1;
  }
  return { bars: out.filter(Boolean), map };
}

// ── THE CONTEXT: everything precomputed once ──────────────────────────────────────────────────
export function buildContext(c, depth = 0) {
  const { wt1, wt2 } = waveTrend(c);
  const pv = pivots(c);
  const ctx = {
    c, wt1, wt2, mf: moneyFlow(c), atr: atrArr(c, 14),
    rsi: {}, sma: {}, pv, patterns: findPatterns(c, pv), fvgs: findFvgs(c), htf: {},
  };
  ctx.rsiFor = p => (ctx.rsi[p] ||= rsiArr(c, p));
  ctx.smaFor = p => (ctx.sma[p] ||= smaArr(c.map(x => x.c), p));
  ctx.htfFor = m => {
    if (!ctx.htf[m]) {
      const { bars, map } = aggregate(c, m);
      ctx.htf[m] = { map, ctx: depth >= 1 ? null : buildContext(bars, depth + 1) };
    }
    return ctx.htf[m];
  };
  return ctx;
}

// ── EVALUATING ONE CONDITION AT BAR i ─────────────────────────────────────────────────────────
const TESTS = {
  wtCrossUp:   (x, i) => x.wt1[i] > x.wt2[i] && x.wt1[i-1] <= x.wt2[i-1],
  wtCrossDown: (x, i) => x.wt1[i] < x.wt2[i] && x.wt1[i-1] >= x.wt2[i-1],
  wt2Below:    (x, i, a) => x.wt2[i] < a.value,
  wt2Above:    (x, i, a) => x.wt2[i] > a.value,
  wtRising:    (x, i, a) => { for (let k = 0; k < a.bars; k++) if (!(x.wt1[i-k] > x.wt1[i-k-1])) return false; return true; },
  wtFalling:   (x, i, a) => { for (let k = 0; k < a.bars; k++) if (!(x.wt1[i-k] < x.wt1[i-k-1])) return false; return true; },
  mfPositive:  (x, i) => x.mf[i] > 0,
  mfNegative:  (x, i) => x.mf[i] < 0,
  mfFlippedUp:   (x, i, a) => { for (let k = 0; k < a.within; k++) if (x.mf[i-k] > 0 && x.mf[i-k-1] <= 0) return true; return false; },
  mfFlippedDown: (x, i, a) => { for (let k = 0; k < a.within; k++) if (x.mf[i-k] < 0 && x.mf[i-k-1] >= 0) return true; return false; },
  rsiBelow:    (x, i, a) => x.rsiFor(a.period || 14)[i] < a.value,
  rsiAbove:    (x, i, a) => x.rsiFor(a.period || 14)[i] > a.value,
  aboveSma:    (x, i, a) => x.c[i].c > x.smaFor(a.period)[i],
  belowSma:    (x, i, a) => x.c[i].c < x.smaFor(a.period)[i],
  atrPctAbove: (x, i, a) => (x.atr[i] / x.c[i].c) * 100 > a.value,
  atrPctBelow: (x, i, a) => (x.atr[i] / x.c[i].c) * 100 < a.value,
  pattern:     (x, i, a) => x.patterns.some(p => p.kind === a.name && p.at <= i && p.at > i - a.within),
  pivotLow:    (x, i, a) => x.pv.lows.some(p => p.confirmedAt <= i && p.confirmedAt > i - a.within),
  pivotHigh:   (x, i, a) => x.pv.highs.some(p => p.confirmedAt <= i && p.confirmedAt > i - a.within),
  higherHigh:  (x, i) => { const h = x.pv.highs.filter(p => p.confirmedAt <= i).slice(-2);
                           return h.length === 2 && h[1].px > h[0].px; },
  lowerLow:    (x, i) => { const l = x.pv.lows.filter(p => p.confirmedAt <= i).slice(-2);
                           return l.length === 2 && l[1].px < l[0].px; },
  bullFvg:     (x, i, a) => x.fvgs.some(f => f.dir === "bull" && f.at <= i && f.at > i - a.within),
  bearFvg:     (x, i, a) => x.fvgs.some(f => f.dir === "bear" && f.at <= i && f.at > i - a.within),
  htf:         (x, i, a) => {
    const h = x.htfFor(a.mult);
    if (!h.ctx) return false;
    const j = h.map[i];                       // the last CLOSED higher-timeframe bar
    if (j < 1 || j >= h.ctx.c.length) return false;
    return evalCond(h.ctx, j, a.cond);
  },
};

function evalCond(x, i, cond) {
  const spec = CONDITIONS[cond.fn];
  if (!spec || i < spec.needs) return false;
  const fn = TESTS[cond.fn];
  if (!fn) return false;
  try { const v = fn(x, i, cond); return v === true; } catch { return false; }
}

// ── STOP PLACEMENT ────────────────────────────────────────────────────────────────────────────
function stopFor(x, i, rule, entry) {
  const a = x.atr[i], sgn = rule.dir === "short" ? -1 : 1;
  if (!Number.isFinite(a) || a <= 0) return null;
  const s = rule.stop;
  if (s.kind === "atr") return entry - sgn * s.mult * a;
  if (s.kind === "percent") return entry * (1 - sgn * s.value / 100);
  if (s.kind === "swing") {
    const from = Math.max(0, i - s.lookback + 1), pad = (s.padAtr || 0) * a;
    let lvl = rule.dir === "short" ? -Infinity : Infinity;
    for (let j = from; j <= i; j++) lvl = rule.dir === "short" ? Math.max(lvl, x.c[j].h) : Math.min(lvl, x.c[j].l);
    return Number.isFinite(lvl) ? lvl - sgn * pad : null;
  }
  if (s.kind === "pattern") {
    // The structure that triggered it. If the rule has no pattern condition there is nothing to
    // measure against, and inventing a level would be the plan fitting itself to the trade.
    const p = x.patterns.filter(q => q.at <= i && q.at > i - 60).pop();
    if (!p) return null;
    return p.invalidate - sgn * (s.padAtr || 0) * a;
  }
  return null;
}

// ── RUN A RULE OVER ONE SERIES ────────────────────────────────────────────────────────────────
// costPct is charged as a fraction of R, the same way the live agent reasons about it: a round
// trip costs about 0.22% of notional, and what that means in R depends entirely on how wide the
// stop is. A rule with tight stops therefore pays a large penalty, which is exactly right and is
// the thing a naive backtest hides.
export function runRule(c, rule, { costPct = 0.22, minStopPct = 2.2, ctx = null } = {}) {
  const x = ctx || buildContext(c);
  const trades = [];
  const need = Math.max(...rule.when.map(w => (CONDITIONS[w.fn] || { needs: 80 }).needs), 60);
  let cooldownUntil = -1;
  for (let i = need; i < c.length - 1; i++) {
    if (i <= cooldownUntil) continue;                       // one trade at a time, like the live bot
    let all = true;
    for (const cond of rule.when) if (!evalCond(x, i, cond)) { all = false; break; }
    if (!all) continue;
    const entry = c[i].c;
    const stop = stopFor(x, i, rule, entry);
    if (stop === null || !Number.isFinite(stop)) continue;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const stopPct = risk / entry * 100;
    if (stopPct < minStopPct) continue;                     // the live cost floor, applied honestly
    const sgn = rule.dir === "short" ? -1 : 1;
    if (sgn * (entry - stop) <= 0) continue;                // stop on the wrong side — never trade it
    const target = entry + sgn * risk * rule.target.value;
    const costR = costPct / stopPct;                        // cost expressed in R

    let R = null, bars = 0;
    for (let j = i + 1; j < Math.min(c.length, i + 1 + rule.maxBars); j++) {
      bars = j - i;
      // Stop first on a bar that covers both. We cannot know the order inside a bar, and resolving
      // the ambiguity in our own favour is how a losing rule reports a profit.
      if (rule.dir === "short" ? c[j].h >= stop : c[j].l <= stop) { R = -1; break; }
      if (rule.dir === "short" ? c[j].l <= target : c[j].h >= target) { R = rule.target.value; break; }
    }
    if (R === null) {
      const last = c[Math.min(c.length, i + 1 + rule.maxBars) - 1].c;
      R = (rule.dir === "short" ? entry - last : last - entry) / risk;
    }
    trades.push({ i, t: c[i].t, entry, stop, target, R: R - costR, rawR: R, stopPct, bars });
    cooldownUntil = i + bars;
  }
  return trades;
}

// What this engine can actually evaluate. The agent checks a stored rule against this before
// running it: a condition that is in the schema but has no TESTS entry would silently return false
// on every bar, which reads as "the setup never fired" rather than "we could not evaluate it".
export const CONDITION_NAMES = Object.fromEntries(Object.keys(TESTS).map(k => [k, true]));

export const _internals = { pivots, findPatterns, findFvgs, aggregate, waveTrend, atrArr };
