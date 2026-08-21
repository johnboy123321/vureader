// Statistics and the written verdict. Every headline number carries a confidence interval,
// because with a few hundred trades the interval is usually the whole story.

export function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
export function sd(a) {
  if (a.length < 2) return NaN;
  const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
// 95% CI on the mean. t≈1.96 is fine past ~60 samples and we say so when it isn't.
export function ci95(a) {
  const m = mean(a), s = sd(a), n = a.length;
  if (!n || !Number.isFinite(s)) return { m, lo: NaN, hi: NaN, se: NaN, n };
  const se = s / Math.sqrt(n);
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, se, n };
}
export function fmtR(x, d = 3) { return (x >= 0 ? '+' : '') + x.toFixed(d) + 'R'; }
export function pct(x, d = 1) { return (x * 100).toFixed(d) + '%'; }

// Bootstrap the probability that true expectancy is above zero — more honest than a t-test on
// a distribution this skewed (a fat right tail of 2.25R winners against a wall of −1R losers).
export function bootstrapPositive(a, iters = 20000) {
  if (a.length < 10) return NaN;
  let above = 0;
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < a.length; j++) s += a[(Math.random() * a.length) | 0];
    if (s / a.length > 0) above++;
  }
  return above / iters;
}

export function summarise(trades, key) {
  const g = new Map();
  for (const t of trades) {
    const k = typeof key === 'function' ? key(t) : t[key];
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  const rows = [];
  for (const [k, ts] of g) {
    const rs = ts.map(t => t.netR);
    const wins = ts.filter(t => t.netR > 0).length;
    rows.push({ k, n: ts.length, win: wins / ts.length, exp: mean(rs), sum: rs.reduce((a, b) => a + b, 0), ci: ci95(rs) });
  }
  return rows.sort((a, b) => b.n - a.n);
}

export function table(rows, label) {
  const out = [`${label.padEnd(22)}${'n'.padStart(6)}${'win%'.padStart(8)}${'exp R'.padStart(9)}${'total R'.padStart(10)}`];
  out.push('-'.repeat(55));
  for (const r of rows) {
    out.push(String(r.k).padEnd(22) + String(r.n).padStart(6) + pct(r.win, 0).padStart(8) +
             r.exp.toFixed(3).padStart(9) + r.sum.toFixed(1).padStart(10));
  }
  return out.join('\n');
}

// Buy and hold, with the same entry/exit fee charged once each way, for the same window.
export function buyHold(coins, from, to, takerBps = 6) {
  const out = {};
  const basket = [];
  for (const [name, d] of coins) {
    const bars = d.tfs['1D'].filter(b => b.t >= from && b.t <= to);
    if (bars.length < 30) continue;
    const raw = bars[bars.length - 1].c / bars[0].c - 1;
    const net = (1 + raw) * (1 - takerBps / 1e4) ** 2 - 1;
    out[name] = net;
    basket.push(net);
  }
  out['equal-weight basket'] = mean(basket);
  return out;
}
