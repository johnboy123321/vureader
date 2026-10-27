// Verifies the 2026-09-02 protection-gap fix:
//   1. cancelOrder() now sends posSide (Phemex hedge-mode cancel requires it) — was failing
//      SOL/FIL/LTC/APT expiry cancels with "code 10500 ... posSide is not present".
//   2. protectOpenPositions() attaches a real stop to any planned, open position missing one at
//      the venue (the SOL orphan case: adopted, plan built, no order ever placed).
//   3. It does NOT invent a stop when one is already resting.
//   4. Take-profit: since 2026-10-26 it IS placed (reduce-only limit at plan.target).
//   5. The KILL switch still stops it, same as every other order path.
import fs from "node:fs";

const base = fs.readFileSync("cipher-agent-valtown.js", "utf8")
  .replace(/if \(!IS_DENO && typeof process !== "undefined"\) \{[\s\S]*?\n\}\n?$/, "");

const candles = n => { const out=[]; let p=100;
  for (let i=0;i<n;i++){ p=p*(1+0.0008); out.push([Date.now()-(n-i)*864e5,p*0.9995,p*1.008,p*0.992,p,1500]); } return out; };

async function run({ label, whitelist, positions, activeRows, restingSeed, openSeed, kill, keepState, extraState, orderList }) {
  const file = `/tmp/cipher-test/agent-pp-${label}.mjs`;
  fs.writeFileSync(file, base);
  Object.assign(process.env, {
    PHEMEX_KEY:"k", PHEMEX_SECRET:"s", EXEC_DIRECT:"1", MODE:"armed", DRY_RUN:"0",
    RISK_GBP:"10", BATCH:"4", UNIVERSE:"10", CORR_MAX:"6",
    STATE_FILE:`/tmp/cipher-test/state-pp-${label}.json`,
    WHITELIST: whitelist,
    KILL: kill ? "1" : "0",
  });
  if (!keepState) try { fs.unlinkSync(process.env.STATE_FILE); } catch {}
  if (!keepState && (openSeed || restingSeed || extraState)) {
    fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
      cipher_open: openSeed || {},
      cipher_resting: restingSeed || {},
      ...(extraState || {}),
    }));
  }

  const sent = [];       // POST /g-orders bodies
  const cancels = [];    // DELETE /g-orders/cancel query strings
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (b, s = 200) => ({ status:s, ok:s<400, headers:{get:()=>null},
      text:async()=>typeof b==="string"?b:JSON.stringify(b), json:async()=>typeof b==="string"?JSON.parse(b):b });
    if (/phemex/.test(u)) {
      if (/accountPositions/.test(u)) return reply({ code:0, data:{ account:{}, positions: positions || [] } });
      if (/orderList|g-futures\/orders\?/.test(u)) return reply({ code:0, data:{ rows: orderList || [] } });
      if (/activeList/.test(u)) {
        const qs = u.split("?")[1] || "";
        const sym = new URLSearchParams(qs).get("symbol");
        return reply({ code:0, data:{ rows: (activeRows && activeRows[sym]) || [] } });
      }
      if (opts.method === "DELETE" && /\/g-orders\/cancel/.test(u)) {
        cancels.push(u.split("?")[1] || "");
        return reply({ code:0 });
      }
      if (opts.method === "POST") { sent.push(JSON.parse(opts.body)); return reply({ code:0, data:{ orderID:"m"+sent.length } }); }
    }
    if (/ticker/i.test(u)) return reply(["BTC","ETH","SOL","XRP","BNB","ADA","DOGE","LINK","AVAX","DOT","UNI","LTC","BCH","FIL"]
      .map((s,i)=>({symbol:s+"USDT", quoteVolume:String(9e9-i*1e7), priceChangePercent:"1"})));
    if (/binance|okx/i.test(u)) return reply(candles(320).map(c=>c.map(String)));
    return reply({}, 404);
  };

  const A = await import(file + "?t=" + label + Date.now());
  await A.default();
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  return { sent, cancels, log: state.cipher_log || [], state };
}

let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log("  ok   "+n);} else {fail++;console.log("  FAIL "+n+(x!==undefined?" → "+x:""));} };

const SOL_POS = [{ symbol:"SOLUSDT", posSide:"Short", side:"Sell", size:2.24, avgEntryPriceRp:"84.5" }];
const SOL_PLAN = { "SOL|short": { coin:"SOL", dir:"short", size:2.24, book:"swing",
  plan:{ entry:84.5, stop:111.93208549409617, target:83.1303076382836 }, since: Date.now()-864e5, avgEntry:84.5 } };

console.log("\n1. SOL-like: planned, open, NOTHING resting at the venue");
const r1 = await run({ label:"missing", whitelist:"SOLUSDT", positions: SOL_POS, activeRows:{}, openSeed: SOL_PLAN });
const stopSent = r1.sent.find(o => o.clOrdID && o.clOrdID.startsWith("cipherStop"));
ok("a protective STOP order was sent", !!stopSent, JSON.stringify(r1.sent.map(o=>o.clOrdID)));
ok("closing side is Buy (closes a short)", stopSent && stopSent.side === "Buy");
ok("posSide matches the position", stopSent && stopSent.posSide === "Short");
ok("reduceOnly + closeOnTrigger, so it can only close, never open", stopSent && stopSent.reduceOnly === true && stopSent.closeOnTrigger === true);
ok("triggered at the bot's OWN plan.stop, not a guess", stopSent && Math.abs(Number(stopSent.stopPxRp) - 111.93) < 0.1, stopSent && stopSent.stopPxRp);
ok("logged as STOP ATTACHED for SOL", r1.log.some(e => e.coin==="SOL" && e.result==="STOP ATTACHED"));
// 2026-10-26: targets are now placed (resting reduce-only limit at plan.target) — see test-tp-records.mjs.
const tgtSent = r1.sent.find(o => o.clOrdID && o.clOrdID.startsWith("cipherTarget"));
ok("a take-profit is placed at the plan's target", !!tgtSent && tgtSent.ordType === "Limit" && tgtSent.reduceOnly === true && Math.abs(Number(tgtSent.priceRp) - 83.13) < 0.01, JSON.stringify(tgtSent));
ok("so nothing is flagged as missing a target", !r1.log.some(e => e.result==="NO TARGET RESTING" && /SOL short/.test(e.skipped||"")));

console.log("\n2. Same position, but a stop AND a target are already resting");
const already = { SOLUSDT: [
  { orderID:"s1", clOrdID:"old-stop", posSide:"Short", ordType:"Stop", reduceOnly:true },
  { orderID:"t1", clOrdID:"old-tp",   posSide:"Short", ordType:"MarketIfTouched", reduceOnly:true },
]};
const r2 = await run({ label:"present", whitelist:"SOLUSDT", positions: SOL_POS, activeRows: already, openSeed: SOL_PLAN });
ok("no new stop invented when one already rests", !r2.sent.some(o => o.clOrdID && o.clOrdID.startsWith("cipherStop")));
ok("no new target invented either", !r2.sent.some(o => o.clOrdID && o.clOrdID.startsWith("cipherTarget")));
ok("nothing flagged as missing a target", !r2.log.some(e => e.result==="NO TARGET RESTING" && /SOL/.test(e.skipped||"")));

console.log("\n3. KILL switch still stops the protective order");
const r3 = await run({ label:"kill", whitelist:"SOLUSDT", positions: SOL_POS, activeRows:{}, openSeed: SOL_PLAN, kill:true });
ok("nothing sent with KILL on", !r3.sent.some(o => o.clOrdID && o.clOrdID.startsWith("cipherStop")));
ok("failure is logged, not swallowed", r3.log.some(e => e.coin==="SOL" && e.result==="STOP ATTACH FAILED" && /KILL/.test(e.skipped||"")));

console.log("\n4. cancelOrder() sends posSide — the actual live bug");
const restingSeed = { "stale1": { symbol:"LTCUSDT", clOrdID:"stale1", orderID:"ord1", coin:"LTC", dir:"long", at: Date.now() - 10*3600e3 } };
const stillResting = { LTCUSDT: [{ orderID:"ord1", clOrdID:"stale1", posSide:"Long", ordType:"Limit", reduceOnly:false }] };
const r4 = await run({ label:"cancel", whitelist:"LTCUSDT", positions: [], activeRows: stillResting, restingSeed });
ok("a cancel was actually attempted", r4.cancels.length > 0, JSON.stringify(r4.cancels));
ok("and it carries posSide this time", r4.cancels.some(q => /(^|&)posSide=Long(&|$)/.test(q)), JSON.stringify(r4.cancels));
ok("the expiry no longer fails with the old error", !r4.log.some(e => e.result==="EXPIRE FAILED"));


// ═══════════ OPERATOR (GRAY) ORDERS — 2026-10-27 ═══════════
// Book rows arrive with NO posSide (run #826), so the gray rows below carry side only.
const SINCE = Date.now() - 864e5;
const SOL_PLAN_FIXED = { "SOL|short": { ...SOL_PLAN["SOL|short"], since: SINCE } };
const REV = { cipher_protect_rev: { rev: "2026-10-26-unstack", done: ["SOLUSDT"] } };
const OUR_REG = { "SOL|short": { symbol:"SOLUSDT", posSide:"Short", since: SINCE,
  stop:   { px:111.93208549409617, sentPx:111.93, qty:2.24, orderID:"c1", clOrdID:"cipherStop1", source:"placed" },
  target: { px:83.1303076382836,   sentPx:83.13,  qty:2.24, orderID:"c2", clOrdID:"cipherTarget1", source:"placed" } } };
const grayStopRow = (id, px) => ({ orderID:id, clOrdID:"grayStop"+id, side:"Buy", orderType:"Stop", stopPxRp:String(px), orderQtyRq:"2.24", ordStatus:"Untriggered" });
const isGrayCancel = q => /grayStop|orderID=g/.test(q);

console.log("\n5. A gray stop rests on SOL (operator moved it) — the bot's own stop is on record");
const r5 = await run({ label:"gray-stop", whitelist:"SOLUSDT", positions: SOL_POS, openSeed: SOL_PLAN_FIXED,
  extraState: { ...REV, cipher_protect: OUR_REG },
  activeRows: { SOLUSDT: [ grayStopRow("g1", 118.5), { orderID:"c2", clOrdID:"cipherTarget1", side:"Buy", orderType:"Limit", priceRp:"83.13" } ] } });
ok("no new bot stop is placed on top of the operator's", !r5.sent.some(o => /^cipherStop/.test(o.clOrdID||"")), JSON.stringify(r5.sent.map(o=>o.clOrdID)));
ok("the gray stop is never cancelled", !r5.cancels.some(isGrayCancel), JSON.stringify(r5.cancels));
ok("the bot's own stop comes off, so only the operator's can fire", r5.cancels.some(q => /orderID=c1/.test(q)), JSON.stringify(r5.cancels));
ok("the bot's target is left alone (no gray target)", !r5.cancels.some(q => /orderID=c2/.test(q)));
const reg5 = r5.state.cipher_protect && r5.state.cipher_protect["SOL|short"];
ok("the registry records the gray stop as this position's stop (source operator, its own level)",
  reg5 && reg5.stop && reg5.stop.source === "operator" && reg5.stop.clOrdID === "grayStopg1" && reg5.stop.px === 118.5, JSON.stringify(reg5 && reg5.stop));
ok("logged OPERATOR: SOL stop seen", r5.log.some(e => e.result === "OPERATOR: SOL stop seen"));
const h5 = r5.state.cipher_health;
ok("HEALTH does not fail on 'no stop' — the gray stop counts", h5 && !h5.problems.some(p => /no stop/.test(p)) && h5.stops === 1 && h5.operatorLegs === 1, JSON.stringify(h5));

console.log("\n5b. Gray stop present and nothing on record — still no bot stop");
const r5b = await run({ label:"gray-stop-fresh", whitelist:"SOLUSDT", positions: SOL_POS, openSeed: SOL_PLAN_FIXED,
  extraState: { ...REV }, activeRows: { SOLUSDT: [ grayStopRow("g1", 118.5) ] } });
ok("no bot stop placed", !r5b.sent.some(o => /^cipherStop/.test(o.clOrdID||"")), JSON.stringify(r5b.sent.map(o=>o.clOrdID)));
ok("no breach close either (the operator's stop is the protection)", !r5b.sent.some(o => /^cipherBreach/.test(o.clOrdID||"")));

console.log("\n6. The operator MOVES its stop (g1 118.5 → g2 116.0) — the bot leaves it alone");
const r6 = await run({ label:"gray-move", whitelist:"SOLUSDT", positions: SOL_POS, keepState: true,
  activeRows: { SOLUSDT: [ grayStopRow("g2", 116.0), { orderID:"c2", clOrdID:"cipherTarget1", side:"Buy", orderType:"Limit", priceRp:"83.13" } ] } });
const reg6 = r6.state.cipher_protect && r6.state.cipher_protect["SOL|short"];
ok("no bot stop placed, no 'fix' back to the plan's 111.93", !r6.sent.some(o => /^cipherStop/.test(o.clOrdID||"")), JSON.stringify(r6.sent.map(o=>o.clOrdID)));
ok("no gray order cancelled", !r6.cancels.some(isGrayCancel), JSON.stringify(r6.cancels));
ok("the registry follows the operator's new level", reg6 && reg6.stop && reg6.stop.orderID === "g2" && reg6.stop.px === 116, JSON.stringify(reg6 && reg6.stop));
ok("the move is logged", r6.log.filter(e => e.result === "OPERATOR: SOL stop seen").length >= 1);

console.log("\n6b. Gray stop vanishes — kept one run, the plan's own stop goes back on the second");
const tgtOnly = { SOLUSDT: [ { orderID:"c2", clOrdID:"cipherTarget1", side:"Buy", orderType:"Limit", priceRp:"83.13" } ] };
const r6b = await run({ label:"gray-move", whitelist:"SOLUSDT", positions: SOL_POS, keepState: true, activeRows: tgtOnly });
ok("first miss: nothing placed yet", !r6b.sent.some(o => /^cipherStop/.test(o.clOrdID||"")));
const r6c = await run({ label:"gray-move", whitelist:"SOLUSDT", positions: SOL_POS, keepState: true, activeRows: tgtOnly });
ok("second miss: logged OPERATOR: SOL stop gone", r6c.log.some(e => e.result === "OPERATOR: SOL stop gone"));
ok("…and the plan's stop is back (position never left naked)", r6c.sent.some(o => /^cipherStop/.test(o.clOrdID||"")) || r6c.sent.some(o => /^cipherBreach/.test(o.clOrdID||"")), JSON.stringify(r6c.sent.map(o=>o.clOrdID)));

console.log("\n7. Gray CLOSES SOL — position gone, order history names grayClose");
const grayClose = [{ symbol:"SOLUSDT", orderID:"g9", clOrdID:"grayCloseSOL1", side:"Buy", posSide:"Short", ordType:"Market",
  ordStatus:"Filled", cumQtyRq:"2.24", avgPriceRp:"90.10", transactTimeNs: String((Date.now()-6e5)*1e6) }];
const r7 = await run({ label:"gray-close", whitelist:"SOLUSDT", positions: [], openSeed: SOL_PLAN_FIXED,
  extraState: { ...REV, cipher_protect: OUR_REG }, orderList: grayClose, activeRows: {} });
const res7g = (r7.state.cipher_ledger || []).find(e => e.kind === "resolved" && e.coin === "SOL");
ok("resolved with closedBy operator", res7g && res7g.closedBy === "operator", JSON.stringify(res7g));
ok("countsForStats false (and not in the streak)", res7g && res7g.countsForStats === false && res7g.countsForStreak === false);
ok("never recorded as a stop or target hit", res7g && res7g.how === "operator" && !/stop|target/.test(res7g.how));
ok("exit is the operator's fill", res7g && res7g.exit === 90.1, res7g && res7g.exit);
ok("logged OPERATOR: SOL close seen", r7.log.some(e => e.result === "OPERATOR: SOL close seen"));
const hold7 = r7.state.cipher_operator_hold || {};
ok("SOL short is on hold for the next cycle", hold7["SOL|short"] > Date.now() + 10*6e4, JSON.stringify(hold7));
ok("no new SOL order placed this run", !r7.sent.some(o => o.symbol === "SOLUSDT" && !/^cipher(Stop|Target)/.test(o.clOrdID||"")), JSON.stringify(r7.sent));

console.log("\n7b. SOL short reappears plan-less while on hold — not re-adopted, HEALTH warns instead of failing");
const r7b = await run({ label:"gray-close", whitelist:"SOLUSDT", positions: SOL_POS, keepState: true, orderList: [], activeRows: {} });
const open7b = r7b.state.cipher_open && r7b.state.cipher_open["SOL|short"];
ok("not adopted (no plan attached)", open7b && !open7b.plan, JSON.stringify(open7b));
ok("no stop placed on it this cycle", !r7b.sent.some(o => /^cipherStop/.test(o.clOrdID||"")));
const h7b = r7b.state.cipher_health;
ok("HEALTH names the hold as a warning, not a 'no plan' failure", h7b && h7b.problems.some(p => /OPERATOR HOLD/.test(p)) && !h7b.problems.some(p => /no plan at all/.test(p)), JSON.stringify(h7b));

console.log("\n7c. A non-gray close is still NOT labelled operator");
const r7c = await run({ label:"hand-close", whitelist:"SOLUSDT", positions: [], openSeed: SOL_PLAN_FIXED,
  extraState: { ...REV, cipher_protect: OUR_REG }, orderList: [{ ...grayClose[0], clOrdID:"manual123" }], activeRows: {} });
ok("no OPERATOR log for a hand close", !r7c.log.some(e => /^OPERATOR/.test(e.result||"")));
ok("no hold set", !((r7c.state.cipher_operator_hold || {})["SOL|short"]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
