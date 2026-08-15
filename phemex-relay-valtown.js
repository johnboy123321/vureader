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
  //
  // 2026-08-13: an open-to-everything edit sat in the local copy, undeployed, from 09 Aug — the
  // live val never had it. Held back deliberately so the 502 fix ships alone and its effect is
  // readable. Opening this up is a separate, one-line change.
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
  // Read the body ONCE as text, then parse. Calling res.json() and falling back to res.text()
  // in the catch throws "Body is unusable" — res.json() consumes the stream before it throws,
  // so the failure handler itself fails, the val crashes, and Val Town returns a BARE 502 with
  // no JSON body. That is the source of every unexplained "ERR 502" in the agent log
  // (17 of them 11–13 Aug 2026). Same bug, same fix as cipher-agent-valtown.js. (2026-08-13)
  const raw = await res.text();
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500), parseError: true }; }
  return { httpStatus: res.status, data };
}

// ═══════════════════ LIVE CONFIG — the app's control panel talks to this ═══════════════════
// The agent used to read every setting from the GitHub workflow file, so changing the risk or
// stopping the bot meant editing YAML and committing. That is scaffolding, not a control panel.
// Settings now live here: the app POSTs them, the agent GETs them at the top of every run.
//
// Why here and not in the repo: the app already holds this relay's token, and it must NEVER hold
// a GitHub token — a browser cannot keep a secret. This endpoint reuses the auth that exists.
//
// Two properties that matter:
//  · The agent falls back to its workflow env if this read fails, so a flaky moment can neither
//    arm nor disarm anything by accident. Absence of config is not a command.
//  · KILL is enforced HERE, on the order path, not only in the agent. A kill switch that depends
//    on the thing it is killing having read it is not a kill switch.
const CONFIG_KEY = "cipher_bot_config";
let _blob = null;
async function blobStore() {
  if (!_blob) ({ blob: _blob } = await import("https://esm.town/v/std/blob"));
  return _blob;
}
const CONFIG_DEFAULTS = { mode: "dry", riskGbp: 10, corrMax: 6, dayCap: 25, maxNotional: 2000, kill: false };
async function readConfig() {
  try {
    const v = await (await blobStore()).getJSON(CONFIG_KEY);
    return v && typeof v === "object" ? { ...CONFIG_DEFAULTS, ...v } : { ...CONFIG_DEFAULTS };
  } catch { return { ...CONFIG_DEFAULTS }; }
}
// Every field is bounds-checked. The panel is a convenience, not a licence to set risk to 10000 —
// a fat finger in a text box should not be able to do something the code would refuse elsewhere.
function validateConfig(patch) {
  const out = {}, errs = [];
  const num = (k, lo, hi) => {
    if (patch[k] === undefined) return;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) errs.push(`${k} must be between ${lo} and ${hi}`);
    else out[k] = v;
  };
  if (patch.mode !== undefined) {
    const m = String(patch.mode).toLowerCase();
    if (!["off", "dry", "armed"].includes(m)) errs.push("mode must be off, dry or armed");
    else out.mode = m;
  }
  if (patch.kill !== undefined) out.kill = !!patch.kill;
  num("riskGbp", 1, 100);
  num("corrMax", 1, 12);
  num("dayCap", 1, 50);
  num("maxNotional", 100, 5000);
  return { out, errs };
}

async function handle(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  const auth = request.headers.get("Authorization") || "";
  if (auth !== "Bearer " + cfg("AUTH_TOKEN")) return json({ error: "unauthorised" }, 401);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const live = await readConfig();
  // Either brake stops an order: the env var (set on the val) or the live config (set from the
  // app). Neither can be overridden by the other — both have to be clear.
  const KILL = String(cfg("KILL") || "0") === "1" || live.kill === true;
  const DRY  = String(cfg("DRY_RUN") || "0") === "1";

  // Val Town serves vals under a path; match on the trailing segment.
  const seg = "/" + (path.split("/").pop() || "");

  // ── Health / config echo ──
  if (request.method === "GET" && (seg === "/" || seg === "/status" || path === "")) {
    return json({
      ok: true, base: BASE, live: BASE.indexOf("testnet") === -1,
      kill: KILL, dryRun: DRY, killSource: live.kill ? "app" : (String(cfg("KILL") || "0") === "1" ? "env" : null),
      maxNotional: Number(cfg("MAX_NOTIONAL_USDT")),
      whitelist: String(cfg("WHITELIST")).split(",").map((s) => s.trim()),
      config: live,
    });
  }

  // ── The control panel: read what the bot is set to ──
  if (request.method === "GET" && seg === "/config") return json({ config: live });

  // ── The control panel: change what the bot is set to ──
  // Returns the FULL config it saved, so the panel renders what actually took effect rather than
  // what it hoped for. Rejected fields come back named, so a bad value is visible, not swallowed.
  if (request.method === "POST" && seg === "/config") {
    let patch = {}; try { patch = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const { out, errs } = validateConfig(patch);
    if (errs.length) return json({ error: errs.join("; ") }, 400);
    if (!Object.keys(out).length) return json({ error: "nothing to change" }, 400);
    const next = { ...live, ...out, updatedAt: new Date().toISOString(), updatedBy: "app" };
    try { await (await blobStore()).setJSON(CONFIG_KEY, next); }
    catch (e) { return json({ error: "could not save config: " + String(e && e.message || e).slice(0, 200) }, 500); }
    return json({ config: next, changed: Object.keys(out) });
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
  //
  // ── THE "12 WITHOUT STOP" BUG, fixed 2026-08-15 ──────────────────────────────────────────
  // A protective stop lives on Phemex as a CONDITIONAL order: it sits untriggered until price
  // reaches it. `activeList` WITHOUT `untriggered=true` does not return untriggered conditionals
  // at all — so every genuinely protected position came back with an empty order list and the
  // app quite correctly concluded "NO STOP ON EXCHANGE". The stops were there the whole time;
  // this endpoint simply never asked for them. Ask for BOTH views and merge by orderID.
  // (Diagnosed 2026-08-10, but the fixed file was never uploaded — the live val was still
  //  importing ?v=7 of the old one. Re-upload AND bump the ?v= or nothing changes.)
  if (request.method === "GET" && seg === "/orders") {
    const sym = (url.searchParams.get("symbol") || "").toUpperCase();
    if (!sym) return json({ error: "symbol required" }, 400);

    const seen = new Set();
    const orders = [];
    let phemexCode;
    const errors = [];
    for (const q of [`symbol=${sym}`, `symbol=${sym}&untriggered=true`]) {
      try {
        const r = await phemex("GET", "/g-orders/activeList", q, null);
        if (phemexCode === undefined) phemexCode = r.data && r.data.code;
        const rows = (r.data && r.data.data && (r.data.data.rows || r.data.data)) || [];
        for (const o of (Array.isArray(rows) ? rows : [])) {
          if (!o || seen.has(o.orderID)) continue;           // the two views overlap
          seen.add(o.orderID);
          orders.push({
            orderID: o.orderID, clOrdID: o.clOrdID, symbol: o.symbol, side: o.side, posSide: o.posSide,
            ordType: o.ordType, ordStatus: o.ordStatus, orderQtyRq: o.orderQtyRq,
            stopPxRp: o.stopPxRp, priceRp: o.priceRp, closeOnTrigger: o.closeOnTrigger, reduceOnly: o.reduceOnly,
            untriggered: q.includes("untriggered"),
          });
        }
      } catch (e) {
        // One view failing must not blind the other — reporting "no stop" because half the
        // query broke is exactly the failure mode this fix exists to prevent. Say so instead.
        errors.push(String((e && e.message) || e).slice(0, 200));
      }
    }
    return json({ symbol: sym, orders, phemexCode, partial: errors.length ? errors : undefined });
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
    // Same hard rule: a protective stop on the wrong side of the market is not protection.
    const mkt = Number(b.markPrice || b.refPx || 0);
    if (mkt > 0) {
      if (posSide === "Long" && stopPx >= mkt) return json({ error: `refusing stop: LONG stop ${stopPx} must be BELOW market ${mkt}` }, 400);
      if (posSide === "Short" && stopPx <= mkt) return json({ error: `refusing stop: SHORT stop ${stopPx} must be ABOVE market ${mkt}` }, 400);
    }
    const sdp = mkt > 0 ? ((String(mkt).split(".")[1] || "").length || 2) : 2;
    const stopOrder = {
      clOrdID: ("cipherSL-" + Date.now()).slice(0, 40),
      symbol,
      side: posSide === "Long" ? "Sell" : "Buy",   // closing side
      posSide,
      ordType: "Stop",
      stopPxRp: String(Number(stopPx.toFixed(sdp))),
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

    // ── HARD RULE: a stop must exist AND sit on the losing side of entry. ──
    // A long's stop is below entry, a short's is above. A stop on the wrong side is not a
    // stop — Phemex silently drops it and the position ends up naked. Refuse the whole order.
    const isLong = side === "Buy";
    const slNum = Number(stopLossRp);
    if (!(slNum > 0)) return json({ error: "refusing order: stop loss is not a valid price" }, 400);
    if (isLong && slNum >= refPx) return json({ error: `refusing order: LONG stop ${slNum} must be BELOW entry ${refPx}` }, 400);
    if (!isLong && slNum <= refPx) return json({ error: `refusing order: SHORT stop ${slNum} must be ABOVE entry ${refPx}` }, 400);
    const slDist = Math.abs(refPx - slNum) / refPx;
    if (slDist < 0.003) return json({ error: `refusing order: stop is ${(slDist * 100).toFixed(2)}% from entry — too tight (min 0.3%), it would mint an oversized position` }, 400);
    if (o.takeProfitRp != null) {
      const tp = Number(o.takeProfitRp);
      if (!(tp > 0) || (isLong && tp <= refPx) || (!isLong && tp >= refPx))
        return json({ error: `refusing order: target ${tp} is on the wrong side of entry ${refPx}` }, 400);
    }

    const notional = qty * refPx;
    // The panel's cap binds if it is TIGHTER than the val's. A control panel may reduce risk
    // freely; raising the hard limit set on the val itself stays a deliberate act on the val.
    const envCap = Number(cfg("MAX_NOTIONAL_USDT"));
    const maxNotional = Math.min(envCap, Number(live.maxNotional) || envCap);
    if (notional > maxNotional)
      return json({ error: `notional ${notional.toFixed(2)} USDT exceeds cap ${maxNotional}` }, 403);

    // Match the exchange's own price precision — 14-decimal prices get rejected outright.
    const dp = (String(refPx).split(".")[1] || "").length || 2;
    const px = (v) => String(Number(Number(v).toFixed(dp)));

    const order = {
      clOrdID: (o.clOrdID || "cipher-" + Date.now()).slice(0, 40),
      symbol, side, posSide, ordType,
      orderQtyRq: String(qty),
      timeInForce: o.timeInForce || "ImmediateOrCancel",
      stopLossRp: px(stopLossRp),
      slTrigger: o.slTrigger || "ByMarkPrice",
      reduceOnly: false,
      text: "cipher-auto",
    };
    if (ordType === "Limit") order.priceRp = px(o.priceRp);
    if (o.takeProfitRp != null) { order.takeProfitRp = px(o.takeProfitRp); order.tpTrigger = o.tpTrigger || "ByLastPrice"; }

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

// Nothing may escape as an uncaught throw. An uncaught error here becomes a platform 502 with a
// non-JSON body, which the agent logs as a bare "ERR 502" with no cause — a silent failure that
// looks identical to an exchange rejection. Always answer in JSON, always say what broke.
export default async function (request) {
  try {
    return await handle(request);
  } catch (e) {
    const msg = String((e && e.stack) || (e && e.message) || e).slice(0, 600);
    console.error("relay crashed:", msg);
    return json({ error: "relay crashed: " + msg, crashed: true }, 500);
  }
}
