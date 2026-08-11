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
};

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
const VMC = { chlen: 9, avg: 12, malen: 3, osLevel: -53, obLevel: 53, osLevel2: -60, obLevel2: 60, mfiPeriod: 60, mfiMult: 150, mfiPosY: 2.5 };

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
const TF_MS = { "15m": 9e5, "1H": 36e5, "4H": 144e5, "1D": 864e5, "1W": 6048e5 };
function dropUnclosed(arr, tf) {
  if (!arr || !arr.length) return arr;
  const ms = TF_MS[tf]; if (!ms) return arr;
  const t = +arr[arr.length - 1].t;
  return (Number.isFinite(t) && (t + ms) > Date.now()) ? arr.slice(0, -1) : arr;
}
async function fetchCandles(sym, tf, bars = 260) {
  const s = String(sym).toUpperCase().replace(/USDT$/, "");
  const binInt = { "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" }[tf];
  const okxBar = { "15m": "15m", "1H": "1H", "4H": "4H", "1D": "1Dutc", "1W": "1Wutc" }[tf];
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${s}USDT&interval=${binInt}&limit=${Math.min(bars, 1000)}`);
    if (r.ok) { const d = await r.json(); if (Array.isArray(d) && d.length) return dropUnclosed(d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })), tf); }
  } catch { /* fall through to OKX */ }
  try {
    const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${s}-USDT&bar=${okxBar}&limit=${Math.min(bars, 300)}`);
    if (r.ok) { const j = await r.json(); if (j.data && j.data.length) return dropUnclosed(j.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse(), tf); }
  } catch { /* no data */ }
  return null;
}
async function topUniverse(n) {
  const EXCL = /(UP|DOWN|BULL|BEAR)$/;
  const STABLE = new Set(["USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP", "USTC", "EUR", "GBP", "AEUR", "PAXG", "USDT", "EURI"]);
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (r.ok) {
      const d = await r.json();
      return d.filter(x => x.symbol.endsWith("USDT"))
        .map(x => ({ sym: x.symbol.slice(0, -4), vol: parseFloat(x.quoteVolume) }))
        .filter(x => x.sym && !EXCL.test(x.sym) && !STABLE.has(x.sym) && Number.isFinite(x.vol))
        .sort((a, b) => b.vol - a.vol).map(x => x.sym).slice(0, n);
    }
  } catch { /* fall through */ }
  return ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "LINK", "AVAX", "DOT"];
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
function buildOrder(t) {
  const symbol = String(t.coin).toUpperCase() + "USDT";
  const entry = +t.entry, sl = +t.sl, tp1 = +t.tp1;
  const stopDist = Math.abs(entry - sl); if (!(stopDist > 0)) return { err: "zero stop distance" };
  const qty = roundQty(CFG.risk() / stopDist); if (!(qty > 0)) return { err: "computed qty <= 0" };
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
    meta: { symbol, qty, exitPx },
  };
}

// ═══════════════════════ RELAY ═══════════════════════
async function relay(path, body) {
  const url = CFG.relayUrl(); if (!url) throw new Error("RELAY_URL not set");
  const res = await fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + CFG.relayToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = { raw: await res.text() }; }
  return { status: res.status, data };
}
async function openPositions() {
  try { const r = await relay("/positions"); return ((r.data && r.data.data && r.data.data.positions) || []).filter(p => Number(p.size) > 0); }
  catch { return []; }
}

async function pushLog(entry) {
  const log = await getJSON(KEY.log, []);
  log.unshift({ at: new Date().toISOString(), ...entry });
  await setJSON(KEY.log, log.slice(0, 300));
}

// ═══════════════════════ THE LOOP ═══════════════════════
export default async function cipherAgent() {
  const started = Date.now();
  const mode = CFG.mode();
  if (mode === "off") { console.log("MODE=off — agent idle"); return; }

  // Rotate through the universe a batch at a time so every run finishes well inside 60s.
  const uni = await topUniverse(CFG.universe());
  const cursor = await getJSON(KEY.cursor, 0);
  const batch = Math.max(5, CFG.batch());
  const slice = [];
  for (let i = 0; i < batch; i++) slice.push(uni[(cursor + i) % uni.length]);
  await setJSON(KEY.cursor, (cursor + batch) % uni.length);

  // Day-scoped dedupe: one trade per coin+direction per day, same as the app.
  const day = new Date().toISOString().slice(0, 10);
  let fired = await getJSON(KEY.fired, {});
  for (const k of Object.keys(fired)) if (!k.endsWith(day)) delete fired[k];

  const positions = await openPositions();
  const held = new Set(positions.map(p => String(p.symbol || "").replace(/USDT$/, "").toUpperCase()));
  const sameDir = dir => positions.filter(p => String(p.posSide || p.side || "").toLowerCase() === dir).length;

  const log24 = (await getJSON(KEY.log, [])).filter(e => e.result === "PLACED" || e.result === "dry-run OK");
  const dayAgo = Date.now() - 864e5;
  let placedToday = log24.filter(e => new Date(e.at).getTime() > dayAgo).length;

  let scanned = 0, candidates = 0, placed = 0;

  for (const coin of slice) {
    if (Date.now() - started > 45000) { console.log("time budget reached — stopping early"); break; }
    if (!coin || NOT_CRYPTO.test(coin)) continue;
    scanned++;

    const tfData = {};
    for (const tf of ["1D", "4H", "1H"]) tfData[tf] = analyzeTF(await fetchCandles(coin, tf, 260));
    const sig = scoreCoin(tfData);
    if (!sig || sig.score < CFG.minScore()) continue;
    candidates++;

    const key = `${coin}|${sig.bias}|${day}`;
    if (fired[key]) continue;
    if (held.has(coin)) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: "already holding this coin" }); continue; }
    if (sameDir(sig.bias) >= CFG.corrMax()) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: `correlation guard — already ${sameDir(sig.bias)} ${sig.bias} positions` }); continue; }
    if (placedToday >= CFG.dayCap()) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: `daily cap reached (${CFG.dayCap()})` }); break; }

    const planBars = await fetchCandles(coin, sig.planTf || "1D", 260);
    const plan = planBars ? buildTradePlan(planBars, sig.bias, sig.price) : null;
    if (!plan) { await pushLog({ coin, dir: sig.bias, score: sig.score, skipped: "could not build a trade plan" }); continue; }

    const t = { coin, dir: sig.bias, entry: plan.entry, sl: plan.stop, tp1: plan.targets[0], tp2: plan.targets[1], score: sig.score };
    const bad = planValid(t);
    if (bad) { await pushLog({ ...t, skipped: "REFUSED — " + bad }); continue; }

    const built = buildOrder(t);
    if (built.err) { await pushLog({ ...t, skipped: built.err }); continue; }

    fired[key] = Date.now();
    if (mode === "dry") {
      await pushLog({ ...t, qty: built.meta.qty, mode, result: "dry-run OK", thesis: sig.ev.join("; ") + " · plan from " + (sig.planTf || "1D") });
      placed++; placedToday++;
      continue;
    }
    const r = await relay("/order", built.order);
    const ok = r.status === 200 && !r.data.error;
    const oid = (r.data?.phemex?.data?.data?.orderID) || "";
    await pushLog({ ...t, qty: built.meta.qty, mode, orderID: oid, result: ok ? (r.data.dryRun ? "dry-run OK" : "PLACED") : "ERR " + (r.data.error || r.status), thesis: sig.ev.join("; ") + " · plan from " + (sig.planTf || "1D") });
    if (ok) { placed++; placedToday++; }
  }

  await setJSON(KEY.fired, fired);
  await setJSON("cipher_heartbeat", { at: new Date().toISOString(), scanned, candidates, placed, mode, ms: Date.now() - started });
  console.log(`cipher-agent: scanned ${scanned}, ${candidates} candidates, ${placed} placed (${mode}) in ${Date.now() - started}ms`);
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
