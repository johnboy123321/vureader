// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  OPEN INTEREST + ORDER FLOW — is there signal in the one data class Cipher has never used?
//
//  Three years of hourly open interest, long/short account ratios and taker buy volume for all
//  25 coins have been sitting in backtest-data/oi and backtest-data/flow since September. Nothing
//  in the repo reads them. This asks the question of the bot's OWN replayed trades: knowing only
//  what was knowable at the moment of the decision, do any of these separate winners from losers?
//
//  PRE-REGISTERED 2026-11-11, before a single number was looked at:
//    F1  oi24      % change in open interest (contracts) over the 24h before the decision
//                  buckets: falling (< -3%) · flat · rising (> +3%)
//    F2  quadrant  the 24h price move × the sign of the OI change × which way the trade goes
//                  with-move/OI-up · with-move/OI-down · against-move/OI-up · against-move/OI-down
//    F3  crowd     all-accounts long/short ratio, z-scored on its own prior 30 days
//                  trade WITH a crowded side (|z|>1) · AGAINST it · neutral
//    F4  flow      taker-buy share of volume over the prior 24h, z-scored on its prior 30 days
//                  trade WITH aggressive flow (|z|>1) · AGAINST it · neutral
//    F5  oiLevel   open interest level z-scored on its prior 30 days: high (>1) · mid · low (<-1)
//  16 buckets in all. A bucket is a LEAD only if: n >= 150, the 95% interval on £/trade excludes
//  zero, and it keeps its sign in both halves of the sample. With 16 buckets, one lead is what
//  chance alone would produce about half the time — so STRONG additionally needs |t| > 3.
//  Money, not R (R's denominator moves with the fill). Every figure is net of fees and funding.
//
//  No look-ahead: an OI snapshot stamped t is used only if t < decision time; an hourly flow bar
//  starting at t is used only once it has closed (t + 1h <= decision time).
//
//    node oi-test.mjs            (needs trades.json from run-backtest.mjs, and OI_DIR / FLOW_DIR)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { loadCoin } from './lib/data.mjs';
import { ci95, mean } from './lib/report.mjs';

const OI_DIR = process.env.OI_DIR || '../backtest-data/oi';
const FLOW_DIR = process.env.FLOW_DIR || '../backtest-data/flow';
const T = JSON.parse(fs.readFileSync(process.env.TRADES || 'trades.json', 'utf8'));
const H = 36e5, D30 = 720;

const gz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)));
const cache = new Map();
function series(coin) {
  if (cache.has(coin)) return cache.get(coin);
  let oi = null, flow = null, px = null;
  try { oi = gz(path.join(OI_DIR, coin + '.json.gz')); } catch {}
  try { flow = gz(path.join(FLOW_DIR, coin + '.json.gz')); } catch {}
  try { px = loadCoin(coin).tfs['1H']; } catch {}
  const s = { oi: null, flow: null, px };
  if (oi) {
    const c = (n) => oi.cols.indexOf(n) + 1;
    s.oi = { t: oi.rows.map(r => r[0]), oi: oi.rows.map(r => r[c('sum_open_interest')]), ls: oi.rows.map(r => r[c('count_long_short_ratio')]) };
  }
  if (flow) {
    const c = (n) => flow.cols.indexOf(n) + 1;
    const t = flow.rows.map(r => r[0]), v = flow.rows.map(r => r[c('volume')]), b = flow.rows.map(r => r[c('taker_buy_volume')]);
    // rolling 24h taker-buy share, indexed by the bar that ENDS the window
    const share = new Array(t.length).fill(null); let sv = 0, sb = 0;
    for (let i = 0; i < t.length; i++) { sv += v[i] || 0; sb += b[i] || 0; if (i >= 24) { sv -= v[i - 24] || 0; sb -= b[i - 24] || 0; } if (i >= 23 && sv > 0) share[i] = sb / sv; }
    s.flow = { t, share };
  }
  cache.set(coin, s); return s;
}
// last index with t[i] <= x  (binary search); -1 if none
function lastLE(t, x) { let lo = 0, hi = t.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= x) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
function zAt(arr, i, n = D30) {
  if (i < n || arr[i] == null) return null;
  let s = 0, s2 = 0, k = 0;
  for (let j = i - n; j < i; j++) { const v = arr[j]; if (v == null || !Number.isFinite(v)) continue; s += v; s2 += v * v; k++; }
  if (k < n * 0.8) return null;
  const m = s / k, sd = Math.sqrt(Math.max(0, s2 / k - m * m));
  return sd > 0 ? (arr[i] - m) / sd : null;
}

let covered = 0;
for (const t of T) {
  const s = series(t.coin), at = t.placedAt, long = /long|buy|bull/i.test(String(t.dir)), sgn = long ? 1 : -1;
  const f = {};
  if (s.oi) {
    const i = lastLE(s.oi.t, at - 1);                       // strictly before the decision
    const j = i >= 0 ? lastLE(s.oi.t, s.oi.t[i] - 24 * H) : -1;
    if (i >= 0 && j >= 0 && s.oi.t[i] >= at - 3 * H && s.oi.oi[i] > 0 && s.oi.oi[j] > 0) {
      f.oi24 = (s.oi.oi[i] / s.oi.oi[j] - 1) * 100;
      f.oiZ = zAt(s.oi.oi, i);
      const lz = zAt(s.oi.ls, i); f.crowdZ = lz == null ? null : lz * sgn;      // + = trading WITH the crowded side
    }
  }
  if (s.px) {
    const pt = s.px.map ? null : null;                      // (bars are objects)
    const tt = s._pt || (s._pt = s.px.map(b => b.t));
    const i = lastLE(tt, at - H);                           // last CLOSED 1H bar
    const j = i >= 0 ? lastLE(tt, tt[i] - 24 * H) : -1;
    if (i >= 0 && j >= 0) f.px24 = (s.px[i].c / s.px[j].c - 1) * 100;
  }
  if (s.flow) {
    const i = lastLE(s.flow.t, at - H);                     // bar must have closed
    if (i >= 0 && s.flow.t[i] >= at - 3 * H) { const z = zAt(s.flow.share, i); f.flowZ = z == null ? null : z * sgn; }
  }
  if (f.oi24 != null && f.px24 != null) { f.withMove = Math.sign(f.px24) === sgn; covered++; }
  t.oif = f;
}

const sorted = [...T].sort((a, b) => a.exitAt - b.exitAt), mid = sorted[Math.floor(sorted.length / 2)].exitAt;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const all = ci95(T.map(t => t.netGbp));
const out = [];
const P = (s) => { console.log(s); out.push(s); };
P('OPEN INTEREST + FLOW vs THE BOT\'S OWN REPLAYED TRADES');
P(`trades ${T.length} · with OI+price coverage ${covered} · book: £${all.m.toFixed(2)}/trade [${all.lo.toFixed(2)}, ${all.hi.toFixed(2)}] · total £${sum(T.map(t => t.netGbp)).toFixed(0)}`);
P('lead = n>=150, interval excludes zero, same sign in both halves · STRONG = lead and |t|>3 (16 buckets tested)\n');
const leads = [];
function row(feature, label, pred) {
  const q = T.filter(t => { try { return pred(t.oif, t) === true; } catch { return false; } });
  if (q.length < 30) { P(`  ${label.padEnd(34)} n=${q.length} — too few`); return; }
  const m = q.map(t => t.netGbp), c = ci95(m), tstat = c.m / c.se;
  const h1 = mean(q.filter(t => t.exitAt < mid).map(t => t.netGbp)), h2 = mean(q.filter(t => t.exitAt >= mid).map(t => t.netGbp));
  const agree = (h1 > 0) === (h2 > 0), excl = c.lo > 0 || c.hi < 0;
  const lead = q.length >= 150 && excl && agree, strong = lead && Math.abs(tstat) > 3;
  const rest = T.filter(t => !q.includes(t)).map(t => t.netGbp), rc = ci95(rest);
  const win = q.filter(t => t.netGbp > 0).length / q.length * 100;
  P(`  ${label.padEnd(34)} n=${String(q.length).padStart(5)}  £${c.m.toFixed(2).padStart(6)}  [${c.lo.toFixed(2).padStart(6)}, ${c.hi.toFixed(2).padStart(6)}]  t=${tstat.toFixed(2).padStart(5)}  win ${win.toFixed(0)}%  halves ${h1.toFixed(2)} / ${h2.toFixed(2)} ${agree ? '✓' : '✗'}  ${strong ? 'STRONG' : lead ? 'lead' : ''}`);
  if (lead) leads.push({ feature, label, n: q.length, m: c.m, t: tstat, strong, restM: rc.m, restLo: rc.lo, restHi: rc.hi, restN: rest.length });
}
P('F1  open interest change, prior 24h');
row('F1', 'OI falling  (< -3%)', f => f.oi24 != null && f.oi24 < -3);
row('F1', 'OI flat', f => f.oi24 != null && f.oi24 >= -3 && f.oi24 <= 3);
row('F1', 'OI rising   (> +3%)', f => f.oi24 != null && f.oi24 > 3);
P('\nF2  price move × OI × trade direction');
row('F2', 'with the move, OI rising', f => f.withMove === true && f.oi24 > 0);
row('F2', 'with the move, OI falling', f => f.withMove === true && f.oi24 <= 0);
row('F2', 'against the move, OI rising', f => f.withMove === false && f.oi24 > 0);
row('F2', 'against the move, OI falling', f => f.withMove === false && f.oi24 <= 0);
P('\nF3  the crowd (all-accounts long/short ratio, z on 30d)');
row('F3', 'trading WITH the crowded side', f => f.crowdZ != null && f.crowdZ > 1);
row('F3', 'neutral', f => f.crowdZ != null && Math.abs(f.crowdZ) <= 1);
row('F3', 'trading AGAINST the crowd', f => f.crowdZ != null && f.crowdZ < -1);
P('\nF4  aggressive flow (taker-buy share, 24h, z on 30d)');
row('F4', 'trading WITH the flow', f => f.flowZ != null && f.flowZ > 1);
row('F4', 'neutral', f => f.flowZ != null && Math.abs(f.flowZ) <= 1);
row('F4', 'trading AGAINST the flow', f => f.flowZ != null && f.flowZ < -1);
P('\nF5  open interest level (z on 30d)');
row('F5', 'OI high (z > 1)', f => f.oiZ != null && f.oiZ > 1);
row('F5', 'OI mid', f => f.oiZ != null && Math.abs(f.oiZ) <= 1);
row('F5', 'OI low  (z < -1)', f => f.oiZ != null && f.oiZ < -1);

P('\nVERDICT');
if (!leads.length) P('  No bucket cleared the bar. Open interest and flow, cut these five ways, do not separate this bot\'s winners from its losers.');
for (const l of leads) {
  P(`  ${l.strong ? 'STRONG' : 'lead  '}  ${l.feature} "${l.label.trim()}": £${l.m.toFixed(2)}/trade over ${l.n} (t=${l.t.toFixed(2)}).`);
  if (l.m < 0) P(`          dropping it leaves ${l.restN} trades at £${l.restM.toFixed(2)}/trade [${l.restLo.toFixed(2)}, ${l.restHi.toFixed(2)}] — ${l.restLo > 0 ? 'the rest of the book is then positive with the interval clear of zero' : l.restM > 0 ? 'the rest turns positive on average but the interval still spans zero' : 'the rest is still not positive'}.`);
}
P(`  ${leads.length} of 16 buckets flagged; chance alone flags about one in twenty, so ~0.8 expected with no real effect.`);
fs.writeFileSync('OI_RESULTS.txt', out.join('\n') + '\n');
fs.writeFileSync('trades-oi.json', JSON.stringify(T));
