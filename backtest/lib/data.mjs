import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const TF_MS = { '15m': 9e5, '30m': 1.8e6, '1H': 36e5, '4H': 144e5, '1D': 864e5 };

const DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

export function listCoins() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json.gz')).map(f => f.replace('.json.gz', '')).sort();
}

export function manifest() {
  const p = path.join(DIR, 'manifest.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// Bars arrive as [t,o,h,l,c,v]. Everything downstream wants objects, and wants to be sure the
// series is strictly increasing — a duplicated or out-of-order bar silently corrupts every
// indicator built on it.
export function loadCoin(coin) {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, coin + '.json.gz'))));
  const tfs = {};
  for (const [tf, rows] of Object.entries(raw.tfs)) {
    const bars = rows.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    for (let i = 1; i < bars.length; i++) {
      if (!(bars[i].t > bars[i - 1].t)) throw new Error(`${coin} ${tf}: bars not strictly increasing at ${i}`);
    }
    for (const b of bars) {
      if (!(b.h >= b.l && b.h >= b.o && b.h >= b.c && b.l <= b.o && b.l <= b.c && b.o > 0)) {
        throw new Error(`${coin} ${tf}: impossible OHLC at ${new Date(b.t).toISOString()}`);
      }
    }
    tfs[tf] = bars;
  }
  const funding = (raw.funding || []).map(f => ({ t: +f[0], rate: +f[1] })).sort((a, b) => a.t - b.t);
  return { coin, tfs, funding };
}

// "What had closed by time T." A bar that opens at t closes at t + duration, so a bar is only
// visible once T has reached its close — this single rule is what keeps the replay honest.
export function closedBy(bars, tf, T) {
  const ms = TF_MS[tf];
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].t + ms <= T) lo = mid + 1; else hi = mid; }
  return lo;   // count of bars closed by T
}

// Funding paid between two instants, as a signed rate sum (positive = longs pay).
export function fundingBetween(fund, from, to) {
  let sum = 0, n = 0, fallback = 0;
  for (const f of fund) { if (f.t > from && f.t <= to) { sum += f.rate; n++; } }
  // No settlement records in the window at all is not the same as "funding was zero" — count it.
  if (!fund.length) fallback = Math.max(0, Math.floor((to - from) / 288e5));
  return { sum, n, fallback };
}
