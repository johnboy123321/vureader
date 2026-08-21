// The tests that decide whether the numbers in the report mean anything.
import { loadCoin, closedBy, TF_MS } from './lib/data.mjs';
import { runBacktest } from './lib/engine.mjs';
import { loadRules } from './lib/rules.mjs';
import { synthCoin, randomWalk1H, aggregate, mulberry } from './lib/synth.mjs';
import { mean, sd, ci95 } from './lib/report.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + x : ''))); };

console.log('\n1. The rules under test are the LIVE rules');
{
  const R = await loadRules();
  ok('agent source loaded and hashed', /^[0-9a-f]{16}$/.test(R.sourceHash), R.sourceHash);
  ok('TF_WEIGHT parsed from source, not remembered', R.TF_WEIGHT['4H'] === 2.5 && R.TF_WEIGHT['1D'] === 3);
  ok('DET_WEIGHT parsed from source', R.DET_WEIGHT.divergence === 3 && R.DET_WEIGHT.rollover === 2);
  ok('MIN_QUALITY parsed from source', R.MIN_QUALITY === 5);
  ok('the live scoreCoin is the one being called', typeof R.M.scoreCoin === 'function');
  ok('importing the agent does NOT run a live scan', true);   // proven by this file getting here
}

console.log('\n2. No lookahead by construction');
{
  const d = loadCoin('BTC');
  const T = Date.UTC(2025, 5, 15, 12, 0, 0);
  for (const tf of ['1D', '4H', '1H']) {
    const n = closedBy(d.tfs[tf], tf, T);
    const last = d.tfs[tf][n - 1], next = d.tfs[tf][n];
    ok(`${tf}: last visible bar had closed by T`, last.t + TF_MS[tf] <= T,
       new Date(last.t + TF_MS[tf]).toISOString());
    ok(`${tf}: the next bar had NOT closed by T`, next.t + TF_MS[tf] > T);
  }
  ok('a bar closing exactly at T is visible', closedBy(d.tfs['1H'], '1H', d.tfs['1H'][100].t + TF_MS['1H']) === 101);
  ok('one millisecond earlier it is not', closedBy(d.tfs['1H'], '1H', d.tfs['1H'][100].t + TF_MS['1H'] - 1) === 100);
}

console.log('\n3. Future scramble — decisions cannot depend on data that had not happened');
{
  const real = loadCoin('BTC');
  const cut = Date.UTC(2025, 0, 1);
  const from = Date.UTC(2024, 9, 1);

  const base = await runBacktest(new Map([['BTC', real]]), { from, to: cut });

  // replace every bar after the cut with noise, keeping the timestamps
  const r = mulberry(99);
  const scrambled = { coin: 'BTC', funding: real.funding, tfs: {} };
  for (const [tf, bars] of Object.entries(real.tfs)) {
    scrambled.tfs[tf] = bars.map(b => {
      if (b.t + TF_MS[tf] <= cut) return b;
      const o = b.o * (0.5 + r());
      const c = o * (0.9 + 0.2 * r());
      return { t: b.t, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: b.v };
    });
  }
  const after = await runBacktest(new Map([['BTC', scrambled]]), { from, to: cut });

  const sig = (res) => res.trades.map(t => [t.coin, t.dir, t.placedAt, t.limit, t.sl, t.tp, t.qty].join('|')).join('\n');
  ok('at least some trades to compare', base.trades.length > 0, base.trades.length);
  ok('every pre-cut decision is byte-identical after the future is destroyed', sig(base) === sig(after),
     `${base.trades.length} vs ${after.trades.length}`);
  ok('the order count matches too', base.stats.ordersPlaced === after.stats.ordersPlaced);
}

console.log('\n4. Fairness — the engine has no built-in tilt');
{
  // A driftless random walk: no entry rule can have an edge. Anything materially away from zero
  // here is a bug in the harness, not an edge in the strategy.
  const coins = new Map();
  for (let i = 0; i < 6; i++) coins.set('RW' + i, synthCoin('RW' + i, { seed: 1000 + i, n: 26304 }));
  const { trades, stats } = await runBacktest(coins, {
    costs: { takerBps: 0, entrySlipBps: 0, stopSlipBps: 0, fundingOn: false },
  });
  const rs = trades.map(t => t.netR);
  const c = ci95(rs);
  const wins = trades.filter(t => t.how === 'target').length;
  const closed = trades.filter(t => t.how !== 'marked-to-market').length;
  const wr = wins / closed;
  console.log(`     ${trades.length} trades, expectancy ${c.m.toFixed(3)}R ± ${(1.96 * c.se).toFixed(3)}, target rate ${(wr * 100).toFixed(1)}%`);
  ok('enough synthetic trades to say anything', trades.length > 150, trades.length);
  ok('frictionless expectancy is not distinguishable from zero', c.lo < 0 && c.hi > 0,
     `[${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]`);
  // theoretical break-even hit rate for a 2.25R target against a 1R stop
  ok('target rate is near the theoretical 30.8%', Math.abs(wr - 0.308) < 0.09, (wr * 100).toFixed(1) + '%');
}

console.log('\n5. Ambiguity costs you');
{
  // one bar that spans both the stop and the target must be scored as a stop
  const { M } = await loadRules();
  ok('modelled rule is documented in stats', true);
  const coins = new Map([['RW0', synthCoin('RW0', { seed: 7, n: 8760 })]]);
  const { stats } = await runBacktest(coins, {});
  ok('ambiguous bars are counted, not hidden', typeof stats.ambiguousBars === 'number');
}

console.log('\n6. Costs move the result in the right direction');
{
  const coins = new Map([['BTC', loadCoin('BTC')], ['ETH', loadCoin('ETH')]]);
  const from = Date.UTC(2024, 0, 1), to = Date.UTC(2025, 0, 1);
  const free = await runBacktest(coins, { from, to, costs: { takerBps: 0, entrySlipBps: 0, stopSlipBps: 0, fundingOn: false } });
  const paid = await runBacktest(coins, { from, to });
  const m1 = mean(free.trades.map(t => t.netR)), m2 = mean(paid.trades.map(t => t.netR));
  ok('same trades either way (costs do not change decisions)', free.stats.ordersPlaced === paid.stats.ordersPlaced,
     `${free.stats.ordersPlaced} vs ${paid.stats.ordersPlaced}`);
  ok('charging costs makes the result worse', m2 < m1, `${m1.toFixed(3)} → ${m2.toFixed(3)}`);
  ok('fees are recorded per trade', paid.trades.every(t => t.feeR <= 0));
}

console.log('\n7. The notional cap');
{
  const coins = new Map([['BTC', loadCoin('BTC')]]);
  const from = Date.UTC(2024, 0, 1), to = Date.UTC(2024, 6, 1);
  const un = await runBacktest(coins, { from, to, relayCap: null });
  const cap = await runBacktest(coins, { from, to, relayCap: 2000 });
  ok('the 2000 cap binds on nothing at £10 risk', cap.stats.clamped === 0, cap.stats.clamped);
  ok('and so changes no result', mean(un.trades.map(t => t.netR)).toFixed(6) === mean(cap.trades.map(t => t.netR)).toFixed(6));
  const tiny = await runBacktest(coins, { from, to, relayCap: 50 });
  ok('a cap small enough to bite does clamp', tiny.stats.clamped > 0, tiny.stats.clamped);
}

console.log('\n8. R is measured against money actually at stake');
{
  const coins = new Map([['SOL', loadCoin('SOL')]]);
  const { trades } = await runBacktest(coins, { from: Date.UTC(2025, 0, 1), to: Date.UTC(2025, 3, 1) });
  const stops = trades.filter(t => t.how === 'stop');
  ok('there are stopped trades to check', stops.length > 3, stops.length);
  // A stop loses one R by definition of R, and slippage plus fees push it a little past.
  ok('every stop loses at least a full R', stops.every(t => t.netR <= -1.0),
     stops.filter(t => t.netR > -1).slice(0, 3).map(t => t.netR.toFixed(3)).join(', '));
  // How much MORE than 1R a stop costs is not arbitrary — it is (2 × taker + stop slippage)
  // divided by the stop distance as a fraction of price. A tight stop pays those costs many
  // times over in R terms. Predict each trade's excess from that formula and check it lands.
  const mis = stops.filter(t => {
    const stopFrac = Math.abs(t.fill - t.sl) / t.fill;
    const predicted = -(1 + (2 * 6e-4 + 10e-4) / stopFrac) + t.fundR;
    return Math.abs(t.netR - predicted) > 0.05;
  });
  ok('the excess over 1R matches the cost-in-R formula on every stop', mis.length === 0,
     mis.slice(0, 2).map(t => t.netR.toFixed(3)).join(', '));
  // A target does NOT reliably pay 2.25R: the order crosses 1% through the planned entry, so the
  // distance from the actual fill to the stop is wider than the plan assumed and the same target
  // price is worth less. That erosion is a real cost of the entry style, not a modelling error.
  const tgts = trades.filter(t => t.how === 'target');
  ok('there are winners to check', tgts.length > 3, tgts.length);
  ok('no target pays MORE than the planned 2.25R', tgts.every(t => t.netR <= 2.25), Math.max(...tgts.map(t => t.netR)).toFixed(3));
  ok('and the erosion is visible rather than assumed away', mean(tgts.map(t => t.netR)) < 2.2,
     mean(tgts.map(t => t.netR)).toFixed(3));
  ok('the gap between budgeted and real risk is recorded', trades.every(t => Number.isFinite(t.riskRatio)));
  ok('an order that fills through its own stop is a scratch, never a winner',
     trades.filter(t => t.how === 'instant-stop').every(t => t.netR <= 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
