// The replay. Drives the LIVE decision pipeline over history at 1H resolution and walks each
// resulting order forward bar by bar.
//
// What is faithfully modelled: the scan pipeline (scoreCoin → detector sweep → quality gate),
// the trade plan, planValid, buildOrder (including the entry cross and the notional clamp), the
// day-scoped one-trade-per-coin-per-direction dedupe, the no-hedge rule, "already holding this
// coin", the correlation cap, the daily cap, and the exit at T2 that buildOrder actually sets.
//
// Every simplification is COUNTED in stats and printed with the result. An uncounted
// simplification is an unfalsifiable claim.
import { loadRules } from './rules.mjs';
import { TF_MS, closedBy } from './data.mjs';

export const DEFAULT_COSTS = {
  takerBps: 6,        // Phemex USDⓈ-M taker, 0.06%
  entrySlipBps: 5,    // marketable limit crossing 1% through the book
  stopSlipBps: 10,    // a stop is a market order into the move that triggered it
  fundingOn: true,
};

const CONF_TFS = ['1D', '4H', '1H'];
const DET_TFS = ['1D', '4H', '1H'];   // 30m/15m are not in the dataset — see stats.detectorTfsMissing

export async function runBacktest(coins, opts = {}) {
  const {
    costs = DEFAULT_COSTS,
    riskGbp = 10,
    from = null, to = null,
    relayCap = null,          // null = unclamped (matches the agent before it has read /status)
    corrMax = 6, dayCap = 25,
    targetR = null,           // null = the plan's own T2, as buildOrder sets it
    noTarget = false,         // exit on the stop only, recording how far the trade ever ran
    onProgress = null,
  } = opts;

  const { M, TF_WEIGHT, DET_WEIGHT, MIN_QUALITY, sourceHash } = await loadRules();
  M.__setRelayCap(relayCap);

  const minScore = M.CFG.minScore();
  const DETS = [['divergence', M.detectWTDivergence], ['rollover', M.detectMomentumRollover], ['greendot', M.detectGreenDotMFReversal]];

  // ── the clock: every 1H close that every coin shares ────────────────────────────────────────
  const stamps = new Set();
  for (const d of coins.values()) for (const b of d.tfs['1H']) stamps.add(b.t + TF_MS['1H']);
  let clock = [...stamps].sort((a, b) => a - b);
  if (from) clock = clock.filter(t => t >= from);
  if (to) clock = clock.filter(t => t <= to);
  // No global warm-up. The live agent asks each coin for 260 bars and works with whatever comes
  // back, so a coin joins the scan as soon as it has enough history for the detectors — which is
  // what scanOnce enforces per coin, per timeframe. A single global start date would have thrown
  // away every trade before the LATEST-listing coin was ready (POL is missing 13 early months,
  // which silently deleted 2023 and 2024 from an earlier run of this harness).

  const names = [...coins.keys()];
  const trades = [];
  const open = [];      // filled positions
  const resting = [];   // placed, not yet filled
  const fired = new Map();      // "COIN|dir|YYYY-MM-DD" → true
  let placedToday = 0, curDay = null;
  const stats = {
    stamps: clock.length, coins: names.length, evaluations: 0,
    signals: 0, plansRefused: 0, planValidRefused: 0, buildErrs: 0,
    skipHeld: 0, skipHedge: 0, skipDedupe: 0, skipCorr: 0, skipDayCap: 0, skipQuality: 0,
    ordersPlaced: 0, filled: 0, neverFilled: 0, stillRestingAtEnd: 0,
    ambiguousBars: 0, markedToMarket: 0, fundingFallbacks: 0, clamped: 0, filledBeyondStop: 0,
    detectorTfsMissing: ['30m', '15m'],
    sourceHash, TF_WEIGHT, DET_WEIGHT, MIN_QUALITY, minScore, costs, riskGbp, relayCap,
  };

  // cursor rotation stands in for the agent's batch cursor, so the correlation and daily caps
  // don't systematically favour whichever coin sorts first
  let cursor = 0;

  for (let ci = 0; ci < clock.length; ci++) {
    const T = clock[ci];
    const day = new Date(T).toISOString().slice(0, 10);
    if (day !== curDay) { curDay = day; placedToday = 0; for (const k of [...fired.keys()]) if (!k.endsWith(day)) fired.delete(k); }

    // 1) advance every live order/position on this bar BEFORE looking for new ones
    stepPositions(T, coins, open, resting, trades, stats, costs);

    // 2) scan
    const heldCoins = new Set(open.map(p => p.coin));
    const heldDir = new Map();
    for (const p of open) { if (!heldDir.has(p.coin)) heldDir.set(p.coin, new Set()); heldDir.get(p.coin).add(p.dir); }
    const sameDir = d => open.filter(p => p.dir === d).length;

    for (let k = 0; k < names.length; k++) {
      const coin = names[(cursor + k) % names.length];
      const d = coins.get(coin);
      stats.evaluations++;

      const sig = scanOnce(M, d, T, { TF_WEIGHT, DET_WEIGHT, MIN_QUALITY, minScore, DETS, stats });
      if (!sig) continue;
      stats.signals++;

      const key = `${coin}|${sig.bias}|${day}`;
      if (fired.has(key)) { stats.skipDedupe++; continue; }
      const other = sig.bias === 'long' ? 'short' : 'long';
      if (heldDir.has(coin) && heldDir.get(coin).has(other)) { stats.skipHedge++; continue; }
      if (heldCoins.has(coin)) { stats.skipHeld++; continue; }
      if (sameDir(sig.bias) >= corrMax) { stats.skipCorr++; continue; }
      if (placedToday >= dayCap) { stats.skipDayCap++; break; }

      const planBars = sig.bars;
      const plan = M.buildTradePlan(planBars, sig.bias, sig.price);
      if (!plan) { stats.plansRefused++; continue; }

      const t = { coin, dir: sig.bias, entry: plan.entry, sl: plan.stop, tp1: plan.targets[0], tp2: plan.targets[1],
                  score: sig.score, stopKind: plan.stopKind, trend: plan.trend, zone: plan.zone };
      if (M.planValid(t)) { stats.planValidRefused++; continue; }

      const built = M.buildOrder(t);
      if (built.err) { stats.buildErrs++; continue; }
      if (built.meta.clamped) stats.clamped++;

      fired.set(key, true);
      placedToday++;
      stats.ordersPlaced++;
      resting.push({
        coin, dir: sig.bias, placedAt: T,
        limit: built.order.priceRp,
        sl: built.order.stopLossRp,
        // The exit dial. buildOrder sets T2 (2.25R); overriding it here is what makes the
        // win-rate-versus-expectancy trade-off measurable instead of arguable.
        tp: noTarget ? null
          : (targetR != null ? (plan.entry + (sig.bias === 'short' ? -1 : 1) * plan.risk * targetR)
                             : built.meta.exitPx),
        qty: built.meta.qty, riskUnit: built.meta.riskActual, clamped: !!built.meta.clamped,
        entryKind: built.meta.entryKind, stopKind: plan.stopKind, plannedEntry: plan.entry,
        detector: sig.detector || 'confluence', tf: sig.planTf, quality: sig.quality ?? null,
        stopPct: Math.abs(built.order.priceRp - built.order.stopLossRp) / built.order.priceRp,
      });
    }
    cursor = (cursor + 7) % names.length;    // co-prime-ish stride so the rotation is not a cycle of 1
    if (onProgress && ci % 500 === 0) onProgress(ci, clock.length, trades.length);
  }

  // 3) whatever is still open at the end is marked to market, and SAID SO
  for (const p of open) {
    const bars = coins.get(p.coin).tfs['1H'];
    const last = bars[bars.length - 1];
    closeTrade(p, last.c, last.t, 'marked-to-market', trades, stats, costs, coins);
    stats.markedToMarket++;
  }
  stats.stillRestingAtEnd = resting.length;
  stats.neverFilled = resting.length;

  return { trades, stats };
}

// ── ONE SCAN, EXACTLY AS THE AGENT DOES IT ────────────────────────────────────────────────────
function scanOnce(M, d, T, ctx) {
  const { TF_WEIGHT, DET_WEIGHT, MIN_QUALITY, minScore, DETS, stats } = ctx;
  const bars = {}, tfData = {};
  for (const tf of CONF_TFS) {
    const n = closedBy(d.tfs[tf], tf, T);
    if (n < 80) return null;
    bars[tf] = d.tfs[tf].slice(Math.max(0, n - 260), n);   // the same 260-bar window fetchCandles gives
    tfData[tf] = M.analyzeTF(bars[tf]);
  }

  let sig = M.scoreCoin(tfData);
  if (sig && sig.score < minScore) sig = null;
  if (sig) return { ...sig, bars: bars[sig.planTf] || bars['1D'], quality: null };

  const hits = [];
  for (const tf of DET_TFS) {
    const c = bars[tf]; if (!c || c.length < 80) continue;
    for (const [nm, fn] of DETS) {
      let r = null; try { r = fn(c); } catch { }
      if (!r || !r.match) continue;
      const bonus = (r.stage === 'extreme' || r.stage === 'fresh') ? 1 : 0;
      hits.push({ m: r, label: nm, tf, c, q: (TF_WEIGHT[tf] || 1) + (DET_WEIGHT[nm] || 1) + bonus });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.q - a.q);
  const best = hits[0];
  if (best.q < MIN_QUALITY) { stats.skipQuality++; return null; }
  return {
    bias: best.m.dir, score: minScore, price: best.c[best.c.length - 1].c,
    planTf: best.tf, detector: best.label, bars: best.c, quality: best.q,
  };
}

// ── ORDER AND POSITION LIFECYCLE ──────────────────────────────────────────────────────────────
function barAt(bars, T) {
  // the 1H bar that closed exactly at T
  const t = T - TF_MS['1H'];
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t === t) return bars[mid]; if (bars[mid].t < t) lo = mid + 1; else hi = mid - 1; }
  return null;
}

function stepPositions(T, coins, open, resting, trades, stats, costs) {
  // fills first: an order placed at the close of the previous bar can only fill from this one
  for (let i = resting.length - 1; i >= 0; i--) {
    const o = resting[i];
    if (T <= o.placedAt) continue;
    const b = barAt(coins.get(o.coin).tfs['1H'], T);
    if (!b) continue;
    const isLong = o.dir === 'long';
    const touched = isLong ? b.l <= o.limit : b.h >= o.limit;
    if (!touched) continue;
    // you never get a better price than the market opens at, and never worse than your limit
    let fill = isLong ? Math.min(o.limit, b.o) : Math.max(o.limit, b.o);
    fill = isLong ? fill * (1 + costs.entrySlipBps / 1e4) : fill * (1 - costs.entrySlipBps / 1e4);
    resting.splice(i, 1);
    stats.filled++;

    // ── FILLED ON THE WRONG SIDE OF ITS OWN STOP ─────────────────────────────────────────────
    // ENTRY_EXPIRY_H is declared in the agent and never read, so an unfilled limit rests forever.
    // If price runs through the stop level before the order fills, the position opens already
    // beyond its stop and the exchange triggers it immediately — a scratch, not a winner. Without
    // this the replay would book the distance from the fill back up to the stop as PROFIT, which
    // is exactly the kind of quiet flattery a backtest must not do.
    const throughStop = isLong ? fill <= o.sl : fill >= o.sl;
    if (throughStop) {
      stats.filledBeyondStop++;
      open.push({ ...o, fill, filledAt: T });
      closeTrade(open.pop(), fill, T, 'instant-stop', trades, stats, costs, coins);
      continue;
    }
    open.push({ ...o, fill, filledAt: T });
  }

  // then exits, on the same bar the position may have been filled on
  for (let i = open.length - 1; i >= 0; i--) {
    const p = open[i];
    if (T <= p.filledAt) continue;
    const b = barAt(coins.get(p.coin).tfs['1H'], T);
    if (!b) continue;
    const isLong = p.dir === 'long';
    // How far the trade EVER ran in its favour, in R. With no target set this is the whole
    // point of the run: every target multiple can then be read off one replay.
    const best = isLong ? b.h : b.l;
    const excursion = (best - p.fill) * (isLong ? 1 : -1) / Math.abs(p.fill - p.sl);
    if (!(p.mfe >= excursion)) p.mfe = excursion;
    const hitStop = isLong ? b.l <= p.sl : b.h >= p.sl;
    const hitTgt = p.tp != null && (isLong ? b.h >= p.tp : b.l <= p.tp);
    if (!hitStop && !hitTgt) continue;
    // A bar that contains both is scored as a STOP. Intrabar order is unknowable and assuming
    // the good one is how a backtest flatters itself.
    if (hitStop && hitTgt) stats.ambiguousBars++;
    if (hitStop) {
      const px = isLong ? p.sl * (1 - costs.stopSlipBps / 1e4) : p.sl * (1 + costs.stopSlipBps / 1e4);
      closeTrade(p, px, T, 'stop', trades, stats, costs, coins);
    } else {
      closeTrade(p, p.tp, T, 'target', trades, stats, costs, coins);
    }
    open.splice(i, 1);
  }
}

function closeTrade(p, exitPx, exitAt, how, trades, stats, costs, coins) {
  const sign = p.dir === 'long' ? 1 : -1;
  const grossGbp = (exitPx - p.fill) * sign * p.qty;
  const feeGbp = (p.fill * p.qty + exitPx * p.qty) * (costs.takerBps / 1e4);

  let fundGbp = 0, fundN = 0;
  if (costs.fundingOn) {
    const f = coins.get(p.coin).funding;
    let sum = 0;
    for (const s of f) { if (s.t > p.filledAt && s.t <= exitAt) { sum += s.rate; fundN++; } }
    if (!fundN && exitAt - p.filledAt > 288e5) stats.fundingFallbacks++;
    // longs pay a positive rate; the payment is on notional at entry (close enough at these sizes)
    fundGbp = -sign * sum * (p.fill * p.qty);
  }

  // ── WHAT ONE R IS ────────────────────────────────────────────────────────────────────────────
  // The money actually at stake: the size that was bought, times the distance from the price it
  // was bought at to the stop. NOT the figure buildOrder budgeted — those differ, and by a lot.
  // buildOrder sizes off `cross` (entry × 1.01 in immediate mode) but the marketable limit fills
  // at about `entry`, so the real distance to the stop is smaller than the one used for sizing
  // and the bot risks LESS than RISK_GBP on every trade. riskBudget keeps the intended figure so
  // the gap is measurable rather than buried.
  const riskReal = Math.abs(p.fill - p.sl) * p.qty;
  const R = (x) => x / riskReal;
  trades.push({
    riskReal, riskBudget: p.riskUnit, riskRatio: riskReal / p.riskUnit,
    coin: p.coin, dir: p.dir, detector: p.detector, tf: p.tf, quality: p.quality,
    stopKind: p.stopKind, entryKind: p.entryKind, clamped: p.clamped,
    placedAt: p.placedAt, filledAt: p.filledAt, exitAt, how,
    barsHeld: Math.round((exitAt - p.filledAt) / TF_MS['1H']),
    mfe: Number.isFinite(p.mfe) ? p.mfe : 0,
    plannedEntry: p.plannedEntry, limit: p.limit, fill: p.fill, sl: p.sl, tp: p.tp, exitPx,
    qty: p.qty, stopPct: p.stopPct, notional: p.fill * p.qty,
    grossGbp, feeGbp, fundGbp, netGbp: grossGbp - feeGbp + fundGbp,
    grossR: R(grossGbp), feeR: R(-feeGbp), fundR: R(fundGbp),
    netR: R(grossGbp - feeGbp + fundGbp),
    year: new Date(exitAt).getUTCFullYear(),
  });
}
