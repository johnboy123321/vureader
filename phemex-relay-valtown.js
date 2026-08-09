// ═══════════════════════════════════════════════════════════════════════
//  CIPHER PHEMEX EXECUTION RELAY  —  Val Town HTTP val (testnet signer)
//  ---------------------------------------------------------------------
//  Same job as the Cloudflare worker: the app NEVER sees your Phemex key.
//  It sends a plain "place this trade" request here; this val holds the key,
//  signs it, and forwards to Phemex.
//
//  HOW TO USE ON VAL TOWN:
//   1. Create a new HTTP val, paste this whole file in.
//   2. In the val's settings → Environment Variables, add (as secrets):
//        PHEMEX_KEY, PHEMEX_SECRET, AUTH_TOKEN
//      and optionally: KILL, DRY_RUN, MAX_NOTIONAL_USDT, WHITELIST
//   3. Copy the val's HTTP URL — that's what the app points at.
//
//  SAFETY (all enforced HERE — the app cannot override it):
//   • BASE is hard-locked to Phemex TESTNET. Going live = editing one line.
//   • KILL=1 refuses every order instantly.
//   • DRY_RUN=1 signs + validates but sends nothing (returns what it WOULD send).
//   • MAX_NOTIONAL_USDT caps any single order (qty × refPx).
//   • WHITELIST limits which symbols can ever trade.
//   • Refuses any order that has no stop loss. Ever.
// ═══════════════════════════════════════════════════════════════════════

// ── HARD LOCK: testnet only. Changing this is the deliberate go-live step. ──
const BASE = "https://testnet-api.phemex.com";
// LIVE (do NOT use until testnet is proven for weeks):
// const BASE = "https://api.phemex.com";

const DEFAULTS = {
  MAX_NOTIONAL_USDT: "200",
  // Widened 2026-08-08 for the testnet data-gathering phase ("let it fly" — play money only).
  // Tighten this back down before BASE ever changes to live. "*" would allow any symbol.
  WHITELIST: "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT,LTCUSDT,BCHUSDT,UNIUSDT,ATOMUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,SUIUSDT,TONUSDT,TRXUSDT,POLUSDT,FILUSDT,INJUSDT,AAVEUSDT",
};
const cfg = (k) => {
  const v = Deno.env.get(k);
  return (v === undefined || v === null || v === "") ? DEFAULTS[k] : v;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── HMAC-SHA256 → lowercase hex, per Phemex spec ──
async function sign(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function phemex(method, path, query, bodyObj) {
  const expiry = Math.floor(Date.now() / 1000) + 60;
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const message = path + (query || "") + expiry + bodyStr; // Phemex signing string
  const signature = await sign(cfg("PHEMEX_SECRET"), message);
  const res = await fetch(BASE + path + (query ? "?" + query : ""), {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-phemex-access-token": cfg("PHEMEX_KEY"),
      "x-phemex-request-expiry": String(expiry),
      "x-phemex-request-signature": signature,
    },
    body: bodyStr || undefined,
  });
  let data; try { data = await res.json(); } catch { data = { raw: await res.text() }; }
  return { httpStatus: res.status, data };
}

export default async function (request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  const auth = request.headers.get("Authorization") || "";
  if (auth !== "Bearer " + cfg("AUTH_TOKEN")) return json({ error: "unauthorised" }, 401);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const KILL = String(cfg("KILL") || "0") === "1";
  const DRY  = String(cfg("DRY_RUN") || "0") === "1";

  // Val Town serves vals under a path; match on the trailing segment.
  const seg = "/" + (path.split("/").pop() || "");

  // ── Health / config echo ──
  if (request.method === "GET" && (seg === "/" || seg === "/status" || path === "")) {
    return json({
      ok: true, base: BASE, live: BASE.indexOf("testnet") === -1,
      kill: KILL, dryRun: DRY,
      maxNotional: Number(cfg("MAX_NOTIONAL_USDT")),
      whitelist: String(cfg("WHITELIST")).split(",").map((s) => s.trim()),
    });
  }

  // ── Read open positions (read-only) ──
  if (request.method === "GET" && seg === "/positions") {
    const r = await phemex("GET", "/g-accounts/accountPositions", "currency=USDT", null);
    return json(r, r.httpStatus === 200 ? 200 : 502);
  }

  // ── KILL: cancel all resting orders on a symbol ──
  if (request.method === "POST" && seg === "/panic") {
    let body = {}; try { body = await request.json(); } catch {}
    const sym = (body.symbol || "").toUpperCase();
    if (!sym) return json({ error: "symbol required" }, 400);
    const r = await phemex("DELETE", "/g-orders/all", `symbol=${sym}&untriggered=true`, null);
    return json({ cancelled: r, note: "Open orders cancelled. Close any live position manually to be certain." });
  }

  // ── Open orders for a symbol (so the app can SEE a resting protective stop) ──
  // A stop placed as a conditional order does NOT appear on the position object —
  // without this the app reports "no stop" for a position that is actually protected.
  if (request.method === "GET" && seg === "/orders") {
    const sym = (url.searchParams.get("symbol") || "").toUpperCase();
    if (!sym) return json({ error: "symbol required" }, 400);
    const r = await phemex("GET", "/g-orders/activeList", `symbol=${sym}`, null);
    const rows = (r.data && r.data.data && (r.data.data.rows || r.data.data)) || [];
    const orders = (Array.isArray(rows) ? rows : []).map((o) => ({
      orderID: o.orderID, clOrdID: o.clOrdID, symbol: o.symbol, side: o.side, posSide: o.posSide,
      ordType: o.ordType, ordStatus: o.ordStatus, orderQtyRq: o.orderQtyRq,
      stopPxRp: o.stopPxRp, priceRp: o.priceRp, closeOnTrigger: o.closeOnTrigger, reduceOnly: o.reduceOnly,
    }));
    return json({ symbol: sym, orders, phemexCode: r.data && r.data.code });
  }

  // ── Attach a protective stop to an EXISTING position ──
  // Belt and braces: entry orders carry stopLossRp, but if the exchange ever drops it the
  // position is naked. This places a reduce-only conditional stop that closes the position.
  if (request.method === "POST" && seg === "/stop") {
    if (KILL) return json({ error: "KILL switch is ON — no orders placed." }, 423);
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const symbol = String(b.symbol || "").toUpperCase();
    const posSide = b.posSide === "Short" ? "Short" : "Long";
    const stopPx = Number(b.stopPxRp);
    const qty = Number(b.orderQtyRq);
    if (!symbol || !(stopPx > 0) || !(qty > 0)) return json({ error: "symbol, stopPxRp and orderQtyRq required" }, 400);
    const stopOrder = {
      clOrdID: ("cipherSL-" + Date.now()).slice(0, 40),
      symbol,
      side: posSide === "Long" ? "Sell" : "Buy",   // closing side
      posSide,
      ordType: "Stop",
      stopPxRp: String(stopPx),
      triggerType: "ByMarkPrice",
      orderQtyRq: String(qty),
      timeInForce: "ImmediateOrCancel",
      closeOnTrigger: true,
      reduceOnly: true,
      text: "cipher-protective-stop",
    };
    if (DRY) return json({ dryRun: true, wouldSend: stopOrder });
    const r = await phemex("POST", "/g-orders", "", stopOrder);
    // Phemex reports rejections INSIDE a 200 via code != 0 — surface that as a real error,
    // otherwise the app logs "stop attached" for a stop that was never placed.
    const code = r.data && r.data.code;
    if (r.httpStatus !== 200 || (code !== 0 && code !== undefined)) {
      return json({ error: `phemex ${code}: ${(r.data && r.data.msg) || "rejected"}`, sent: stopOrder, phemex: r }, 502);
    }
    return json({ ok: true, ordStatus: r.data?.data?.ordStatus, sent: stopOrder, phemex: r });
  }

  // ── Place order ──
  if (request.method === "POST" && seg === "/order") {
    if (KILL) return json({ error: "KILL switch is ON — no orders placed." }, 423);

    let o; try { o = await request.json(); } catch { return json({ error: "bad json" }, 400); }

    const symbol = String(o.symbol || "").toUpperCase();
    const side = o.side;
    const posSide = o.posSide || "Merged";
    const ordType = o.ordType || "Market";
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
    const maxNotional = Number(cfg("MAX_NOTIONAL_USDT"));
    if (notional > maxNotional)
      return json({ error: `notional ${notional.toFixed(2)} USDT exceeds cap ${maxNotional}` }, 403);

    const order = {
      clOrdID: (o.clOrdID || "cipher-" + Date.now()).slice(0, 40),
      symbol, side, posSide, ordType,
      orderQtyRq: String(qty),
      timeInForce: o.timeInForce || "ImmediateOrCancel",
      stopLossRp,
      slTrigger: o.slTrigger || "ByMarkPrice",
      reduceOnly: false,
      text: "cipher-auto",
    };
    if (ordType === "Limit") order.priceRp = String(o.priceRp);
    if (o.takeProfitRp != null) { order.takeProfitRp = String(o.takeProfitRp); order.tpTrigger = o.tpTrigger || "ByLastPrice"; }

    if (DRY) return json({ dryRun: true, wouldSend: order, notional, cap: maxNotional });

    const r = await phemex("POST", "/g-orders", "", order);
    const code = r.data && r.data.code;
    if (r.httpStatus !== 200 || (code !== 0 && code !== undefined)) {
      return json({ error: `phemex ${code}: ${(r.data && r.data.msg) || "rejected"}`, sent: order, phemex: r }, 502);
    }
    return json({ sent: order, phemex: r });
  }

  return json({ error: "not found" }, 404);
}
