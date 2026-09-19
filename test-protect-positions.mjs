// Verifies the 2026-09-02 protection-gap fix:
//   1. cancelOrder() now sends posSide (Phemex hedge-mode cancel requires it) — was failing
//      SOL/FIL/LTC/APT expiry cancels with "code 10500 ... posSide is not present".
//   2. protectOpenPositions() attaches a real stop to any planned, open position missing one at
//      the venue (the SOL orphan case: adopted, plan built, no order ever placed).
//   3. It does NOT invent a stop when one is already resting.
//   4. Take-profit is flagged (NO TARGET RESTING) but never auto-placed.
//   5. The KILL switch still stops it, same as every other order path.
import fs from "node:fs";

const base = fs.readFileSync("cipher-agent-valtown.js", "utf8")
  .replace(/if \(!IS_DENO && typeof process !== "undefined"\) \{[\s\S]*?\n\}\n?$/, "");

const candles = n => { const out=[]; let p=100;
  for (let i=0;i<n;i++){ p=p*(1+0.0008); out.push([Date.now()-(n-i)*864e5,p*0.9995,p*1.008,p*0.992,p,1500]); } return out; };

async function run({ label, whitelist, positions, activeRows, restingSeed, openSeed, kill }) {
  const file = `/tmp/cipher-test/agent-pp-${label}.mjs`;
  fs.writeFileSync(file, base);
  Object.assign(process.env, {
    PHEMEX_KEY:"k", PHEMEX_SECRET:"s", EXEC_DIRECT:"1", MODE:"armed", DRY_RUN:"0",
    RISK_GBP:"10", BATCH:"4", UNIVERSE:"10", CORR_MAX:"6",
    STATE_FILE:`/tmp/cipher-test/state-pp-${label}.json`,
    WHITELIST: whitelist,
    KILL: kill ? "1" : "0",
  });
  try { fs.unlinkSync(process.env.STATE_FILE); } catch {}
  if (openSeed || restingSeed) {
    fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
      cipher_open: openSeed || {},
      cipher_resting: restingSeed || {},
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
  return { sent, cancels, log: state.cipher_log || [] };
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
ok("no take-profit was invented", !r1.sent.some(o => o.clOrdID && o.clOrdID.startsWith("cipherTarget")));
ok("but the missing target IS flagged", r1.log.some(e => e.result==="NO TARGET RESTING" && /SOL short/.test(e.skipped||"")));

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
