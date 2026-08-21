import fs from 'node:fs';
import { loadCoin, listCoins, manifest } from './lib/data.mjs';
import { runBacktest, DEFAULT_COSTS } from './lib/engine.mjs';
import { mean, sd, ci95, fmtR, pct, bootstrapPositive, summarise, table, buyHold } from './lib/report.mjs';

const t0 = Date.now();
const names = listCoins();
const coins = new Map();
for (const c of names) coins.set(c, loadCoin(c));
const mf = manifest();
console.log(`loaded ${coins.size} coins (${mf ? mf.from + ' → ' + mf.to : '?'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const L = [];
const say = (s = '') => { L.push(s); console.log(s); };

// ── the run ───────────────────────────────────────────────────────────────────────────────────
const free = { takerBps: 0, entrySlipBps: 0, stopSlipBps: 0, fundingOn: false };
const slipOnly = { takerBps: 0, entrySlipBps: 5, stopSlipBps: 10, fundingOn: false };

const t1 = Date.now();
const full = await runBacktest(coins, { costs: DEFAULT_COSTS, onProgress: (i, n, tr) => process.stdout.write(`\r  replaying ${((i / n) * 100).toFixed(0)}%  ${tr} trades`) });
process.stdout.write('\r' + ' '.repeat(50) + '\r');
console.log(`replayed in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
const noCost = await runBacktest(coins, { costs: free });
const slipRun = await runBacktest(coins, { costs: slipOnly });

const T = full.trades, S = full.stats;
const closed = T.filter(t => t.how !== 'marked-to-market');
const rs = T.map(t => t.netR);
const c = ci95(rs);

const first = T.slice(0, Math.floor(T.length / 2)), second = T.slice(Math.floor(T.length / 2));
const window = { from: Math.min(...[...coins.values()].map(d => d.tfs['1D'][0].t)),
                 to: Math.max(...[...coins.values()].map(d => d.tfs['1D'].at(-1).t)) };

say('═'.repeat(78));
say('  CIPHER — FULL-SYSTEM BACKTEST');
say('═'.repeat(78));
say(`  rules under test : cipher-agent-valtown.js  sha256:${S.sourceHash}`);
say(`  data             : ${coins.size} coins, ${mf ? mf.from + ' → ' + mf.to : ''}, 1D/4H/1H + realised funding`);
say(`  decisions        : ${S.evaluations.toLocaleString()} coin-evaluations at ${S.stamps.toLocaleString()} hourly closes`);
say(`  settings         : MIN_SCORE ${S.minScore}, MIN_QUALITY ${S.MIN_QUALITY}, RISK £${S.riskGbp}, exit at T2 (2.25R), immediate entry`);
say(`  costs charged    : taker ${DEFAULT_COSTS.takerBps}bps each way, entry slip ${DEFAULT_COSTS.entrySlipBps}bps, stop slip ${DEFAULT_COSTS.stopSlipBps}bps, realised funding`);
say('');

say('── THE ANSWER ' + '─'.repeat(64));
say('');
say(`  ${T.length} trades in ${((window.to - window.from) / 3.156e10).toFixed(1)} years`);
say('');
say(`  expectancy, frictionless        ${fmtR(mean(noCost.trades.map(t => t.netR)))}  per trade`);
say(`  after slippage                  ${fmtR(mean(slipRun.trades.map(t => t.netR)))}  per trade`);
say(`  AFTER EVERYTHING                ${fmtR(c.m)}  per trade   95% CI [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]`);
say('');
const pPos = bootstrapPositive(rs);
say(`  probability the true edge is positive: ${(pPos * 100).toFixed(1)}%  (20,000 bootstrap resamples)`);
say(`  total: ${fmtR(rs.reduce((a, b) => a + b, 0), 1)}  =  £${(rs.reduce((a, b) => a + b, 0) * S.riskGbp).toFixed(0)} at £${S.riskGbp} a trade`);
say('');

// what a win and a loss actually pay
const wins = T.filter(t => t.netR > 0), losses = T.filter(t => t.netR <= 0);
const avgWin = mean(wins.map(t => t.netR)), avgLoss = mean(losses.map(t => t.netR));
const be = -avgLoss / (avgWin - avgLoss);
say('── WHAT A WIN AND A LOSS ACTUALLY PAY ' + '─'.repeat(41));
say('');
say(`  average winner   ${fmtR(avgWin)}   (the plan says +2.25R)`);
say(`  average loser    ${fmtR(avgLoss)}   (the plan says −1.00R)`);
say(`  hit rate         ${pct(wins.length / T.length)}`);
say(`  break-even hit rate needed: ${pct(be)}  — ${wins.length / T.length >= be ? 'CLEARED' : 'NOT cleared'}`);
say('');
say(`  The target is worth less than 2.25R because the order crosses 1% through the planned`);
say(`  entry, so the real distance from fill to stop is wider than the plan assumed.`);
say(`  Mean realised risk was ${pct(mean(T.map(t => t.riskRatio)))} of the £${S.riskGbp} the sizing intended.`);
say('');

say('── AGAINST DOING NOTHING ' + '─'.repeat(54));
say('');
const bh = buyHold(coins, window.from, window.to);
const totalGbp = rs.reduce((a, b) => a + b, 0) * S.riskGbp;
say(`  the bot, £${S.riskGbp} risk per trade                 £${totalGbp.toFixed(0)}`);
for (const k of ['BTC', 'ETH', 'equal-weight basket']) {
  if (bh[k] === undefined) continue;
  say(`  buy and hold ${k.padEnd(22)} ${(bh[k] * 100).toFixed(0).padStart(6)}%   (£1,000 → £${(1000 * (1 + bh[k])).toFixed(0)})`);
}
say('');

say('── WHERE THE MONEY WENT ' + '─'.repeat(55));
say('');
say(`  gross            ${fmtR(mean(T.map(t => t.grossR)))}`);
say(`  fees             ${fmtR(mean(T.map(t => t.feeR)))}`);
say(`  funding          ${fmtR(mean(T.map(t => t.fundR)))}`);
say(`  net              ${fmtR(c.m)}`);
say('');
const byStop = summarise(T, t => {
  const p = t.stopPct * 100;
  return p < 1 ? 'a. under 1%' : p < 2 ? 'b. 1–2%' : p < 4 ? 'c. 2–4%' : p < 7 ? 'd. 4–7%' : 'e. over 7%';
});
say(table(byStop.sort((a, b) => String(a.k).localeCompare(String(b.k))), 'stop distance'));
say('');
say('  A tight stop pays the same cash costs over a smaller R, so costs in R are');
say('  roughly (2 × fee% + slippage%) ÷ stop%. That is the whole story of this table.');
say('');

say('── BREAKDOWNS ' + '─'.repeat(65));
say('');
for (const [label, key] of [['detector', 'detector'], ['timeframe', 'tf'], ['direction', 'dir'],
                            ['exit', 'how'], ['stop type', 'stopKind'], ['year', 'year']]) {
  say(table(summarise(T, key), label));
  say('');
}
const byCoin = summarise(T, 'coin');
say(table(byCoin.slice(0, 12), 'coin (top 12 by n)'));
say('');

say('── IS IT STABLE? ' + '─'.repeat(62));
say('');
const c1 = ci95(first.map(t => t.netR)), c2 = ci95(second.map(t => t.netR));
say(`  first half   ${fmtR(c1.m)}  [${c1.lo.toFixed(3)}, ${c1.hi.toFixed(3)}]   n=${c1.n}`);
say(`  second half  ${fmtR(c2.m)}  [${c2.lo.toFixed(3)}, ${c2.hi.toFixed(3)}]   n=${c2.n}`);
say('');
const posCoins = byCoin.filter(r => r.exp > 0).length;
say(`  coins with a positive expectancy: ${posCoins} of ${byCoin.length}`);
say('');

say('── WHAT COULD STILL MAKE THIS WRONG ' + '─'.repeat(43));
say('');
const caveats = [
  [`30m and 15m detectors were not tested`, `no data for those timeframes. 15m can never reach MIN_QUALITY 5 (max 4.5), but a 30m divergence scores exactly 5.0 and would have traded.`],
  [`${S.ambiguousBars} bars contained both the stop and the target`, `each scored as a stop. If some were really targets, the result is understated.`],
  [`${S.markedToMarket} positions were still open at the end`, `closed at the last price rather than at a real exit.`],
  [`${S.neverFilled} orders never filled`, `they rest forever because ENTRY_EXPIRY_H is declared and never read in the agent.`],
  [`${S.filledBeyondStop} orders filled through their own stop`, `scored as scratches. In life the exchange triggers immediately, which is what is modelled.`],
  [`${S.fundingFallbacks} holds had no funding records`, `charged nothing for those.`],
  [`${S.clamped} orders hit the venue notional cap`, `at £${S.riskGbp} risk the £${S.relayCap ?? '—'} cap is unreachable — it starts binding above about £20 risk per trade.`],
  [`one evaluation per hourly close`, `the live agent rotates a 20-coin batch every 15 minutes, so it looks ~3× as often — but all confluence timeframes here close hourly or slower, so the extra looks see the same closed-bar state.`],
  [`fills assume you never do better than the bar open`, `and never worse than your limit. A fast market can be worse than both.`],
  [`survivorship`, `these 25 coins are the agent's whitelist as it stands today, chosen with hindsight about which projects survived.`],
];
for (const [a, b] of caveats) say(`  · ${a}\n      ${b}`);
say('');
say('═'.repeat(78));

fs.writeFileSync('report.txt', L.join('\n'));
fs.writeFileSync('trades.json', JSON.stringify(T, null, 0));
fs.writeFileSync('stats.json', JSON.stringify(S, null, 1));
console.log(`\nwrote report.txt (${L.length} lines), trades.json (${T.length}), stats.json`);
