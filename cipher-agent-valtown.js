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
  const binInt = { "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" }[tf];
  const okxBar = { "15m": "15m", "30m": "30m", "1H": "1H", "4H": "4H", "1D": "1Dutc", "1W": "1Wutc" }[tf];
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
  // A structure stop can be enormous on a volatile coin — ADA came out 14.4% away, giving a
  // 32% target from a momentum cross that has no edge over a move that size. If structure
  // demands more than 3 ATR, the setup is not tradeable on this timeframe: refuse it rather
  // than stretch the plan to fit (2026-08-12).
  if (Math.abs(entry - stop) > 3 * a) return null;
  const risk = Math.abs(entry - stop); if (!(risk > 0)) return null;
  const sgn = dir === "short" ? -1 : 1;
  return { entry, stop, risk, targets: [1, 2.25, 4].map(m => entry + sgn * risk * m) };
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
  if (dist < 0.003) return `stop only ${(dist * 100).toFixed(2)}% from entry — too tight`;
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
  const stopDist = Math.abs(entry - sl); if (!(stopDist > 0)) return { err: "zero stop distance" };
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
    const maxQty = roundQty((RELAY_CAP * 0.98) / entry);   // 2% headroom absorbs qty rounding
    if (maxQty > 0 && qty > maxQty) { qty = maxQty; clamped = true; }
    if (!(qty > 0)) return { err: "notional cap leaves no tradeable size" };
  }
  const riskActual = +(qty * stopDist).toFixed(2);
  const isLong = (t.dir || "long") === "long";
  const cross = roundPx(isLong ? entry * 1.01 : entry * 0.99);
  // Exit at T2 (2.25R), not T1. T1 is 1R by construction, but every backtest and the discovery
  // lab validate a ~2R exit — at a 35% win rate that is the difference between −0.30R and +0.14R
  // per trade. Mirrors the app's fix (2026-08-09).
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
    meta: { symbol, qty, exitPx, riskActual, clamped },
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

// null = "I could not read the book". [] = "the book is genuinely empty". Never conflate them:
// a non-200, or a 200 whose body contains no positions array at all, is a FAILED read, and the
// caller must be able to tell. Returning [] on a 502 is what let opposing legs stack up.
async function execPositions() {
  const r = CFG.direct()
    ? await phemexCall("GET", "/g-accounts/accountPositions", "currency=USDT", null)
    : await relay("/positions");
  if (r.status !== 200) { console.error("positions read: HTTP " + r.status); return null; }
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
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
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
  // KILL from the panel stops the agent placing at all. The relay enforces it independently on
  // the order path, so this is the polite half of the switch, not the whole of it.
  if (c.kill === true) { CFG.mode = () => "off"; applied.push("KILL=on"); }
  return applied;
}

// ═══════════════════════ THE LOOP ═══════════════════════
export default async function cipherAgent() {
  const started = Date.now();
  LIVE = await loadLiveConfig();
  const applied = applyLiveConfig(LIVE);
  if (applied.length) console.log("live config from the app: " + applied.join(", "));
  const mode = CFG.mode();
  if (mode === "off") { console.log(`MODE=off — agent idle${LIVE && LIVE.kill ? " (KILL is ON from the app)" : ""}`); return; }

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
  for (let i = 0; i < batch && seenThisRun.size < uni.length; i++) {
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
  const held = new Set(positions.map(p => String(p.symbol || "").replace(/USDT$/, "").toUpperCase()));

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
  const heldDir = new Map();                      // COIN → Set("long"|"short")
  for (const p of positions) {
    const coin = String(p.symbol || "").replace(/USDT$/, "").toUpperCase();
    // Phemex reports posSide Long/Short in hedge mode; fall back to side, then to a signed size.
    let d = String(p.posSide || p.side || "").toLowerCase();
    if (d !== "long" && d !== "short") d = Number(p.size) < 0 ? "short" : "long";
    if (!heldDir.has(coin)) heldDir.set(coin, new Set());
    heldDir.get(coin).add(d);
  }
  const opposes = (coin, dir) => {
    const other = dir === "long" ? "short" : "long";
    return heldDir.has(coin) && heldDir.get(coin).has(other);
  };
  const noteOpened = (coin, dir) => {
    if (!heldDir.has(coin)) heldDir.set(coin, new Set());
    heldDir.get(coin).add(dir);
  };
  const dupes = [...heldDir].filter(([, s]) => s.size > 1).map(([c]) => c);
  if (dupes.length) console.log(`WARNING: ${dupes.length} coin(s) already hold BOTH sides — ${dupes.join(", ")}. Not adding to them.`);
  // Positions are read ONCE per run, so trades opened during this run must be counted too —
  // otherwise a single pass can stack far past CORR_MAX before the next run notices. Found when
  // the ported detectors made one run place 10 orders (2026-08-11).
  const openedThisRun = [];
  const sameDir = dir => positions.filter(p => String(p.posSide || p.side || "").toLowerCase() === dir).length
                       + openedThisRun.filter(d => d === dir).length;

  const log24 = (await getJSON(KEY.log, [])).filter(e => e.result === "PLACED" || e.result === "dry-run OK");
  const dayAgo = Date.now() - 864e5;
  let placedToday = log24.filter(e => new Date(e.at).getTime() > dayAgo).length;

  let scanned = 0, candidates = 0, placed = 0;

  for (const coin of slice) {
    if (Date.now() - started > 45000) { console.log("time budget reached — stopping early"); break; }
    if (!coin || NOT_CRYPTO.test(coin)) continue;
    scanned++;

    // Confluence timeframes, keeping the candles so the detectors can reuse them.
    const bars = {}, tfData = {};
    for (const tf of ["1D", "4H", "1H"]) { bars[tf] = await fetchCandles(coin, tf, 260); tfData[tf] = analyzeTF(bars[tf]); }
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
    if (!canSeeBook) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: "REFUSED — cannot read open positions, so cannot check for an opposing leg" }); continue; }
    if (opposes(coin, sig.bias)) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: `REFUSED — would open a ${sig.bias} against an existing ${sig.bias === "long" ? "short" : "long"} on ${coin}. This bot does not hedge.` }); continue; }
    if (held.has(coin)) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: "already holding this coin" }); continue; }
    if (sameDir(sig.bias) >= CFG.corrMax()) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: `correlation guard — already ${sameDir(sig.bias)} ${sig.bias} positions` }); continue; }
    if (placedToday >= CFG.dayCap()) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: `daily cap reached (${CFG.dayCap()})` }); break; }

    const planBars = bars[sig.planTf] || await fetchCandles(coin, sig.planTf || "1D", 260);
    const plan = planBars ? buildTradePlan(planBars, sig.bias, sig.price) : null;
    if (!plan) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: "could not build a trade plan" }); continue; }

    const t = { coin, dir: sig.bias, entry: plan.entry, sl: plan.stop, tp1: plan.targets[0], tp2: plan.targets[1], score: sig.score };
    const bad = planValid(t);
    if (bad) { await pushLog({ ...t, skipped: "REFUSED — " + bad }); continue; }

    const built = buildOrder(t);
    if (built.err) { await pushLog({ ...t, skipped: built.err }); continue; }

    fired[key] = Date.now();
    if (mode === "dry") {
      openedThisRun.push(sig.bias);
      noteOpened(coin, sig.bias);          // a dry run must model the same book the armed one would
      held.add(coin);
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
    await pushLog({ ...t, qty: built.meta.qty, risk: built.meta.riskActual, clamped: built.meta.clamped || undefined, mode, orderID: oid, recovered: recovered ? recovered.trim() : undefined, via: EXEC(), attempt: attempts[key], diag: ok ? undefined : r.diag, result: ok ? (r.data.dryRun ? "dry-run OK" : "PLACED" + recovered) : "ERR " + why, thesis: sig.ev.join("; ") + " · plan from " + (sig.planTf || "1D") + (sig.detector ? " · " + sig.detector + " detector" + (sig.alt ? " (best of " + (sig.alt + 1) + " hits)" : "") : " · confluence") });
    // fired[] was set BEFORE the attempt, so a failed order still burned the coin for the whole
    // day — 17 signals in Aug were lost twice over: no order placed AND no retry. A server-side
    // fault is not a decision, so undo the mark and let the next sweep have another go. A 4xx IS
    // a decision (cap breached, bad symbol) and would just repeat, so that one stays burned.
    if (!ok && r.status >= 500) delete fired[key];
    if (ok) { placed++; placedToday++; openedThisRun.push(sig.bias); held.add(coin); noteOpened(coin, sig.bias); }
  }

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
