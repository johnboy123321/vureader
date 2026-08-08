// ═══════════════════════════════════════════════════════════════════════════
// CIPHER → BYBIT DEMO RELAY (Val Town HTTP val)
// Drop-in replacement for the Phemex testnet relay: the app keeps sending the
// exact same requests and reading the exact same response shapes — this val
// translates them to Bybit V5 and back. Nothing in the app changes.
//
// Endpoints (unchanged): POST /order · GET /positions · POST /panic · GET /status
// Env vars needed:       BYBIT_KEY, BYBIT_SECRET  (from your Bybit DEMO account)
//                        AUTH_TOKEN               (keep the existing one)
// Optional:              KILL=1 (halt), DRY_RUN=1, MAX_NOTIONAL_USDT, WHITELIST
// ═══════════════════════════════════════════════════════════════════════════

// DEMO TRADING — locked. Live is api.bybit.com; do NOT change until the ledger
// has earned it (50+ trades, positive expectancy after fees).
const BASE = "https://api-demo.bybit.com";

const DEFAULTS = {
  MAX_NOTIONAL_USDT: "2000",
  WHITELIST:
    "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT,LTCUSDT,BCHUSDT,UNIUSDT,ATOMUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,SUIUSDT,TONUSDT,TRXUSDT,POLUSDT,FILUSDT,INJUSDT,AAVEUSDT",
};
const cfg = (k) => {
  const v = Deno.env.get(k);
  return v === undefined || v === null || v === "" ? DEFAULTS[k] : v;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// ── Bybit V5 signing: HMAC-SHA256 hex of (timestamp + apiKey + recvWindow + payload) ──
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function bybit(method, path, params) {
  const key = Deno.env.get("BYBIT_KEY"), sec = Deno.env.get("BYBIT_SECRET");
  if (!key || !sec) return { status: 500, data: { retCode: -1, retMsg: "BYBIT_KEY / BYBIT_SECRET env vars not set on the val" } };
  const ts = Date.now().toString(), rw = "5000";
  let url = BASE + path, body;
  let payload;
  if (method === "GET") {
    const qs = new URLSearchParams(params || {}).toString();
    if (qs) url += "?" + qs;
    payload = ts + key + rw + qs;
  } else {
    body = JSON.stringify(params || {});
    payload = ts + key + rw + body;
  }
  const sign = await hmacHex(sec, payload);
  const res = await fetch(url, {
    method,
    headers: {
      "X-BAPI-API-KEY": key,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": rw,
      "X-BAPI-SIGN": sign,
      "Content-Type": "application/json",
    },
    body,
  });
  // Keep the raw body: when Bybit (or a CDN in front of it) answers with HTML,
  // the status + first slice of the body is the only thing that identifies the cause.
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    data = { retCode: -1, retMsg: `non-JSON reply from Bybit — HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 300).replace(/\s+/g, " ")}` };
  }
  return { status: res.status, data };
}

export default async function (req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // ── auth ──
  const auth = req.headers.get("Authorization") || "";
  const token = Deno.env.get("AUTH_TOKEN") || "";
  if (!token || auth !== "Bearer " + token) return json({ error: "unauthorised" }, 401);

  if (!Deno.env.get("KILL")) console.warn('WARNING: "KILL" is not set. Set Environment Variables KILL=1 to halt all trading instantly.');

  // ── /status ──
  if (path === "/status") {
    return json({
      exchange: "bybit-demo",
      live: false,
      base: BASE,
      dryRun: cfg("DRY_RUN") === "1",
      kill: cfg("KILL") === "1",
      maxNotional: Number(cfg("MAX_NOTIONAL_USDT")),
      whitelist: String(cfg("WHITELIST")).split(",").map((s) => s.trim()),
    });
  }

  // ── /positions — mapped to the Phemex-ish shape the app already parses ──
  if (path === "/positions") {
    const r = await bybit("GET", "/v5/position/list", { category: "linear", settleCoin: "USDT" });
    const list = (r.data && r.data.result && r.data.result.list) || [];
    const positions = list.map((p) => ({
      symbol: p.symbol,
      posSide: p.side === "Buy" ? "Long" : p.side === "Sell" ? "Short" : "None",
      size: p.size,
      avgEntryPriceRp: p.avgPrice,
      markPriceRp: p.markPrice,
      unRealisedPnlRv: p.unrealisedPnl,
      leverageRr: p.leverage,
      stopLossRp: p.stopLoss,
      takeProfitRp: p.takeProfit,
    }));
    return json({ data: { data: { positions } }, bybit: { retCode: r.data.retCode, retMsg: r.data.retMsg } });
  }

  // ── /panic — cancel every resting order ──
  if (path === "/panic" && req.method === "POST") {
    const r = await bybit("POST", "/v5/order/cancel-all", { category: "linear", settleCoin: "USDT" });
    return json({ ok: r.data.retCode === 0, bybit: r.data });
  }

  // ── /order — Phemex-style order in, Bybit V5 out ──
  if (path === "/order" && req.method === "POST") {
    if (cfg("KILL") === "1") return json({ error: "KILL is set — all trading halted" }, 403);
    let o;
    try { o = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }

    const symbol = String(o.symbol || "").toUpperCase();
    const side = o.side; // Buy | Sell
    const ordType = o.ordType === "Market" ? "Market" : "Limit";
    const qty = Number(o.orderQtyRq);
    const refPx = Number(o.refPx || o.priceRp);
    const stopLossRp = o.stopLossRp != null ? String(o.stopLossRp) : undefined;

    const whitelist = String(cfg("WHITELIST")).split(",").map((s) => s.trim().toUpperCase());
    if (!whitelist.includes("*") && !whitelist.includes(symbol)) return json({ error: `symbol ${symbol} not in whitelist` }, 403);
    if (!(qty > 0)) return json({ error: "orderQtyRq must be > 0" }, 400);
    if (side !== "Buy" && side !== "Sell") return json({ error: "side must be Buy or Sell" }, 400);
    if (!stopLossRp) return json({ error: "refusing order with no stop loss" }, 400);
    if (!(refPx > 0)) return json({ error: "refPx required to size-check the order" }, 400);

    const notional = qty * refPx;
    const cap = Number(cfg("MAX_NOTIONAL_USDT"));
    if (notional > cap) return json({ error: `notional ${notional.toFixed(0)} USDT exceeds cap ${cap}` }, 403);

    // Bybit wants qty as a string and respects per-symbol lot steps — 4 significant
    // figures keeps within step size for the liquid pairs without going to zero.
    const qtyStr = String(Number(qty.toPrecision(4)));

    const order = {
      category: "linear",
      symbol,
      side,
      orderType: ordType,
      qty: qtyStr,
      timeInForce: o.timeInForce === "ImmediateOrCancel" ? "IOC" : "GTC",
      positionIdx: 0, // one-way mode (Bybit demo default) — long+short across DIFFERENT symbols is fine
      stopLoss: stopLossRp,
      takeProfit: o.takeProfitRp != null ? String(o.takeProfitRp) : undefined,
      orderLinkId: o.clOrdID ? String(o.clOrdID).slice(0, 36) : undefined,
    };
    if (ordType === "Limit") order.price = String(o.priceRp);

    if (cfg("DRY_RUN") === "1") return json({ dryRun: true, wouldSend: order });

    const r = await bybit("POST", "/v5/order/create", order);
    const ok = r.data.retCode === 0;
    // Wrap in the Phemex-shaped envelope the app's displays already read.
    const mapped = {
      code: r.data.retCode,
      msg: r.data.retMsg,
      data: { orderID: ok ? r.data.result.orderId : undefined, ordStatus: ok ? "Created" : "Rejected" },
    };
    if (!ok) return json({ error: "bybit " + r.data.retCode + ": " + r.data.retMsg, phemex: { data: mapped } });
    return json({ ok: true, phemex: { data: mapped }, bybit: r.data });
  }

  return json({ error: "unknown endpoint " + path }, 404);
}
