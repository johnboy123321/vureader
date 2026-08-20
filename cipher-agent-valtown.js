// ═══════════════════════════════════════════════════════════════════════════════
//  CIPHER AGENT — the 24/7 half of MarketCipherAI
//
//  Runs on Val Town as a CRON val (every 15 min on the free plan). Scans a rotating
//  batch of coins, computes VuManChu Cipher B + structure signals exactly as the
//  browser app does, builds an ATR trade plan, applies every guard, and places the
//  order through the EXISTING Phemex relay val. No browser, no open tab, no laptop.
//
//  Deliberately does NOT duplicate: order signing (the relay owns that), the
//  discovery lab, or the learning layer. Those stay in the app. This is the core
//  loop only — the thing that must never sleep.
//
//  ── SETUP ──────────────────────────────────────────────────────────────────────
//  1. New val → type: Cron. Interval: every 15 minutes.
//  2. Paste this file (or import it from the GitHub repo like the relay does).
//  3. Environment variables (val settings → Environment variables):
//       RELAY_URL    = https://jboy--cc5bad508df411f1b9601607ee4eb77e.web.val.run
//       RELAY_TOKEN  = (the same token the app uses — Settings → exec token)
//       MODE         = dry        ← start here. 'armed' places real testnet orders.
//       RISK_GBP     = 10
//       MIN_SCORE    = 6
//       DAY_CAP      = 25
//       CORR_MAX     = 6
//       BATCH        = 20         ← coins scanned per run; keeps runs under 60s
//       AGENT_TOKEN  = (any long random string — protects the /decisions endpoint)
//  4. Watch the val's logs for the first run, then flip MODE to armed.
//
//  Safety that is NOT optional and cannot be configured away:
//    · never places an order without a stop loss
//    · stop must be the correct side of entry, 0.3%–35% away
//    · the relay is testnet-locked and enforces its own notional cap
//    · MODE=off kills all placing instantly
// ═══════════════════════════════════════════════════════════════════════════════

// ── Runtime-agnostic: the SAME file runs on Val Town (Deno) and GitHub Actions (Node). ──
// Keeping one file rather than two copies is deliberate: duplicated trading logic drifts, and
// a divergence between "what I tested" and "what runs" is the worst class of bug here.
const IS_DENO = typeof Deno !== "undefined" && Deno.env && typeof Deno.env.get === "function";
const env = (k, d) => {
  const v = IS_DENO ? Deno.env.get(k) : (typeof process !== "undefined" ? process.env[k] : undefined);
  return (v === undefined || v === null || v === "") ? d : v;
};
const num = (k, d) => { const v = parseFloat(env(k, "")); return Number.isFinite(v) ? v : d; };

const CFG = {
  relayUrl: () => String(env("RELAY_URL", "")).replace(/\/+$/, ""),
  relayToken: () => env("RELAY_TOKEN", ""),
  mode: () => String(env("MODE", "dry")).toLowerCase(),   // off | dry | armed
  risk: () => num("RISK_GBP", 10),
  minScore: () => num("MIN_SCORE", 6),
  dayCap: () => num("DAY_CAP", 25),
  corrMax: () => num("CORR_MAX", 6),
  batch: () => num("BATCH", 20),
  universe: () => num("UNIVERSE", 100),
  // ── Direct execution (2026-08-15). See the EXEC section below for why. ──
  direct: () => String(env("EXEC_DIRECT", "0")) === "1" && !!env("PHEMEX_KEY", "") && !!env("PHEMEX_SECRET", ""),
  phemexKey: () => env("PHEMEX_KEY", ""),
  phemexSecret: () => env("PHEMEX_SECRET", ""),
  maxNotional: () => num("MAX_NOTIONAL_USDT", 2000),
  whitelist: () => String(env("WHITELIST", DEFAULT_WHITELIST)),
  kill: () => String(env("KILL", "0")) === "1",
  maxAttempts: () => num("MAX_ATTEMPTS", 3),
  // immediate = enter where price is when the signal fires (how it has always worked)
  // structure = rest a limit at the zone the move came from and let price come back
  entryMode: () => String(env("ENTRY_MODE", "immediate")).toLowerCase(),
  entryExpiryH: () => num("ENTRY_EXPIRY_H", 8),
  // ── WHICH TIMEFRAME THE REAL COINS FOLLOW (2026-08-19) ────────────────────────────────────
  // "off" = the pump ladder keeps the stack, which is how this has always worked and stays the
  // default. Any of the eight timeframes = the dot flip on that timeframe trades the real spot
  // balance instead, and the ladder stands down. Set from the app panel via the relay; the env
  // var is the fallback for when the relay cannot be reached.
  accumFlipTf: () => String(env("ACCUM_FLIP_TF", "off")),
};
// The relay's own default list, duplicated here so direct mode enforces the SAME gate. If these
// two ever need to differ, that must be a deliberate decision, not drift.
const DEFAULT_WHITELIST = "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT,LTCUSDT,BCHUSDT,UNIUSDT,ATOMUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,SUIUSDT,TONUSDT,TRXUSDT,POLUSDT,FILUSDT,INJUSDT,AAVEUSDT";

// ── State: must survive between runs (the rotation cursor and the fired-set ARE the memory).
// Val Town → its blob store. GitHub Actions → a JSON file the workflow commits back to the repo.
// Imports are dynamic so neither runtime chokes on the other's module.
const KEY = { cursor: "cipher_cursor", fired: "cipher_fired", log: "cipher_log" };
const STATE_FILE = env("STATE_FILE", "agent-state.json");
let _blob = null, _fs = null, _fileState = null;

async function loadFileState() {
  if (_fileState) return _fileState;
  if (!_fs) _fs = await import("node:fs/promises");
  try { _fileState = JSON.parse(await _fs.readFile(STATE_FILE, "utf8")); }
  catch { _fileState = {}; }                       // first run, or the file isn't there yet
  return _fileState;
}
async function getJSON(k, d) {
  try {
    if (IS_DENO) {
      if (!_blob) ({ blob: _blob } = await import("https://esm.town/v/std/blob"));
      const v = await _blob.getJSON(k); return v ?? d;
    }
    const s = await loadFileState();
    return (k in s) ? s[k] : d;
  } catch { return d; }
}
async function setJSON(k, v) {
  try {
    if (IS_DENO) {
      if (!_blob) ({ blob: _blob } = await import("https://esm.town/v/std/blob"));
      return await _blob.setJSON(k, v);
    }
    const s = await loadFileState();
    s[k] = v;
    if (!_fs) _fs = await import("node:fs/promises");
    await _fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error("state write failed:", k, e && e.message); }
}

// ═══════════════════════ INDICATORS (identical maths to the app) ═══════════════════════
// Exact VuManChu inputs from John's TradingView header. Divergence levels are ASYMMETRIC.
const VMC = { chlen: 9, avg: 12, malen: 3,
  osLevel: -53, obLevel: 53, osLevel2: -60, obLevel2: 60, osLevel3: -75, obLevel3: 100,
  divOB: 45, divOS: -65,
  mfiPeriod: 60, mfiMult: 150, mfiPosY: 2.5 };

function emaArr(arr, p) {
  const k = 2 / (p + 1); const out = []; let e = arr[0];
  for (let i = 0; i < arr.length; i++) { e = i === 0 ? arr[0] : arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function smaArr(arr, p) {
  const out = [];
  for (let i = 0; i < arr.length; i++) { if (i < p - 1) { out.push(NaN); continue; } let s = 0; for (let j = i - p + 1; j <= i; j++) s += arr[j]; out.push(s / p); }
  return out;
}
function waveTrend(c) {
  const src = c.map(x => (x.h + x.l + x.c) / 3);
  const esa = emaArr(src, VMC.chlen);
  const de = emaArr(src.map((v, i) => Math.abs(v - esa[i])), VMC.chlen);
  const ci = src.map((v, i) => de[i] === 0 ? 0 : (v - esa[i]) / (0.015 * de[i]));
  const wt1 = emaArr(ci, VMC.avg);
  const wt2 = smaArr(wt1, VMC.malen);
  return { wt1, wt2 };
}
function vmcMoneyFlow(c) {
  const raw = c.map(x => { const rng = x.h - x.l; return rng === 0 ? 0 : ((x.c - x.o) / rng) * VMC.mfiMult; });
  return smaArr(raw, VMC.mfiPeriod).map(v => v - VMC.mfiPosY);
}
function rsiArr(c, p = 14) {
  const cl = c.map(x => x.c); const out = new Array(cl.length).fill(NaN);
  let rg = 0, rl = 0;
  for (let i = 1; i < cl.length; i++) {
    const ch = cl[i] - cl[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= p) { rg += g; rl += l; if (i === p) { rg /= p; rl /= p; out[i] = 100 - 100 / (1 + rg / (rl || 1e-9)); } }
    else { rg = (rg * (p - 1) + g) / p; rl = (rl * (p - 1) + l) / p; out[i] = 100 - 100 / (1 + rg / (rl || 1e-9)); }
  }
  return out;
}
function atrArr(c, p = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  const out = new Array(c.length).fill(NaN);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    if (i <= p) { a += tr[i]; if (i === p) out[i] = a / p; }
    else { a = (out[i - 1] * (p - 1) + tr[i]) / p; out[i] = a; }
  }
  return out;
}

// ═══════════════════════ MARKET DATA (Binance, OKX fallback) ═══════════════════════
const TF_MS = { "15m": 9e5, "30m": 1.8e6, "1H": 36e5, "4H": 144e5, "1D": 864e5, "1W": 6048e5 };
function dropUnclosed(arr, tf) {
  if (!arr || !arr.length) return arr;
  const ms = TF_MS[tf]; if (!ms) return arr;
  const t = +arr[arr.length - 1].t;
  return (Number.isFinite(t) && (t + ms) > Date.now()) ? arr.slice(0, -1) : arr;
}
let _binanceUp = true;   // Binance geo-blocks GitHub's US runners; after the first failure we
                         // skip straight to OKX rather than paying the timeout on every call.
async function fetchCandles(sym, tf, bars = 260) {
  const s = String(sym).toUpperCase().replace(/USDT$/, "");
  // 5m and 2H added 2026-08-19 for the dot-flip timeframe switch. 3H is NOT a standard exchange
  // interval anywhere, so it is built locally from 1H bars further down rather than requested.
  const binInt = { "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "2H": "2h", "4H": "4h", "1D": "1d", "1W": "1w" }[tf];
  const okxBar = { "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1H", "2H": "2H", "4H": "4H", "1D": "1Dutc", "1W": "1Wutc" }[tf];
  if (!binInt && !okxBar) return null;
  if (_binanceUp) try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${s}USDT&interval=${binInt}&limit=${Math.min(bars, 1000)}`);
    if (!r.ok) _binanceUp = false;
    if (r.ok) { const d = await r.json(); if (Array.isArray(d) && d.length) return dropUnclosed(d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })), tf); }
  } catch { _binanceUp = false; }
  try {
    const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${s}-USDT&bar=${okxBar}&limit=${Math.min(bars, 300)}`);
    if (r.ok) { const j = await r.json(); if (j.data && j.data.length) return dropUnclosed(j.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse(), tf); }
  } catch { /* no data */ }
  return null;
}
async function topUniverse(n) {
  const EXCL = /(UP|DOWN|BULL|BEAR)$/;
  const STABLE = new Set(["USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP", "USTC", "EUR", "GBP", "AEUR", "PAXG", "USDT", "EURI"]);
  const keep = (sym) => sym && !EXCL.test(sym) && !STABLE.has(sym);
  // Binance blocks US IPs, and GitHub's runners are US-hosted — on Actions this call fails and we
  // fall through to OKX. Without the OKX step the agent silently dropped to a 10-coin hardcoded
  // list and scanned the same coins twice per run (found on the first live run, 2026-08-11).
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (r.ok) {
      const d = await r.json();
      const list = d.filter((x) => x.symbol.endsWith("USDT"))
        .map((x) => ({ sym: x.symbol.slice(0, -4), vol: parseFloat(x.quoteVolume) }))
        .filter((x) => keep(x.sym) && Number.isFinite(x.vol))
        .sort((a, b) => b.vol - a.vol).map((x) => x.sym).slice(0, n);
      if (list.length >= 20) return list;
    }
  } catch { /* fall through to OKX */ }
  try {
    const r = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
    if (r.ok) {
      const j = await r.json();
      const list = (j.data || []).filter((x) => x.instId.endsWith("-USDT"))
        .map((x) => ({ sym: x.instId.split("-")[0], vol: parseFloat(x.volCcy24h) }))
        .filter((x) => keep(x.sym) && Number.isFinite(x.vol))
        .sort((a, b) => b.vol - a.vol).map((x) => x.sym).slice(0, n);
      if (list.length >= 20) { console.log("universe: OKX (" + list.length + " coins) — Binance unreachable"); return list; }
    }
  } catch { /* fall through to the fixed list */ }
  console.warn("universe: BOTH exchanges unreachable — using the 10-coin fallback list");
  return ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "LINK", "AVAX", "DOT"];
}


// ═══════════════════════ DETECTORS ═══════════════════════
// EXTRACTED VERBATIM from index.html so the server and the app cannot drift. Do not hand-edit:
// re-extract if the app's versions change. Ported 2026-08-11 to bring the agent to parity —
// before this it only had confluence scoring and missed everything these catch.
function formatPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return String(p);
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(6);
}

function ema200At(c, i) {
  if (!c || c.length < 200) return null;
  const k = 2 / 201; let e = c[0].c;
  for (let j = 1; j <= i; j++) e = c[j].c * k + e * (1 - k);
  return e;
}

function volRatio(c, i) {
  if (i == null || i < 20) return null;
  let s = 0; for (let k = i - 20; k < i; k++) s += (c[k].v || 0);
  const avg = s / 20;
  return avg > 0 ? (c[i].v || 0) / avg : null;
}

function wtPivots(wt, kind, left = 2, right = 2) {
  const out = [];
  for (let i = left; i < wt.length - right; i++) {
    const v = wt[i]; if (!Number.isFinite(v)) continue;
    let ok = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i || !Number.isFinite(wt[k])) continue;
      if (kind === 'high' ? wt[k] > v : wt[k] < v) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// ═══════════════════ MARKET STRUCTURE — where, not whether (2026-08-15) ═══════════════════
// John's diagnosis, and it is the right one: "VuManChu is great at direction, not entries."
// Every detector here is momentum — WaveTrend crosses, MFI flips, divergences. They answer
// "is something turning?" and say nothing about WHERE. So entry has been "wherever price is when
// the oscillator fires", which on a cross is often well after the move started, and the stop has
// been ten bars back plus a quarter ATR — defensible, but arbitrary.
//
// These functions answer the other half. They are NOT new firing triggers; adding a twelfth
// trigger to a system with eleven would mostly add noise. They are LOCATIONS: the level a move
// came from, and the level that invalidates the idea if price trades back through it.
//
// Definitions are deliberately explicit, because "order block" means slightly different things to
// different people and any published claim about them is therefore unfalsifiable. These are ours,
// they are testable, and the lab can search their parameters like anything else.

// Swing pivots on PRICE (wtPivots above does the same job on the oscillator).
function pricePivots(c, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < c.length - right; i++) {
    let isH = true, isL = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (c[k].h >= c[i].h) isH = false;
      if (c[k].l <= c[i].l) isL = false;
    }
    if (isH) highs.push(i);
    if (isL) lows.push(i);
  }
  return { highs, lows };
}

// Break of structure / change of character.
//   BOS   = price takes out the last swing high while already trending up (continuation)
//   CHoCH = price takes out the last swing LOW while trending up (the trend's character changed)
// Trend is defined by the swings themselves — higher highs AND higher lows — not by an average,
// so it agrees with what you would call it looking at the chart.
function marketStructure(c) {
  const { highs, lows } = pricePivots(c);
  if (highs.length < 2 || lows.length < 2) return { trend: "none", lastBOS: null, lastCHoCH: null, swingHigh: null, swingLow: null };
  const hv = highs.slice(-3).map(i => c[i].h), lv = lows.slice(-3).map(i => c[i].l);
  const up = hv.length >= 2 && hv.at(-1) > hv.at(-2) && lv.at(-1) > lv.at(-2);
  const dn = hv.length >= 2 && hv.at(-1) < hv.at(-2) && lv.at(-1) < lv.at(-2);
  const trend = up ? "up" : dn ? "down" : "none";
  const lastHigh = c[highs.at(-1)].h, lastLow = c[lows.at(-1)].l;
  const px = c.at(-1).c;
  let lastBOS = null, lastCHoCH = null;
  if (px > lastHigh) (trend === "down" ? (lastCHoCH = "bullish") : (lastBOS = "bullish"));
  if (px < lastLow)  (trend === "up"   ? (lastCHoCH = "bearish") : (lastBOS = "bearish"));
  return { trend, lastBOS, lastCHoCH, swingHigh: lastHigh, swingLow: lastLow, highIdx: highs.at(-1), lowIdx: lows.at(-1) };
}

// FAIR VALUE GAP: three candles where price moved so fast it left a hole in the traded range.
// Bullish gap = candle i's LOW is above candle i-2's HIGH — nothing traded in between.
// A gap only counts while it is UNFILLED: once price trades back through it the imbalance is gone,
// which is the whole idea. Returns newest first.
function findFVGs(c, lookback = 60) {
  const out = [];
  const start = Math.max(2, c.length - lookback);
  for (let i = start; i < c.length; i++) {
    const a = c[i - 2], z = c[i];
    if (z.l > a.h) out.push({ kind: "bullish", top: z.l, bottom: a.h, at: i });
    if (z.h < a.l) out.push({ kind: "bearish", top: a.l, bottom: z.h, at: i });
  }
  // Drop any the market has since traded back through.
  return out.filter(g => {
    for (let j = g.at + 1; j < c.length; j++) {
      if (g.kind === "bullish" && c[j].l <= g.bottom) return false;
      if (g.kind === "bearish" && c[j].h >= g.top) return false;
    }
    return true;
  }).reverse();
}

// ORDER BLOCK: the last opposing candle before an impulsive move that broke structure.
// The reasoning is not mystical — it is the last price at which the other side was in control
// before they lost it, so it is a level with unfinished business. Ours requires the move to be
// genuinely impulsive (>= 1.2 ATR over 3 candles) so that any old red candle does not qualify.
function findOrderBlocks(c, lookback = 60) {
  const atr = atrArr(c, 14);
  const out = [];
  const start = Math.max(4, c.length - lookback);
  for (let i = start; i < c.length - 3; i++) {
    const a = atr[i]; if (!Number.isFinite(a) || a <= 0) continue;
    const move3 = c[i + 3].c - c[i].c;
    if (Math.abs(move3) < 1.2 * a) continue;                 // not impulsive enough to count
    if (move3 > 0 && c[i].c < c[i].o) out.push({ kind: "bullish", top: Math.max(c[i].o, c[i].c), bottom: c[i].l, at: i, impulse: +(move3 / a).toFixed(2) });
    if (move3 < 0 && c[i].c > c[i].o) out.push({ kind: "bearish", top: c[i].h, bottom: Math.min(c[i].o, c[i].c), at: i, impulse: +(Math.abs(move3) / a).toFixed(2) });
  }
  return out.filter(b => {                                    // still untouched?
    for (let j = b.at + 4; j < c.length; j++) {
      if (b.kind === "bullish" && c[j].l <= b.bottom) return false;
      if (b.kind === "bearish" && c[j].h >= b.top) return false;
    }
    return true;
  }).reverse();
}

// The nearest unfilled zone that price would have to come BACK to — the pullback entry.
// For a long: a bullish zone below current price. Rejects zones so far away the trade would be a
// different idea by the time it filled (>8% is not a pullback, it is a crash).
function nearestZone(c, dir, maxAwayPct = 8) {
  const px = c.at(-1).c;
  const want = dir === "short" ? "bearish" : "bullish";
  const zones = [...findOrderBlocks(c).map(z => ({ ...z, src: "OB" })), ...findFVGs(c).map(z => ({ ...z, src: "FVG" }))]
    .filter(z => z.kind === want)
    .filter(z => (dir === "short" ? z.bottom > px : z.top < px))        // must be a RETURN, not chasing
    .map(z => ({ ...z, away: Math.abs((dir === "short" ? z.bottom : z.top) - px) / px * 100 }))
    .filter(z => z.away <= maxAwayPct)
    .sort((a, b) => a.away - b.away);
  return zones[0] || null;
}

function vmcVwapWave(c) {
  const { wt1, wt2 } = waveTrend(c);
  return wt1.map((v, i) => v - wt2[i]);
}

function detectWTDivergence(c) {
  if (!c || c.length < 80) return null;
  const { wt1, wt2 } = waveTrend(c), n = c.length, i = n - 1;
  const mf = vmcMoneyFlow(c);
  const FRESH = 4; // the confirming cross must be on one of the last few closed bars

  for (const dir of ['short', 'long']) {
    const bear = dir === 'short';
    const piv = wtPivots(wt2, bear ? 'high' : 'low');
    if (piv.length < 2) continue;
    const b = piv[piv.length - 1], a = piv[piv.length - 2];
    if (n - 1 - b > 30 || b - a < 3) continue;          // stale, or the two pivots are the same swing

    // price extreme at each pivot (small window around it, since price and WT rarely peak on the same bar)
    const pxAt = (idx) => { const s = Math.max(0, idx - 2), e = Math.min(n, idx + 3); const seg = c.slice(s, e);
      return bear ? Math.max(...seg.map(x => x.h)) : Math.min(...seg.map(x => x.l)); };
    const pA = pxAt(a), pB = pxAt(b), wA = wt2[a], wB = wt2[b];

    const priceExtends = bear ? pB > pA * 1.001 : pB < pA * 0.999;   // genuinely higher high / lower low
    const wtFails = bear ? wB < wA - 1 : wB > wA + 1;                 // momentum did not follow
    if (!priceExtends || !wtFails) continue;
    const extreme = bear ? wB >= VMC.divOB : wB <= VMC.divOS;         // VuManChu divergence zones (+45 / −65)
    if (!extreme) continue;

    // ── COMPARABILITY CHECK (2026-08-10, found in testing — do not remove) ──
    // WaveTrend divides by recent volatility. If volatility EXPANDED between the two pivots, the
    // second WT reading is scaled down by a bigger divisor, so it prints a "lower high" even when
    // real momentum grew — a permanent fake divergence that would short every strong rally.
    // Measured on test cases: genuine divergences ran at 0.87–0.93× ATR (a grind, volatility flat
    // or contracting); false ones at 2.8–3.4× (blow-off expansion). 1.5× sits clear of both.
    const atr = atrArr(c, 14);
    const atrA = atr[a], atrB = atr[b];
    if (Number.isFinite(atrA) && Number.isFinite(atrB) && atrA > 0 && atrB / atrA > 1.5) continue;

    // Confirmation: a WT cross in our direction that happened AT OR AFTER the second pivot.
    // Anchoring to the pivot (not to "the last N bars") is what makes this robust — the pivot
    // itself is only confirmed 2 bars late, so a fixed window near `now` misses real signals.
    // wt1 leads wt2, so the cross lands ON the wt2 pivot bar or 1–2 bars before it — searching
    // strictly after the pivot finds nothing at all (caught in testing, 2026-08-10).
    // Take the FIRST cross following the pivot, not the most recent one: searching backwards
    // picks up an unrelated cross made 30 bars into the move and reports it as fresh.
    let crossIdx = -1;
    for (let k = Math.max(1, b - 2); k < n; k++) {
      const d0 = wt1[k] - wt2[k], d1 = wt1[k - 1] - wt2[k - 1];
      if (bear ? (d1 >= 0 && d0 < 0) : (d1 <= 0 && d0 > 0)) { crossIdx = k; break; }
    }
    if (crossIdx < 0) continue;
    const barsSince = n - 1 - crossIdx;
    if (barsSince > 10) continue;                      // the move is long gone — not a signal any more

    const ev = [
      `${bear ? 'Bearish' : 'Bullish'} divergence: price ${bear ? 'higher high' : 'lower low'} (${formatPrice(pA)} → ${formatPrice(pB)}), WaveTrend ${bear ? 'lower high' : 'higher low'} (${wA.toFixed(0)} → ${wB.toFixed(0)})`,
      `Pivot in the ${bear ? 'overbought' : 'oversold'} zone (WT ${wB.toFixed(0)})`,
      `${bear ? 'Red' : 'Green'} dot confirmed ${barsSince === 0 ? 'on the last closed bar' : barsSince + ' bars ago'}`
    ];
    const mfAgrees = bear ? mf[i] < mf[Math.max(0, i - 3)] : mf[i] > mf[Math.max(0, i - 3)];
    if (mfAgrees) ev.push(`Money flow ${bear ? 'rolling over' : 'turning up'}`);
    if (barsSince > FRESH) ev.push(`Note: already ${barsSince} bars into the move — chasing risk`);
    return { match: true, dir, label: `Class A ${bear ? 'Bearish' : 'Bullish'} Divergence`,
      stage: barsSince <= FRESH ? 'fresh' : 'late', ev };
  }
  return null;
}

function detectMomentumRollover(c) {
  if (!c || c.length < 80) return null;
  const { wt1, wt2 } = waveTrend(c), mf = vmcMoneyFlow(c), vw = vmcVwapWave(c);
  // 6-bar window, not 3: on a daily chart the cross prints, then price takes a few bars to
  // confirm the roll — a 3-bar window missed a cross that was only 4 bars old (caught in testing).
  const n = c.length, i = n - 1, FRESH = 6;
  for (const dir of ['short', 'long']) {
    const bear = dir === 'short';
    // a cross in our direction on one of the last few closed bars
    let xi = -1;
    for (let k = i; k >= n - FRESH && k >= 1; k--) {
      const d0 = wt1[k] - wt2[k], d1 = wt1[k - 1] - wt2[k - 1];
      if (bear ? (d1 >= 0 && d0 < 0) : (d1 <= 0 && d0 > 0)) { xi = k; break; }
    }
    if (xi < 0) continue;
    // Tightened 2026-08-12: |wt2| > 10 fired on almost every coin (15 candidates from 20) — it
    // described the market rather than finding anything. A mid-range cross now has to agree with
    // the 50 EMA trend; only a genuine extreme-zone cross may go against it.
    const w = wt2[xi];
    const extremeZone = bear ? w >= VMC.obLevel : w <= VMC.osLevel;
    const midRange = bear ? w >= 25 : w <= -25;
    if (!extremeZone && !midRange) continue;
    if (!extremeZone) {
      const closes = c.map(x => x.c), e50 = emaArr(closes, 50);
      const trendAgrees = bear ? closes[i] < e50[i] : closes[i] > e50[i];
      if (!trendAgrees) continue;                 // counter-trend mid-range fade = noise
    }
    // VWAP wave (the early-warning wave) must agree, and be falling/rising into the cross
    const vwOK = bear ? (vw[i] < vw[Math.max(0, i - 2)] && vw[i] < 0) : (vw[i] > vw[Math.max(0, i - 2)] && vw[i] > 0);
    if (!vwOK) continue;
    // money flow turning with it
    const mfOK = bear ? mf[i] < mf[Math.max(0, i - 3)] : mf[i] > mf[Math.max(0, i - 3)];
    if (!mfOK) continue;
    const ev = [
      `${bear ? 'Bearish' : 'Bullish'} WaveTrend cross at ${wt2[xi].toFixed(0)}${bear ? (wt2[xi] >= VMC.obLevel ? ' (overbought)' : ' (rolling over from above zero)') : (wt2[xi] <= VMC.osLevel ? ' (oversold)' : ' (turning up from below zero)')}`,
      `VWAP wave ${bear ? 'below zero and falling' : 'above zero and rising'} (${vw[i].toFixed(1)}) — the early-warning wave agrees`,
      `Money flow ${bear ? 'rolling over' : 'turning up'}`
    ];
    const extreme = bear ? wt2[xi] >= VMC.obLevel : wt2[xi] <= VMC.osLevel;
    if (extreme) ev.push('Cross happened in the extreme zone — higher quality');
    const age = i - xi;
    ev.push(age === 0 ? 'Cross on the last closed bar' : `Cross ${age} bar${age === 1 ? '' : 's'} ago`);
    return { match: true, dir, label: `Momentum Rollover ${bear ? 'Short' : 'Long'}`,
      stage: extreme ? 'extreme' : 'mid-range', ev };
  }
  return null;
}

function detectGreenDotMFReversal(c) {
  if (!c || c.length < 80) return null;
  const { wt1, wt2 } = waveTrend(c); const mf = vmcMoneyFlow(c); const n = c.length, i = n-1;
  // green dot must have printed on the last 1–2 closed bars (fresh), in oversold
  let greenDot=false, gI=i;
  for (let k=n-1;k>=n-2 && k>=1;k--){ const d0=wt1[k]-wt2[k], d1=wt1[k-1]-wt2[k-1]; if(d1<=0&&d0>0&&wt2[k]<=VMC.osLevel){greenDot=true;gI=k;break;} }
  if (!greenDot) return null;
  const mfUp = mf[i] > mf[Math.max(0,i-3)];                 // money flow turning up
  if (!mfUp) return null;
  // recent swing low (last 20 bars) for the stop
  let lo=Infinity; for (let k=Math.max(0,n-20);k<n;k++){ if(c[k].l<lo) lo=c[k].l; }
  if (!isFinite(lo)||lo<=0) return null;
  const movePct = (c[i].c-lo)/lo*100;
  if (movePct >= 40) return null;                            // already run too far — not a fresh reversal
  // — scoring: deeper oversold, MF acceleration, volume, daily-trend gate —
  let score = 4;
  const ev = ['oversold green dot just fired', 'money flow turning up'];
  const deepOS = wt2[gI] <= -60;
  if (deepOS) { score++; ev.push('deep oversold (WT ≤ -60)'); } else ev.push('mild oversold');
  const mfAccel = (mf[i] - mf[Math.max(0,i-2)]) > (mf[Math.max(0,i-2)] - mf[Math.max(0,i-4)]);
  if (mfAccel) { score++; ev.push('MF accelerating, not just rising'); }
  const vr = Math.max(volRatio(c, gI) || 0, volRatio(c, i) || 0);
  if (vr >= 1.5) { score++; ev.push(`volume ${vr.toFixed(1)}× the 20-bar avg`); } else ev.push(`volume ${vr.toFixed(1)}× avg (modest)`);
  const ema200 = ema200At(c, i);
  const withTrend = ema200 == null ? null : c[i].c > ema200;
  if (withTrend === true)  { score++; ev.push('above daily 200 EMA — with trend'); }
  if (withTrend === false) { score--; ev.push('below daily 200 EMA — counter-trend, half size or skip'); }
  ev.push(`+${movePct.toFixed(0)}% off the low (early)`);
  const risk = c[i].c - lo*0.985;
  return { match:true, dir:'long', label:'Green Dot MF Reversal', stage: withTrend === false ? 'counter-trend reversal' : 'reversal', score, base:lo,
    entry:c[i].c, stop:lo*0.985, target:c[i].c + (risk>0?risk:c[i].c*0.02)*2, ev };
}

// ═══════════════════════ SIGNAL: confluence score (mirrors scanCoin) ═══════════════════════
function analyzeTF(c) {
  if (!c || c.length < 70) return null;
  const { wt1, wt2 } = waveTrend(c), mf = vmcMoneyFlow(c), rsi = rsiArr(c), closes = c.map(x => x.c);
  const e50 = emaArr(closes, 50), i = c.length - 1;
  const d0 = wt1[i] - wt2[i], d1 = wt1[i - 1] - wt2[i - 1];
  return {
    price: closes[i],
    trendUp: closes[i] > e50[i],
    bullCross: d1 <= 0 && d0 > 0,
    bearCross: d1 >= 0 && d0 < 0,
    wt2: wt2[i],
    deepOS: wt2[i] <= VMC.osLevel2,
    deepOB: wt2[i] >= VMC.obLevel2,
    mfOsc: mf[i],
    rsi: rsi[i],
  };
}
// Same scoring shape as the app's scanCoin: HTF agreement + entry trigger + money flow + extremes.
function scoreCoin(tfData) {
  const d1 = tfData["1D"], h4 = tfData["4H"], h1 = tfData["1H"];
  if (!d1 && !h4 && !h1) return null;
  const ups = [d1, h4].filter(Boolean).filter(x => x.trendUp).length;
  const downs = [d1, h4].filter(Boolean).filter(x => !x.trendUp).length;
  let bias = "neutral";
  if (ups >= 1 && downs === 0) bias = "long";
  else if (downs >= 1 && ups === 0) bias = "short";
  if (bias === "neutral") return null;

  const ev = []; let score = 0;
  if (d1 && h4 && d1.trendUp === h4.trendUp) { score += 2; ev.push(`Daily & 4H agree (${d1.trendUp ? "up" : "down"})`); }
  const entry = h1;
  if (entry) {
    if (bias === "short" ? entry.bearCross : entry.bullCross) { score += 2; ev.push(`1H ${bias === "short" ? "bearish" : "bullish"} WT cross`); }
    if (bias === "short" ? entry.mfOsc < 0 : entry.mfOsc > 0) { score += 1; ev.push(`Money flow ${bias === "short" ? "negative" : "positive"}`); }
    if (bias === "short" ? entry.deepOB : entry.deepOS) { score += 1; ev.push(`WT deeply ${bias === "short" ? "overbought" : "oversold"} (${Math.round(entry.wt2)})`); }
    if (Number.isFinite(entry.rsi) && entry.rsi > 25 && entry.rsi < 75) { score += 1; ev.push(`RSI healthy (${Math.round(entry.rsi)})`); }
  }
  const px = (entry || d1 || h4).price;
  // The plan must be built on the timeframe that actually triggered — a 1H entry with a daily
  // ATR stop is a swing-width stop on an intraday idea, and never works out.
  const planTf = entry ? "1H" : (h4 ? "4H" : "1D");
  return { bias, score: Math.min(10, score), ev, price: px, planTf };
}

// ═══════════════════════ TRADE PLAN (identical to buildTradePlan) ═══════════════════════
function buildTradePlan(candles, dir, entry) {
  const atr = atrArr(candles, 14), a = atr[atr.length - 1];
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(entry)) return null;
  const last10 = candles.slice(-10);
  let stop;
  if (dir === "short") { stop = Math.max(...last10.map(k => k.h)) + 0.25 * a; if (stop - entry < 0.6 * a) stop = entry + 1.5 * a; }
  else { stop = Math.min(...last10.map(k => k.l)) - 0.25 * a; if (entry - stop < 0.6 * a) stop = entry - 1.5 * a; }
  let stopKind = "swing10";

  // ── STRUCTURAL STOP (2026-08-15) ─────────────────────────────────────────────────────────────
  // "Ten bars back plus a quarter ATR" is defensible but arbitrary — it is a lookback, not a
  // reason. The far side of the zone the move came from IS a reason: if price trades back through
  // the level that caused the impulse, the idea is wrong, and that is what a stop is for.
  //
  // Only ever moves the stop CLOSER, never further out — a structural level beyond the swing stop
  // would be widening risk to suit a story, which is how a plan becomes a hope. Since size is
  // risk / stopDistance, a tighter honest stop also means a larger position on the same £ risk.
  const st = marketStructure(candles);
  const zone = nearestZone(candles, dir);
  if (zone) {
    const cand = dir === "short" ? zone.top + 0.15 * a : zone.bottom - 0.15 * a;   // just beyond it
    const tighter = dir === "short" ? (cand < stop && cand > entry) : (cand > stop && cand < entry);
    if (tighter && Math.abs(entry - cand) >= 0.4 * a) { stop = cand; stopKind = zone.src; }
  }

  // A structure stop can be enormous on a volatile coin — ADA came out 14.4% away, giving a
  // 32% target from a momentum cross that has no edge over a move that size. If structure
  // demands more than 3 ATR, the setup is not tradeable on this timeframe: refuse it rather
  // than stretch the plan to fit (2026-08-12).
  if (Math.abs(entry - stop) > 3 * a) return null;
  const risk = Math.abs(entry - stop); if (!(risk > 0)) return null;
  const sgn = dir === "short" ? -1 : 1;
  return {
    entry, stop, risk, targets: [1, 2.25, 4].map(m => entry + sgn * risk * m),
    stopKind, trend: st.trend,
    // The pullback level, carried but NOT acted on unless ENTRY_MODE=structure. Recorded either
    // way so the two entry styles can be compared on real trades rather than argued about.
    zone: zone ? { src: zone.src, top: zone.top, bottom: zone.bottom, awayPct: +zone.away.toFixed(2) } : null,
  };
}

// ═══════════════════════ GUARDS (same rules as the app's exec) ═══════════════════════
// Leveraged ETFs / stock tickers must never reach a crypto exchange.
const NOT_CRYPTO = /^(SPY|QQQ|MU|DIA|IWM|TLT|GLD|SLV|VOO|VTI|ARKK|TQQQ|SQQQ|SOXL|SPXL|UPRO|LABU|NVDL|TSLL|MSTU|MSTX)[A-Z]?$/;
function planValid(t) {
  const en = +t.entry, sl = +t.sl, isLong = (t.dir || "long") !== "short";
  if (!Number.isFinite(en) || en <= 0) return "no entry price";
  if (!Number.isFinite(sl) || sl <= 0) return "no stop loss — never trade stopless";
  if (isLong && sl >= en) return `LONG stop ${sl} is not below entry ${en}`;
  if (!isLong && sl <= en) return `SHORT stop ${sl} is not above entry ${en}`;
  const dist = Math.abs(en - sl) / en;
  // ── A STOP MUST BE WIDE ENOUGH TO PAY FOR THE TRADE (2026-08-18) ─────────────────────────────
  // The old floor was 0.3%. Round-trip cost is about 22bps (2 x 6bps taker + 10bps slippage), and
  // cost measured in R is simply cost% / stop% — so a 0.3% stop hands 73% of the risk to the
  // exchange before the idea has a chance. For costs to stay under a tenth of R the stop has to
  // clear ~2.2%. Three years of replay drew the same line independently: coins with an ATR under
  // 2% of price lost £0.91 a trade while the rest made money.
  //
  // The exchange agrees. Every TE_SELL_SL_SHOULD_GT_BASE / TE_BUY_SL_SHOULD_LT_BASE rejection in
  // the live log on 2026-08-17/18 was a stop between 0.4% and 0.8% wide — close enough to the
  // market that it was already on the wrong side by the time the order arrived.
  const MIN_STOP_PCT = num("MIN_STOP_PCT", 0.022);
  if (dist < MIN_STOP_PCT) return `stop only ${(dist * 100).toFixed(2)}% from entry — below the ${(MIN_STOP_PCT * 100).toFixed(1)}% floor, costs would eat ${(0.0022 / dist * 100).toFixed(0)}% of the risk`;
  if (dist > 0.35) return `stop ${(dist * 100).toFixed(0)}% from entry — implausible plan`;
  const tp = +t.tp1;
  if (Number.isFinite(tp) && tp > 0 && ((isLong && tp <= en) || (!isLong && tp >= en))) return `target ${tp} on the wrong side of entry`;
  return null;
}
function roundQty(q) { if (q >= 100) return Math.round(q); if (q >= 1) return Math.round(q * 1e3) / 1e3; return Math.round(q * 1e6) / 1e6; }
// Price rounding must scale with the price. `.toFixed(1)` was fine for BTC (64000.0) but for a
// coin at 0.7035 it produced 0.7 — a BUY limit BELOW the market, which rests instead of filling —
// and 0.0006307 became 0.0, which the exchange rejects. This was almost certainly being
// misdiagnosed as "the testnet has no liquidity" (2026-08-10).
function roundPx(p) {
  if (!Number.isFinite(p) || p <= 0) return p;
  if (p >= 1000) return +p.toFixed(1);
  if (p >= 100) return +p.toFixed(2);
  if (p >= 1) return +p.toFixed(4);
  if (p >= 0.01) return +p.toFixed(6);
  return +p.toPrecision(6);          // sub-cent coins keep 6 significant figures
}
// The venue's notional cap, learned from the relay's /status. Null until the first successful
// call; sizing then falls back to the unclamped figure, which is the old behaviour.
let RELAY_CAP = null;

function buildOrder(t) {
  const symbol = String(t.coin).toUpperCase() + "USDT";
  const entry = +t.entry, sl = +t.sl, tp1 = +t.tp1;
  if (!(Math.abs(entry - sl) > 0)) return { err: "zero stop distance" };
  const isLong = (t.dir || "long") === "long";

  // ── ENTRY: chase, or wait at the level? (2026-08-15) ─────────────────────────────────────────
  // immediate  — cross 1% through to guarantee a fill. Takes whatever price the oscillator hands
  //              you, which after a WaveTrend cross is often well into the move.
  // structure  — rest a limit at the edge of the zone the move came from and let price return.
  //              Better price, tighter stop, bigger size for the same risk — but it only trades
  //              if price actually comes back, and the trades that never pull back are often the
  //              best ones. That cost is real and is why this stays opt-in until measured.
  let cross = roundPx(isLong ? entry * 1.01 : entry * 0.99);
  let entryKind = "immediate";
  if (CFG.entryMode() === "structure" && t.zone) {
    const lvl = isLong ? t.zone.top : t.zone.bottom;
    const stillValid = isLong ? (lvl < entry && lvl > sl) : (lvl > entry && lvl < sl);
    if (stillValid) { cross = roundPx(lvl); entryKind = "zone:" + t.zone.src; }
  }

  // ── SIZE OFF THE PRICE WE WILL ACTUALLY GET, NOT THE ONE WE PLANNED (2026-08-15) ─────────────
  // This used to divide the risk by |plannedEntry − stop|, but the order does not fill at the
  // planned entry: immediate mode crosses 1% through it, structure mode rests below it. Sizing
  // off a price we never trade at makes the £ risk wrong in both modes — and in structure mode it
  // was wrong by the entire point of the feature, cancelling out the bigger position the better
  // entry had earned. Found by a test asserting the size should grow. It had not.
  // ── ...WHICH IS NOT ALWAYS THE ORDER PRICE (2026-08-18) ──────────────────────────────────────
  // The 2026-08-15 note above is right for one of the two modes. A limit that crosses 1% THROUGH
  // the market is marketable: it fills at the market, which is about `entry` — it does NOT fill at
  // `cross`. Sizing off `cross` in immediate mode therefore adds a phantom 1% of price to the stop
  // distance and buys too little. Measured over a 3-year replay of the live rules: the bot risked
  // a mean of £7.28 every time it believed it was risking £10, and on a tight stop it was worse
  // than that. A RESTING limit (structure mode) genuinely does fill at its own price, and there
  // `cross` was always correct. So size off whichever price this order will actually trade at.
  const fillPx = entryKind === "immediate" ? entry : cross;
  const stopDist = Math.abs(fillPx - sl);
  if (!(stopDist > 0)) return { err: "zero stop distance at the order price" };
  let qty = roundQty(CFG.risk() / stopDist); if (!(qty > 0)) return { err: "computed qty <= 0" };

  // ── SIZE TO THE VENUE CAP INSTEAD OF BEING REJECTED BY IT (2026-08-13) ──
  // notional = qty × entry = risk / stopPercent. With risk 10 and a 2000 cap, ANY stop tighter
  // than 0.5% breaches it — while planValid happily allows stops down to 0.3%. So every setup in
  // the 0.3–0.5% band was built, approved, sent and refused, and those are the tightest, best
  // R:R setups in the book (two in the Aug log at 2652 and 2609 USDT). A cap is a venue limit,
  // not a signal about the trade: take it at the size that fits rather than throwing it away.
  // The trade-off is explicit — such a trade risks LESS than RISK_GBP, and riskActual records it.
  let clamped = false;
  if (Number.isFinite(RELAY_CAP) && RELAY_CAP > 0) {
    const maxQty = roundQty((RELAY_CAP * 0.98) / cross);   // 2% headroom absorbs qty rounding
    if (maxQty > 0 && qty > maxQty) { qty = maxQty; clamped = true; }
    if (!(qty > 0)) return { err: "notional cap leaves no tradeable size" };
  }
  const riskActual = +(qty * stopDist).toFixed(2);
  const sizedOff = +fillPx;                     // recorded so "what did it actually risk" is answerable
  const tp2 = Number(t.tp2);
  const exitPx = Number.isFinite(tp2) && tp2 > 0 ? tp2 : (Number.isFinite(tp1) ? tp1 : undefined);
  return {
    order: {
      symbol, side: isLong ? "Buy" : "Sell", posSide: isLong ? "Long" : "Short",
      ordType: "Limit", priceRp: cross, timeInForce: "GoodTillCancel", orderQtyRq: qty,
      refPx: entry, stopLossRp: sl, slTrigger: "ByMarkPrice",
      takeProfitRp: exitPx,
      clOrdID: ("agent" + t.coin + Date.now()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 30),
    },
    meta: { symbol, qty, exitPx, riskActual, clamped, entryKind, sizedOff, stopKind: t.stopKind, zone: t.zone || undefined },
  };
}

// ═══════════════════════ RELAY ═══════════════════════
// A hung call must not eat the run's 45s budget and starve every coin after it.
const RELAY_TIMEOUT_MS = 20000;

// ── FAILURE FORENSICS (2026-08-15) ────────────────────────────────────────────────────────────
// "ERR 502" tells you nothing. These four facts tell you almost everything:
//   ms        — under ~1s means the request never reached the val (edge rejected it). A constant
//               10–60s means the val ran and was killed. That single number separates every
//               competing theory about this bug.
//   cf-ray    — proves Cloudflare answered; its absence means the response came from elsewhere.
//   server / cf-mitigated / cf-cache-status — names the edge behaviour (bot challenge, block).
//   snippet   — Cloudflare's HTML names its OWN error number (502 vs 504 vs 524 origin-timeout
//               vs 1015 rate-limited vs 1020 access-denied). We were throwing that away.
function diagOf(res, ms, raw) {
  const h = (k) => { try { return res.headers.get(k) || undefined; } catch { return undefined; } };
  const d = { ms, status: res.status, cfRay: h("cf-ray"), server: h("server"),
              mitigated: h("cf-mitigated"), cache: h("cf-cache-status"), via: h("via"),
              valtown: h("x-valtown-request-id") || h("x-val-town-request-id") };
  if (res.status >= 400 || (raw && raw[0] !== "{" && raw[0] !== "[")) d.snippet = String(raw || "").replace(/\s+/g, " ").slice(0, 300);
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return d;
}

async function relay(path, body) {
  const url = CFG.relayUrl(); if (!url) throw new Error("RELAY_URL not set");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CFG.relayToken() },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    // Even a thrown request must carry its timing — an abort at exactly RELAY_TIMEOUT_MS is a
    // different animal from a DNS failure at 20ms, and the log has to be able to tell them apart.
    e.ms = Date.now() - t0;
    e.message = String(e.message || e) + ` [after ${e.ms}ms]`;
    throw e;
  } finally { clearTimeout(timer); }
  // Read the body ONCE as text, then try to parse. Calling res.json() and falling back to
  // res.text() in the catch throws "Body is unusable" — the failure handler itself failed, and
  // that killed every scheduled run overnight (2026-08-12). Never re-read a consumed body.
  const raw = await res.text();
  const ms = Date.now() - t0;
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500), parseError: true }; }
  return { status: res.status, data, diag: diagOf(res, ms, raw) };
}

// ═══════════════════ DIRECT PHEMEX EXECUTION — no relay, no Cloudflare ═══════════════════
// WHY (2026-08-15): ~83% of order POSTs were dying as Cloudflare HTML 502s in front of the
// Val Town relay. The relay exists because a BROWSER cannot be trusted with an API key. This
// agent is not a browser — it is a server-side runner that already holds secrets. So for the
// bot's own orders the middleman is pure downside: one more hop, one more cold start, one more
// free-tier edge that can answer with an HTML page instead of JSON.
//
// The relay stays exactly as it is for the app. This path is opt-in via EXEC_DIRECT=1, and if
// the key/secret are missing the agent silently keeps using the relay — so a mis-set secret
// degrades to yesterday's behaviour rather than to no trading at all.
//
// EVERY guard the relay enforced is re-implemented here. That is the price of removing it: the
// relay was not just a signer, it was the safety net, and dropping the net without replacing it
// would be the worst possible trade.
const PHEMEX_BASE = "https://testnet-api.phemex.com";   // HARD LOCK. Going live = editing this line.
const PHEMEX_TIMEOUT_MS = 15000;

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Byte-identical signing to phemex-relay-valtown.js: path + query + expiry + rawBody.
// Public GET — no key, no signature. Used for the spot product table (price/quantity scales),
// which must be read from the venue rather than assumed. Same hard-locked testnet base URL.
async function phemexPublic(path, query) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PHEMEX_TIMEOUT_MS);
  try {
    const res = await fetch(PHEMEX_BASE + path + (query ? "?" + query : ""), { signal: ac.signal });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { data = { parseError: true, raw: raw.slice(0, 300) }; }
    return { status: res.status, data };
  } finally { clearTimeout(timer); }
}

async function phemexCall(method, path, query, bodyObj) {
  const expiry = Math.floor(Date.now() / 1000) + 60;
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const signature = await hmacHex(CFG.phemexSecret(), path + (query || "") + expiry + bodyStr);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PHEMEX_TIMEOUT_MS);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(PHEMEX_BASE + path + (query ? "?" + query : ""), {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-phemex-access-token": CFG.phemexKey(),
        "x-phemex-request-expiry": String(expiry),
        "x-phemex-request-signature": signature,
      },
      body: bodyStr || undefined,
      signal: ac.signal,
    });
  } catch (e) {
    e.ms = Date.now() - t0;
    e.message = String(e.message || e) + ` [phemex, after ${e.ms}ms]`;
    throw e;
  } finally { clearTimeout(timer); }
  const raw = await res.text();                    // once. never twice.
  const ms = Date.now() - t0;
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500), parseError: true }; }
  return { status: res.status, data, diag: { ...diagOf(res, ms, raw), venue: "phemex" } };
}

// The relay's refusals, restated. Returns an error string, or null if the order may go.
function directGuards(o) {
  if (CFG.kill()) return "KILL switch is ON — no orders placed.";
  const symbol = String(o.symbol || "").toUpperCase();
  const wl = CFG.whitelist().split(",").map(s => s.trim().toUpperCase());
  if (!wl.includes("*") && !wl.includes(symbol)) return `symbol ${symbol} not in whitelist`;
  const qty = Number(o.orderQtyRq), refPx = Number(o.refPx || o.priceRp), sl = Number(o.stopLossRp);
  if (!(qty > 0)) return "orderQtyRq must be > 0";
  if (o.side !== "Buy" && o.side !== "Sell") return "side must be Buy or Sell";
  if (!(refPx > 0)) return "refPx required to size-check the order";
  if (!(sl > 0)) return "refusing order with no stop loss";
  const isLong = o.side === "Buy";
  if (isLong && sl >= refPx) return `refusing order: LONG stop ${sl} must be BELOW entry ${refPx}`;
  if (!isLong && sl <= refPx) return `refusing order: SHORT stop ${sl} must be ABOVE entry ${refPx}`;
  const slDist = Math.abs(refPx - sl) / refPx;
  if (slDist < 0.003) return `refusing order: stop is ${(slDist * 100).toFixed(2)}% from entry — too tight (min 0.3%)`;
  if (o.takeProfitRp != null) {
    const tp = Number(o.takeProfitRp);
    if (!(tp > 0) || (isLong && tp <= refPx) || (!isLong && tp >= refPx)) return `refusing order: target ${tp} is on the wrong side of entry ${refPx}`;
  }
  const notional = qty * refPx, cap = CFG.maxNotional();
  if (notional > cap) return `notional ${notional.toFixed(2)} USDT exceeds cap ${cap}`;
  return null;
}

// Answers in the SAME shape as relay() so the loop above does not care which path ran.
//   200 = placed · 4xx = a decision (will repeat, stays burned) · 5xx = a fault (worth retrying)
async function directOrder(o) {
  const bad = directGuards(o);
  if (bad) return { status: 400, data: { error: bad }, diag: { venue: "direct", refused: true } };

  const refPx = Number(o.refPx || o.priceRp);
  const dp = (String(refPx).split(".")[1] || "").length || 2;
  const px = (v) => String(Number(Number(v).toFixed(dp)));
  const order = {
    clOrdID: String(o.clOrdID || "cipher-" + Date.now()).slice(0, 40),
    symbol: String(o.symbol).toUpperCase(), side: o.side, posSide: o.posSide || "Merged",
    ordType: o.ordType || "Market", orderQtyRq: String(o.orderQtyRq),
    timeInForce: o.timeInForce || "ImmediateOrCancel",
    stopLossRp: px(o.stopLossRp), slTrigger: o.slTrigger || "ByMarkPrice",
    reduceOnly: false, text: "cipher-auto",
  };
  if (order.ordType === "Limit") order.priceRp = px(o.priceRp);
  if (o.takeProfitRp != null) { order.takeProfitRp = px(o.takeProfitRp); order.tpTrigger = o.tpTrigger || "ByLastPrice"; }

  // Two independent brakes, because the relay's server-side DRY_RUN is no longer in the path:
  // MODE must be armed AND DRY_RUN must not be set. Either one alone stops a real order.
  if (CFG.mode() !== "armed" || String(env("DRY_RUN", "0")) === "1")
    return { status: 200, data: { dryRun: true, wouldSend: order }, diag: { venue: "direct", dry: true } };

  const r = await phemexCall("POST", "/g-orders", "", order);
  const code = r.data && r.data.code;
  if (r.status !== 200) return { status: r.status, data: { error: `phemex http ${r.status}`, sent: order, phemex: r.data }, diag: r.diag };
  if (code !== 0 && code !== undefined) {
    // A rejection is a DECISION, not a fault — 4xx so the coin stays burned instead of being
    // re-sent every run. The relay returned 502 here, which is what taught the agent to retry
    // orders the exchange had already refused on purpose.
    return { status: 422, data: { error: `phemex ${code}: ${(r.data && r.data.msg) || "rejected"}`, sent: order, phemex: r.data }, diag: r.diag };
  }
  // Wrapped { httpStatus, data } exactly as the relay wrapped it, so the loop's orderID lookup
  // (r.data.phemex.data.data.orderID) reads the same shape whichever route ran.
  return { status: 200, data: { sent: order, phemex: { httpStatus: r.status, data: r.data } }, diag: r.diag };
}

// ── EXEC WRAPPERS: one switch, so nothing below has to know which route is live ──
const EXEC = () => (CFG.direct() ? "direct" : "relay");

async function execOrder(order) {
  if (CFG.direct()) return await directOrder(order);
  return await relay("/order", order);
}

// Phemex nests this two levels deep: { code, msg, data: { account, positions } }. The relay
// wraps it again as { httpStatus, data: <that> } — so through the relay the positions live at
// r.data.data.data.positions, and the old accessor stopped one level short and always returned
// an empty list. That silently disabled "already holding this coin" AND the position half of
// confirmPlaced. Found 2026-08-15. Dig for the array instead of trusting a fixed path.
function findPositions(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 5) return null;
  if (Array.isArray(o.positions)) return o.positions;
  for (const k of Object.keys(o)) { const hit = findPositions(o[k], depth + 1); if (hit) return hit; }
  return null;
}

// The same accountPositions response carries the account object — balance, margin. Capturing it
// here means the circuit breaker can watch real equity without a single extra API call.
function findAccount(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 5) return null;
  if (o.accountBalanceRv != null || o.accountBalanceEv != null) return o;
  for (const k of Object.keys(o)) { const hit = findAccount(o[k], depth + 1); if (hit) return hit; }
  return null;
}
let LAST_ACCOUNT = null;
function equityNow() {
  if (!LAST_ACCOUNT) return null;
  const v = Number(LAST_ACCOUNT.accountBalanceRv ?? NaN);
  if (Number.isFinite(v) && v > 0) return v;
  const e = Number(LAST_ACCOUNT.accountBalanceEv ?? NaN);          // scaled integer variant
  return Number.isFinite(e) && e > 0 ? e / 1e8 : null;
}

// null = "I could not read the book". [] = "the book is genuinely empty". Never conflate them:
// a non-200, or a 200 whose body contains no positions array at all, is a FAILED read, and the
// caller must be able to tell. Returning [] on a 502 is what let opposing legs stack up.
async function execPositions() {
  const r = CFG.direct()
    ? await phemexCall("GET", "/g-accounts/accountPositions", "currency=USDT", null)
    : await relay("/positions");
  if (r.status !== 200) { console.error("positions read: HTTP " + r.status); return null; }
  try { LAST_ACCOUNT = findAccount(r.data); } catch { LAST_ACCOUNT = null; }
  const pos = findPositions(r.data);
  if (!Array.isArray(pos)) { console.error("positions read: no positions array in the response"); return null; }
  return pos;
}

async function execOrdersFor(symbol) {
  if (CFG.direct()) {
    // activeList alone misses UNTRIGGERED conditionals — the same omission that produced the
    // false "no stop on exchange" alarm in the relay. Ask for both and merge.
    const out = [];
    for (const q of [`symbol=${symbol}`, `symbol=${symbol}&untriggered=true`]) {
      try {
        const r = await phemexCall("GET", "/g-orders/activeList", q, null);
        const rows = (r.data && r.data.data && (r.data.data.rows || r.data.data)) || [];
        if (Array.isArray(rows)) out.push(...rows);
      } catch { /* one view failing must not blind the other */ }
    }
    const seen = new Set();
    return out.filter(o => o && o.orderID && !seen.has(o.orderID) && seen.add(o.orderID));
  }
  const r = await relay("/orders?symbol=" + encodeURIComponent(symbol));
  return (r.data && r.data.orders) || [];
}

// Ask the relay what it will actually accept, and scan only those coins. The relay's whitelist
// is the real gate — trading outside it just generates rejected orders and noise in the log.
// Making it the single source of truth means the two can never disagree (2026-08-12).
async function relayWhitelist() {
  try {
    // Direct mode: the relay is not in the path, so it cannot be the source of truth. Our own
    // WHITELIST/MAX_NOTIONAL_USDT are — and they default to the relay's own values.
    if (CFG.direct()) {
      RELAY_CAP = CFG.maxNotional();
      const wl = CFG.whitelist().split(",").map(s => s.trim()).filter(Boolean);
      if (!wl.length || wl.includes("*")) return null;
      return new Set(wl.map(x => x.toUpperCase().replace(/USDT$/, "")));
    }
    const url = CFG.relayUrl(); if (!url) return null;
    const res = await fetch(url + "/status", { headers: { Authorization: "Bearer " + CFG.relayToken() } });
    const raw = await res.text();
    const j = JSON.parse(raw);
    // Learn the venue's notional cap from the same call. Sizing has to respect it or the tightest
    // stops are built, approved, sent and refused — see RELAY_CAP below.
    if (j && Number.isFinite(+j.maxNotional) && +j.maxNotional > 0) RELAY_CAP = +j.maxNotional;
    const wl = j && j.whitelist;
    if (!Array.isArray(wl) || !wl.length) return null;
    if (wl.includes("*")) return null;                       // open relay — scan everything
    return new Set(wl.map(x => String(x).toUpperCase().replace(/USDT$/, "")));
  } catch { return null; }                                    // unreachable → don't block the run
}

// Returns null — NOT [] — when the read fails. "I could not see the book" and "the book is empty"
// are completely different facts, and collapsing them into [] is what let the bot open a second,
// opposing leg on five different coins. A caller that cannot tell them apart cannot be safe.
async function openPositions() {
  try {
    const pos = await execPositions();
    return Array.isArray(pos) ? pos.filter(p => Number(p.size) > 0) : null;
  } catch (e) { console.error("positions read failed:", e && e.message); return null; }
}

// ── Did that order actually land? ─────────────────────────────────────────────────────────────
// The relay sits behind Cloudflare and returns a bare HTML 502 on roughly 45% of order POSTs
// (measured 12–14 Aug 2026 across 47 attempts). It is not the coin, the direction, the size, the
// stop width or the position in the run — all of those were checked and none correlate. It is
// simply an unreliable hop, so the answer is not another diagnosis, it is resilience.
//
// NEVER retry an order blind: a 502 does not mean the order failed, only that we did not hear
// back. The request may well have reached Phemex. So we ask the exchange what happened before
// deciding — a resting order carrying our clOrdID, or a position that appeared on a coin we were
// not holding at the start of the run, both mean it landed and must NOT be sent twice.
async function confirmPlaced(symbol, clOrdID, coin) {
  try {
    const orders = await execOrdersFor(symbol);
    const hit = orders.find(o => o && o.clOrdID === clOrdID);
    if (hit) return { landed: true, how: "resting order", orderID: hit.orderID || "" };
  } catch { /* fall through to the position check */ }
  try {
    // We only ever place when the coin is NOT already held, so any position here is ours.
    const pos = await openPositions();
    if (pos.some(p => String(p.symbol || "").replace(/USDT$/, "").toUpperCase() === coin)) {
      return { landed: true, how: "filled into a position", orderID: "" };
    }
  } catch { /* unknown */ }
  return { landed: false };
}

async function pushLog(entry) {
  const log = await getJSON(KEY.log, []);
  log.unshift({ at: new Date().toISOString(), ...entry });
  await setJSON(KEY.log, log.slice(0, 300));
}

// ── LIVE CONFIG from the relay (the app's control panel) ──────────────────────────────────────
// Settings used to live only in the GitHub workflow, so changing the risk or stopping the bot
// meant editing YAML and committing. Now the app writes them to the relay and we read them here.
//
// The rule that keeps this safe: a FAILED read changes nothing. We fall back to the workflow env,
// which is the behaviour that existed before this feature. Silence is not an instruction — an
// unreachable relay must not be able to arm the bot, and must not be able to disarm it either
// (that is what KILL is for, and KILL is enforced on the relay's own order path).
let LIVE = null;
async function loadLiveConfig() {
  const url = CFG.relayUrl(); if (!url) return null;
  try {
    // 8 seconds was too tight, proved on 2026-08-19: the Val Town relay cold-starts after a code
    // change and answered GitHub's runner in more than that, so every run aborted the read and
    // fell back to the workflow's MODE=off. A settings read that times out does not just lose the
    // settings — it hands control to a stale default, which is a worse failure than waiting.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), num("CONFIG_TIMEOUT_MS", 20000));
    let res;
    try {
      res = await fetch(url + "/config", { headers: { Authorization: "Bearer " + CFG.relayToken() }, signal: ac.signal });
    } finally { clearTimeout(timer); }
    if (res.status !== 200) { console.log(`live config: HTTP ${res.status} — using workflow settings`); return null; }
    const j = JSON.parse(await res.text());
    const c = j && j.config;
    if (!c || typeof c !== "object") return null;
    return c;
  } catch (e) { console.log("live config: unreachable (" + String(e && e.message || e).slice(0, 80) + ") — using workflow settings"); return null; }
}
// Applied through the same CFG accessors everything else already uses, so there is exactly one
// place each setting is read from and no chance of half the code seeing the panel's value and
// half seeing the workflow's.
function applyLiveConfig(c) {
  if (!c) return [];
  const applied = [];
  // Bounds are re-checked HERE as well as in the relay. The agent does not trust the relay to
  // have validated — `+null` is 0, and a CORR_MAX of 0 would quietly block every trade while
  // looking like a setting rather than a bug. Absent, null, empty and out-of-range all mean
  // "leave the workflow value alone".
  const setNum = (key, raw, lo, hi) => {
    if (raw === undefined || raw === null || raw === "") return;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < lo || v > hi) { console.log(`live config: ignoring ${key}=${raw} (out of range ${lo}–${hi})`); return; }
    CFG[key] = () => v; applied.push(`${key}=${v}`);
  };
  if (["off", "dry", "armed"].includes(String(c.mode).toLowerCase())) {
    const m = String(c.mode).toLowerCase(); CFG.mode = () => m; applied.push("mode=" + m);
  } else if (c.mode !== undefined && c.mode !== null) {
    console.log(`live config: ignoring mode=${c.mode}`);
  }
  setNum("risk", c.riskGbp, 1, 100);
  setNum("corrMax", c.corrMax, 1, 12);
  setNum("dayCap", c.dayCap, 1, 50);
  setNum("maxNotional", c.maxNotional, 100, 5000);
  // The accumulator's live timeframe. Validated AGAIN here even though the relay validates on the
  // way in: this value decides which strategy holds real coins, and "the other end checked it" is
  // not a thing worth betting a balance on. Anything unrecognised leaves the env value alone,
  // which means the ladder — the conservative direction to fail in.
  if (c.accumFlipTf !== undefined && c.accumFlipTf !== null && c.accumFlipTf !== "") {
    const want = String(c.accumFlipTf).toLowerCase();
    const hit = want === "off" ? "off" : FLIP_TFS.find(t => t.toLowerCase() === want);
    if (hit) { CFG.accumFlipTf = () => hit; applied.push("accumFlipTf=" + hit); }
    else console.log(`live config: ignoring accumFlipTf=${c.accumFlipTf}`);
  }
  // KILL from the panel stops the agent placing at all. The relay enforces it independently on
  // the order path, so this is the polite half of the switch, not the whole of it.
  if (c.kill === true) { CFG.mode = () => "off"; applied.push("KILL=on"); }
  return applied;
}

// ═══════════ TARGET HIT → LOOK THE OTHER WAY (2026-08-16) ═══════════
// John: "when the brain and bot see the TP long hit, surely we could rescan that coin for the
// short and ping it — get in and out better both ways."
//
// The bot already knows enough to do this and never used it. It records every plan it placed
// (entry, stop, target, book) and it reads open positions every run. A position that WAS there
// and is now gone has resolved — and comparing the last price to the plan says which way.
//
// A target hit is the most informative moment a setup ever produces: the thesis paid in full and
// the move is, by construction, extended. That is precisely when the reverse setup is worth a
// look — so the coin jumps the rotation queue instead of waiting for the cursor to come round,
// which on a 100-coin rotation can be hours.
//
// It does NOT auto-enter the reverse. It queues the coin to be scanned FIRST next run, and the
// normal signal, plan and guards decide from there. Jumping the queue is a scheduling decision;
// taking the trade is still a trading decision, and those should not be the same thing.
const OPEN_KEY = "cipher_open", PRIORITY_KEY = "cipher_priority";

// Snapshot what we are holding, with the plan that opened it, so the next run can tell what
// happened to it. Keyed the same way as the book map.
function snapshotOpen(positions, bookMap, prev) {
  const out = {};
  for (const p of positions) {
    const coin = String(p.symbol || "").replace(/USDT$/, "").toUpperCase();
    let d = String(p.posSide || p.side || "").toLowerCase();
    if (d !== "long" && d !== "short") d = Number(p.size) < 0 ? "short" : "long";
    const k = posKey(coin, d);
    out[k] = { coin, dir: d, size: Math.abs(Number(p.size) || 0), book: bookMap[k] || null,
               plan: (prev && prev[k] && prev[k].plan) || null, since: (prev && prev[k] && prev[k].since) || Date.now(),
               // the exchange's own average entry, so an adopted position can be graded against
               // the price it was really opened at rather than wherever price happens to be today
               avgEntry: +(p.avgEntryPriceRp ?? p.avgEntryPrice) || (prev && prev[k] && prev[k].avgEntry) || undefined,
               adopted: (prev && prev[k] && prev[k].adopted) || undefined };
  }
  return out;
}

// ── ADOPT WHAT WE ARE ALREADY HOLDING (2026-08-19) ────────────────────────────────────────────
// XRP|long and UNI|long predate the books feature: plan null, book null. Nothing could classify
// their exit, no time stop can ever apply to them, and an unknown position is "protected in both
// books" — so each orphan silently occupied a slot in BOTH books while nothing managed it.
// Adoption is pure bookkeeping: build the plan the bot WOULD build today from current daily
// structure (entry = the exchange's average entry price when it reports one), file the position
// under the swing book. No order is placed and nothing on the exchange moves — the plan simply
// gives the resolution pass, the correlation guard and any future time stop something to hold.
async function adoptOrphans(nowOpen, bookMap) {
  const adopted = [];
  for (const [k, pos] of Object.entries(nowOpen || {})) {
    if (pos.plan || !(pos.size > 0)) continue;
    let bars = null;
    try { bars = await fetchCandles(pos.coin, "1D", 260); } catch { }
    if (!bars || !bars.length) continue;
    // The stop and target are anchored to TODAY's price and structure — the position may have
    // been opened far from here, and a stop hung off a stale entry can land on the wrong side of
    // the market or fail the 3-ATR sanity check. The recorded entry stays the exchange's true
    // average entry, so "closed in profit / at a loss" is judged against reality.
    const cur = bars[bars.length - 1].c;
    const plan = buildTradePlan(bars, pos.dir, cur);
    // ── A FAILED ADOPTION MUST NOT BE SILENT (2026-08-20) ───────────────────────────────────
    // Found by John: a SOL long appeared at 07:59 that this bot never opened, and sat for
    // thirteen hours with no stop, no target and no book — because buildTradePlan returned null
    // (structure wider than 3 ATR, most likely) and this line was a bare `continue`.
    //
    // The position was not idle while it waited. A plan-less position counts as belonging to
    // BOTH books for the no-hedge rule, so it was silently blocking every SOL trade, while
    // itself carrying no stop. Unmanaged AND obstructive, and nothing said a word.
    //
    // Refusing to invent a plan is still right — a stop pulled from thin air is worse than an
    // honest "I cannot size this". Refusing QUIETLY is what was wrong.
    if (!plan) {
      const notional = (Number(pos.size) || 0) * (Number(pos.avgEntry) || cur);
      await pushLog({ coin: pos.coin, dir: pos.dir, result: "UNPROTECTED",
        skipped: `held with no plan and none could be built from today's structure — the stop it needs is more than 3 ATR away. It has NO stop and NO target at the venue, it is not in any book, and it is blocking new ${pos.coin} trades in both books. Size ${pos.size} (~${notional.toFixed(0)} USDT). This bot did not open it — close it by hand, or give it a stop yourself.` });
      console.error(`UNPROTECTED: ${pos.coin} ${pos.dir} size ${pos.size} (~${notional.toFixed(0)} USDT) — no plan could be built, no stop at the venue`);
      pos.unprotected = true;
      continue;
    }
    const ref = Number.isFinite(pos.avgEntry) && pos.avgEntry > 0 ? pos.avgEntry : cur;
    pos.plan = { entry: ref, stop: plan.stop, target: plan.targets[1] ?? plan.targets[0] };
    pos.book = pos.book || "swing";
    pos.adopted = Date.now();
    bookMap[k] = pos.book;
    adopted.push(pos);
    await pushLog({ coin: pos.coin, dir: pos.dir, book: pos.book, result: "ADOPTED",
      skipped: `held with no plan (predates the books feature) — given a ${plan.stopKind} stop ${formatPrice(pos.plan.stop)} and target ${formatPrice(pos.plan.target)} from today's daily structure, entry marked at ${formatPrice(ref)}, filed under the swing book. Bookkeeping only: no order placed.` });
  }
  return adopted;
}

// Anything in the previous snapshot that is no longer open has resolved. Classify it by where
// price ended up relative to the plan — target side, stop side, or neither.
// ═══════════ FOUR SEPARATE QUESTIONS, NOT ONE VERDICT (2026-08-20) ═══════════
// Adopted from John and Codex's training pack, and it fixes a defect this bot has had all along.
//
// The old version asked one question — "how did it end?" — and answered it by comparing the
// CURRENT price to the plan. Three things were wrong with that:
//
//   1. It graded a position the bot never closed. Every exit that was not a venue-side stop or
//      target fill is somebody else's decision, and inferring "closed in profit / at a loss"
//      from a price up to forty minutes stale is a guess wearing a fact's clothes. Those guesses
//      then fed the circuit breaker: close a winner by hand, watch price dip under your entry
//      before the bot woke, and it recorded a LOSS and moved you a third of the way to a
//      twelve-hour trading pause.
//   2. It used a snapshot, not a range. Price can touch the target and retrace before the bot
//      looks; the old code would call that "closed" and throw away a real win.
//   3. It blended the four things that have to stay apart. A rejected order, a late entry and a
//      wrong thesis all arrived as one number. Today alone we had two execution failures — an
//      INSUFFICIENT_BASE_BALANCE and a Cloudflare 502 — that say nothing whatever about whether
//      the signal was right, and under the old scheme they were indistinguishable from being
//      wrong about the market.
//
// So each resolution now carries four independent labels, and — the part that matters — a
// `klass` of "strategy" or "execution_artifact". Only strategy outcomes are allowed to touch the
// breaker or the shadow ledger. An artifact is recorded in full and counted in nothing.
//
// `rangeOf(coin)` gives the high/low since the position was last seen, so a target that was hit
// and given back is still a target. Callers that cannot supply a range may omit it and fall back
// to the snapshot, which is weaker but never silently pretends otherwise.
const RESOLUTION_CLASSES = ["strategy", "execution_artifact"];

function resolvedSince(prev, now, priceOf, rangeOf) {
  const out = [];
  for (const k of Object.keys(prev || {})) {
    if (now[k]) continue;                                   // still open
    const was = prev[k], px = priceOf(was.coin);
    const range = typeof rangeOf === "function" ? rangeOf(was.coin) : null;
    out.push({ ...was, ...classifyResolution(was, px, range), exit: px });
  }
  return out;
}

// PURE. Position + last price + the range it traded through = the four labels.
function classifyResolution(was, px, range) {
  const isLong = was.dir !== "short";
  const plan = was.plan;

  // No plan at all: the bot was never managing this, so it can say nothing about it.
  if (!plan) {
    return { how: "closed", outcome: "unattributed", klass: "execution_artifact",
             execution: was.unprotected ? "unprotected_no_plan" : "no_plan",
             why: "held with no plan — nothing to grade it against",
             countsForStreak: false, countsForStats: false };
  }

  const { entry, stop, target } = plan;
  const haveRange = !!(range && Number.isFinite(range.hi) && Number.isFinite(range.lo));
  // With a range we ask "did price TRADE THROUGH this level" — the honest question. Without one
  // we fall back to the old snapshot comparison, which is weaker (it cannot see a target that was
  // hit and given back) and is labelled as such rather than quietly passed off as equivalent.
  const touched = haveRange
    ? (lvl) => Number.isFinite(lvl) && lvl <= range.hi && lvl >= range.lo
    : (lvl) => Number.isFinite(lvl) && Number.isFinite(px) && (isLong ? px >= lvl : px <= lvl);
  const hitTarget = touched(target);
  // On the snapshot path a long sitting below its stop also sits below its target, so test the
  // stop the other way round or every stop-out would read as a target miss.
  const hitStop = haveRange
    ? (Number.isFinite(stop) && stop <= range.hi && stop >= range.lo)
    : (Number.isFinite(stop) && Number.isFinite(px) && (isLong ? px <= stop : px >= stop));

  // Both touched in the same window and we cannot know the order. Saying "win" or "loss" here
  // would be a coin toss recorded as evidence, which is worse than admitting we do not know.
  if (hitTarget && hitStop) {
    return { how: "ambiguous", outcome: "unattributed", klass: "execution_artifact",
             execution: "both_levels_touched",
             why: "price traded through both the stop and the target between two runs — the order cannot be recovered",
             countsForStreak: false, countsForStats: false };
  }
  if (hitTarget) {
    return { how: "target", outcome: "win", klass: "strategy",
             execution: haveRange ? "filled" : "filled_snapshot_only",
             why: haveRange ? "price traded through the target" : "price was at or beyond the target when we looked",
             countsForStreak: true, countsForStats: true };
  }
  if (hitStop) {
    return { how: "stop", outcome: "loss", klass: "strategy",
             execution: haveRange ? "filled" : "filled_snapshot_only",
             why: haveRange ? "price traded through the stop" : "price was at or beyond the stop when we looked",
             countsForStreak: true, countsForStats: true };
  }

  // Gone, but at neither of its own levels. By elimination somebody closed it by hand (or the
  // venue did). Direction is recorded for information; it counts toward nothing, because the
  // exit price the bot can see is not the price it was closed at.
  const dir = Number.isFinite(entry) && Number.isFinite(px)
    ? ((isLong ? px > entry : px < entry) ? "was in profit when we looked" : "was in loss when we looked")
    : "no entry recorded";
  return { how: "closed_by_hand", outcome: "unattributed", klass: "execution_artifact",
           execution: "closed_off_plan",
           why: `closed at neither the stop nor the target — ${dir}. Not the bot's exit, so it grades nothing.`,
           countsForStreak: false, countsForStats: false };
}

// ═══════════════ TWO BOOKS: fast and swing (2026-08-16) ═══════════════
// John: "quick turnover, long to TP, flip short on the signal, meanwhile a bigger swing trade on
// BTC." That is two different businesses sharing one account, and the bot could only run one:
// a single risk setting, one target rule, one correlation pool, one day cap.
//
// Worse, the no-hedge rule written last night would have BLOCKED exactly what he wants — a 4H
// short while a weekly BTC long runs is not a hedge, it is a different trade on a different
// horizon. The rule was right; it just could not tell the two apart.
//
// So a trade belongs to a BOOK, decided by the timeframe its signal came from. Each book gets its
// own slots and day cap, and — the important part — the no-hedge rule applies WITHIN a book, not
// across them. Then "scalp both ways while BTC runs" is simply two books doing their jobs.
const FAST_TFS = ["15m", "30m", "1H", "4H"];
function bookFor(tf) { return FAST_TFS.includes(String(tf)) ? "fast" : "swing"; }
const BOOK_CFG = {
  fast:  { corrMax: () => num("FAST_CORR_MAX", 4),  dayCap: () => num("FAST_DAY_CAP", 20) },
  swing: { corrMax: () => num("SWING_CORR_MAX", 3), dayCap: () => num("SWING_DAY_CAP", 6) },
};
// Which book opened which position? The exchange does not know, so we remember. Positions opened
// before books existed have no entry here — and those are treated as belonging to BOTH books, so
// the no-hedge protection never quietly lapses while this rolls out.
const BOOKMAP_KEY = "cipher_books";
// Positions the bot holds but cannot manage: no plan, so no stop and no target, and no book —
// which means the no-hedge rule treats them as belonging to BOTH books and they quietly block
// every new trade in that coin. Written every run so the app can show them, cleared the moment
// they are adopted or closed.
const ORPHAN_KEY = "cipher_unprotected";
const posKey = (coin, dir) => String(coin).toUpperCase() + "|" + dir;

// ═══════════════ TIME STOP — make trades RESOLVE (2026-08-16) ═══════════════
// John: "I don't believe we've hit a single TP or stop loss yet."
//
// He is right, and it is not impatience — it is a design hole. A trade has a stop and a 2.25R
// target and nothing else, so a setup that simply goes nowhere sits open forever: capital held,
// funding leaking, a correlation slot occupied, and — the part that bites hardest right now —
// it never becomes a data point. A system that cannot resolve trades cannot learn from them.
//
// A time stop says: if the setup has not done its job within N bars, the thesis has expired.
// Take the small win or loss and move on. Three things at once — a faster sample, less funding
// bleed, and slots freed for better setups.
//
// N is what is being TESTED, so this runs as a shadow experiment first: baseline holds forever,
// variants close at 20 / 40 / 60 bars. The variant that wins in R earns the job. Note the neat
// part — this experiment MANUFACTURES the resolutions that every other experiment needs.
const TIMESTOP_BARS = [20, 40, 60];
const BAR_MS = { "15m": 9e5, "30m": 18e5, "1H": 36e5, "4H": 144e5, "1D": 864e5, "1W": 6048e5 };

// How many bars has this position been open, on its own timeframe?
function barsOpen(rec, now) {
  const ms = BAR_MS[rec.tf || "1D"] || BAR_MS["1D"];
  return Math.floor((now - rec.at) / ms);
}

// What WOULD a time stop of N bars have scored on a decision we already have candles for?
// Deliberately reuses gradeOne's walk so the two arms are scored by identical rules — the only
// difference between them is when they give up.
function gradeWithTimeStop(rec, candles, maxBars) {
  const risk = Math.abs(rec.entry - rec.stop);
  if (!(risk > 0) || !candles || !candles.length) return null;
  const isLong = rec.dir !== "short";
  const start = candles.findIndex(c => c.t >= rec.at);
  if (start < 0) return null;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    if (isLong ? c.l <= rec.stop : c.h >= rec.stop) return -1;                       // stop first
    if (isLong ? c.h >= rec.target : c.l <= rec.target) return +Math.abs(rec.target - rec.entry) / risk;
    if (i - start >= maxBars) return (isLong ? c.c - rec.entry : rec.entry - c.c) / risk;  // time is up
  }
  return null;                                   // still open and still inside its window
}

// ═══════════════ MAKER ENTRY (shadow, 2026-08-19) ═══════════════
// The cost work said fees are the binding constraint — 2.2× gross profit, and the three-year
// replay flips sign if both sides pay maker. The live entry is a marketable limit crossed 1%
// through the market: a guaranteed fill, at taker. The candidate is a post-only limit AT the
// signal price: it pays maker IF price trades back through the level inside the entry-expiry
// window, and it MISSES the trades that run without a pullback — which the entry-mode note
// (2026-08-15) warned are often the best ones. Whether the fee saved pays for the trades missed
// is an empirical question, so it is measured here and decides nothing. Scored on the same
// decisions every other experiment uses. Nothing in this path places or changes an order.
const MAKER_FEE = num("MAKER_FEE", 0.0001);   // Phemex maker 0.01%
const TAKER_FEE = num("TAKER_FEE", 0.0006);   // Phemex taker 0.06%

// Pure candle walk from a given bar: −1 on stop, +R on target, marked to market at the cap.
// Stop before target inside a candle — the same pessimism as gradeOne. Mutates nothing.
function walkFromBar(rec, candles, from, fillPx) {
  const risk = Math.abs(fillPx - rec.stop);
  if (!(risk > 0)) return null;
  const isLong = rec.dir !== "short";
  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    if (isLong ? c.l <= rec.stop : c.h >= rec.stop) return -1;
    if (isLong ? c.h >= rec.target : c.l <= rec.target) return +Math.abs(rec.target - fillPx) / risk;
    if (i - from >= SHADOW_TIMEOUT_BARS * (rec.tfMult || 4))
      return (isLong ? c.c - fillPx : fillPx - c.c) / risk;   // time is up — marked to market
  }
  return null;                                  // still open — grade it on a later run
}

// Score one decision both ways, net of fees, in R. Returns null until both arms can settle.
//   taker — fills immediately at the signal price; pays taker in and (pessimistically) taker out.
//   maker — post-only at the signal price; fills only when a later candle trades back through the
//           level inside expiryH. Unfilled by expiry = the trade never happened: 0R, counted as
//           missed, because a fee saved on no position earns nothing.
// Cost in R is fee% ÷ stop% — the same arithmetic that set the 2.2% stop floor.
function gradeMakerEntry(rec, candles, expiryH) {
  const risk = Math.abs(rec.entry - rec.stop);
  if (!(risk > 0) || !candles || !candles.length) return null;
  const isLong = rec.dir !== "short";
  const start = candles.findIndex(c => c.t >= rec.at);
  if (start < 0) return null;
  const stopPct = risk / rec.entry;
  const takerGross = walkFromBar(rec, candles, start, rec.entry);
  if (takerGross === null) return null;
  const takerR = +(takerGross - (2 * TAKER_FEE) / stopPct).toFixed(3);
  const cutoff = rec.at + expiryH * 3600e3;
  let fill = -1;
  for (let i = start; i < candles.length && candles[i].t <= cutoff; i++) {
    if (isLong ? candles[i].l <= rec.entry : candles[i].h >= rec.entry) { fill = i; break; }
  }
  if (fill < 0) {
    const windowOver = candles[candles.length - 1].t > cutoff;
    return windowOver ? { takerR, makerR: 0, filled: false } : null;   // wait the window out
  }
  const makerGross = walkFromBar(rec, candles, fill, rec.entry);
  if (makerGross === null) return null;
  return { takerR, makerR: +(makerGross - (MAKER_FEE + TAKER_FEE) / stopPct).toFixed(3), filled: true };
}

// A live position the bot opened, still sitting there past its window. Closing is a REDUCE-ONLY
// market order — it can only ever shrink a position, never open one, which is the property that
// makes this safe to run automatically.
function closeOrderFor(pos) {
  const size = Math.abs(Number(pos.size) || 0);
  if (!(size > 0)) return null;
  const isLong = String(pos.posSide || pos.side || "").toLowerCase().startsWith("l");
  return {
    clOrdID: ("timestop" + String(pos.symbol || "").replace(/[^A-Z]/gi, "") + Date.now()).slice(0, 40),
    symbol: String(pos.symbol).toUpperCase(),
    side: isLong ? "Sell" : "Buy",               // the closing side
    posSide: pos.posSide || "Merged",
    ordType: "Market", orderQtyRq: String(size),
    timeInForce: "ImmediateOrCancel",
    reduceOnly: true, closeOnTrigger: true, text: "cipher-timestop",
  };
}

// ── AN EXISTING HEDGE IS A STANDING COST (2026-08-18) ─────────────────────────────────────────
// The no-hedge rule stopped the bot OPENING an opposing leg. It never did anything about one
// already sitting there: the run printed "WARNING: ... already hold BOTH sides" and carried on.
// John's exchange screenshot on 2026-08-18 showed BTCUSDT holding a Long AND a Short, quietly
// paying funding and fees on both legs to hold a net position it could have held with one.
//
// So the smaller leg gets closed. Deliberately the smaller one: the two legs offset, so removing
// the smaller leaves the same NET exposure and strictly reduces cost, margin and risk. This
// cannot open a position, cannot increase one, and cannot flip a direction — the order is
// reduceOnly. Set HEDGE_FIX=0 to go back to warning only.
function hedgeCloseOrder(pos) {
  const o = closeOrderFor(pos);
  if (o) { o.clOrdID = ("dehedge" + String(pos.symbol || "").replace(/[^A-Z]/gi, "") + Date.now()).slice(0, 40);
           o.text = "cipher-dehedge"; }
  return o;
}

async function resolveHedges(positions) {
  const out = { found: 0, closed: 0, failed: 0 };
  if (String(env("HEDGE_FIX", "1")) !== "1") return out;
  const bySym = new Map();
  for (const p of positions) {
    if (!(Math.abs(Number(p.size) || 0) > 0)) continue;
    const sym = String(p.symbol || "").toUpperCase();
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym).push(p);
  }
  for (const [sym, legs] of bySym) {
    const longs = legs.filter(p => String(p.posSide || p.side || "").toLowerCase().startsWith("l"));
    const shorts = legs.filter(p => !String(p.posSide || p.side || "").toLowerCase().startsWith("l"));
    if (!longs.length || !shorts.length) continue;                 // not a hedge
    out.found++;
    const notional = p => Math.abs(Number(p.size) || 0) * (+(p.markPriceRp || p.markPrice || 0) || 1);
    const biggestLong = longs.sort((a, b) => notional(b) - notional(a))[0];
    const biggestShort = shorts.sort((a, b) => notional(b) - notional(a))[0];
    const smaller = notional(biggestLong) <= notional(biggestShort) ? biggestLong : biggestShort;
    const order = hedgeCloseOrder(smaller);
    if (!order) { out.failed++; continue; }
    let ok = false;
    try { const r = await execOrder(order); ok = r && r.status === 200 && r.data && !r.data.error; }
    catch { ok = false; }
    if (ok) out.closed++; else out.failed++;
    const coin = sym.replace(/USDT$/, "");
    await pushLog({ coin, dir: String(smaller.posSide || "").toLowerCase(),
      result: ok ? "DE-HEDGED" : "ERR de-hedge",
      skipped: `${sym} was holding both sides. Closed the smaller leg (${smaller.posSide}, ${Math.abs(Number(smaller.size))}) — same net exposure, one set of fees and funding instead of two.` });
  }
  return out;
}

// ═══════════════ CIRCUIT BREAKER (2026-08-19) ═══════════════
// The one real gap every outside review agreed on: the bot had a manual KILL switch and
// trade-COUNT caps, but nothing watched the MONEY. A bug, a regime the rules don't understand,
// or plain variance can bleed an account one correctly-sized loss at a time, and every loss
// individually looks fine. Three trips, all deterministic, none of them clever:
//
//   · the account drops DAY_DD_PCT from where the day started   → no new entries until tomorrow
//   · it drops WEEK_DD_PCT from where the week started          → no new entries until next week
//   · STREAK_N consecutive losing resolutions                   → pause STREAK_PAUSE_H hours;
//     the market is doing something the rules don't understand — stop asking it the same question
//
// A tripped breaker blocks NEW entries only. Exits, stops, entry-expiry cancels and de-hedging
// all keep running — everything that reduces risk stays on; only the thing that adds risk stops.
// It never auto-reverses, never resizes, never touches an open position. Deliberately dumb.
const BREAKER_KEY = "cipher_breaker";
const DAY_MS = 864e5, WEEK_MS = 7 * 864e5;
const dayKeyOf = (now) => new Date(now).toISOString().slice(0, 10);
const weekKeyOf = (now) => Math.floor((now + 3 * DAY_MS) / WEEK_MS);   // epoch was a Thursday; +3d puts the boundary on Monday 00:00 UTC
const nextDayStart = (now) => (Math.floor(now / DAY_MS) + 1) * DAY_MS;
const nextWeekStart = (now) => (weekKeyOf(now) + 1) * WEEK_MS - 3 * DAY_MS;

// Pure, so every trip condition is testable without a venue or a clock.
//   st       — persisted state { dayKey, dayEq, weekKey, weekEq, streak, pausedUntil, pausedWhy }
//   now      — ms
//   equity   — current account balance, or null when the venue didn't show one (never trips blind)
//   resolvedHows — "how" strings from this run's resolutions, for the streak
function breakerStep(st, { now, equity, resolvedHows = [] }, cfg) {
  st = st || {};
  const c = cfg || {
    dayDD: num("BREAKER_DAY_DD_PCT", 5) / 100,
    weekDD: num("BREAKER_WEEK_DD_PCT", 10) / 100,
    streakN: num("BREAKER_STREAK_N", 3),
    streakPauseH: num("BREAKER_STREAK_PAUSE_H", 12),
  };
  const trips = [];
  // anchors roll with the calendar — a new day/week starts a fresh measurement from HERE
  const dk = dayKeyOf(now), wk = weekKeyOf(now);
  if (st.dayKey !== dk) { st.dayKey = dk; st.dayEq = equity ?? st.dayEq ?? null; }
  else if (st.dayEq == null && equity != null) st.dayEq = equity;
  if (st.weekKey !== wk) { st.weekKey = wk; st.weekEq = equity ?? st.weekEq ?? null; }
  else if (st.weekEq == null && equity != null) st.weekEq = equity;
  // an expired pause clears itself
  if (st.pausedUntil && now >= st.pausedUntil) { st.pausedUntil = 0; st.pausedWhy = ""; }
  // consecutive losses — a win resets, a loss counts, "closed"/unknown changes nothing
  for (const how of resolvedHows) {
    if (how === "stop" || how === "closed at a loss") st.streak = (st.streak || 0) + 1;
    else if (how === "target" || how === "closed in profit") st.streak = 0;
    if ((st.streak || 0) >= c.streakN && !(st.pausedUntil > now)) {
      st.pausedUntil = now + c.streakPauseH * 3600e3;
      st.pausedWhy = `${c.streakN} consecutive losing trades — pausing new entries ${c.streakPauseH}h to stop re-asking a market that keeps saying no`;
      st.streak = 0;
      trips.push("streak");
    }
  }
  // drawdown — only when the venue actually showed us a balance
  if (equity != null) {
    if (st.dayEq > 0 && (st.dayEq - equity) / st.dayEq >= c.dayDD && !(st.pausedUntil > now)) {
      st.pausedUntil = nextDayStart(now);
      st.pausedWhy = `down ${(((st.dayEq - equity) / st.dayEq) * 100).toFixed(1)}% today (${equity.toFixed(2)} from ${st.dayEq.toFixed(2)}) — no new entries until tomorrow`;
      trips.push("dayDD");
    }
    if (st.weekEq > 0 && (st.weekEq - equity) / st.weekEq >= c.weekDD && !(trips.length && st.pausedUntil >= nextWeekStart(now))) {
      st.pausedUntil = Math.max(st.pausedUntil || 0, nextWeekStart(now));
      st.pausedWhy = `down ${(((st.weekEq - equity) / st.weekEq) * 100).toFixed(1)}% this week — no new entries until Monday`;
      trips.push("weekDD");
    }
  }
  return { st, trips, paused: (st.pausedUntil || 0) > now };
}

// ═══════════════ THE SHADOW FRAMEWORK (2026-08-16) ═══════════════
// John's brief: "build something different… nothing gets control until it has earned it."
//
// The shadow gate already worked once — the brain's verdicts ran advisory, were graded against
// real outcomes, and only took control when they beat the numeric path. That mechanism is the
// most valuable thing in this system, and it was being used for exactly one purpose.
//
// So it becomes the architecture. Every new component — a different way of choosing trades, a
// sizing multiplier, a veto — registers as an EXPERIMENT. Each run it records what it WOULD have
// done, alongside what actually happened. Those decisions are graded on real forward candles.
// When the variant beats the baseline over enough resolved trades, it promotes itself. If its
// record later slips, it hands control back.
//
// Two consequences worth being explicit about:
//   · we can build aggressively, because nothing new can touch a real order until it has won
//   · the system improves without John deciding it has improved — the evidence decides
//
// Nothing here places an order. A shadow record is a DECISION, never an instruction.
// ═══════════════════ UNFILLED ORDERS MUST NOT LIVE FOREVER (2026-08-18) ═══════════════════
// `ENTRY_EXPIRY_H` has sat in CFG since the entry-mode work and was never read once, so every
// unfilled limit was GoodTillCancel in the most literal sense: it rested until something touched
// it, however long that took and however dead the idea had become. In a three-year replay of
// these rules, 74 orders filled AFTER price had already traded through their own stop level —
// opening a position the exchange then closed on the spot. The signal was hours or days old and
// the stop and target had been computed from a bar that no longer meant anything.
//
// So: remember what was placed, and cancel anything still resting past the expiry. An order that
// has already filled is simply forgotten — that position is real and its stop is on the exchange.
const RESTING_KEY = "cipher_resting";
const RESTING_FORGET_MS = 7 * 864e5;          // a record we could never resolve is dropped after a week

// Pure, so it can be tested without a venue: which remembered orders are past their expiry.
function staleIds(book, now, hours) {
  const cutoff = now - hours * 3600e3;
  return Object.keys(book || {}).filter(id => book[id] && book[id].at <= cutoff);
}

async function rememberResting(meta, order, coin, dir, orderID) {
  if (!meta || !order || !order.clOrdID) return;
  const book = await getJSON(RESTING_KEY, {});
  book[order.clOrdID] = { symbol: meta.symbol, clOrdID: order.clOrdID, orderID: orderID || "",
                          coin, dir, at: Date.now() };
  await setJSON(RESTING_KEY, book);
}

async function cancelOrder(symbol, orderID, clOrdID) {
  if (!CFG.direct()) return false;              // the relay has no cancel route; say so rather than pretend
  try {
    const q = `symbol=${encodeURIComponent(symbol)}&` +
              (orderID ? `orderID=${encodeURIComponent(orderID)}` : `clOrdID=${encodeURIComponent(clOrdID)}`);
    const r = await phemexCall("DELETE", "/g-orders/cancel", q, null);
    return r.status === 200 && r.data && !r.data.error;
  } catch { return false; }
}

async function expireStaleOrders() {
  const hours = CFG.entryExpiryH();
  const out = { checked: 0, cancelled: 0, cleared: 0, blind: 0 };
  if (!(hours > 0)) return out;
  const book = await getJSON(RESTING_KEY, {});
  const stale = staleIds(book, Date.now(), hours);

  const bySym = new Map();
  for (const id of stale) {
    const r = book[id];
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push({ id, ...r });
  }
  for (const [symbol, recs] of bySym) {
    out.checked += recs.length;
    let live = null;
    try { live = await execOrdersFor(symbol); } catch { live = null; }
    // If we cannot see the book we do NOT guess. Cancelling blind and forgetting blind are both
    // ways of losing track of a real order — the same reasoning as the no-hedge rule's refusal.
    if (!Array.isArray(live)) { out.blind += recs.length; continue; }
    for (const r of recs) {
      const still = live.find(o => o && (o.clOrdID === r.clOrdID || (r.orderID && o.orderID === r.orderID)));
      if (!still) { delete book[r.id]; out.cleared++; continue; }          // filled, or already gone
      const ok = await cancelOrder(symbol, still.orderID, r.clOrdID);
      if (ok) {
        delete book[r.id]; out.cancelled++;
        await pushLog({ coin: r.coin, dir: r.dir, result: "EXPIRED",
          skipped: `unfilled after ${hours}h — cancelled. The plan behind it is stale; a fresh signal can place a fresh order.` });
      }
    }
  }
  const now = Date.now();
  for (const id of Object.keys(book)) if (book[id].at < now - RESTING_FORGET_MS) delete book[id];
  await setJSON(RESTING_KEY, book);
  return out;
}

// ═══════════════════ RELATIVE STRENGTH (measurement only) ═══════════════════
// The scanner scores every coin in isolation. It has never known whether the coin it is about to
// buy is the strongest or the weakest thing on the board. Tested against the three-year replay on
// 2026-08-18, that one number sorted the trades into a clean ladder:
//
//     trading the laggard against the field   −£1.47/trade   (gross −£0.96)
//     ...                                       ...
//     trading the leader with the field        +£0.98/trade   (gross +£1.53)
//
// A £2.49 swing in GROSS — the signal, not the costs — monotonic across four pre-specified
// buckets, holding its sign in both halves of the sample, and NOT a restatement of distance from
// the 200 EMA (within coins below their 200 EMA, leaders paid +£1.88 and laggards lost £1.42).
//
// It is still a backtest finding, so it decides nothing. Every recorded decision is stamped with
// the coin's rank and the boxes are reported each run, exactly like the regime experiment.
const RS_LOOKBACK_D = 7;                 // one week of return, the horizon the ladder was found on
const RS_MIN_FIELD = 12;                 // fewer coins than this and a rank means very little

let _rsCache = null;

// Rank every coin in the whitelist by its 7-day return. Uses the same daily candles the scan
// already fetches for its own timeframes, one extra call per coin at most, cached for the run.
async function relativeStrength(symbols) {
  if (_rsCache) return _rsCache;
  const rows = [];
  for (const sym of symbols) {
    let c = null;
    try { c = await fetchCandles(sym, "1D", 30); } catch { }
    if (!c || c.length < RS_LOOKBACK_D + 1) continue;
    const now = c[c.length - 1].c, then = c[c.length - 1 - RS_LOOKBACK_D].c;
    if (!(now > 0 && then > 0)) continue;
    rows.push({ coin: sym, ret: now / then - 1 });
  }
  if (rows.length < RS_MIN_FIELD) { _rsCache = { ok: false, n: rows.length, rank: () => null }; return _rsCache; }
  rows.sort((a, b) => b.ret - a.ret);
  const pos = new Map(rows.map((r, i) => [r.coin, i / (rows.length - 1)]));   // 0 = strongest
  _rsCache = {
    ok: true, n: rows.length,
    leader: rows[0].coin, laggard: rows[rows.length - 1].coin,
    // signed with the trade: 1 = you are trading the leader in your direction, 0 = the laggard
    rank: (coin, dir) => {
      const r = pos.get(coin);
      if (r == null) return null;
      return +(dir === "long" ? 1 - r : r).toFixed(3);
    },
  };
  return _rsCache;
}

// Same shape as the regime boxes, and the same rule: a bucket is only believed once it has a real
// sample AND agrees with itself across both halves of its own history.
const RS_BANDS = [["a. fighting the field", 0.25], ["b. below middle", 0.5], ["c. above middle", 0.75], ["d. with the leader", 1.01]];
function rsBand(v) { if (v == null) return null; for (const [name, hi] of RS_BANDS) if (v < hi) return name; return null; }

function rsBoxes(records) {
  const box = {};
  for (const [name] of RS_BANDS) box[name] = [];
  for (const r of records) {
    if (r.arm !== "baseline" || r.R === null) continue;
    const b = rsBand(r.rs);
    if (b && box[b]) box[b].push(r);
  }
  const out = {};
  for (const [k, rs] of Object.entries(box)) {
    const sorted = [...rs].sort((a, b) => a.at - b.at);
    const half = Math.floor(sorted.length / 2);
    const meanOf = a => a.length ? +(a.reduce((x, r) => x + r.R, 0) / a.length).toFixed(3) : null;
    out[k] = { n: sorted.length, meanR: meanOf(sorted), firstHalf: meanOf(sorted.slice(0, half)), secondHalf: meanOf(sorted.slice(half)) };
  }
  return out;
}

function rsVerdict(records) {
  const boxes = rsBoxes(records);
  const trustworthy = [];
  for (const [k, b] of Object.entries(boxes)) {
    if (b.n < REGIME_MIN_PER_BOX * 2) continue;
    if (b.firstHalf === null || b.secondHalf === null) continue;
    if ((b.firstHalf > 0) === (b.secondHalf > 0)) trustworthy.push({ box: k, ...b, sign: b.meanR > 0 ? "pays" : "costs" });
  }
  return { boxes, trustworthy, ready: trustworthy.length > 0 };
}

// ═══════════════════════ MARKET REGIME (measurement only) ═══════════════════════
// John's idea: "if you short in a bull market you'll get more losses, and vice versa — so define
// bull vs bear and let the bot adjust."  Sound instinct, and testable. When it WAS tested against
// three years of replay (2026-08-17) the four boxes looked decisive on the full sample and then
// reversed: buying while BTC sat under its 200D average paid £8.14 a trade in the first half of
// the data and lost money in the second, and the whole effect turned negative in 2026. A filter
// built on that would have looked magnificent on every chart of the past and cost money from the
// day it went in.
//
// So this does NOT filter anything. It tags every decision with the regime it was taken in and
// waits for a forward sample. The promotion rule below is deliberately stricter than the other
// experiments': a box has to win in BOTH halves of its own history before it may be believed,
// because "wins on the full sample" is precisely the test the idea already passed and failed.
//
// NOTHING HERE PLACES, BLOCKS OR RESIZES AN ORDER.
const REGIME_KEY = "cipher_regime";
const REGIME_MA = 200;              // the standard long-term line; not tuned, deliberately
const REGIME_MIN_PER_BOX = 30;      // resolved trades needed in a box before it means anything

let _regimeCache = null;            // one BTC daily fetch per run, reused by every coin

function smaAt(candles, n) {
  if (!candles || candles.length < n) return null;
  let s = 0;
  for (let i = candles.length - n; i < candles.length; i++) s += candles[i].c;
  return s / n;
}

// Bull or bear, from BTC against its own 200-day average. One number, no parameters to fit, and
// the same definition every trader in the market can see — which is the point: a regime line only
// anyone can compute is a regime line nobody else is reacting to.
async function regimeSnapshot() {
  if (_regimeCache) return _regimeCache;
  let label = null, distPct = null;
  try {
    const d = await fetchCandles("BTC", "1D", 260);
    const ma = smaAt(d, REGIME_MA);
    if (ma && d.length) {
      const px = d[d.length - 1].c;
      label = px > ma ? "bull" : "bear";
      distPct = +(((px - ma) / ma) * 100).toFixed(1);
    }
  } catch { /* no regime this run — records simply carry null and are excluded from the boxes */ }
  _regimeCache = { label, distPct, breadth: null };
  return _regimeCache;
}

// Breadth costs nothing: the scan already pulled every coin's daily candles, so count how many
// closed above their own 200D line while we were there. A second opinion on the same question.
function regimeBreadthTally(reg, dailyBars) {
  if (!reg || !dailyBars) return;
  const ma = smaAt(dailyBars, REGIME_MA);
  if (!ma) return;
  reg._bUp = (reg._bUp || 0) + (dailyBars[dailyBars.length - 1].c > ma ? 1 : 0);
  reg._bN = (reg._bN || 0) + 1;
  reg.breadth = +(reg._bUp / reg._bN).toFixed(2);
}

// ── the 2x2, and the stability test that decides whether to believe it ────────────────────────
function regimeBoxes(records) {
  const box = {};
  for (const key of ["long|bull", "long|bear", "short|bull", "short|bear"]) box[key] = [];
  for (const r of records) {
    if (r.arm !== "baseline" || r.R === null || !r.reg) continue;
    const k = (r.dir === "short" ? "short" : "long") + "|" + r.reg;
    if (box[k]) box[k].push(r);
  }
  const out = {};
  for (const [k, rs] of Object.entries(box)) {
    const sorted = [...rs].sort((a, b) => a.at - b.at);
    const half = Math.floor(sorted.length / 2);
    const meanOf = (a) => a.length ? +(a.reduce((x, r) => x + r.R, 0) / a.length).toFixed(3) : null;
    out[k] = {
      n: sorted.length,
      meanR: meanOf(sorted),
      firstHalf: meanOf(sorted.slice(0, half)),
      secondHalf: meanOf(sorted.slice(half)),
    };
  }
  return out;
}

// A box is only "trustworthy" if it has a real sample AND both halves of that sample agree on the
// sign. This is the whole lesson of 2026-08-17 written down as a gate: full-sample means lie.
function regimeVerdict(records) {
  const boxes = regimeBoxes(records);
  const trustworthy = [];
  for (const [k, b] of Object.entries(boxes)) {
    if (b.n < REGIME_MIN_PER_BOX * 2) continue;                 // need enough to split in half
    if (b.firstHalf === null || b.secondHalf === null) continue;
    const agree = (b.firstHalf > 0) === (b.secondHalf > 0);
    if (agree) trustworthy.push({ box: k, ...b, sign: b.meanR > 0 ? "pays" : "costs" });
  }
  return { boxes, trustworthy, ready: trustworthy.length > 0 };
}

// ═══════════════ THE ACCUMULATOR (2026-08-19) ═══════════════
// A SECOND, SEPARATE OBJECTIVE. Everything else in this file is trying to make £. This is trying
// to end the year holding more BTC than it started with — units, not money. John's spec:
//
//   "sell on the daily red dot, then stagger buys back in as soon as price drops below the sell
//    entry. We don't have to find tops and bottoms, just trade within ranges."
//
// Backtested first on 14.5 years of real BTC before a line of this was written. What that said:
//   · the revisit tendency is REAL — a −1% level comes back 83% of the time within 5 days, −2%
//     comes back 68%. Measured on BTC and TSLA; the numbers are nearly identical.
//   · the VuManChu dot barely improves those odds (1–5 points on BTC, nothing on TSLA). The
//     ladder works because of the market's revisit tendency, not because of the signal.
//   · the arithmetic is brutal and exact: at a −2% rung you win ~1.8% of the slice 83% of the
//     time and lose a MEDIAN 20% the other 17%. That is −1.9% per cycle in units.
//   · so it GAINS units in ranges and falls, and LOSES them in sustained rallies. Full history
//     −27.8%; since Jan 2024 +14.9%. Costs are irrelevant either way (zero fees moved TSLA by
//     0.12 of a percentage point — stranding is 15× the total gains).
//
// Which is why this ships MEASURE-ONLY. It holds a virtual 1.0 BTC, records exactly what it would
// have done, and reports units against the one baseline that cannot be argued with: buy-and-hold
// is 1.0000 forever. If the live record beats that over a real sample it can be argued about then.
// ACCUM=off disables it entirely. Nothing in this block can place, size, or cancel an order.
const ACCUM_KEY = "cipher_accum";
const ACCUM_COIN = () => env("ACCUM_COIN", "BTC");

// The ladder, at real levels below the sell price — swing lows first (they paid best in the
// replay: 27 fills / +0.080 BTC, ahead of FVGs and order blocks), then unfilled bullish zones.
function accumLevels(daily, sellPx, maxRungs = 4, maxAwayPct = 0.12, minGapPct = 0.002) {
  const cand = [];
  const { lows } = pricePivots(daily);
  for (const i of lows.slice(-12)) if (daily[i].l < sellPx) cand.push({ px: daily[i].l, src: "swingLow" });
  for (const z of findOrderBlocks(daily)) if (z.kind === "bullish" && z.top < sellPx) cand.push({ px: z.top, src: "OB" });
  for (const z of findFVGs(daily)) if (z.kind === "bullish" && z.top < sellPx) cand.push({ px: z.top, src: "FVG" });
  const out = [];
  for (const z of cand.filter(z => z.px > 0 && (sellPx - z.px) / sellPx <= maxAwayPct).sort((a, b) => b.px - a.px)) {
    if (out.length >= maxRungs) break;
    if (out.some(o => Math.abs(o.px - z.px) / sellPx < minGapPct)) continue;
    out.push(z);
  }
  return out;
}

// ── FILLS RUN ON EVERY PASS, NOT ONCE A DAY (2026-08-19) ─────────────────────────────────────
// The decision to SELL belongs to the closed daily bar — that is where the red dot lives. But a
// buy-back rung is a resting order, and a resting order does not wait politely for 00:00 UTC. If
// price wicks down through a level at 03:00 and bounces, that rung filled, and a once-a-day check
// would either miss it or book it at the wrong moment. John: "it needs to work 24/7 to capture
// all the moves." So fills are checked on every 15-minute run, against every intraday bar that
// has closed since the last check — no bar is skipped and none is counted twice.
// PURE: bars in, state + events out. No I/O, no clock.
function accumFillPass(state, intraday, cfg = {}) {
  const { feeBps = 10 } = cfg;
  const st = { units: 1, cash: 0, open: [], sells: 0, fills: 0, lastFillT: 0, ...(state || {}) };
  const events = [];
  if (!intraday || !intraday.length || !st.open.length) return { st, events };
  const fresh = intraday.filter(b => b.t > (st.lastFillT || 0)).sort((a, b) => a.t - b.t);
  for (const b of fresh) {
    for (let k = st.open.length - 1; k >= 0; k--) {
      const r = st.open[k];
      if (b.l <= r.px) {
        const got = (r.usdt / r.px) * (1 - feeBps / 1e4);
        st.units += got; st.cash -= r.usdt; st.fills++;
        st.open.splice(k, 1);
        events.push({ kind: "fill", px: r.px, src: r.src, at: b.t, units: +got.toFixed(8),
                      delta: +(got - r.soldUnits).toFixed(8) });
      }
    }
    st.lastFillT = b.t;
  }
  return { st, events };
}

// PURE: one closed daily bar in, new state + a list of what happened out. No I/O, no clock, so
// every rule here is testable without a venue — the same discipline as breakerStep.
function accumStep(state, daily, cfg = {}) {
  const {
    slicePct = 0.20, feeBps = 10, maxConcurrent = 4, maxCashPct = 0.5, maxRungs = 4,
    // ── THE CORE (2026-08-19) ───────────────────────────────────────────────────────────────
    // The measured failure mode of this idea is not bad trades — every completed cycle GAINED
    // units. It is STRANDING: a slice sold that never gets bought back, whose cash is then worth
    // ever fewer coins. Over 14.5 years that cost 0.39 BTC against 0.11 BTC of total wins.
    //
    // A core changes the SHAPE of that loss. A fixed fraction of the stack is simply not for
    // sale, so no sequence of signals, however wrong, can convert the position to cash. It turns
    // an unbounded loss into a bounded one — the only honest way to let a strategy with a fat
    // left tail run long enough to prove itself.
    //
    // The core also RATCHETS: when total units make a new high the core rises with them, so
    // accumulated coins are progressively locked away rather than re-risked forever.
    //
    // ── SET TO 0 ON JOHN'S INSTRUCTION, 2026-08-19 ──────────────────────────────────────────
    // "let's not save any of the acquired BTC, put that back in, risk it all every time."
    // Chosen deliberately with the measured trade-off in front of him: on the 14.5-year replay
    // no core gives 2025-26 +14.48% (vs +5.73% at a 60% core) but full-history −27.81% (vs
    // −11.13%), and the stranding loss more than doubles, 0.156 → 0.389 of the stack. The core
    // is a linear exposure dial, so this is the full dose in both directions — at a deliberately
    // small stake, to prove the machinery before any bigger portfolio.
    // Raise ACCUM_CORE_PCT above 0 to put the floor back at any time.
    corePct = num("ACCUM_CORE_PCT", 0),
    // cfg wins over env so the pure core stays testable without touching the environment
    // ── THRESHOLD LOWERED 3% → 1%, 2026-08-19 ──────────────────────────────────────────────
    // John: "why are we waiting for a 3% move, it should just be buying and selling all the time
    // to begin with." He is right for the stage this is at. Measured frequency on 2025-26 BTC
    // with the money-flow gate on: +3% fires ~15 times a YEAR, roughly one trade a month — far
    // too slow to prove the machinery or to gather a sample worth reading. +1% fires ~48 times a
    // year, about weekly.
    //
    // Stated plainly, this trades edge for evidence: the stretch measurement showed the pull-back
    // hit rate RISES with the size of the pump (81.6% baseline → 85.4% after +3%), so a 1%
    // trigger is a weaker signal than a 3% one. At a $500 stake that is the right way round —
    // the job now is to prove orders place, fill and buy back, not to harvest a thin edge.
    // Raise ACCUM_TRIGGER back to pump3 once the plumbing is proven.
    trigger = env("ACCUM_TRIGGER", "pump1"),
    pumpPct = null,
    mfGate = String(env("ACCUM_MF_GATE", "1")) === "1",
    minOrderUsdt = num("ACCUM_MIN_ORDER_USDT", 10),
    // ── STOOD DOWN (2026-08-19) ─────────────────────────────────────────────────────────────
    // Set when a dot-flip timeframe has been promoted to the real balance. The ladder places no
    // NEW sells while that is true, but its existing rungs keep being filled — abandoning a
    // resting rung would strand its cash, which is the exact failure this whole strategy is
    // built to avoid. It stops starting things; it does not stop finishing them.
    paused = false,
    pausedWhy = "",
  } = cfg;
  const st = {
    units: 1, cash: 0, open: [], sells: 0, fills: 0, lastDay: null, startedAt: null, lastFillT: 0,
    startUnits: 1, coreUnits: null, highWater: null,
    ...(state || {}),
  };
  const events = [];
  if (!daily || daily.length < 60) return { st, events };
  const bar = daily[daily.length - 1];
  const day = new Date(bar.t).toISOString().slice(0, 10);
  if (st.lastDay === day) return { st, events };            // one SELL decision per closed daily bar
  st.lastDay = day;
  if (!st.startedAt) { st.startedAt = day; st.startPx = bar.c; st.startUnits = st.units; }

  // The core, and its ratchet. Total units counts cash at the current price, so a slice that is
  // temporarily in cash cannot fake a new high while it waits to be bought back.
  const totalNow = st.units + (st.cash || 0) / bar.c;
  st.highWater = Math.max(st.highWater || st.startUnits || 1, totalNow);
  st.coreUnits = Math.max(st.coreUnits || 0, (st.startUnits || 1) * corePct, st.highWater * corePct);

  // 1) a safety net only: accumFillPass does the real work every 15 minutes, but if the intraday
  //    fetch failed for a while the daily low still tells us a rung must have filled.
  for (let k = st.open.length - 1; k >= 0; k--) {
    const r = st.open[k];
    if (bar.l <= r.px) {
      const got = (r.usdt / r.px) * (1 - feeBps / 1e4);
      st.units += got; st.cash -= r.usdt; st.fills++;
      st.open.splice(k, 1);
      events.push({ kind: "fill", px: r.px, src: r.src, units: +got.toFixed(8),
                    delta: +(got - r.soldUnits).toFixed(8), viaDaily: true });
    }
  }

  // 1b) …and if a dot-flip timeframe owns the coins, that is as far as the ladder goes today.
  if (paused) {
    events.push({ kind: "skip", why: pausedWhy || "the dot flip holds the coins" });
    return { st, events };
  }

  // 2) THE SELL TRIGGER (2026-08-19) ─────────────────────────────────────────────────────────
  // John: "if BTC jumps 3% or more in a candle, what chance it comes down? Probably quite high."
  // Measured on 14.5 years, and he is right about the hit rate — it rises monotonically with the
  // size of the pump: any day 81.6% comes back 2%, after a +2% day 84.3%, +3% 85.4%, +5% 87.6%.
  //
  // Tested end to end it also BEATS the red dot in the regimes where this strategy works at all
  // (2025-26: +11.6% vs +5.7%; 2022: +12.2% vs +5.7%). Worth knowing why they differ: a red dot
  // fires AFTER momentum has rolled over, while "just pumped" IS momentum surging — they are
  // alternatives, not a stack, and stacking them produced one sell in fourteen years.
  //
  // Neither escapes the regime problem: both lose in sustained rallies. This is a better trigger,
  // not a solved strategy.
  const trig = trigger;
  const { wt1, wt2 } = waveTrend(daily);
  const mf = vmcMoneyFlow(daily);
  const n = daily.length - 1;
  let fired = false, how = "";
  if (trig === "reddot") {
    const d0 = wt1[n] - wt2[n], dPrev = wt1[n - 1] - wt2[n - 1];
    fired = Number.isFinite(wt2[n]) && Number.isFinite(wt2[n - 1]) && dPrev >= 0 && d0 < 0;
    how = "VuManChu red dot";
  } else {
    // "pumpN" means an N-percent day: pump3 = 3%, pump1 = 1%, pump0.5 = 0.5%. Parsed rather than
    // enumerated so the threshold can be dialled without another code change.
    const m = /^pump([\d.]+)$/.exec(String(trig));
    const pct = pumpPct != null ? pumpPct
              : m ? Number(m[1]) / 100
              : num("ACCUM_PUMP_PCT", 0.01);
    const move = daily[n].c / daily[n - 1].c - 1;
    fired = move >= pct;
    how = `day closed +${(move * 100).toFixed(1)}% (trigger ${(pct * 100).toFixed(0)}%)`;
  }
  if (!fired) return { st, events };
  if (mfGate && !(Number.isFinite(mf[n]) && mf[n] < 0)) {
    events.push({ kind: "skip", why: `${how}, but money flow is not negative` });
    return { st, events };
  }
  st.lastTrigger = how;

  const ladders = new Set(st.open.map(r => r.sinceDay)).size;
  if (ladders >= maxConcurrent) { events.push({ kind: "skip", why: `${ladders} ladders already resting` }); return { st, events }; }
  const portfolio = st.units * bar.c + st.cash;
  if (portfolio > 0 && (st.cash + st.units * slicePct * bar.c) / portfolio > maxCashPct) {
    events.push({ kind: "skip", why: "cash ceiling — too much of the stack would be waiting for a dip" }); return { st, events };
  }
  // Only inventory ABOVE the core may be traded. Whatever the signals say, the core is not for sale.
  const tradeable = Math.max(0, st.units - st.coreUnits);
  const sellUnits = tradeable * slicePct;
  if (!(sellUnits > 0)) {
    events.push({ kind: "skip", why: `core floor — ${st.coreUnits.toFixed(5)} of ${st.units.toFixed(5)} units is core and not for sale` });
    return { st, events };
  }

  // ── FIT THE LADDER TO THE VENUE'S MINIMUM (2026-08-19) ─────────────────────────────────────
  // A ladder is only a ladder if every rung is a placeable order. Phemex rejects spot orders under
  // a minimum notional (typically ~10 USDT), and at John's funded size a 4-rung ladder came to
  // $9.99 a rung — every one would have bounced. So the rung COUNT adapts to the money available
  // rather than being a fixed 4, and if even a single rung cannot clear the minimum the trade is
  // refused with a plain reason instead of being sent to be rejected.
  const sliceValue = sellUnits * bar.c;
  const minOrder = minOrderUsdt;
  const affordable = Math.floor(sliceValue / minOrder);
  if (affordable < 1) {
    events.push({ kind: "skip", why: `slice is only ${sliceValue.toFixed(2)} USDT — below the ${minOrder} USDT minimum order, so there is nothing placeable` });
    return { st, events };
  }
  const rungBudget = Math.min(maxRungs, affordable);
  const levels = accumLevels(daily, bar.c, rungBudget);
  if (!levels.length) { events.push({ kind: "skip", why: "no level below to buy back at" }); return { st, events }; }

  const proceeds = sellUnits * bar.c * (1 - feeBps / 1e4);
  st.units -= sellUnits; st.cash += proceeds; st.sells++;
  const per = proceeds / levels.length, perUnits = sellUnits / levels.length;
  for (const z of levels) st.open.push({ px: z.px, src: z.src, usdt: per, soldUnits: perUnits, sellPx: bar.c, sinceDay: day });
  events.push({ kind: "sell", px: bar.c, units: +sellUnits.toFixed(8), how: st.lastTrigger || "",
                rungs: levels.map(z => `${z.src}@${formatPrice(z.px)}`) });
  return { st, events };
}

// ═══════════════ THE DOT FLIP (2026-08-19) ═══════════════
// John: "5 min green sell, 5 min red buy — just run it and see."
//
// Run on real 1-minute BTC before writing it, because the answer was decisive:
//
//   timeframe   round trips   fees paid   end units   vs hold
//   5m               16,730      3,346%     0.00000   -100.00%   <- zeroes the account
//   15m               5,592      1,118%     0.00001   -100.00%
//   1H                1,394        279%     0.08486    -91.51%
//
// And the part that matters — the SAME strategy with fees removed:
//
//   5m  +10.90%   ·   15m +2.86%   ·   1H +38.22%
//
// So the dots carry genuine signal at every timeframe. What destroys it is paying 0.2% a
// round trip sixteen thousand times. At MAKER fees (1bp a side) the 1H version survives at
// +4.58% — 1,394 trips paying 28% instead of 279%.
//
// Hence: this runs on 1H, not 5m, and it is MEASURE-ONLY until its fills are proven, because
// +4.58% assumes every post-only order fills at its price, and a post-only order that never
// fills is a slice left in cash — the exact failure mode that costs this whole idea its units.
// It places nothing. It exists so John can watch a busy version accumulate evidence beside the
// live one, and arm it on a record rather than on a hope.
const FLIP_TF = () => env("FLIP_TF", "1H");
// Every timeframe John asked to be able to switch between. 3H is assembled from 1H bars because
// no exchange serves it natively.
const FLIP_TFS = ["5m", "15m", "30m", "1H", "2H", "3H", "4H", "1D"];

function aggregateBars(bars, factor) {
  const out = [];
  for (let i = 0; i + factor <= bars.length; i += factor) {
    const slice = bars.slice(i, i + factor);
    out.push({ t: slice[0].t, o: slice[0].o, c: slice[slice.length - 1].c,
               h: Math.max(...slice.map(b => b.h)), l: Math.min(...slice.map(b => b.l)),
               v: slice.reduce((a, b) => a + (b.v || 0), 0) });
  }
  return out;
}

// PURE: bars in, state + events out. Sells the whole tradeable amount on a red dot, buys it all
// back on a green one. No ladder, no levels — a straight flip, which is what was asked for.
function accumFlipStep(state, bars, cfg = {}) {
  const { feeBps = num("FLIP_FEE_BPS", 1), slicePct = num("FLIP_SLICE", 1) } = cfg;
  const st = { units: 1, cash: 0, trips: 0, sells: 0, lastT: 0, startUnits: 1, ...(state || {}) };
  const events = [];
  if (!bars || bars.length < 60) return { st, events };
  const { wt1, wt2 } = waveTrend(bars);
  const fresh = [];
  for (let i = 1; i < bars.length; i++) if (bars[i].t > (st.lastT || 0)) fresh.push(i);
  for (const i of fresh) {
    if (!Number.isFinite(wt2[i]) || !Number.isFinite(wt2[i - 1])) continue;
    const d0 = wt1[i] - wt2[i], dPrev = wt1[i - 1] - wt2[i - 1];
    const red = dPrev >= 0 && d0 < 0, green = dPrev <= 0 && d0 > 0;
    const px = bars[i].c;
    if (red && st.units > 0) {
      const sell = st.units * slicePct;
      const proceeds = sell * px * (1 - feeBps / 1e4);
      st.cash += proceeds; st.units -= sell; st.sells++;
      // `cash` rides along because the live arm sizes a real order from it: a spot BUY is sized
      // in the money, not the coin, so the proceeds of the sell are what the buy-back spends.
      events.push({ kind: "flip-sell", at: bars[i].t, px, units: sell, cash: proceeds });
    } else if (green && st.cash > 0) {
      const spent = st.cash;
      const got = (spent / px) * (1 - feeBps / 1e4);
      st.units += got; st.cash = 0; st.trips++;
      events.push({ kind: "flip-buy", at: bars[i].t, px, units: got, cash: spent });
    }
    st.lastT = bars[i].t;
  }
  return { st, events };
}

// ═══════════ THE LIVE FLIP ARM (2026-08-19) ═══════════
// John, having seen the eight paper arms: "I want toggles to switch to those timeframes."
//
// So one arm — and only ever one — may be promoted from paper to the real spot balance. This is
// the promotion, and everything difficult about it is in the seams rather than the strategy:
//
//  1. NO REPLAY. accumFlipStep acts on every bar newer than `lastT`. A freshly armed timeframe
//     has no lastT, and the bar fetch is 500 deep — so an unguarded arm would replay two months
//     of dots as live orders inside one run. Arming therefore plants the cursor on the newest
//     closed bar and places NOTHING; the first real order waits for the first dot after that.
//  2. SWITCHING IS ALSO ARMING. Moving 1H → 4H is not a continuation, it is a new strategy on
//     the same coins, so it resets the cursor and the record the same way a fresh arm does.
//  3. ONE BOOK OWNS THE COINS. The ladder and the flip cannot both hold the stack. The caller
//     stands the ladder down before this runs, and refuses to arm at all while ladder rungs are
//     still resting — two books claiming one balance is how you sell the same coin twice.
//
// The bookkeeping fee is the REAL one (10bps taker), not the 1bp the paper arms assume. Those
// arms exist to rank timeframes under an optimistic assumption; this one has to be honest, and
// its record is the only one that gets to claim anything about live performance.
const LIVE_FLIP_KEY = "cipher_accum_liveflip";

// ── POSITION TARGET, NOT DOT REPLAY ──────────────────────────────────────────────────────────
// The paper arms replay every dot as if each could be acted on the instant it printed. A bot that
// wakes every 30–40 minutes cannot do that, and pretending otherwise is not a small inaccuracy —
// it would place a LIMIT order at the close of a bar that may be half an hour old, which either
// never fills (the slice strands in cash: the exact failure this strategy exists to avoid) or
// fills at a price nothing like the one the book recorded.
//
// So the live arm asks a different, answerable question: given the newest closed bar, SHOULD this
// be holding coins or holding cash? A red dot is wt1 crossing below wt2 and a green dot is the
// cross back, so "hold coins while wt1 is above wt2" is the same position the dots describe —
// just sampled when the bot is actually awake, and transacted at a price that is actually current.
//
// The consequence is worth stating plainly rather than burying: on fast timeframes this arm will
// MISS moves the paper arm catches, because dots that open and close between two runs are
// invisible to it. That gap is real and it grows as the timeframe shortens. It is also honest —
// the paper 5m number was never achievable by this bot at any fee.
function liveFlipStep(state, bars, tf, cfg = {}) {
  // ── DUST IS NOT A POSITION (2026-08-19) ─────────────────────────────────────────────────────
  // The first live arm came up holding 0.00767931 BTC and 1.2 CENTS of leftover USDT. Treating
  // any non-zero cash as "in cash" would have reported the arm as sold when it holds the whole
  // stack, and — far worse — the next green reading would have tried to BUY with $0.012, which
  // is under the venue's $10 minimum. That order gets refused, the refusal trips the rollback,
  // and the arm retries the same thing every run forever. So both sides ignore anything too
  // small to be an order.
  const { feeBps = num("ACCUM_FEE_BPS", 10), seedUnits = null, seedCash = 0,
          minOrderUsdt = num("ACCUM_MIN_ORDER_USDT", 10) } = cfg;
  const st = {
    tf: null, units: 0, cash: 0, trips: 0, sells: 0, lastT: 0,
    startUnits: 0, startedAt: null, armedAt: null, want: null,
    ...(state || {}),
  };
  const events = [];
  if (!bars || bars.length < 60) return { st, events, why: "not enough bars to arm" };
  const last = bars[bars.length - 1];
  const { wt1, wt2 } = waveTrend(bars);
  const n = bars.length - 1;
  if (!Number.isFinite(wt1[n]) || !Number.isFinite(wt2[n])) return { st, events, why: "indicator not ready" };
  const wantCoins = wt1[n] > wt2[n];

  if (st.tf !== tf) {
    const prev = st.tf;
    st.tf = tf;
    st.lastT = last.t;                 // ← the whole no-replay guarantee is this line
    st.trips = 0; st.sells = 0;
    st.want = wantCoins;
    st.armedAt = new Date().toISOString();
    st.startedAt = st.armedAt;
    if (seedUnits != null) { st.units = seedUnits; st.cash = seedCash || 0; }
    // The benchmark this arm is judged against: what it started with, held and never traded.
    st.startUnits = st.units + (st.cash || 0) / last.c;
    events.push({ kind: "flip-armed", tf, prev, at: last.t, px: last.c,
                  units: st.units, cash: st.cash, want: wantCoins ? "coins" : "cash" });
    return { st, events };
  }

  if (!(last.t > (st.lastT || 0))) return { st, events };     // no new bar has closed
  st.lastT = last.t;
  st.want = wantCoins;
  const px = last.c;

  // At most ONE order per run, for the whole position, at the newest price we have.
  if (!wantCoins && st.units * px >= minOrderUsdt) {
    const sell = st.units;
    const proceeds = sell * px * (1 - feeBps / 1e4);
    st.cash += proceeds; st.units = 0; st.sells++;
    events.push({ kind: "flip-sell", at: last.t, px, units: sell, cash: proceeds });
  } else if (wantCoins && st.cash >= minOrderUsdt) {
    const spent = st.cash;
    const got = (spent / px) * (1 - feeBps / 1e4);
    st.units += got; st.cash = 0; st.trips++;
    events.push({ kind: "flip-buy", at: last.t, px, units: got, cash: spent });
  }
  return { st, events };
}

// ═══════════════ SPOT RAILS (2026-08-19) ═══════════════
// John: "it also has to be done on spot, not futures." He is right, and it is not a preference —
// it is the whole objective. On a USDT-M perpetual you never own a coin: you hold a position,
// you pay funding to keep it, and "more BTC" is not a thing that can happen. Accumulating UNITS
// only means anything on spot, where the coin is actually yours.
//
// Everything else in this file talks to /g-orders (USDT-M). Spot is a different product on the
// same venue: symbols carry an "s" prefix (sBTCUSDT), and prices and quantities go over the wire
// as SCALED INTEGERS whose scale factors come from /public/products. Getting a scale wrong sends
// an order a thousand times too big, so nothing here guesses: if the scales have not been read
// from the venue, the order is refused.
//
// IMPORTANT, stated plainly: this code has NOT been exercised against the live venue — Phemex is
// unreachable from the machine it was written on.
//
// ── CORRECTED 2026-08-20, after Codex's review ──────────────────────────────────────────────
// This comment used to claim "It is DRY by default (ACCUM_EXEC=dry)". That was false, and had
// been false since the accumulator was armed. The default below is now genuinely "dry", and the
// arming lives in ONE auditable place: ACCUM_EXEC in .github/workflows/cipher-agent.yml.
// A safety note that lies is worse than no safety note — anyone auditing this file would have
// concluded the spot path could not place an order, and been wrong.
const SPOT_KEY = "cipher_spot_products";
let _spotProducts = null;

// Read the product table once and remember the scales. Public endpoint, no key needed.
async function spotProducts() {
  if (_spotProducts) return _spotProducts;
  try {
    const r = await phemexPublic("/public/products");
    const body = (r && r.data && (r.data.data || r.data)) || {};
    const list = body.products || [];
    // ── WHERE THE SCALES ACTUALLY LIVE (found 2026-08-19 by running the preflight) ────────────
    // The first version looked for baseValueScale on the PRODUCT and never found it, so every
    // symbol failed the readiness check even though the market plainly exists. Phemex keeps
    // value scales on the CURRENCY, not the product: /public/products returns a `currencies`
    // array where each entry carries its own valueScale. A spot pair therefore needs two
    // lookups — one for the coin, one for the money.
    const cur = {};
    for (const c of (body.currencies || [])) {
      if (c && c.currency) cur[String(c.currency).toUpperCase()] = Number(c.valueScale);
    }
    const map = {};
    for (const p of list) {
      if (!p || !p.symbol || !String(p.symbol).startsWith("s")) continue;   // spot symbols only
      const base = String(p.baseCurrency || "").toUpperCase();
      const quote = String(p.quoteCurrency || "").toUpperCase();
      map[p.symbol] = {
        baseCurrency: base, quoteCurrency: quote,
        priceScale: Number(p.priceScale ?? p.pricePrecision ?? 8),
        ratioScale: Number(p.ratioScale),
        baseTickSize: p.baseTickSize, quoteTickSize: p.quoteTickSize,
        baseValueScale: Number.isFinite(cur[base]) ? cur[base] : Number(p.baseValueScale),
        quoteValueScale: Number.isFinite(cur[quote]) ? cur[quote] : Number(p.quoteValueScale),
      };
    }
    if (Object.keys(map).length) _spotProducts = map;
    return _spotProducts;
  } catch (e) { console.error("spot products read failed:", e && e.message); return null; }
}

// Build a spot order. Returns { order } or { err } — never a half-built order.
//   side "Sell": we are selling BASE (BTC), so baseQtyEv carries the size
//   side "Buy" : we are spending QUOTE (USDT), so quoteQtyEv carries the spend
function buildSpotOrder(sym, side, { price, baseQty, quoteQty }, products) {
  const symbol = "s" + String(sym).toUpperCase().replace(/^S/, "") + "USDT";
  const p = products && products[symbol];
  if (!p) return { err: `no spot product data for ${symbol} — refusing to guess the scales` };
  if (!(Number.isFinite(p.baseValueScale) && Number.isFinite(p.quoteValueScale) && Number.isFinite(p.priceScale)))
    return { err: `incomplete scales for ${symbol} — refusing to send` };
  if (side !== "Buy" && side !== "Sell") return { err: "side must be Buy or Sell" };
  if (!(price > 0)) return { err: "spot order needs a price" };
  const order = {
    symbol, side, ordType: "Limit", timeInForce: "GoodTillCancel",
    priceEp: Math.round(price * 10 ** p.priceScale),
    clOrdID: ("accum" + sym + Date.now()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 30),
  };
  // qtyType is REQUIRED and tells the venue which of the two quantity fields to read. Missing it
  // was a real defect, caught 2026-08-19 by reading Phemex's own spot docs rather than trusting
  // the shape I had inferred. A sell is sized in the coin; a buy is sized in the money.
  // ── FLOOR, NEVER ROUND (2026-08-19) ────────────────────────────────────────────────────────
  // Math.round can round a quantity UP, which asks the venue to sell coins that are not there or
  // spend money that is not there. Phemex answers that with
  // TE_PLACE_ORDER_INSUFFICIENT_BASE_BALANCE — which is exactly what killed the first live flip
  // sell, an order for the entire wallet balance where the last scaled digit went the wrong way.
  // Flooring can only ever leave a sub-tick crumb behind; rounding can lose the whole order.
  if (side === "Sell") {
    if (!(baseQty > 0)) return { err: "sell needs a base quantity" };
    order.qtyType = "ByBase";
    order.baseQtyEv = Math.floor(baseQty * 10 ** p.baseValueScale);
    if (!(order.baseQtyEv > 0)) return { err: "base quantity rounds to zero at this scale" };
  } else {
    if (!(quoteQty > 0)) return { err: "buy needs a quote amount" };
    order.qtyType = "ByQuote";
    order.quoteQtyEv = Math.floor(quoteQty * 10 ** p.quoteValueScale);
    if (!(order.quoteQtyEv > 0)) return { err: "quote amount rounds to zero at this scale" };
  }
  return { order };
}

// PREFLIGHT — read-only, answers "can this actually trade spot here?" from the runner itself.
// Written because the machine this code was authored on cannot reach Phemex at all, so the only
// honest way to find out is to have the bot look and report back. Three questions, in order:
//   1. does the venue expose a spot market for this coin, and what are its scales?
//   2. is there a spot wallet, and does it hold anything?
//   3. what would the very next order look like, byte for byte?
// It places nothing. Run it, read the log, and only then decide whether to arm.
async function spotPreflight(coin) {
  const out = { symbol: "s" + String(coin).toUpperCase() + "USDT" };
  try {
    const prods = await spotProducts();
    out.productsRead = !!prods;
    out.product = prods && prods[out.symbol] ? prods[out.symbol] : null;
    out.spotSymbolCount = prods ? Object.keys(prods).length : 0;
  } catch (e) { out.productsErr = String(e && e.message || e).slice(0, 120); }
  try {
    // /spot/wallets takes a currency parameter; ask for the two that matter to this strategy.
    const w = await phemexCall("GET", "/spot/wallets", "currency=USDT", null);
    let w2 = null;
    try { w2 = await phemexCall("GET", "/spot/wallets", `currency=${String(coin).toUpperCase()}`, null); } catch {}
    if (w2 && w2.status === 200 && w2.data) out.baseWallet = JSON.stringify(w2.data).slice(0, 200);
    out.walletStatus = w.status;
    const rows = (w.data && (w.data.data || w.data.result)) || [];
    const all = Array.isArray(rows) ? [...rows] : [];
    if (w2 && w2.status === 200) {
      const r2 = (w2.data && (w2.data.data || w2.data.result)) || [];
      if (Array.isArray(r2)) all.push(...r2);
    }
    if (all.length) {
      out.balances = all
        .filter(r => r && (Number(r.balanceEv) > 0 || Number(r.balance) > 0))
        .map(r => `${r.currency || r.currencyCode || "?"}:${r.balanceEv ?? r.balance}`)
        .slice(0, 8);
      out.walletRows = all.length;
      // The real, human-readable balance of the coin we trade. Wallet balances come back as
      // scaled integers (balanceEv) using the SAME per-currency valueScale as orders do, so the
      // scale has to be read, never assumed — the identical trap that broke the first preflight.
      const want = String(coin).toUpperCase();
      const row = all.find(r => String(r.currency || r.currencyCode || "").toUpperCase() === want);
      const scale = out.product ? out.product.baseValueScale : NaN;
      if (row && Number.isFinite(scale)) {
        const ev = Number(row.balanceEv ?? row.balance);
        if (Number.isFinite(ev)) out.baseBalance = ev / 10 ** scale;
        // AVAILABLE is not the same as BALANCE. Anything locked in a resting order is still in
        // `balanceEv` but cannot be sold, and the venue answers the difference with
        // INSUFFICIENT_BASE_BALANCE rather than telling you which part was unavailable. Record
        // both, and prefer the available figure when the venue reports one.
        const lockedEv = Number(row.lockedTradingBalanceEv ?? row.lockedBalanceEv ?? row.lockedEv);
        if (Number.isFinite(lockedEv)) {
          out.baseLocked = lockedEv / 10 ** scale;
          out.baseAvailable = (ev - lockedEv) / 10 ** scale;
          if (out.baseAvailable >= 0) out.baseBalance = out.baseAvailable;
        }
        out.baseRow = JSON.stringify(row).slice(0, 300);   // so a refusal can be diagnosed once
      }
      const qrow = all.find(r => String(r.currency || r.currencyCode || "").toUpperCase() === "USDT");
      const qscale = out.product ? out.product.quoteValueScale : NaN;
      if (qrow && Number.isFinite(qscale)) {
        const ev = Number(qrow.balanceEv ?? qrow.balance);
        if (Number.isFinite(ev)) out.quoteBalance = ev / 10 ** qscale;
      }
    } else out.walletShape = typeof rows;
  } catch (e) { out.walletErr = String(e && e.message || e).slice(0, 120); }
  return out;
}

// The only function that can put a spot order on the wire. Three independent brakes, all of which
// must be off: ACCUM_EXEC must be "armed", the global KILL must be clear, and the notional must
// sit under ACCUM_MAX_USDT. Anything else returns a dry-run result that says what it would have done.
async function sendSpotOrder(order, notionalUsdt, opts = {}) {
  // ── ARMED ON JOHN'S INSTRUCTION, 2026-08-19 ────────────────────────────────────────────────
  // Default flipped from "dry" to "armed" after he funded the spot wallet with 0.007682 BTC and
  // asked for it live. Note WHY the default had to change rather than the workflow file: the
  // deployed .github/workflows/cipher-agent.yml carries no ACCUM_* variables at all, so every
  // accumulator setting comes from these code defaults. Editing the yml alone would have looked
  // like arming it and changed nothing.
  //
  // The cap is raised 100 → 200 USDT for a real reason, not a round number: with no core a slice
  // is 20% of the whole stack, which is ~$100 at $65k BTC and ~$123 at $80k. A $100 cap would
  // have silently blocked the first trade the moment BTC rose. $200 still bounds any single
  // order to well under half the account.
  //
  // Three brakes remain and all still apply: the app's KILL switch, this cap, and the fact that
  // PHEMEX_BASE is hard-locked to testnet. Set ACCUM_EXEC=dry to stand it down.
  // ── TWO CAPS, BECAUSE THERE ARE TWO STRATEGIES (2026-08-19) ────────────────────────────────
  // The ladder sells a 20% slice, so 200 bounds it to comfortably under half the account and is
  // a real brake. The dot flip sells the WHOLE stack by construction — capping it below the
  // stack does not make it smaller, it makes it BROKEN: the order is silently skipped while the
  // strategy's book records a sell that never happened. A cap that turns a live strategy into a
  // fiction is worse than no cap, so the flip gets its own, set above the stack on purpose.
  // DEFAULT IS DRY (2026-08-20). It was "armed", which meant any deploy of this file anywhere
  // started able to place real spot orders with nothing stating that intent. Arming is now an
  // explicit ACCUM_EXEC=armed in the workflow — one place, auditable, greppable.
  const armed = String(env("ACCUM_EXEC", "dry")) === "armed";
  const cap = opts.cap != null ? opts.cap : num("ACCUM_MAX_USDT", 200);
  if (CFG.kill()) return { dry: true, why: "KILL switch is on", order };
  if (!(notionalUsdt <= cap)) return { dry: true, why: `notional ${notionalUsdt.toFixed(2)} over the ACCUM_MAX_USDT cap ${cap}`, order };
  if (!armed) return { dry: true, why: "ACCUM_EXEC is not armed", order };
  // ── A TRANSPORT BLIP MUST NOT COST A WHOLE CYCLE (2026-08-19) ─────────────────────────────
  // The second live flip sell died on a bare `spot http 502` — Cloudflare, not Phemex, and not a
  // rejection of anything. On a bot that wakes every 30–40 minutes that one blip cost the entire
  // trade: by the next run the signal had flipped back and the move was over. A 5xx says nothing
  // about the order, so retry it; a 4xx or a Phemex error code is a real answer, so never do.
  //
  // What makes the retry safe is that it re-sends the SAME order object, and that object carries
  // a clOrdID minted once in buildSpotOrder. If the first attempt actually reached the venue and
  // only the response was lost, the retry arrives with an ID the venue has already seen and is
  // rejected as a duplicate rather than filled twice. Retrying a POST without a stable client ID
  // would be the dangerous version of this.
  let r = await phemexCall("POST", "/spot/orders", "", order);
  for (let attempt = 1; attempt <= num("SPOT_RETRIES", 2) && r.status >= 500; attempt++) {
    console.log(`spot order http ${r.status} — retry ${attempt}`);
    await new Promise(res => setTimeout(res, 1200 * attempt));
    r = await phemexCall("POST", "/spot/orders", "", order);
  }
  const code = r.data && r.data.code;
  if (r.status !== 200) return { ok: false, status: r.status, error: `spot http ${r.status}`, sent: order, phemex: r.data };
  if (code !== 0 && code !== undefined) return { ok: false, status: 422, error: `phemex ${code}: ${(r.data && r.data.msg) || "rejected"}`, sent: order, phemex: r.data };
  return { ok: true, sent: order, phemex: r.data };
}

// Units held right now, counting cash at the current price — the only number that matters, and
// the only one comparable to buy-and-hold's flat 1.0000.
function accumUnits(st, px) {
  if (!st || !(px > 0)) return null;
  return st.units + (st.cash || 0) / px;
}

// ═══════════════ INSIGHT SCANNER (2026-08-19) ═══════════════
// John: "I want the brain to really see the market, really scan and learn and check for new
// insight from the indicators." The honest version of that is not more oscillators — it is
// sweeping every feature the bot ALREADY stamps on its decisions and asking, continuously, which
// of them actually separates winners from losers in live forward history.
//
// The features are PRE-REGISTERED here, in code — fixed buckets, chosen before looking. That is
// the whole defence against fishing: ~20 buckets are watched every run, so at a 1-in-20 false
// positive rate roughly one will look good by chance, and the both-halves gate exists precisely
// to kill those. A bucket is reported as an INSIGHT only when it has a real sample AND holds the
// same sign in both halves of its own history — the same bar the regime and rank boxes must clear.
// It measures. It filters nothing. Anything that looks real graduates to a proper shadow arm.
const INSIGHT_MIN_N = 30;
const INSIGHT_FEATURES = [
  ["direction",  r => r.dir === "short" ? "short" : "long"],
  ["timeframe",  r => r.tf || "1D"],
  ["detector",   r => (r.note || "?").split(" ")[0].toLowerCase()],
  ["quality",    r => r.quality == null ? null : r.quality < 5 ? "q<5" : r.quality < 6 ? "q5-6" : "q6+"],
  ["breadth",    r => r.breadth == null ? null : r.breadth < 0.4 ? "few above 200D" : r.breadth <= 0.6 ? "mixed field" : "most above 200D"],
  ["btc-extension", r => r.regDist == null ? null : r.regDist < -10 ? "btc <-10% of 200D" : r.regDist < 0 ? "btc -10..0%" : r.regDist <= 10 ? "btc 0..+10%" : "btc >+10%"],
];

function insightScan(records) {
  const done = records.filter(r => r.arm === "baseline" && r.R !== null);
  const meanOf = a => a.length ? +(a.reduce((x, r) => x + r.R, 0) / a.length).toFixed(3) : null;
  const rows = [];
  for (const [feature, of] of INSIGHT_FEATURES) {
    const buckets = new Map();
    for (const r of done) {
      const b = of(r);
      if (b == null) continue;
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(r);
    }
    for (const [bucket, rs] of buckets) {
      const sorted = [...rs].sort((a, b) => a.at - b.at);
      const half = Math.floor(sorted.length / 2);
      const first = meanOf(sorted.slice(0, half)), second = meanOf(sorted.slice(half));
      const m = meanOf(sorted);
      const stable = sorted.length >= INSIGHT_MIN_N && first !== null && second !== null &&
                     Math.sign(first) === Math.sign(second) && Math.sign(first) !== 0;
      rows.push({ feature, bucket, n: sorted.length, meanR: m, firstHalf: first, secondHalf: second, stable });
    }
  }
  return rows.sort((a, b) => b.n - a.n);
}

// ═══════════════ THE SERVER-SIDE BRAIN: LOSER AUTOPSY (2026-08-19) ═══════════════
// John: "give it eyes so it learns" — and give it the server, so it works while the laptop is
// closed. This is the LLM doing the one thing it is actually good at in a trading system: reading
// the messy context of a trade that FAILED and naming what happened. It never predicts price,
// never sizes, never places, never blocks. Its output is a label on a record.
//
// The learning loop, held to the same evidence bar as everything else:
//   1. every newly graded LOSING decision is sent (in ONE batched call) to a small cheap model
//   2. the model must pick a cause from a PRE-REGISTERED taxonomy — free text can't be clustered,
//      and an unclusterable excuse is not learning
//   3. causes accumulate on the records; when one cause has a real sample AND its trades lose in
//      both halves of history, it is reported as a VETO CANDIDATE
//   4. a candidate stays advisory. Gating real orders would need its own shadow arm and a
//      deliberate flag — nothing here touches the order path, and the tests assert that.
//
// Cost is engineered down before it is capped: one call per run at most, only when there are new
// graded losses, batch of AUTOPSY_BATCH, compact JSON in and out, small model. Then capped anyway:
// BRAIN_DAILY_USD (default $0.25/day) is a hard stop, tracked in the state file where John can
// see it. No ANTHROPIC_API_KEY secret = the whole feature is silently off.
const AUTOPSY_CAUSES = [
  "chased-extended",   // entered far into a move that had already paid
  "against-field",     // fought the cross-sectional leader/laggard read
  "quiet-market",      // ATR too small for the costs — the known killer
  "vol-collapse",      // volatility died right after entry; the move never came
  "crowded-level",     // obvious level, stop where everyone's stop was
  "signal-noise",      // low-timeframe signal that was never more than wiggle
  "late-fill",         // the idea was right, the entry was stale by fill time
  "regime-turn",       // BTC/the field turned over right after entry
  "unknown",
];
const AUTOPSY_MAX_R = () => num("AUTOPSY_MAX_R", -0.4);   // what counts as a loss worth reading
const AUTOPSY_BATCH = () => Math.max(1, num("AUTOPSY_BATCH", 8));
const VETO_MIN_N = () => Math.max(4, num("VETO_MIN_N", 10));

// Compact, deterministic prompt. Everything the model sees is data the record already carries.
function buildAutopsyPrompt(losses) {
  const rows = losses.map((r, i) => ({
    i, coin: r.coin, dir: r.dir, tf: r.tf || "1D", det: (r.note || "?").split(" ")[0],
    q: r.quality ?? null, rs: r.rs ?? null, reg: r.reg ?? null, dist: r.regDist ?? null,
    br: r.breadth ?? null, stopPct: r.entry ? +((Math.abs(r.entry - r.stop) / r.entry) * 100).toFixed(2) : null,
    R: r.R,
  }));
  return [
    "You are the post-trade analyst for a rules-based crypto bot. Every trade below LOST.",
    "For each, pick the SINGLE most likely cause from this fixed list (reply with the id):",
    AUTOPSY_CAUSES.join(" | "),
    "Field key: det=detector, q=setup quality, rs=field rank signed with the trade (0 laggard..1 leader),",
    "reg=BTC regime, dist=BTC % from its 200D, br=share of coins above their 200D, R=result in R.",
    'Reply ONLY a JSON array, no prose: [{"i":<index>,"c":"<cause-id>","w":"<why, max 12 words>"}]',
    "TRADES:", JSON.stringify(rows),
  ].join("\n");
}

// Tolerant of everything a model can do to JSON: prose around it, fences, bad ids.
function parseAutopsy(text, count) {
  if (!text) return [];
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const i = Number(x.i);
    if (!Number.isInteger(i) || i < 0 || i >= count) continue;
    const c = AUTOPSY_CAUSES.includes(x.c) ? x.c : "unknown";
    out.push({ i, c, w: String(x.w || "").slice(0, 90) });
  }
  return out;
}

// The spend meter is the contract: the brain can never cost more than the cap says, and what it
// did cost is committed to the repo in the state file where it can be audited like everything else.
function brainBudget(slot, now, usage) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (slot.spendDay !== day) { slot.spendDay = day; slot.spendUsd = 0; slot.calls = 0; }
  if (usage) {
    const inUsd = (usage.input_tokens || 0) / 1e6 * num("BRAIN_IN_USD_PER_M", 1);
    const outUsd = (usage.output_tokens || 0) / 1e6 * num("BRAIN_OUT_USD_PER_M", 5);
    slot.spendUsd = +((slot.spendUsd || 0) + inUsd + outUsd).toFixed(4);
    slot.calls = (slot.calls || 0) + 1;
  }
  return (slot.spendUsd || 0) < num("BRAIN_DAILY_USD", 0.25);
}

async function brainCall(prompt) {
  const key = env("ANTHROPIC_API_KEY", "");
  if (!key) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env("BRAIN_MODEL", "claude-haiku-4-5"), max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const j = await r.json();
    if (!r.ok) { console.error("brain call refused:", (j && j.error && j.error.message) || r.status); return null; }
    return { text: (j.content && j.content[0] && j.content[0].text) || "", usage: j.usage || {} };
  } catch (e) { console.error("brain call failed (harmless, labels only):", e && e.message); return null; }
  finally { clearTimeout(to); }
}

// ── THE BRAIN OVERSEEING THE ACCUMULATOR (2026-08-19) ────────────────────────────────────────
// John: "the brain needs to be able to oversee it, see it and tweak it if it sees obvious
// improvements." The first half is easy and safe — show it the record and let it name what it
// sees. The second half is where every trading system quietly destroys itself, so the rule here
// is explicit and enforced by the code: THE BRAIN CANNOT CHANGE A SETTING. It returns a written
// observation and, at most, a NAMED suggestion. A suggestion is logged for John and would have to
// win a shadow arm before it could ever alter behaviour — the same bar every other idea in this
// system has had to clear. Anything else is a language model tuning a live strategy on a sample
// of a dozen trades, which is precisely how you overfit an account to zero.
function buildAccumReviewPrompt(st, px, backtest) {
  const rungs = (st.open || []).map(r => `${r.src}@${r.px}`).join(", ") || "none";
  const units = (st.units || 0) + (st.cash || 0) / (px || 1);
  return [
    "You are reviewing a BTC accumulation strategy. Its ONLY goal is to end up holding more BTC.",
    "Buy-and-hold always ends with exactly 1.0000 units — that is the benchmark it must beat.",
    "",
    "How it works: on a daily VuManChu red dot with negative money flow it sells 20% of the stack,",
    "then places buy-back orders at real levels below (swing lows, order blocks, fair value gaps).",
    "It gains units when a rung fills lower; it LOSES units when price runs away and cash is left",
    "stranded — that is the known failure mode and it dwarfs the wins.",
    "",
    `Backtest on 14.5 years: ${backtest}`,
    "",
    "LIVE RECORD SO FAR:",
    `  units now ${units.toFixed(5)} vs benchmark 1.00000`,
    `  sells ${st.sells || 0} · rung fills ${st.fills || 0} · rungs still resting: ${rungs}`,
    `  cash waiting to be redeployed: ${(st.cash || 0).toFixed(2)} USDT · BTC price ${px}`,
    `  running since ${st.startedAt || "just started"}`,
    "",
    "Reply ONLY this JSON, no prose:",
    '{"read":"<what the record shows, max 25 words>",',
    ' "concern":"<the single biggest risk RIGHT NOW, max 20 words>",',
    ' "suggestion":"<one specific testable change, or null if the sample is too small>",',
    ' "sampleTooSmall":true|false}',
  ].join("\n");
}

function parseAccumReview(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return {
      read: String(o.read || "").slice(0, 200),
      concern: String(o.concern || "").slice(0, 200),
      suggestion: o.suggestion == null ? null : String(o.suggestion).slice(0, 240),
      sampleTooSmall: !!o.sampleTooSmall,
    };
  } catch { return null; }
}

// Cause → veto candidate. IMPORTANT: only losses are autopsied, so "this cause's trades lose"
// is true by construction and proves nothing. What a label CAN prove is persistence: a failure
// mode that keeps recurring across time is structural; one that clustered in a single bad week
// was weather. So the bar is: a real sample overall, AND the cause appears in BOTH halves of the
// autopsied timeline. A candidate is a NAMED, RECURRING failure mode — the veto itself must then
// be written as a mechanical rule and earn its place through a shadow arm like everything else.
// Advisory output only — the order path is not in this function's reach.
function vetoCandidates(records) {
  const done = records.filter(r => r.arm === "baseline" && r.R !== null && r.autopsy).sort((a, b) => a.at - b.at);
  if (!done.length) return [];
  const midAt = done[Math.floor(done.length / 2)].at;        // the autopsied timeline's midpoint
  const byCause = new Map();
  for (const r of done) {
    if (!byCause.has(r.autopsy)) byCause.set(r.autopsy, []);
    byCause.get(r.autopsy).push(r);
  }
  const meanOf = a => a.length ? +(a.reduce((x, r) => x + r.R, 0) / a.length).toFixed(3) : null;
  const minEach = Math.max(2, Math.floor(VETO_MIN_N() / 3));
  const out = [];
  for (const [cause, rs] of byCause) {
    if (cause === "unknown") continue;                       // "I don't know" is never a rule
    const early = rs.filter(r => r.at < midAt).length, late = rs.length - early;
    const candidate = rs.length >= VETO_MIN_N() && early >= minEach && late >= minEach;
    out.push({ cause, n: rs.length, early, late, meanR: meanOf(rs), candidate });
  }
  return out.sort((a, b) => b.n - a.n);
}

// ═══════════════ THE ENTRY LAB (2026-08-20) ═══════════════
// From John and Codex's pack, cut from eight arms to three for a reason that is arithmetic
// rather than taste: this bot resolves about 10.7 trades a day, and the pack's own promotion
// rule wants 60 resolved per arm. Three arms is 17 days to a verdict. Eight would be 45, and the
// full eight-by-six entry/exit grid would be 268 days — longer than the strategy will stay
// unchanged, which makes it not an experiment but a wish.
//
// The three are chosen to answer ONE question, the one the record cannot currently answer:
//
//     Are the losses because the SIGNALS are bad, or because the ENTRIES are late?
//
// That question is John's own weakness stated mechanically — "I panic and buy back higher" — and
// until it is answered, every other tuning decision is guesswork.
//
//   immediate_marketable  the live behaviour, and therefore the baseline. Not a shadow.
//   structure_retest      rest at the zone the move came from; EXPIRES rather than waiting for
//                         ever, because an entry that never fills is not a better entry, it is
//                         no trade — and pretending otherwise is how a retest arm flatters itself.
//   no_chase_filter       skip when price has already travelled more than N ATR from the signal.
//                         It RECORDS the skip. An arm that makes trades disappear cannot be
//                         compared with one that takes them.
//
// Everything here is measurement. No arm but the live one places anything, nothing here filters,
// scores, promotes, demotes or sizes, and the pattern taxonomy is deliberately absent: patterns
// stay reference-only until one of them earns a hypothesis of its own.
const ENTRY_LAB_KEY = "cipher_entry_lab";
const ENTRY_ARMS = ["immediate_marketable", "structure_retest", "no_chase_filter"];

// PURE. A signal in, the three arms' intents out. No venue, no clock, no I/O.
function entryArmPlan(sig, bars, cfg = {}) {
  const {
    chaseAtr = num("LAB_CHASE_ATR", 1.0),      // "already travelled too far" in ATR from the trigger
    expireBars = num("LAB_EXPIRE_BARS", 12),   // a retest that has not filled by then is no trade
  } = cfg;
  const { coin, dir, entry, stop, target, tf, at } = sig;
  const isLong = dir !== "short";
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !Number.isFinite(entry)) return null;

  const atr = atrArr(bars, 14);
  const a = atr[atr.length - 1];
  const trigger = Number.isFinite(sig.triggerPx) ? sig.triggerPx : entry;
  // How far price has ALREADY run from the bar that produced the signal, in ATR. This is the
  // number "chased" actually means, and it is why the filter is expressed in ATR rather than
  // percent: the same 1% is a shrug on DOGE and a lot on BTC.
  const travelled = Number.isFinite(a) && a > 0 ? Math.abs(entry - trigger) / a : 0;

  const zone = nearestZone(bars, dir);
  const retestPx = zone ? (isLong ? zone.top : zone.bottom) : null;

  return {
    coin, dir, tf, at, risk, atr: a,
    arms: [
      { arm: "immediate_marketable", live: true, wants: entry, stop, target,
        note: "what the bot actually does" },
      { arm: "structure_retest", live: false,
        wants: Number.isFinite(retestPx) ? retestPx : null, stop, target,
        expireBars, zone: zone ? zone.src : null,
        note: Number.isFinite(retestPx) ? "rest at the zone the move came from"
                                        : "no zone within reach — this arm sits out and says so" },
      { arm: "no_chase_filter", live: false,
        wants: travelled <= chaseAtr ? entry : null, stop, target,
        travelledAtr: +travelled.toFixed(3), chaseAtr,
        skipped: travelled > chaseAtr,
        note: travelled > chaseAtr
          ? `skipped — price had already run ${travelled.toFixed(2)} ATR from the trigger`
          : "took it, same price as live" },
    ],
  };
}

// PURE. Walk an arm's intent forward over bars and say what happened to it. Grades ONLY the
// entry model — whether the venue would have taken the order is a different question, kept in a
// different column, because blending them is exactly what the four-way split exists to prevent.
function entryArmResolve(intent, forward) {
  const isLong = intent.dir !== "short";
  const { wants, stop, target } = intent;
  const out = { arm: intent.arm, wouldFill: false, fillBar: null, fillPx: null,
                mfeR: 0, maeR: 0, hitTarget: false, hitStop: false, expired: false,
                skipped: !!intent.skipped, note: intent.note };
  if (intent.skipped) { out.note = intent.note; return out; }          // recorded, not vanished
  if (!Number.isFinite(wants)) { out.note = intent.note; out.noZone = true; return out; }

  const limit = intent.expireBars || Infinity;
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i];
    if (!out.wouldFill) {
      if (i >= limit) { out.expired = true; break; }                    // a retest that never came
      const filled = isLong ? b.l <= wants : b.h >= wants;
      if (filled) { out.wouldFill = true; out.fillBar = i; out.fillPx = wants; }
      continue;
    }
    const risk = Math.abs(wants - stop) || 1;
    const fav = isLong ? (b.h - wants) / risk : (wants - b.l) / risk;
    const adv = isLong ? (wants - b.l) / risk : (b.h - wants) / risk;
    out.mfeR = Math.max(out.mfeR, fav);
    out.maeR = Math.max(out.maeR, adv);
    if (Number.isFinite(target) && (isLong ? b.h >= target : b.l <= target)) { out.hitTarget = true; break; }
    if (Number.isFinite(stop) && (isLong ? b.l <= stop : b.h >= stop)) { out.hitStop = true; break; }
  }
  out.mfeR = +out.mfeR.toFixed(3); out.maeR = +out.maeR.toFixed(3);
  return out;
}

const SHADOW_KEY = "cipher_shadow";
const SHADOW_MIN_RESOLVED = 30;    // per arm, before a comparison means anything
const SHADOW_MARGIN_R     = 0.05;  // variant must beat baseline by this much in mean R
const SHADOW_MAX_RECORDS  = 600;   // keep the state file sane
const SHADOW_GRADE_AFTER_H = 4;    // don't try to resolve a trade that has had no time to move
const SHADOW_TIMEOUT_BARS = 40;    // same time cap the app's backtester uses

async function loadShadow() { return (await getJSON(SHADOW_KEY, {})) || {}; }
async function saveShadow(sh) { await setJSON(SHADOW_KEY, sh); }

function shadowSlot(sh, id) {
  if (!sh[id]) sh[id] = { records: [], promoted: false, history: [] };
  return sh[id];
}

// A decision, with everything needed to grade it later. `arm` is "baseline" or "variant".
function shadowRecord(sh, id, arm, t, meta) {
  const slot = shadowSlot(sh, id);
  slot.records.push({
    at: Date.now(), arm, coin: t.coin, dir: t.dir, tf: t.planTf || t.tf || "1D",
    entry: +t.entry, stop: +t.sl, target: +(t.tp2 ?? t.tp1),
    quality: meta && meta.quality, note: meta && meta.note,
    reg: (meta && meta.reg) || null,            // "bull" | "bear" at the moment of the decision
    rs: (meta && meta.rs) != null ? meta.rs : null,  // 1 = trading the field's leader in your direction
    regDist: (meta && meta.regDist) ?? null,    // how far BTC was from its 200D line, in %
    breadth: (meta && meta.breadth) ?? null,    // share of scanned coins above their own 200D
    R: null,                                    // filled in by grading, later
  });
  if (slot.records.length > SHADOW_MAX_RECORDS) slot.records = slot.records.slice(-SHADOW_MAX_RECORDS);
}

// Walk real candles forward from the decision and score it in R. Stop is checked BEFORE target
// within a candle — the pessimistic reading, same as the app's backtester. Anything still open
// after the time cap is marked to market.
function gradeOne(rec, candles) {
  const risk = Math.abs(rec.entry - rec.stop);
  if (!(risk > 0) || !candles || !candles.length) return null;
  const isLong = rec.dir !== "short";
  const start = candles.findIndex(c => c.t >= rec.at);
  if (start < 0) return null;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const hitStop = isLong ? c.l <= rec.stop : c.h >= rec.stop;
    const hitTgt  = isLong ? c.h >= rec.target : c.l <= rec.target;
    if (hitStop && hitTgt) rec.ambiguous = (rec.ambiguous || 0) + 1;   // counted, never hidden
    if (hitStop) return -1;
    if (hitTgt) return +Math.abs(rec.target - rec.entry) / risk;
    // The cap is 40 bars OF THE SIGNAL'S timeframe. Graded on a finer one, that is 4x as many
    // bars — otherwise a 4H idea would be marked to market after less than a day.
    if (i - start >= SHADOW_TIMEOUT_BARS * (rec.tfMult || 4)) {
      return (isLong ? c.c - rec.entry : rec.entry - c.c) / risk;   // marked to market
    }
  }
  return null;                                  // not enough candles yet — leave it open
}

// ── GRADE ON A FINER TIMEFRAME THAN THE SIGNAL (2026-08-18) ──────────────────────────────────
// gradeOne checks the stop BEFORE the target inside each candle, which is the right pessimism —
// but applied to the SIGNAL's own timeframe it is ruinous. A 4H candle is wide enough to contain
// both a 1R stop and a 2.25R target most of the time, so every such bar scored as a loss. The
// live evidence on 2026-08-18: of 43 graded 4H records, **43 were losses**. Not a market fact,
// an artefact of the resolution it was measured at — and this grader is what decides which rules
// get promoted, so it was quietly corrupting every conclusion the shadow framework reached.
//
// Walking the timeframe BELOW the signal cuts the candles that can contain both levels by 4x.
// The same reasoning the confirmation watcher already uses.
const GRADE_TF_BELOW = { "1D": "4H", "4H": "1H", "1H": "30m", "30m": "15m", "15m": "15m" };

async function gradeShadow(sh) {
  const cutoff = Date.now() - SHADOW_GRADE_AFTER_H * 3600e3;
  const need = new Map();                        // coin|tf → the records waiting on it
  for (const id of Object.keys(sh)) {
    for (const rec of sh[id].records) {
      if (rec.R !== null || rec.at > cutoff) continue;
      const gtf = GRADE_TF_BELOW[rec.tf || "1D"] || "1H";
      const k = rec.coin + "|" + gtf;
      if (!need.has(k)) need.set(k, []);
      need.get(k).push(rec);
    }
  }
  let graded = 0;
  for (const [k, recs] of need) {
    const [coin, gtf] = k.split("|");
    let candles = null;
    // 600 bars of the finer timeframe covers a longer stretch of history than 300 of the coarser
    // one did, so a decision cannot age out of the window before it resolves.
    try { candles = await fetchCandles(coin, gtf, 600); } catch {}
    if (!candles) continue;
    for (const rec of recs) {
      const R = gradeOne(rec, candles);
      if (R !== null) { rec.R = +R.toFixed(3); rec.gtf = gtf; graded++; }
    }
  }
  return graded;
}

function armStats(records, arm) {
  const done = records.filter(r => r.arm === arm && r.R !== null);
  if (!done.length) return { n: 0, meanR: 0, wins: 0 };
  const sum = done.reduce((a, r) => a + r.R, 0);
  return { n: done.length, meanR: +(sum / done.length).toFixed(3), wins: done.filter(r => r.R > 0).length };
}

// Promotion and demotion, on evidence only. Both arms need a real sample: a variant that beats a
// baseline of four trades has proved nothing, and this is exactly where a system talks itself
// into a change it likes the look of.
function shadowJudge(sh, id) {
  const slot = shadowSlot(sh, id);
  const base = armStats(slot.records, "baseline"), varr = armStats(slot.records, "variant");
  const ready = base.n >= SHADOW_MIN_RESOLVED && varr.n >= SHADOW_MIN_RESOLVED;
  const edge = +(varr.meanR - base.meanR).toFixed(3);
  let changed = null;
  // ── BEATING A LOSER IS NOT WINNING (2026-08-18) ──────────────────────────────────────────────
  // On 2026-08-18 this gate promoted rank_vs_threshold on an edge of +0.084R — while the variant
  // was losing 0.705R a trade and the baseline 0.789R. "Better than the incumbent" was the only
  // test, so the system handed control to a rule that loses money, because it lost slightly less.
  // A relative test needs an absolute floor underneath it or it will always find a winner.
  const variantPays = varr.meanR > 0;
  if (ready && !slot.promoted && edge >= SHADOW_MARGIN_R && variantPays) {
    slot.promoted = true; changed = "promoted";
  } else if (ready && slot.promoted && (edge < 0 || varr.meanR <= 0)) {
    // Demoted either for falling behind the baseline OR for simply not making money. The second
    // clause also unwinds any promotion granted before the floor existed.
    slot.promoted = false; changed = "demoted";
  }
  if (changed) slot.history.push({ at: Date.now(), changed, base, varr, edge });
  return { ready, base, varr, edge, promoted: slot.promoted, changed };
}

// ═══════════ THE ACCUMULATOR, RUN INDEPENDENTLY OF THE FUTURES BOT (2026-08-19) ═══════════
// Pulled out of the scan loop for a reason found the hard way. The accumulator used to sit below
// the `MODE=off — agent idle` return, so the SPOT strategy was silently governed by the FUTURES
// bot's mode. On 2026-08-19 the relay's /config read timed out, the agent fell back to the
// workflow's MODE=off, went idle, and the accumulator never ran at all — John sat watching dots
// print on a chart while the thing meant to act on them had already returned.
//
// These are two different strategies on two different products. The futures scanner is governed
// by MODE; the accumulator is governed by ACCUM and ACCUM_EXEC. KILL still stops both, because
// sendSpotOrder checks it on the order path where it cannot be missed.
async function runAccumulator() {
  // ── A SECOND OBJECTIVE: UNITS, NOT MONEY ────────────────────────────────────────────────────
  // Everything else in this file is trying to make pounds. This is trying to end the year with
  // more BTC than it started with, which is a different question with a different scoreboard —
  // buy-and-hold finishes with EXACTLY the starting units, always, and that is the line to beat.
  //
  // It runs on SPOT, never futures: on a perpetual you never own a coin, so "more BTC" is not a
  // thing that can happen. Its decision core (accumStep, accumFlipStep, liveFlipStep) is pure —
  // bars in, state and events out, no venue and no clock. Only the spot rails below it can put
  // an order on the wire, and every one of those goes through sendSpotOrder's three brakes.
  if (String(env("ACCUM", "1")) === "1") {
    try {
      const coin = ACCUM_COIN();
      // Read-only preflight: report whether spot is actually usable here. No orders.
      let PF = null;
      if (String(env("ACCUM_PREFLIGHT", "1")) === "1") {
        try {
          PF = await spotPreflight(coin);
          const prod = PF.product
            ? `scales price/base/quote ${PF.product.priceScale}/${PF.product.baseValueScale}/${PF.product.quoteValueScale}`
            : "NOT FOUND";
          console.log(`spot preflight: ${PF.symbol} — products ${PF.productsRead ? PF.spotSymbolCount + " spot symbols" : "UNREADABLE"} · ${prod} · wallet http ${PF.walletStatus ?? "?"}${PF.balances ? " · holding " + (PF.balances.join(", ") || "nothing") : ""}${PF.walletErr ? " · wallet error " + PF.walletErr : ""}${PF.productsErr ? " · products error " + PF.productsErr : ""}`);
          // A console line lives only in the Actions log, which is not where John looks. The
          // verdict belongs in the state file so the app can show it plainly.
          PF.ready = !!(PF.product && Number.isFinite(PF.product.baseValueScale)
                        && Number.isFinite(PF.product.quoteValueScale) && PF.walletStatus === 200
                        && (PF.balances || []).length > 0);
          PF.why = !PF.product ? "no spot market for this coin"
                 : !Number.isFinite(PF.product.baseValueScale) ? "could not read the value scales"
                 : PF.walletStatus !== 200 ? "spot wallet unreadable"
                 : !(PF.balances || []).length ? "the SPOT wallet is empty — it needs funding before it can trade"
                 : "ready";
          PF.checkedAt = Date.now();
        } catch (e) { console.error("spot preflight failed (read-only, harmless):", e && e.message); }
      }
      const bars = await fetchCandles(coin, "1D", 260);
      if (bars && bars.length >= 60) {
        let state = await getJSON(ACCUM_KEY, null);
        // ── SEED FROM THE REAL WALLET (2026-08-19) ─────────────────────────────────────────────
        // Until the spot wallet was funded this held a virtual 1.0 unit so the maths could be
        // watched. Now there is a real balance, so the strategy tracks THAT — otherwise the
        // panel reports a fiction and the order sizes bear no relation to what is actually there.
        // Seeded once; after that the strategy's own bookkeeping owns the number, because a
        // mid-cycle wallet read would double-count a slice that is currently sitting in cash.
        if (PF && Number.isFinite(PF.baseBalance) && PF.baseBalance > 0 && (!state || !state.seededReal)) {
          const carried = state || {};
          state = { ...carried, units: PF.baseBalance, cash: Number.isFinite(PF.quoteBalance) ? PF.quoteBalance : 0,
                    startUnits: PF.baseBalance, coreUnits: null, highWater: PF.baseBalance,
                    open: [], sells: carried.sells || 0, fills: carried.fills || 0,
                    seededReal: true, seededAt: new Date().toISOString(), startedAt: carried.startedAt || null };
          console.log(`accumulator seeded from the real spot wallet: ${PF.baseBalance} ${coin}` +
                      (Number.isFinite(PF.quoteBalance) && PF.quoteBalance > 0 ? ` + ${PF.quoteBalance} USDT` : ""));
          await pushLog({ coin, result: "ACCUM SEEDED",
            skipped: `spot wallet funded — tracking the real balance of ${PF.baseBalance} ${coin} from here. Benchmark is that same number held and never traded.` });
        }
        const all = [];

        // 1) FILLS — every run, against every 15-minute bar closed since the last check, so a
        //    3am wick through a rung is caught when it happens rather than at the daily close.
        try {
          const fine = await fetchCandles(coin, "15m", 200);
          if (fine && fine.length) {
            const f = accumFillPass(state, fine);
            state = f.st; all.push(...f.events);
          }
        } catch (e) { console.error("accumulator intraday fills skipped:", e && e.message); }

        // 2) THE DAILY DECISION — the red dot only exists on a closed daily bar.
        // Which book owns the coins this run? "off" (the default) means the ladder, exactly as
        // before. A timeframe means the dot flip — but only once the ladder's resting rungs have
        // all filled, because until then the ladder still has cash out against those coins and
        // handing the same balance to a second strategy would sell it twice.
        const flipWant = String((CFG.accumFlipTf && CFG.accumFlipTf()) || "off");
        const flipTf = flipWant.toLowerCase() === "off" ? null
                     : (FLIP_TFS.find(t => t.toLowerCase() === flipWant.toLowerCase()) || null);
        if (flipWant.toLowerCase() !== "off" && !flipTf) console.log(`accumulator: unknown flip timeframe "${flipWant}" — ladder keeps the coins`);
        const flipBlocked = flipTf && state.open && state.open.length > 0;
        const flipOwns = !!flipTf && !flipBlocked;

        const d = accumStep(state, bars, flipOwns
          ? { paused: true, pausedWhy: `the ${flipTf} dot flip holds the coins — ladder stood down` }
          : {});
        state = d.st; all.push(...d.events);

        const px = bars[bars.length - 1].c;
        const units = accumUnits(state, px);
        if (all.length) {
          await setJSON(ACCUM_KEY, state);
          for (const e of all) {
            if (e.kind === "sell") {
              // SPOT, never futures: you cannot accumulate coins on a perpetual. Dry unless armed.
              let execNote = "Measure only — no order placed.";
              try {
                const prods = await spotProducts();
                const built = buildSpotOrder(coin, "Sell", { price: e.px, baseQty: e.units }, prods);
                if (built.err) execNote = `Spot order NOT built: ${built.err}`;
                else {
                  const r = await sendSpotOrder(built.order, e.units * e.px);
                  execNote = r.ok ? `SPOT SELL PLACED (${built.order.clOrdID})`
                          : r.dry ? `dry run — would have sent a SPOT sell (${r.why})`
                                  : `spot sell refused: ${r.error}`;
                }
              } catch (err) { execNote = "spot path errored (no order sent): " + (err && err.message); }
              await pushLog({ coin, result: "ACCUM SELL",
                skipped: `sold 20% of the tradeable stack at ${formatPrice(e.px)} — ${e.how || "signal"}, money flow negative; buy-backs laddered at ${e.rungs.join(", ")}. ${execNote}` });
            }
            if (e.kind === "fill") await pushLog({ coin, result: "ACCUM BUY",
              skipped: `laddered buy filled at the ${e.src} level ${formatPrice(e.px)} — ${e.delta >= 0 ? "+" : ""}${e.delta.toFixed(6)} ${coin} on that slice.${e.viaDaily ? " (caught by the daily safety net)" : ""}` });
            if (e.kind === "skip") await pushLog({ coin, result: "ACCUM PASS", skipped: `red dot, but no sell: ${e.why}.` });
          }
        }
        // ── THE DOT FLIP ──────────────────────────────────────────────────────────────────
        // All eight timeframes always run as PAPER arms, whatever is armed, so the table the
        // choice gets made from never goes dark — including for the timeframe currently live.
        // Exactly one of them may additionally be promoted to the real balance (see the toggles
        // in the app panel and liveFlipStep above); the paper arm and the live arm are kept in
        // separate books so neither can flatter or corrupt the other.
        try {
          state.flips = state.flips || {};
          const oneH = await fetchCandles(coin, "1H", 500);
          const flipBars = {};
          for (const ftf of FLIP_TFS) {
            let fbars = null;
            if (ftf === "3H") fbars = oneH ? aggregateBars(oneH, 3) : null;      // built, not fetched
            else if (ftf === "1H") fbars = oneH;
            else fbars = await fetchCandles(coin, ftf, 500);
            if (!fbars || fbars.length < 60) continue;
            flipBars[ftf] = fbars;                       // reused by the live arm — no second fetch
            const f = accumFlipStep(state.flips[ftf] || null, fbars);
            state.flips[ftf] = f.st;
            const fpx = fbars[fbars.length - 1].c;
            f.st.unitsNow = +(f.st.units + f.st.cash / fpx).toFixed(8);
            f.st.gainPct = +(((f.st.unitsNow / (f.st.startUnits || 1)) - 1) * 100).toFixed(2);
            f.st.holding = f.st.cash <= 0;
          }
          const line = FLIP_TFS.map(t => { const x = state.flips[t]; return x ? `${t} ${x.gainPct >= 0 ? "+" : ""}${x.gainPct}% (${x.trips})` : `${t} —`; }).join(" · ");
          console.log(`dot flip @${num("FLIP_FEE_BPS", 1)}bps maker, paper: ${line}`);

          // ── AND THE ONE THAT IS REAL ───────────────────────────────────────────────────────
          let lf = await getJSON(LIVE_FLIP_KEY, null);
          if (flipBlocked) {
            state.liveFlip = { tf: null, want: flipTf, blocked: true,
              why: `waiting for ${state.open.length} resting ladder rung${state.open.length === 1 ? "" : "s"} to fill before the flip can take the coins` };
            console.log(`live flip ${flipTf}: NOT armed — ${state.liveFlip.why}`);
          } else if (flipTf && flipBars[flipTf]) {
            const wasTf = lf && lf.tf;
            // ── THE CAP HAS TO BE CHECKED *BEFORE* ARMING, NOT AT THE ORDER ─────────────────
            // The flip sells the WHOLE stack in one order, and sendSpotOrder answers an
            // over-cap notional with {dry:true} — no order, no error. The internal book would
            // record a sell that never happened and every number after it would be fiction,
            // with the wallet still holding coins the strategy thinks it converted to cash.
            // So an arm that cannot possibly execute is refused up front and said out loud.
            const capUsdt = num("ACCUM_FLIP_MAX_USDT", 1500);
            const armedExec = String(env("ACCUM_EXEC", "dry")) === "armed";
            let outOfSync = false;
            // ── THE WALLET IS THE ARBITER (2026-08-19) ──────────────────────────────────────
            // Found live: the book said 0.00767931 BTC while the spot wallet held 0.00000031.
            // Every run then fired a sell for coins that were not there, Phemex refused it, the
            // rollback undid it, and the next run did the same — a loop that would have run all
            // night writing failures into the log and learning nothing.
            //
            // A book that disagrees with the wallet is not a trading problem to push through,
            // it is a RECONCILIATION problem, and the only safe move is to stop and say so.
            // Silence here would be the worst outcome: a strategy that looks armed, is not
            // trading, and never explains why.
            const minOrder = num("ACCUM_MIN_ORDER_USDT", 10);
            const wBase = PF && Number.isFinite(PF.baseBalance) ? PF.baseBalance : null;
            const wQuote = PF && Number.isFinite(PF.quoteBalance) ? PF.quoteBalance : null;
            const bookUnits = Number((lf && lf.tf === flipTf ? lf.units : state.units)) || 0;
            const bookCash = Number((lf && lf.tf === flipTf ? lf.cash : state.cash)) || 0;
            const shortOfCoins = wBase != null && bookUnits * px >= minOrder && wBase * px < minOrder;
            const shortOfCash = wQuote != null && bookCash >= minOrder && wQuote < minOrder;
            if (armedExec && (shortOfCoins || shortOfCash)) {
              const detail = shortOfCoins
                ? `the strategy's book holds ${bookUnits.toFixed(8)} ${coin} but the SPOT wallet has ${wBase.toFixed(8)} — about ${(wBase * px).toFixed(2)} USDT, under the ${minOrder} minimum`
                : `the book holds ${bookCash.toFixed(2)} USDT but the SPOT wallet has ${wQuote.toFixed(2)}`;
              state.liveFlip = { tf: null, want: flipTf, blocked: true,
                why: `${detail}. Nothing can be traded until the two agree — check whether the balance was moved off the spot wallet, then re-arm to reseed from what is actually there.` };
              console.log(`live flip ${flipTf}: STOOD DOWN — ${state.liveFlip.why}`);
              await pushLog({ coin, result: "FLIP OUT OF SYNC", skipped: state.liveFlip.why });
              outOfSync = true;
            }
            const stackUsdt = ((Number(state.units) || 0) * px) + (Number(state.cash) || 0);
            if (outOfSync) {
              // already reported above; nothing else may run this pass
            } else if (armedExec && stackUsdt > capUsdt) {
              state.liveFlip = { tf: null, want: flipTf, blocked: true,
                why: `the whole stack is ${stackUsdt.toFixed(0)} USDT but ACCUM_FLIP_MAX_USDT is ${capUsdt} — a flip sells it all in one order, so it would be refused. Raise the cap above ${Math.ceil(stackUsdt / 50) * 50} to arm this.` };
              console.log(`live flip ${flipTf}: NOT armed — ${state.liveFlip.why}`);
              await pushLog({ coin, result: "FLIP BLOCKED", skipped: state.liveFlip.why });
            } else {
            const lfBefore = lf ? JSON.parse(JSON.stringify(lf)) : null;
            let placeFailed = null;
            // Seed from the ladder's book on handover. The ladder has nothing resting (checked
            // above), so its units and cash ARE the whole balance.
            const seedUnits = wasTf === flipTf ? null : (Number(state.units) || 0);
            const seedCash = wasTf === flipTf ? 0 : (Number(state.cash) || 0);
            const r = liveFlipStep(lf, flipBars[flipTf], flipTf, { seedUnits, seedCash });
            lf = r.st;
            for (const e of r.events) {
              if (e.kind === "flip-armed") {
                await pushLog({ coin, result: "FLIP ARMED",
                  skipped: `${flipTf} dot flip is now live on the real balance${e.prev ? ` (switched from ${e.prev})` : ""} — ${e.units.toFixed(8)} ${coin}${e.cash > 0 ? ` + ${e.cash.toFixed(2)} USDT` : ""} at ${formatPrice(e.px)}. No order placed on arming: it waits for the first dot AFTER this bar. The pump ladder is stood down.` });
                continue;
              }
              const isSell = e.kind === "flip-sell";
              let execNote = "Measure only — no order placed.";
              try {
                const prods = await spotProducts();
                // ── SIZE FROM THE WALLET, NOT ONLY FROM THE BOOK ─────────────────────────────
                // The book is what the strategy believes it holds; the wallet is what Phemex will
                // actually let it sell. They can differ — a fee taken in base, part of the balance
                // locked, a rounding crumb — and the venue arbitrates, not us. Taking the smaller
                // of the two means a disagreement costs a crumb rather than the whole order.
                // ── NEVER ASK FOR 100% OF THE BALANCE (2026-08-19) ───────────────────────────
                // Proved by arithmetic after the live refusal: 0.00767931 BTC scales to exactly
                // 767931, which is exactly the wallet's balanceEv — so the order asked for every
                // last satoshi and Phemex answered INSUFFICIENT_BASE_BALANCE. Flooring did not
                // help because there was no fractional slack to floor away. The venue wants room
                // for its fee, so leave it some.
                //
                // For THIS strategy the reserve is close to free: what stays behind stays as
                // BTC, and BTC is the thing being accumulated. A sell that never places is far
                // more expensive — it misses the whole cycle, which is what happened at 17:09.
                const reserveBps = num("ACCUM_SELL_RESERVE_BPS", 15);
                const walletBase = PF && Number.isFinite(PF.baseBalance) ? PF.baseBalance : null;
                const sellable = walletBase != null ? walletBase * (1 - reserveBps / 1e4) : null;
                const sellQty = sellable != null ? Math.min(e.units, sellable) : e.units;
                const walletQuote = PF && Number.isFinite(PF.quoteBalance) ? PF.quoteBalance : null;
                const buyQty = walletQuote != null ? Math.min(e.cash, walletQuote) : e.cash;
                const built = isSell
                  ? buildSpotOrder(coin, "Sell", { price: e.px, baseQty: sellQty }, prods)
                  : buildSpotOrder(coin, "Buy", { price: e.px, quoteQty: buyQty }, prods);
                if (built.err) {
                  execNote = `Spot order NOT built: ${built.err}`;
                  if (armedExec) placeFailed = built.err;
                } else {
                  const notional = isSell ? sellQty * e.px : buyQty;
                  const sr = await sendSpotOrder(built.order, notional, { cap: capUsdt });
                  execNote = sr.ok ? `SPOT ${isSell ? "SELL" : "BUY"} PLACED (${built.order.clOrdID})`
                           : sr.dry ? `dry run — would have sent a SPOT ${isSell ? "sell" : "buy"} (${sr.why})`
                                    : `spot ${isSell ? "sell" : "buy"} refused: ${sr.error}`;
                  // Armed and NOT placed is the one outcome the book must never absorb. A dry
                  // note here means a brake fired (kill, cap) while we believed we were live.
                  if (armedExec && !sr.ok) placeFailed = sr.dry ? sr.why : sr.error;
                }
              } catch (err) {
                execNote = "spot path errored (no order sent): " + (err && err.message);
                if (armedExec) placeFailed = String(err && err.message || err);
              }
              await pushLog({ coin, result: isSell ? "FLIP SELL" : "FLIP BUY",
                skipped: isSell
                  ? `${flipTf} red dot — sold the whole stack, ${e.units.toFixed(8)} ${coin} at ${formatPrice(e.px)}. Waiting for the green dot to buy it back. ${execNote}`
                  : `${flipTf} green dot — bought back with ${e.cash.toFixed(2)} USDT at ${formatPrice(e.px)}, ${e.units.toFixed(8)} ${coin}. ${execNote}` });
            }
            // ── THE BOOK FOLLOWS THE WALLET, NOT THE OTHER WAY ROUND ───────────────────────
            // If we were armed and an order did not reach the venue, the position on Phemex is
            // unchanged — so the strategy's book must be unchanged too. Rolling back to the
            // pre-step snapshot also rewinds `lastT`, which means the same dot is retried next
            // run: right for a transient failure, and loud enough in the log to be caught if it
            // is not. The alternative — carrying on from a sell that never happened — silently
            // corrupts every number downstream and is not recoverable without a manual audit.
            if (placeFailed) {
              lf = lfBefore || { tf: null, units: 0, cash: 0, trips: 0, sells: 0, lastT: 0, startUnits: 0 };
              console.error(`live flip ${flipTf}: ORDER DID NOT PLACE (${placeFailed}) — book rolled back, the dot will be retried next run`);
              await pushLog({ coin, result: "FLIP UNPLACED",
                skipped: `a ${flipTf} flip order did not reach the venue (${placeFailed}). The strategy's book has been rolled back to match the wallet — nothing was bought or sold. It will retry on the next run.` });
            }
            const lpx = flipBars[flipTf][flipBars[flipTf].length - 1].c;
            lf.unitsNow = +(lf.units + (lf.cash || 0) / lpx).toFixed(8);
            lf.gainPct = +(((lf.unitsNow / (lf.startUnits || lf.unitsNow || 1)) - 1) * 100).toFixed(2);
            // "Holding" means the coins are what it owns, not that its cash is exactly zero —
            // a cent of leftover USDT does not make a stack of BTC into a cash position.
            lf.holding = (lf.units || 0) * lpx > (lf.cash || 0);
            await setJSON(LIVE_FLIP_KEY, lf);
            // ONE TRUTH about what is actually held. While the flip owns the coins the ladder's
            // own book would otherwise sit frozen at the handover figures, and every downstream
            // reader — the panel, the console line, the benchmark — would quietly report a
            // position that no longer exists. Mirroring keeps state.units meaning what it says.
            // startUnits is deliberately NOT touched: the benchmark is still the balance this
            // whole exercise began with, whichever strategy is currently driving.
            state.units = lf.units; state.cash = lf.cash || 0;
            state.liveFlip = { tf: lf.tf, blocked: false, armedAt: lf.armedAt, units: lf.units,
                               cash: lf.cash, unitsNow: lf.unitsNow, startUnits: lf.startUnits,
                               gainPct: lf.gainPct, holding: lf.holding, trips: lf.trips, sells: lf.sells };
            console.log(`live flip ${lf.tf} (REAL): ${lf.unitsNow} units vs ${lf.startUnits} at arming — ${lf.gainPct >= 0 ? "+" : ""}${lf.gainPct}% · ${lf.sells} sells, ${lf.trips} round trips · ${lf.holding ? "holding coins" : "in cash, waiting for green"}`);
            }
          } else {
            // Toggled back to off — HAND THE COINS BACK. The flip may well be sitting in cash
            // mid-cycle, so the ladder must resume from what is actually held rather than from
            // the figures it was frozen at on handover; otherwise it would size its next sell
            // against coins that are currently USDT. The arm's record is kept, not deleted:
            // switching away should not erase what it did.
            if (lf && lf.tf) {
              state.units = Number(lf.units) || 0;
              state.cash = Number(lf.cash) || 0;
              console.log(`live flip stood down from ${lf.tf} — ladder resumes with ${state.units.toFixed(8)} ${coin}` +
                          (state.cash > 0 ? ` + ${state.cash.toFixed(2)} USDT still to be bought back` : ""));
              await pushLog({ coin, result: "FLIP OFF",
                skipped: `${lf.tf} dot flip switched off after ${lf.trips} round trip${lf.trips === 1 ? "" : "s"} — the pump ladder has the coins again: ${state.units.toFixed(8)} ${coin}${state.cash > 0 ? ` plus ${state.cash.toFixed(2)} USDT still in cash` : ""}.` });
              lf.tf = null; await setJSON(LIVE_FLIP_KEY, lf);
            }
            state.liveFlip = { tf: null, blocked: false, why: "off — the pump ladder holds the coins" };
          }
        } catch (e) { console.error("dot flip skipped:", e && e.message); }

        if (units != null) {
          const since = state.startedAt || "today";
          const resting = state.open.map(r => `${r.src}@${formatPrice(r.px)}`).join(", ") || "none";
          // Benchmark is the STARTING balance, not 1.0 — see the same fix in the app panel.
          const startU = Number(state.startUnits) > 0 ? Number(state.startUnits) : 1;
          const gainPct = (units / startU - 1) * 100;
          console.log(`accumulator (${coin} SPOT, core ${(state.coreUnits || 0).toFixed(8)}, ${String(env("ACCUM_EXEC", "dry")) === "armed" ? "ARMED" : "measure only"}): ${units.toFixed(8)} units vs buy-and-hold ${startU.toFixed(8)} — ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(2)}% since ${since} · ${state.sells} sells, ${state.fills} fills · resting: ${resting}`);
          state.unitsNow = +units.toFixed(6); state.pxNow = px;
          state.trigger = env("ACCUM_TRIGGER", "pump1");
          state.exec = String(env("ACCUM_EXEC", "dry"));
          if (PF) state.spot = { ready: PF.ready, why: PF.why, symbol: PF.symbol, hasProduct: !!PF.product,
                                 scales: PF.product ? `${PF.product.priceScale}/${PF.product.baseValueScale}/${PF.product.quoteValueScale}` : null,
                                 spotSymbols: PF.spotSymbolCount || 0, walletStatus: PF.walletStatus ?? null,
                                 balances: PF.balances || [], err: PF.walletErr || PF.productsErr || null,
                                 baseBalance: Number.isFinite(PF.baseBalance) ? PF.baseBalance : null,
                                 quoteBalance: Number.isFinite(PF.quoteBalance) ? PF.quoteBalance : null,
                                 exec: String(env("ACCUM_EXEC", "dry")), checkedAt: PF.checkedAt };

          // ── brain oversight: weekly, cheap, and it cannot change anything ──────────────────
          // Only when something has actually happened (a sell or a fill), at most once every
          // ACCUM_REVIEW_DAYS, sharing the same daily spend cap as the autopsy.
          try {
            const bSlot = shadowSlot(await loadShadow(), "brain_autopsy");
            const days = num("ACCUM_REVIEW_DAYS", 7);
            const due = !state.lastReview || (Date.now() - state.lastReview) > days * 864e5;
            if (env("ANTHROPIC_API_KEY", "") && due && (state.sells || 0) + (state.fills || 0) > 0
                && brainBudget(bSlot, Date.now(), null)) {
              const res = await brainCall(buildAccumReviewPrompt(state, px,
                "gains units in ranging/falling markets, loses them in sustained rallies; full history -27.8%, since Jan 2024 +14.9%"));
              if (res) {
                brainBudget(bSlot, Date.now(), res.usage);
                const rv = parseAccumReview(res.text);
                state.lastReview = Date.now();
                if (rv) {
                  state.lastReviewText = rv;
                  console.log(`accumulator review: ${rv.read}${rv.concern ? " · concern: " + rv.concern : ""}`);
                  await pushLog({ coin, result: "ACCUM REVIEW",
                    skipped: `${rv.read}${rv.concern ? ` Concern: ${rv.concern}.` : ""}${rv.suggestion && !rv.sampleTooSmall ? ` Suggestion (advisory only, would have to win a shadow arm before anything changes): ${rv.suggestion}` : " No suggestion — sample too small."}` });
                }
              }
            }
          } catch (e) { console.error("accumulator review skipped (harmless, changes nothing):", e && e.message); }

          await setJSON(ACCUM_KEY, state);
        }
      }
    } catch (e) { console.error("accumulator failed (harmless, measures only):", e && e.message); }
  }
}

// ═══════════════════════ THE LOOP ═══════════════════════
export default async function cipherAgent() {
  const started = Date.now();
  LIVE = await loadLiveConfig();
  const applied = applyLiveConfig(LIVE);
  if (applied.length) console.log("live config from the app: " + applied.join(", "));
  const mode = CFG.mode();
  if (mode === "off") {
    console.log(`MODE=off — futures scanner idle${LIVE && LIVE.kill ? " (KILL is ON from the app)" : ""}`);
    // …but the accumulator is a different strategy on a different product, with its own switches.
    // Letting the futures mode silently disable it is what cost 2026-08-19 an afternoon: the
    // relay read timed out, MODE fell back to off, and the spot strategy never ran. KILL still
    // stops it — that check lives on the order path in sendSpotOrder, where it cannot be missed.
    await runAccumulator();
    return;
  }

  // Rotate through the universe a batch at a time so every run finishes well inside 60s.
  let uni = await topUniverse(CFG.universe());
  const allowed = await relayWhitelist();
  if (allowed) {
    const before = uni.length;
    uni = uni.filter(c => allowed.has(c));
    if (!uni.length) uni = [...allowed];                      // none of the top movers are allowed
    console.log(`universe: ${uni.length} tradeable of ${before} (relay whitelist)`);
  }
  const cursor = await getJSON(KEY.cursor, 0);
  const batch = Math.max(5, CFG.batch());
  const slice = [];
  const seenThisRun = new Set();
  // Coins whose trade resolved last run jump the queue — see "TARGET HIT → LOOK THE OTHER WAY".
  // On a 100-coin rotation the cursor can take hours to come back round, by which time the
  // reverse setup is history.
  const priority = await getJSON(PRIORITY_KEY, []);
  for (const sym of priority) {
    if (slice.length >= batch) break;
    if (!seenThisRun.has(sym) && uni.includes(sym)) { seenThisRun.add(sym); slice.push(sym); }
  }
  if (priority.length) console.log(`priority scan: ${priority.join(", ")} (resolved last run)`);
  await setJSON(PRIORITY_KEY, []);
  for (let i = 0; i < batch && seenThisRun.size < uni.length && slice.length < batch; i++) {
    const sym = uni[(cursor + i) % uni.length];
    if (!seenThisRun.has(sym)) { seenThisRun.add(sym); slice.push(sym); }
  }
  await setJSON(KEY.cursor, (cursor + batch) % uni.length);

  // Day-scoped dedupe: one trade per coin+direction per day, same as the app.
  const day = new Date().toISOString().slice(0, 10);
  let fired = await getJSON(KEY.fired, {});
  for (const k of Object.keys(fired)) if (!k.endsWith(day)) delete fired[k];

  // ── ATTEMPT CAP (2026-08-15) ──────────────────────────────────────────────────────────────
  // Un-burning a coin on a 5xx was right — a server fault is not a decision. But with nothing
  // counting, one broken hop turned into BCH long attempted 15 times in a day, SUI 14, SOL 14.
  // That is not resilience, it is a feedback loop that manufactures its own traffic and buries
  // the real signal in noise. Three goes, then the coin rests until tomorrow.
  let attempts = await getJSON("cipher_attempts", {});
  for (const k of Object.keys(attempts)) if (!k.endsWith(day)) delete attempts[k];

  // A failed position read is not an empty book. If we cannot see what we are holding we cannot
  // honour the no-hedge rule, the correlation guard or "already holding" — so we scan and log,
  // but place nothing. Missing a setup costs one setup; placing blind cost ten tangled positions.
  const positionsRead = await openPositions();
  const canSeeBook = positionsRead !== null;
  const positions = positionsRead || [];
  if (!canSeeBook) console.log("WARNING: could not read open positions — scanning only, no orders will be placed this run");
  // ── NO OPPOSING LEG ON THE SAME COIN (2026-08-15) ────────────────────────────────────────────
  // Found LINK, XRP, ETH, UNI and BTC each holding a long AND a short at once. The bot never chose
  // to hedge — openPositions() was silently returning [] (see findPositions), so "already holding
  // this coin" was checking an empty list and always said no. That accessor is fixed, but a bug
  // being fixed is a weaker promise than code that refuses, so this is the explicit rule:
  //
  //   the bot has no hedging thesis, so it may never hold both sides of one coin.
  //
  // A real hedge needs a reason, a level and a stop on BOTH legs. This engine produces
  // one-directional setups; two opposing legs is not a position, it is two positions paying
  // funding against each other. Refuse, and say why in the log so it is visible rather than quiet.
  const bookMap = await getJSON(BOOKMAP_KEY, {});
  // ── What resolved since last run, and what that suggests looking at ──
  const prevOpen = await getJSON(OPEN_KEY, {});
  const lastPrice = {};                       // filled as the scan fetches candles anyway
  const priceOf = c => lastPrice[c];
  const heldDir = new Map();                      // "book|COIN" → Set("long"|"short")
  const addHeld = (book, coin, d) => { const k = book + "|" + coin; if (!heldDir.has(k)) heldDir.set(k, new Set()); heldDir.get(k).add(d); };
  for (const p of positions) {
    const coin = String(p.symbol || "").replace(/USDT$/, "").toUpperCase();
    // Phemex reports posSide Long/Short in hedge mode; fall back to side, then to a signed size.
    let d = String(p.posSide || p.side || "").toLowerCase();
    if (d !== "long" && d !== "short") d = Number(p.size) < 0 ? "short" : "long";
    const known = bookMap[posKey(coin, d)];
    if (known) addHeld(known, coin, d);
    else { addHeld("fast", coin, d); addHeld("swing", coin, d); }   // unknown → protected in both
  }
  // "book|COIN" — a coin can be held in one book and still be free in the other, which is the
  // whole point: a weekly BTC long must not block a 4H BTC trade in the fast book.
  const held = new Set();
  for (const [k, set] of heldDir) if (set.size) held.add(k);

  const opposes = (book, coin, dir) => {
    const other = dir === "long" ? "short" : "long";
    const k = book + "|" + coin;
    return heldDir.has(k) && heldDir.get(k).has(other);
  };
  const noteOpened = (book, coin, dir) => { addHeld(book, coin, dir); bookMap[posKey(coin, dir)] = book; };
  const dupes = [...heldDir].filter(([, set]) => set.size > 1).map(([k]) => k);
  if (dupes.length) console.log(`WARNING: ${dupes.length} coin(s) already hold BOTH sides — ${dupes.join(", ")}. Not adding to them.`);
  // ...and, unlike before, do something about it. Reduce-only, smaller leg, armed mode only.
  if (mode === "armed" && canSeeBook) {
    try {
      const hf = await resolveHedges(positions);
      if (hf.found) console.log(`hedges found on ${hf.found} coin(s) — ${hf.closed} smaller leg(s) closed${hf.failed ? `, ${hf.failed} failed` : ""}`);
    } catch (e) { console.error("de-hedge pass failed (harmless, reduce-only):", e && e.message); }
  }

  // ── CIRCUIT BREAKER: check the money before asking for more risk ──────────────────────────
  let BREAKER = { paused: false, st: {} };
  try {
    const bst = await getJSON(BREAKER_KEY, {});
    const eq = canSeeBook ? equityNow() : null;
    const wasPaused = (bst.pausedUntil || 0) > Date.now();
    BREAKER = breakerStep(bst, { now: Date.now(), equity: eq });
    await setJSON(BREAKER_KEY, BREAKER.st);
    if (BREAKER.trips.length) {
      console.log(`CIRCUIT BREAKER TRIPPED (${BREAKER.trips.join("+")}): ${BREAKER.st.pausedWhy}`);
      await pushLog({ result: "BREAKER", skipped: BREAKER.st.pausedWhy });
    } else if (BREAKER.paused) {
      console.log(`circuit breaker holding: ${BREAKER.st.pausedWhy} (until ${new Date(BREAKER.st.pausedUntil).toISOString()})`);
    } else if (wasPaused) {
      console.log("circuit breaker released — new entries allowed again");
    }
    if (eq == null && canSeeBook) console.log("breaker: no account balance in the positions response — drawdown arms inactive this run, streak arm still live");
  } catch (e) { console.error("breaker check failed (fails open for exits, closed for entries is handled per-trade):", e && e.message); }
  // Positions are read ONCE per run, so trades opened during this run must be counted too —
  // otherwise a single pass can stack far past CORR_MAX before the next run notices. Found when
  // the ported detectors made one run place 10 orders (2026-08-11).
  const openedThisRun = [];   // { book, dir }
  const sameDir = (book, dir) => {
    const fromExchange = positions.filter(p => {
      const coin = String(p.symbol || "").replace(/USDT$/, "").toUpperCase();
      let d = String(p.posSide || p.side || "").toLowerCase();
      if (d !== "long" && d !== "short") d = Number(p.size) < 0 ? "short" : "long";
      if (d !== dir) return false;
      const known = bookMap[posKey(coin, d)];
      return known ? known === book : true;      // unknown positions count against BOTH books
    }).length;
    return fromExchange + openedThisRun.filter(x => x.book === book && x.dir === dir).length;
  };
  const placedInBook = { fast: 0, swing: 0 };

  const log24 = (await getJSON(KEY.log, [])).filter(e => e.result === "PLACED" || e.result === "dry-run OK");
  const dayAgo = Date.now() - 864e5;
  let placedToday = log24.filter(e => new Date(e.at).getTime() > dayAgo).length;

  // Clear out anything that never filled before scanning, so a coin freed by an expiry can be
  // looked at again on this same run rather than waiting another fifteen minutes.
  if (mode === "armed") {
    try {
      const ex = await expireStaleOrders();
      if (ex.checked) console.log(`entry expiry: ${ex.checked} past ${CFG.entryExpiryH()}h — ${ex.cancelled} cancelled, ${ex.cleared} already gone${ex.blind ? `, ${ex.blind} unreadable (left alone)` : ""}`);
    } catch (e) { console.error("entry expiry pass failed (harmless, cancels only):", e && e.message); }
  }

  let scanned = 0, candidates = 0, placed = 0;
  const rankPool = [];                       // every coin's best signal this run, threshold or not
  const SHADOW = await loadShadow();
  _regimeCache = null; _rsCache = null;      // one BTC daily read, one field ranking, per run
  const REGIME = await regimeSnapshot();
  const RS = await relativeStrength(uni.slice(0, 40));
  if (RS.ok) console.log(`field: ${RS.n} coins ranked over ${RS_LOOKBACK_D}d — leader ${RS.leader}, laggard ${RS.laggard} (measured only, it filters nothing)`);
  if (REGIME.label) console.log(`regime: ${REGIME.label} (BTC ${REGIME.distPct >= 0 ? "+" : ""}${REGIME.distPct}% vs its ${REGIME_MA}D average) — measured only, it filters nothing`);

  for (const coin of slice) {
    if (Date.now() - started > 45000) { console.log("time budget reached — stopping early"); break; }
    if (!coin || NOT_CRYPTO.test(coin)) continue;
    scanned++;

    // Confluence timeframes, keeping the candles so the detectors can reuse them.
    const bars = {}, tfData = {};
    for (const tf of ["1D", "4H", "1H"]) { bars[tf] = await fetchCandles(coin, tf, 260); tfData[tf] = analyzeTF(bars[tf]); }
    try { regimeBreadthTally(REGIME, bars["1D"]); } catch {}   // free: the candles are already here
    // Detector-only timeframes — the BTC 30m top the app missed lived here.
    for (const tf of ["30m", "15m"]) bars[tf] = await fetchCandles(coin, tf, 260);

    // Two independent sources of a trade: the confluence score, and the pattern detectors.
    // Detectors carry no score, so they use the configured minimum — the guards below still bind.
    let sig = scoreCoin(tfData);
    if (sig && sig.score < CFG.minScore()) sig = null;
    if (!sig) {
      // Look at EVERY timeframe and detector, then take the STRONGEST hit — not whichever
      // happened to be checked first. Taking the first match meant a 15m wobble could outrank a
      // clean daily signal, and made the bot fire on ~75% of coins (2026-08-12).
      const TF_WEIGHT = { "1D": 3, "4H": 2.5, "1H": 2, "30m": 1, "15m": 0.5 };
      // rollover raised 1 → 2 (2026-08-13). At 1 it was arithmetically IMPOSSIBLE for a 4H
      // rollover to fire: 2.5 + 1 + 1 = 4.5 against a threshold of 5, so the timeframe John
      // actually trades was silently excluded. That was a side effect of the weights, not a
      // decision. At 2 the reachable set becomes: extreme-zone rollovers on 1D/4H/1H (5.5/5.0/
      // 5.0) and mid-range only on the daily (5.0) — while every sub-1H rollover stays out
      // (30m 4.0, 15m 3.5), which is what MIN_QUALITY was raised to 5 to achieve in the first
      // place. Deliberately the smallest change that reopens 4H without reopening the noise.
      const DET_WEIGHT = { divergence: 3, greendot: 2, rollover: 2 };
      const hits = [];
      for (const tf of ["1D", "4H", "1H", "30m", "15m"]) {
        const c = bars[tf]; if (!c || c.length < 80) continue;
        for (const [nm, fn] of [["divergence", detectWTDivergence], ["rollover", detectMomentumRollover], ["greendot", detectGreenDotMFReversal]]) {
          let r = null; try { r = fn(c); } catch {}
          if (!r || !r.match) continue;
          const bonus = (r.stage === "extreme" || r.stage === "fresh") ? 1 : 0;
          hits.push({ m: r, label: nm, tf, c, q: (TF_WEIGHT[tf] || 1) + (DET_WEIGHT[nm] || 1) + bonus });
        }
      }
      // Ranking alone does NOT reduce how often we trade — a candidate still exists if ANY
      // timeframe fires, and across 5 timeframes that is ~half of all coins. A minimum quality
      // is what actually bites: a bare rollover on a low timeframe is not a trade. At 5.0 the
      // bar is roughly "daily extreme-zone rollover, or a divergence on 4H+" (2026-08-12).
      const MIN_QUALITY = num("MIN_QUALITY", 5);
      if (hits.length) {
        hits.sort((a, b) => b.q - a.q);
        const best = hits[0];
        // ── RANKING EXPERIMENT (shadow) ───────────────────────────────────────────────────────
        // The live rule fires whatever clears MIN_QUALITY, so a hot market gives twenty mediocre
        // trades and a quiet one gives nothing — and a whole day can pass with "quality 4.0 < 5"
        // on every line. The variant asks a different question: of everything the scanner saw
        // this run, which are the BEST few? Threshold vs rank, same signals, graded on the same
        // forward candles. Recorded here whether or not it clears the bar.
        rankPool.push({ coin, dir: best.m.dir, quality: best.q, tf: best.tf, label: best.label,
                        price: best.c[best.c.length - 1].c });
        if (best.q < MIN_QUALITY) {
          await pushLog({ coin, dir: best.m.dir, skipped: `signal too weak — ${best.label} on ${best.tf} (quality ${best.q.toFixed(1)} < ${MIN_QUALITY})` });
        } else {
        sig = { bias: best.m.dir, score: CFG.minScore(),
                ev: [best.m.label || best.label, ...(best.m.ev || [])].slice(0, 4),
                price: best.c[best.c.length - 1].c, planTf: best.tf, detector: best.label,
                alt: hits.length > 1 ? hits.length - 1 : 0 };
        }
      }
    }
    if (!sig) continue;
    candidates++;

    const key = `${coin}|${sig.bias}|${day}`;
    if (fired[key]) continue;
    if ((attempts[key] || 0) >= CFG.maxAttempts()) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: `attempt cap — ${attempts[key]} failed sends today, resting until tomorrow` }); continue; }
    const book = bookFor(sig.planTf || "1D");
    const bcfg = BOOK_CFG[book];
    if (!canSeeBook) { await pushLog({ coin, dir: sig.bias, book, score: sig.score, skipped: "REFUSED — cannot read open positions, so cannot check for an opposing leg" }); continue; }
    // The no-hedge rule lives INSIDE a book. A 4H short while a weekly long runs is not a hedge,
    // it is a different trade on a different horizon — which is the whole point of splitting them.
    if (opposes(book, coin, sig.bias)) { await pushLog({ coin, dir: sig.bias, book, score: sig.score, skipped: `REFUSED — would open a ${sig.bias} against an existing ${sig.bias === "long" ? "short" : "long"} on ${coin} in the ${book} book. This bot does not hedge within a book.` }); continue; }
    if (held.has(book + "|" + coin)) { await pushLog({ coin, dir: sig.bias, book, score: sig.score, skipped: `already holding ${coin} in the ${book} book` }); continue; }
    if (sameDir(book, sig.bias) >= bcfg.corrMax()) { await pushLog({ coin, dir: sig.bias, book, score: sig.score, skipped: `correlation guard — already ${sameDir(book, sig.bias)} ${sig.bias} positions in the ${book} book (max ${bcfg.corrMax()})` }); continue; }
    if (placedInBook[book] + placedToday >= CFG.dayCap() || placedInBook[book] >= bcfg.dayCap()) { await pushLog({ coin, dir: sig.bias, book, score: sig.score, skipped: `daily cap reached for the ${book} book (${bcfg.dayCap()})` }); continue; }

    const planBars = bars[sig.planTf] || await fetchCandles(coin, sig.planTf || "1D", 260);
    const plan = planBars ? buildTradePlan(planBars, sig.bias, sig.price) : null;
    if (!plan) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: "could not build a trade plan" }); continue; }

    const t = { coin, dir: sig.bias, entry: plan.entry, sl: plan.stop, tp1: plan.targets[0], tp2: plan.targets[1], score: sig.score,
                stopKind: plan.stopKind, trend: plan.trend, zone: plan.zone };
    lastPrice[coin] = sig.price;
    const bad = planValid(t);
    if (bad) { await pushLog({ ...t, skipped: "REFUSED — " + bad }); continue; }

    // The breaker blocks NEW entries only — everything above (scan, shadow records) and every
    // risk-reducing pass (exits, expiry, de-hedge) has already run. The coin is not burned for
    // the day: the signal was fine, the account state was not.
    if (BREAKER.paused) { await pushLog({ ...t, skipped: "CIRCUIT BREAKER — " + (BREAKER.st.pausedWhy || "paused") }); continue; }

    const built = buildOrder(t);
    if (built.err) { await pushLog({ ...t, skipped: built.err }); continue; }

    fired[key] = Date.now();
    if (mode === "dry") {
      openedThisRun.push({ book, dir: sig.bias, coin, plan: { entry: t.entry, stop: t.sl, target: t.tp2 ?? t.tp1 } });
      noteOpened(book, coin, sig.bias);    // a dry run must model the same book the armed one would
      held.add(book + "|" + coin); placedInBook[book]++;
      await pushLog({ ...t, qty: built.meta.qty, risk: built.meta.riskActual, clamped: built.meta.clamped || undefined, mode, result: "dry-run OK", thesis: sig.ev.join("; ") + " · plan from " + (sig.planTf || "1D") + (sig.detector ? " · " + sig.detector + " detector" + (sig.alt ? " (best of " + (sig.alt + 1) + " hits)" : "") : " · confluence") });
      placed++; placedToday++;
      continue;
    }
    let r;
    attempts[key] = (attempts[key] || 0) + 1;          // count the send, not the outcome
    try { r = await execOrder(built.order); }
    catch (e) {
      // A hiccup on one coin should cost that coin, not the rest of the sweep.
      delete fired[key];                               // transient — let the next run retry it
      await pushLog({ ...t, qty: built.meta.qty, risk: built.meta.riskActual, clamped: built.meta.clamped || undefined, mode, via: EXEC(), attempt: attempts[key], result: "ERR unreachable — " + String(e && e.message || e).slice(0, 160), diag: { ms: e && e.ms, error: String(e && e.name || "") } });
      continue;
    }
    // An empty 200 is NOT a fill — require the relay to have actually said something back,
    // or a blank response gets logged as a placed trade that doesn't exist.
    const isOK = (x) => x.status === 200 && x.data && !x.data.error && !x.data.parseError && Object.keys(x.data).length > 0;
    let ok = isOK(r), recovered = "";

    // ── VERIFY, THEN RETRY ONCE, ON A 5xx (2026-08-14) ──
    // ~45% of order POSTs come back as a Cloudflare HTML 502 with no correlation to anything
    // about the trade. Ask the exchange whether it landed before doing anything: if it did, the
    // trade is real and we record it rather than firing a duplicate. Only if it genuinely is not
    // there do we send again — one retry, not a loop, so a systemic outage can't machine-gun.
    if (!ok && r.status >= 500) {
      await new Promise(res => setTimeout(res, 1500));   // let the exchange settle before asking
      const chk = await confirmPlaced(built.meta.symbol, built.order.clOrdID, coin);
      if (chk.landed) {
        ok = true; recovered = " (recovered — 502 on the way back, but it " + chk.how + ")";
        if (chk.orderID) r = { status: 200, data: { phemex: { data: { data: { orderID: chk.orderID } } } } };
      } else if ((attempts[key] || 0) < CFG.maxAttempts()) {
        try {
          attempts[key] = (attempts[key] || 0) + 1;
          const r2 = await execOrder(built.order);
          if (isOK(r2)) { r = r2; ok = true; recovered = " (retried after a " + r.status + ")"; }
          else r = r2;
        } catch { /* keep the original failure */ }
      }
    }
    const oid = (r.data?.phemex?.data?.data?.orderID) || "";
    // If the relay answered with something we could not parse, say so and keep the first 200
    // chars. A bare "ERR 502" is undiagnosable after the fact — it hid a relay crash for two
    // days (2026-08-13). The cause must be in the log entry itself, not in a val's console.
    const why = r.data.error || (r.data.parseError ? r.status + " unparseable — " + String(r.data.raw || "").slice(0, 200) : r.status);
    await pushLog({ ...t, qty: built.meta.qty, risk: built.meta.riskActual, clamped: built.meta.clamped || undefined, mode, orderID: oid, entryKind: built.meta.entryKind, stopKind: built.meta.stopKind, book, recovered: recovered ? recovered.trim() : undefined, via: EXEC(), attempt: attempts[key], diag: ok ? undefined : r.diag, result: ok ? (r.data.dryRun ? "dry-run OK" : "PLACED" + recovered) : "ERR " + why, thesis: sig.ev.join("; ") + " · plan from " + (sig.planTf || "1D") + (sig.detector ? " · " + sig.detector + " detector" + (sig.alt ? " (best of " + (sig.alt + 1) + " hits)" : "") : " · confluence") });
    // fired[] was set BEFORE the attempt, so a failed order still burned the coin for the whole
    // day — 17 signals in Aug were lost twice over: no order placed AND no retry. A server-side
    // fault is not a decision, so undo the mark and let the next sweep have another go. A 4xx IS
    // a decision (cap breached, bad symbol) and would just repeat, so that one stays burned.
    if (!ok && r.status >= 500) delete fired[key];
    if (ok) { try { await rememberResting(built.meta, built.order, coin, sig.bias, oid); } catch {}
      placed++; placedToday++; placedInBook[book]++;
      openedThisRun.push({ book, dir: sig.bias, coin, plan: { entry: t.entry, stop: t.sl, target: t.tp2 ?? t.tp1 } });
      held.add(book + "|" + coin); noteOpened(book, coin, sig.bias); }
  }

  // ── SHADOW: record this run's decisions, grade older ones, let the evidence decide ──────────
  try {
    const RANK_TOP_N = num("RANK_TOP_N", 3);
    const planFor = async (x) => {
      const bars = await fetchCandles(x.coin, x.tf || "1D", 260);
      const plan = bars ? buildTradePlan(bars, x.dir, x.price) : null;
      if (!plan) return null;
      const t = { coin: x.coin, dir: x.dir, entry: plan.entry, sl: plan.stop, tp1: plan.targets[0],
                  tp2: plan.targets[1], planTf: x.tf };
      return planValid(t) ? null : t;
    };
    const MINQ = num("MIN_QUALITY", 5);
    const baselineSet = rankPool.filter(x => x.quality >= MINQ);
    const variantSet  = [...rankPool].sort((a, b) => b.quality - a.quality).slice(0, RANK_TOP_N);
    for (const [arm, set] of [["baseline", baselineSet], ["variant", variantSet]]) {
      for (const x of set) {
        const t = await planFor(x);
        if (t) shadowRecord(SHADOW, "rank_vs_threshold", arm, t,
          { quality: +x.quality.toFixed(1), note: x.label,
            reg: REGIME.label, regDist: REGIME.distPct, breadth: REGIME.breadth,
            rs: RS.ok ? RS.rank(x.coin, x.dir) : null });
      }
    }
    const gradedN = await gradeShadow(SHADOW);

    // ── TIME-STOP EXPERIMENT ─────────────────────────────────────────────────────────────────
    // Re-scores the SAME decisions the ranking experiment already recorded, under each candidate
    // window. No extra trades, no extra risk — just a second question asked of the same data:
    // would giving up after N bars have made more R than holding on?
    const tsSlot = shadowSlot(SHADOW, "time_stop");
    tsSlot.arms = tsSlot.arms || {};
    const src = (SHADOW.rank_vs_threshold && SHADOW.rank_vs_threshold.records) || [];
    const byKey = new Map();
    for (const rec of src) {
      if (rec.arm !== "baseline") continue;                       // score the live rule's trades
      const k = rec.coin + "|" + (rec.tf || "1D");
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(rec);
    }
    for (const [k, recs] of byKey) {
      const [coin, tf] = k.split("|");
      let candles = null;
      try { candles = await fetchCandles(coin, tf, 300); } catch {}
      if (!candles) continue;
      for (const rec of recs) {
        for (const n of TIMESTOP_BARS) {
          const key = "bars" + n;
          tsSlot.arms[key] = tsSlot.arms[key] || { sum: 0, n: 0, seen: [] };
          const id = rec.coin + rec.at;
          if (tsSlot.arms[key].seen.includes(id)) continue;
          const R = gradeWithTimeStop(rec, candles, n);
          if (R === null) continue;
          tsSlot.arms[key].sum += R; tsSlot.arms[key].n++;
          tsSlot.arms[key].seen.push(id);
          if (tsSlot.arms[key].seen.length > SHADOW_MAX_RECORDS) tsSlot.arms[key].seen = tsSlot.arms[key].seen.slice(-SHADOW_MAX_RECORDS);
        }
      }
    }
    const holdStats = armStats(src, "baseline");
    const tsLine = TIMESTOP_BARS.map(n => { const a = tsSlot.arms["bars" + n] || { sum: 0, n: 0 };
      return `${n}b ${a.n ? (a.sum / a.n).toFixed(3) : "—"}R (${a.n})`; }).join(" · ");
    console.log(`shadow time_stop: hold-forever ${holdStats.meanR}R (${holdStats.n}) · ${tsLine}`);

    // ── MAKER-ENTRY EXPERIMENT (2026-08-19) ──────────────────────────────────────────────────
    // The same decisions, a fourth question: what would a post-only limit at the signal price
    // have returned, net of fees, against the marketable limit the bot actually sends? Graded on
    // the timeframe below the signal so a fill and a stop can be told apart within the bar.
    const meSlot = shadowSlot(SHADOW, "maker_entry");
    meSlot.arms = meSlot.arms || { taker: { sum: 0, n: 0 }, maker: { sum: 0, n: 0, filled: 0, missed: 0 } };
    meSlot.seen = meSlot.seen || [];
    const meNeed = new Map();
    for (const rec of src) {
      if (rec.arm !== "baseline") continue;
      if (meSlot.seen.includes(rec.coin + rec.at)) continue;
      const gtf = GRADE_TF_BELOW[rec.tf || "1D"] || "1H";
      const mk = rec.coin + "|" + gtf;
      if (!meNeed.has(mk)) meNeed.set(mk, []);
      meNeed.get(mk).push(rec);
    }
    for (const [mk, mrecs] of meNeed) {
      const [coin, gtf] = mk.split("|");
      let candles = null;
      try { candles = await fetchCandles(coin, gtf, 600); } catch { }
      if (!candles) continue;
      for (const rec of mrecs) {
        const g = gradeMakerEntry(rec, candles, CFG.entryExpiryH() || 8);
        if (!g) continue;                       // not settled yet — try again next run
        meSlot.arms.taker.sum += g.takerR; meSlot.arms.taker.n++;
        meSlot.arms.maker.sum += g.makerR; meSlot.arms.maker.n++;
        if (g.filled) meSlot.arms.maker.filled++; else meSlot.arms.maker.missed++;
        meSlot.seen.push(rec.coin + rec.at);
        if (meSlot.seen.length > SHADOW_MAX_RECORDS) meSlot.seen = meSlot.seen.slice(-SHADOW_MAX_RECORDS);
      }
    }
    {
      const a = meSlot.arms, meanME = x => x.n ? (x.sum / x.n).toFixed(3) : "—";
      console.log(`shadow maker_entry: taker ${meanME(a.taker)}R (${a.taker.n}) · maker ${meanME(a.maker)}R (${a.maker.n}: ${a.maker.filled} filled, ${a.maker.missed} missed)`);
    }

    const v = shadowJudge(SHADOW, "rank_vs_threshold");
    await saveShadow(SHADOW);
    console.log(`shadow rank_vs_threshold: baseline ${v.base.n} trades @ ${v.base.meanR}R · variant ${v.varr.n} @ ${v.varr.meanR}R · edge ${v.edge >= 0 ? "+" : ""}${v.edge}R${v.ready ? "" : " (still gathering)"}${v.changed ? " — " + v.changed.toUpperCase() : ""}${gradedN ? ` · graded ${gradedN} this run` : ""}`);
    if (v.changed) await pushLog({ shadow: "rank_vs_threshold", result: v.changed.toUpperCase(),
      skipped: `ranking ${v.changed}: variant ${v.varr.meanR}R vs baseline ${v.base.meanR}R over ${v.varr.n}/${v.base.n} resolved trades` });

    // ── REGIME EXPERIMENT ────────────────────────────────────────────────────────────────────
    // Same decisions again, asked a third question: does it matter which way the market was
    // pointing? Reported every run so the sample builds in the open; believed only when a box
    // wins in both halves of its own history.
    const rv = regimeVerdict(src);
    const boxLine = Object.entries(rv.boxes)
      .map(([k, b]) => `${k} ${b.meanR === null ? "—" : (b.meanR >= 0 ? "+" : "") + b.meanR + "R"} (${b.n})`).join(" · ");
    console.log(`shadow regime_direction: ${boxLine}`);
    if (rv.ready) {
      for (const t of rv.trustworthy) {
        console.log(`  → ${t.box} ${t.sign} consistently: ${t.meanR}R over ${t.n}, and holds in both halves (${t.firstHalf} then ${t.secondHalf})`);
      }
      const prev = shadowSlot(SHADOW, "regime_direction");
      const sig = rv.trustworthy.map(t => t.box + ":" + t.sign).sort().join(",");
      if (prev.lastVerdict !== sig) {
        prev.lastVerdict = sig;
        prev.history.push({ at: Date.now(), changed: "evidence", boxes: rv.boxes, trustworthy: rv.trustworthy });
        await pushLog({ shadow: "regime_direction", result: "EVIDENCE",
          skipped: `regime boxes now stable: ${rv.trustworthy.map(t => `${t.box} ${t.sign} ${t.meanR}R over ${t.n}`).join("; ")}. Still advisory — nothing is filtered.` });
      }
    } else {
      const need = Object.entries(rv.boxes).filter(([, b]) => b.n < REGIME_MIN_PER_BOX * 2).length;
      console.log(`  → still gathering: ${need} of 4 boxes short of ${REGIME_MIN_PER_BOX * 2} resolved trades, and none may be believed until both halves agree`);
    }

    // ── RELATIVE STRENGTH EXPERIMENT ─────────────────────────────────────────────────────────
    const sv = rsVerdict(src);
    console.log('shadow relative_strength: ' + Object.entries(sv.boxes)
      .map(([k, b]) => `${k.slice(3)} ${b.meanR === null ? "—" : (b.meanR >= 0 ? "+" : "") + b.meanR + "R"} (${b.n})`).join(" · "));
    if (sv.ready) {
      for (const t of sv.trustworthy) {
        console.log(`  → ${t.box} ${t.sign} consistently: ${t.meanR}R over ${t.n}, and holds in both halves (${t.firstHalf} then ${t.secondHalf})`);
      }
      const slot = shadowSlot(SHADOW, "relative_strength");
      const sig = sv.trustworthy.map(t => t.box + ":" + t.sign).sort().join(",");
      if (slot.lastVerdict !== sig) {
        slot.lastVerdict = sig;
        slot.history.push({ at: Date.now(), changed: "evidence", boxes: sv.boxes, trustworthy: sv.trustworthy });
        await pushLog({ shadow: "relative_strength", result: "EVIDENCE",
          skipped: `rank boxes now stable: ${sv.trustworthy.map(t => `${t.box} ${t.sign} ${t.meanR}R over ${t.n}`).join("; ")}. Still advisory — nothing is filtered.` });
      }
    }
    // ── INSIGHT SCAN ─────────────────────────────────────────────────────────────────────────
    // Every pre-registered feature, swept over every graded live decision, every run. Insights
    // are reported when stable in both halves; a change in the stable set is logged so it can be
    // seen from the app. Measures only — an insight earns a shadow arm, never a filter, from here.
    const ins = insightScan(src);
    const stable = ins.filter(r => r.stable);
    const gathering = ins.filter(r => !r.stable && r.n < INSIGHT_MIN_N).length;
    if (stable.length) {
      for (const r of stable) {
        console.log(`insight: ${r.feature}=${r.bucket} ${r.meanR >= 0 ? "+" : ""}${r.meanR}R over ${r.n}, holds in both halves (${r.firstHalf} then ${r.secondHalf})`);
      }
    }
    console.log(`insight scan: ${ins.length} buckets watched · ${stable.length} stable · ${gathering} still gathering toward n=${INSIGHT_MIN_N}`);
    {
      const slot = shadowSlot(SHADOW, "insight_scan");
      const sig = stable.map(r => `${r.feature}=${r.bucket}:${r.meanR >= 0 ? "+" : "-"}`).sort().join(",");
      if (slot.lastVerdict !== sig) {
        slot.lastVerdict = sig;
        slot.history.push({ at: Date.now(), changed: "evidence", stable });
        if (stable.length) await pushLog({ shadow: "insight_scan", result: "EVIDENCE",
          skipped: `stable insights now: ${stable.map(r => `${r.feature}=${r.bucket} ${r.meanR}R over ${r.n}`).join("; ")}. Still advisory — nothing is filtered.` });
      }
    }

    // ── THE BRAIN'S EYES: loser autopsy (2026-08-19) ─────────────────────────────────────────
    // One batched call, only when there are new graded losses, hard daily cap, labels only.
    try {
      const bSlot = shadowSlot(SHADOW, "brain_autopsy");
      const fresh = src.filter(r => r.arm === "baseline" && r.R !== null && r.R <= AUTOPSY_MAX_R() && !r.autopsy)
                       .sort((a, b) => a.at - b.at).slice(0, AUTOPSY_BATCH());
      if (!env("ANTHROPIC_API_KEY", "")) {
        if (fresh.length) console.log(`brain autopsy: ${fresh.length} unread loss(es) waiting — no ANTHROPIC_API_KEY secret set, brain is off`);
      } else if (fresh.length && brainBudget(bSlot, Date.now(), null)) {
        const res = await brainCall(buildAutopsyPrompt(fresh));
        if (res) {
          const withinBudget = brainBudget(bSlot, Date.now(), res.usage);
          const labels = parseAutopsy(res.text, fresh.length);
          for (const { i, c, w } of labels) { fresh[i].autopsy = c; fresh[i].autopsyWhy = w; }
          console.log(`brain autopsy: read ${labels.length}/${fresh.length} losses · $${(bSlot.spendUsd || 0).toFixed(3)} of $${num("BRAIN_DAILY_USD", 0.25)} today${withinBudget ? "" : " — cap reached, brain rests until tomorrow"}`);
        }
      } else if (fresh.length) {
        console.log(`brain autopsy: ${fresh.length} unread loss(es) held — daily cap $${num("BRAIN_DAILY_USD", 0.25)} already spent`);
      }
      // report the failure modes whether or not the brain ran this cycle
      const vc = vetoCandidates(src);
      if (vc.length) {
        console.log("brain vetoes: " + vc.map(v => `${v.cause} ${v.meanR}R (${v.n}${v.candidate ? " CANDIDATE" : ""})`).join(" · "));
        const sig = vc.filter(v => v.candidate).map(v => v.cause).sort().join(",");
        if (bSlot.lastVerdict !== sig) {
          bSlot.lastVerdict = sig;
          bSlot.history.push({ at: Date.now(), changed: "evidence", candidates: vc.filter(v => v.candidate) });
          if (sig) await pushLog({ shadow: "brain_autopsy", result: "EVIDENCE",
            skipped: `recurring failure modes: ${vc.filter(v => v.candidate).map(v => `${v.cause} (${v.n} trades, ${v.meanR}R)`).join("; ")}. Advisory only — a veto must be written as a mechanical rule and win a shadow arm before it can block anything.` });
        }
      }
    } catch (e) { console.error("brain autopsy failed (harmless, labels only):", e && e.message); }

    await saveShadow(SHADOW);
  } catch (e) { console.error("shadow pass failed (harmless, no orders involved):", e && e.message); }

  // ── Resolutions → the reverse look ─────────────────────────────────────────────────────────
  try {
    const nowOpen = snapshotOpen(positions, bookMap, prevOpen);
    // Attach the plan to anything opened this run, so the NEXT run can tell how it ended. Without
    // this a resolution is just "gone" — with it we can say target, stop, or neither.
    for (const o of openedThisRun) {
      const k = posKey(o.coin, o.dir);
      if (!nowOpen[k]) nowOpen[k] = { coin: o.coin, dir: o.dir, size: 0, book: o.book, since: Date.now() };
      nowOpen[k].plan = o.plan || nowOpen[k].plan || null;
      nowOpen[k].book = o.book;
    }
    // Anything held with no plan gets adopted — see adoptOrphans. Bookkeeping only, no orders.
    const adopted = await adoptOrphans(nowOpen, bookMap);
    if (adopted.length) console.log(`adopted ${adopted.length} plan-less position(s): ${adopted.map(p => p.coin + " " + p.dir).join(", ")} — plan and book attached, no orders placed`);
    // ── AND THE ONES IT COULD NOT ADOPT ─────────────────────────────────────────────────────
    // Reported EVERY run, not once when it appeared. A warning you have to have been watching
    // for is not a warning; this is money sitting at the venue with no stop on it, and it stays
    // on the screen until it is gone. Recorded on state so the app panel shows it too.
    const orphans = Object.values(nowOpen).filter(p => p && !p.plan && p.size > 0);
    await setJSON(ORPHAN_KEY, orphans.map(p => ({
      coin: p.coin, dir: p.dir, size: p.size, avgEntry: p.avgEntry,
      notional: (Number(p.size) || 0) * (Number(p.avgEntry) || 0), since: p.since })));
    if (orphans.length) {
      console.error(`⚠ ${orphans.length} UNPROTECTED position(s) — no stop, no target, not in any book: ` +
        orphans.map(p => `${p.coin} ${p.dir} ${p.size} (~${((Number(p.size)||0)*(Number(p.avgEntry)||0)).toFixed(0)} USDT)`).join(", "));
    }
    // The range each resolved position traded through since we last saw it, so a target that was
    // hit and given back before the next run still reads as a target rather than as "closed".
    const ranges = {};
    for (const k of Object.keys(prevOpen || {})) {
      if (nowOpen[k]) continue;
      const coin = prevOpen[k].coin;
      if (ranges[coin]) continue;
      try {
        const c = await fetchCandles(coin, "15m", 96);        // ~24h, far more than any run gap
        const since = Number(prevOpen[k].lastSeen) || (Date.now() - 6 * 36e5);
        const win = (c || []).filter(b => b.t >= since - 36e5);
        if (win.length) ranges[coin] = { hi: Math.max(...win.map(b => b.h)), lo: Math.min(...win.map(b => b.l)) };
      } catch { /* no range — classifyResolution falls back to the snapshot and says so */ }
    }
    const resolved = resolvedSince(prevOpen, nowOpen, priceOf, c => ranges[c] || null);
    const queue = [];
    for (const r of resolved) {
      const line = `${r.coin} ${r.dir} ${r.how}${Number.isFinite(r.exit) ? " at " + formatPrice(r.exit) : ""}`;
      await pushLog({ coin: r.coin, dir: r.dir, book: r.book || undefined,
        result: r.klass === "execution_artifact" ? "RESOLVED (not counted)" : "RESOLVED",
        skipped: `${line} — ${r.why}` +
          (r.klass === "execution_artifact"
            ? " This is an EXECUTION ARTIFACT: it does not count toward the loss streak or the strategy's record."
            : r.how === "target" ? " Target hit, queued for a reverse look." : "") });
      delete bookMap[posKey(r.coin, r.dir)];
      if (r.how === "target") queue.push(r.coin);
    }
    if (queue.length) await setJSON(PRIORITY_KEY, queue);
    // Stamp when each open position was last seen, so the next resolution knows how far back to
    // look for its range. Without this the window is a guess.
    const seenAt = Date.now();
    for (const v of Object.values(nowOpen)) if (v) v.lastSeen = seenAt;
    await setJSON(OPEN_KEY, nowOpen);
    if (resolved.length) console.log(`resolved: ${resolved.map(r => `${r.coin} ${r.how}${r.klass === "execution_artifact" ? " (artifact, not counted)" : ""}`).join(", ")}`);

    // ── ONLY REAL STRATEGY OUTCOMES REACH THE BREAKER (2026-08-20) ─────────────────────────
    // The circuit breaker exists to stop the bot re-asking a market that keeps saying no. A
    // rejected order, a hand-closed position or an unrecoverable ambiguity is not the market
    // saying no — it is the plumbing, or you, and pausing trading over it would be the breaker
    // firing at a phantom. Artifacts are logged in full above and consumed by nothing.
    const strategyOutcomes = resolved.filter(r => r.countsForStreak);
    const artifacts = resolved.filter(r => r.klass === "execution_artifact");
    if (artifacts.length) console.log(`  ${artifacts.length} of those were execution artifacts and count toward nothing: ${artifacts.map(r => r.coin + " " + r.how).join(", ")}`);
    if (strategyOutcomes.length) {
      const bst = await getJSON(BREAKER_KEY, {});
      const b = breakerStep(bst, { now: Date.now(), equity: null, resolvedHows: strategyOutcomes.map(r => r.how) });
      await setJSON(BREAKER_KEY, b.st);
      if (b.trips.includes("streak")) {
        console.log(`CIRCUIT BREAKER TRIPPED (streak): ${b.st.pausedWhy}`);
        await pushLog({ result: "BREAKER", skipped: b.st.pausedWhy });
      }
    }
  } catch (e) { console.error("resolution pass failed (no orders involved):", e && e.message); }

  // ── THE ACCUMULATOR ─────────────────────────────────────────────────────────────────────────
  // The second objective: units, not money. It also runs on the MODE=off path above, so this
  // call is for the normal scan path only. See runAccumulator for why the two are separate.
  await runAccumulator();

  await setJSON(BOOKMAP_KEY, bookMap);
  await setJSON(KEY.fired, fired);
  await setJSON("cipher_attempts", attempts);
  await setJSON("cipher_heartbeat", { at: new Date().toISOString(), scanned, candidates, placed, mode, via: EXEC(), ms: Date.now() - started });
  console.log(`cipher-agent: scanned ${scanned}, ${candidates} candidates, ${placed} placed (${mode}, via ${EXEC()}) in ${Date.now() - started}ms`);
}

// ── HTTP view: the app reads these so the Bot Trades panel can show server decisions ──
// Deploy this as a SECOND (HTTP) val importing { agentHttp } from this file, or split it out.
export async function agentHttp(req) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization" };
  const auth = req.headers.get("Authorization") || "";
  if (auth !== "Bearer " + env("AGENT_TOKEN", "")) return new Response("unauthorised", { status: 401, headers: cors });
  const body = {
    heartbeat: await getJSON("cipher_heartbeat", null),
    decisions: await getJSON(KEY.log, []),
    mode: CFG.mode(),
  };
  return new Response(JSON.stringify(body), { headers: { ...cors, "Content-Type": "application/json" } });
}

// ── Node / GitHub Actions entry point ──────────────────────────────────────────────────────
// On Val Town the default export is invoked by the cron. Under Node nothing calls it, so run it
// here and exit non-zero on failure so a broken run shows as a red tick rather than passing quietly.
if (!IS_DENO && typeof process !== "undefined") {
  cipherAgent()
    .then(() => process.exit(0))
    .catch((e) => { console.error("cipher-agent failed:", e && (e.stack || e.message || e)); process.exit(1); });
}
