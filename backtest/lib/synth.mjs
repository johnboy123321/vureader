// Synthetic series for the fairness tests. 1H bars are generated first and 4H/1D are AGGREGATED
// from them, so the timeframes cannot disagree — a synthetic dataset whose daily bar contradicts
// its hourly bars would make any conclusion drawn from it meaningless.

export function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Driftless geometric random walk: no entry rule can have an edge on this by construction.
export function randomWalk1H({ n = 26304, start = Date.UTC(2023, 7, 1), px0 = 100, vol = 0.006, seed = 1, drift = 0 }) {
  const r = mulberry(seed);
  const bars = [];
  let px = px0;
  for (let i = 0; i < n; i++) {
    const o = px;
    // four sub-steps give the bar a believable high/low rather than a straight line
    let hi = o, lo = o, c = o;
    for (let k = 0; k < 4; k++) { c *= Math.exp(drift / 4 + (vol / 2) * gauss(r)); hi = Math.max(hi, c); lo = Math.min(lo, c); }
    bars.push({ t: start + i * 36e5, o, h: hi, l: lo, c, v: 1000 + 500 * r() });
    px = c;
  }
  return bars;
}

export function aggregate(bars1h, factor, ms) {
  const out = [];
  for (let i = 0; i + factor <= bars1h.length; i += factor) {
    const g = bars1h.slice(i, i + factor);
    // align to the timeframe boundary so t + ms is a real close time
    if (g[0].t % ms !== 0) continue;
    out.push({
      t: g[0].t, o: g[0].o,
      h: Math.max(...g.map(b => b.h)), l: Math.min(...g.map(b => b.l)),
      c: g[g.length - 1].c, v: g.reduce((s, b) => s + b.v, 0),
    });
  }
  return out;
}

export function synthCoin(name, opts = {}) {
  const h1 = randomWalk1H(opts);
  const start = h1[0].t;
  const aligned = h1.filter(b => b.t >= Math.ceil(start / 864e5) * 864e5);
  return {
    coin: name,
    tfs: { '1H': aligned, '4H': aggregate(aligned, 4, 144e5), '1D': aggregate(aligned, 24, 864e5) },
    funding: [],
  };
}
