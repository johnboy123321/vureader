// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SCORER — the ruthless filter that makes a cheap model good enough
//
//  The whole economics of this idea rest on one thing: a bad proposal must cost CPU, not money.
//  That only holds if the filter is genuinely hard to fool. If it can be fooled, a generator that
//  produces a hundred setups a day will find something that looks wonderful and is worth nothing,
//  and it will do it very efficiently.
//
//  ── THE TRAP, NAMED ───────────────────────────────────────────────────────────────────────────
//  Test 200 rules, keep the best 3, and you have not found an edge — you have found the right tail
//  of a noise distribution. With enough attempts, something always wins. This is the single reason
//  most published strategy research is worthless, and it is not a small effect: at 200 candidates,
//  the best one will typically look excellent on pure chance alone.
//
//  There is no clever statistic that rescues you. The only defence is data the rule was not chosen
//  on. So:
//
//     DISCOVER on six coins   BTC ETH SOL XRP BNB DOGE
//     VALIDATE on six others  ADA LINK AVAX LTC DOT ATOM     ← never used to select anything
//
//  and, separately, both halves of the time period must agree. A rule earns the word "survives"
//  only if it clears the bar on the validation coins it has never been scored on, and in both
//  halves. Everything else is "looked promising", which is a different word on purpose.
//
//  ── THE BAR ───────────────────────────────────────────────────────────────────────────────────
//  Compared against the live agent's own measured record: 35.2% win rate, +0.058R expectancy over
//  13,454 replayed trades. A new setup is only interesting if it beats THAT, not if it beats zero.
//  Beating zero is easy in a sample where most coins went up.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import zlib from 'node:zlib';
import { runRule, buildContext } from './engine.mjs';
import { validateSetup } from './schema.mjs';

// ── THE SPLIT MUST NOT BE STRATIFIED BY ANYTHING THAT MATTERS ─────────────────────────────────
// First attempt split by market cap, which put all six RISERS in discovery and all six FALLERS in
// validation (ADA -34%, AVAX -31%, LTC -33%, DOT -81%, ATOM -83%). The search promptly returned 99
// "survivors", every single one of them a short. They had not found an edge — they had found that
// the held-out set was a bear market. The random control survived at a HIGHER rate than the real
// setups, which is the only reason this was caught.
//
// So the two sides are now matched on the thing most likely to confound them: three coins that
// rose and three that fell on each side. A held-out set that differs systematically from the
// discovery set does not test generalisation, it tests direction.
//                     rose:  BTC +133%  SOL +241%  BNB +174%   |  ETH +11%  XRP +106%  DOGE +12%
//                     fell:  ADA  -34%  AVAX -31%  DOT  -81%   |  LINK -0%  LTC  -33%  ATOM -83%
export const DISCOVER = ['BTC','SOL','BNB','ADA','AVAX','DOT'];
export const VALIDATE = ['ETH','XRP','DOGE','LINK','LTC','ATOM'];
// ── WHERE THE CANDLES LIVE ────────────────────────────────────────────────────────────────────
// Hardcoding one path meant this only ran on the machine it was written on. The repo it has to run
// in keeps its candles somewhere else entirely, and a module that throws ENOENT on import is the
// least helpful way to discover that. So: look in the usual places, allow an override, and if
// none of them exist say exactly which paths were tried — a missing-data error should tell you
// where to put the data.
const DATA = (() => {
  const tried = [process.env.CANDLE_DIR, 'bt-cipherb/data', 'backtest-data', 'backtest/data', 'data']
    .filter(Boolean);
  for (const d of tried) { try { if (fs.statSync(d).isDirectory()) return d; } catch {} }
  throw new Error('no candle directory found. Tried: ' + tried.join(', ') +
    '. Set CANDLE_DIR to the folder holding <COIN>.json.gz files.');
})();

// The live agent's own measured expectancy — the number to beat, not zero.
export const BASELINE_R = 0.058;
export const MIN_TRADES = 40;          // per side of the split, before anything is claimed

const cache = new Map();
export function bars(coin, tf) {
  const k = coin + tf;
  if (!cache.has(k)) {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DATA}/${coin}.json.gz`)));
    cache.set(k, j.tfs[tf].map(([t,o,h,l,c,v]) => ({ t,o,h,l,c })));
  }
  return cache.get(k);
}
const ctxCache = new Map();
function ctxFor(coin, tf) {
  const k = coin + tf;
  if (!ctxCache.has(k)) ctxCache.set(k, buildContext(bars(coin, tf)));
  return ctxCache.get(k);
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, win: 0, exp: 0, totalR: 0, maxDD: 0, pf: 0 };
  const R = trades.map(t => t.R);
  const wins = R.filter(r => r > 0);
  const gw = wins.reduce((s,r)=>s+r,0), gl = Math.abs(R.filter(r=>r<=0).reduce((s,r)=>s+r,0));
  let eq = 0, peak = 0, dd = 0;
  for (const r of R) { eq += r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return { n, win: wins.length/n, exp: eq/n, totalR: eq, maxDD: dd, pf: gl ? gw/gl : (gw>0?Infinity:0) };
}

// Score a rule over a set of coins, optionally over one half of the history.
function scoreOn(rule, coins, half = null) {
  const all = [];
  const perCoin = {};
  for (const coin of coins) {
    const c = bars(coin, rule.timeframe);
    const t = runRule(c, rule, { ctx: ctxFor(coin, rule.timeframe) });
    const mid = Math.floor(c.length / 2);
    const keep = half === null ? t : half === 1 ? t.filter(x => x.i < mid) : t.filter(x => x.i >= mid);
    perCoin[coin] = summarise(keep);
    all.push(...keep);
  }
  return { ...summarise(all), perCoin };
}

// ── THE VERDICT ───────────────────────────────────────────────────────────────────────────────
export function scoreSetup(raw) {
  const v = validateSetup(raw);
  if (!v.ok) return { ok: false, errors: v.errors };
  const rule = v.rule;

  const disc = scoreOn(rule, DISCOVER);
  const val  = scoreOn(rule, VALIDATE);
  const h1   = scoreOn(rule, [...DISCOVER, ...VALIDATE], 1);
  const h2   = scoreOn(rule, [...DISCOVER, ...VALIDATE], 2);

  // Every reason it might fail, stated separately, so the feedback is usable rather than a verdict.
  const reasons = [];
  if (disc.n < MIN_TRADES) reasons.push(`only ${disc.n} trades on the discovery coins — needs ${MIN_TRADES} before any number means anything`);
  if (val.n < MIN_TRADES) reasons.push(`only ${val.n} trades on the validation coins — too rare to judge`);
  if (disc.exp <= BASELINE_R) reasons.push(`discovery expectancy ${disc.exp.toFixed(3)}R does not beat the bot's own ${BASELINE_R}R`);
  if (val.exp <= BASELINE_R) reasons.push(`VALIDATION expectancy ${val.exp.toFixed(3)}R does not beat ${BASELINE_R}R — it did not survive coins it was not chosen on`);
  if (h1.exp <= 0 || h2.exp <= 0) reasons.push(`fails a half: first half ${h1.exp.toFixed(3)}R, second half ${h2.exp.toFixed(3)}R — a rule that only worked in one period found a regime, not an edge`);

  // How many of the twelve coins it is individually positive on. A rule carried by one coin is one
  // coin's history, however good the pooled number looks.
  const perAll = { ...disc.perCoin, ...val.perCoin };
  const coinsPositive = Object.values(perAll).filter(s => s.n >= 5 && s.exp > 0).length;
  const coinsTraded = Object.values(perAll).filter(s => s.n >= 5).length;
  if (coinsTraded && coinsPositive / coinsTraded < 0.5)
    reasons.push(`positive on only ${coinsPositive} of ${coinsTraded} coins — carried by a few, not a general effect`);

  return {
    ok: true, rule, survives: reasons.length === 0, reasons,
    discovery: disc, validation: val, half1: h1, half2: h2,
    coinsPositive, coinsTraded, perCoin: perAll,
  };
}

// ── A HUMAN-READABLE CARD ─────────────────────────────────────────────────────────────────────
export function report(res) {
  if (!res.ok) return 'REJECTED — the proposal is not a valid setup:\n' + res.errors.map(e => '  · ' + e).join('\n');
  const r = res.rule;
  const line = (label, s) =>
    `  ${label.padEnd(22)} ${String(s.n).padStart(5)} trades   win ${(s.win*100).toFixed(1).padStart(5)}%   ` +
    `exp ${(s.exp>=0?'+':'')+s.exp.toFixed(3)}R   total ${s.totalR.toFixed(0).padStart(5)}R   maxDD ${s.maxDD.toFixed(0)}R`;
  const L = [];
  L.push('─'.repeat(92));
  L.push(`${r.name}   (${r.dir} · ${r.timeframe} · target ${r.target.value}R · ${r.stop.kind} stop)`);
  L.push(`  falsifier: ${r.falsifier}`);
  L.push('─'.repeat(92));
  L.push(line('DISCOVERY  (6 coins)', res.discovery));
  L.push(line('VALIDATION (6 others)', res.validation));
  L.push(line('first half of history', res.half1));
  L.push(line('second half', res.half2));
  L.push(`  positive on ${res.coinsPositive} of ${res.coinsTraded} coins that traded it`);
  L.push(`  the bar: beat the live bot's own +${BASELINE_R}R, on the validation coins, in both halves`);
  L.push('');
  L.push(res.survives
    ? '  ✓ SURVIVES — worth a shadow arm.'
    : '  ✗ does not survive:\n' + res.reasons.map(x => '      · ' + x).join('\n'));
  return L.join('\n');
}
