// Verifies the 2026-10-26 record-keeping fix (take-profits, scores, close reasons):
//   1. Every planned position gets ONE stop and ONE take-profit (a resting reduce-only limit).
//   2. A stop the open-orders read cannot see is NOT re-attached every run (the stacking bug that
//      ran SOL/AVAX/ADA/UNI to 11-12 stops each and the rest into TE_SO_NUM_EXCEEDS).
//   3. The one-time reset clears stacked conditionals once per symbol, then never again.
//   4. A trailed stop replaces the old order instead of stacking beside it.
//   5. The market-side check uses the venue's MARK, not the position's entry (the DOT false alarm),
//      and a stop already behind the mark closes the position at market (reduce-only).
//   6. De-hedge closes go out reduce-only with no "NaN" stop (the September 502s).
//   7. A closed position is attributed from the venue's closing fill: target / own stop / stale
//      stop / outside the bot — with real R, the quality score and the setup on the record.
//   8. KILL still stops every one of these orders.
import fs from "node:fs";

const base = fs.readFileSync("cipher-agent-valtown.js", "utf8")
  .replace(/if \(!IS_DENO && typeof process !== "undefined"\) \{[\s\S]*?\n\}\n?$/, "")
  + "\nexport { attributeClose, pickClosingFill, fillRowsFrom, levelMoved, findRestingStop, findRestingTarget, directOrder };\n";
fs.mkdirSync("/tmp/cipher-test", { recursive: true });

const candles = n => { const out=[]; let p=100;
  for (let i=0;i<n;i++){ p=p*(1+0.0008); out.push([Date.now()-(n-i)*864e5,p*0.9995,p*1.008,p*0.992,p,1500]); } return out; };

let seq = 0;
async function run({ label, positions = [], activeRows = {}, marks = {}, fills = {}, state, keep, kill, postReply, whitelist = "SOLUSDT,DOTUSDT,ADAUSDT,APTUSDT" }) {
  const file = `/tmp/cipher-test/agent-tp-${label}-${++seq}.mjs`;
  fs.writeFileSync(file, base);
  const STATE = `/tmp/cipher-test/state-tp-${keep || label}.json`;
  Object.assign(process.env, {
    PHEMEX_KEY:"k", PHEMEX_SECRET:"s", EXEC_DIRECT:"1", MODE:"armed", DRY_RUN:"0",
    RISK_GBP:"10", BATCH:"3", UNIVERSE:"10", CORR_MAX:"6", STATE_FILE: STATE,
    WHITELIST: whitelist, KILL: kill ? "1" : "0", RELAY_URL: "",
  });
  if (state !== undefined) fs.writeFileSync(STATE, JSON.stringify(state));
  else if (!keep) { try { fs.unlinkSync(STATE); } catch {} }

  const sent = [], cancels = [], cancelAll = [], fillCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (b, s = 200) => ({ status:s, ok:s<400, headers:{get:()=>null},
      text:async()=>typeof b==="string"?b:JSON.stringify(b), json:async()=>typeof b==="string"?JSON.parse(b):b });
    if (/phemex/.test(u)) {
      const qs = new URLSearchParams(u.split("?")[1] || "");
      const sym = qs.get("symbol");
      if (/accountPositions/.test(u)) return reply({ code:0, data:{ account:{ accountBalanceRv: "1000" }, positions } });
      if (/activeList/.test(u)) return reply({ code:0, data:{ rows: (activeRows[sym]) || [] } });
      if (/\/md\/.*ticker/.test(u)) return marks[sym] ? reply({ result:{ symbol:sym, markPriceRp: String(marks[sym]) } }) : reply({}, 404);
      if (/tradingList|g-futures\/trades/.test(u)) { fillCalls.push(sym); return reply({ code:0, data:{ rows: fills[sym] || [] } }); }
      if (opts.method === "DELETE" && /\/g-orders\/all/.test(u)) { cancelAll.push(sym + (qs.get("untriggered") === "true" ? ":untriggered" : "")); return reply({ code:0 }); }
      if (opts.method === "DELETE" && /\/g-orders\/cancel/.test(u)) { cancels.push(u.split("?")[1] || ""); return reply({ code:0 }); }
      if (opts.method === "POST") { const b = JSON.parse(opts.body); sent.push({ ...b, _raw: opts.body });
        const custom = postReply && postReply(b); if (custom) return reply(custom);
        return reply({ code:0, data:{ orderID:"m"+sent.length } }); }
      return reply({ code:0, data:{ rows: [] } });
    }
    if (/ticker/i.test(u)) return reply(["BTC","ETH","SOL","XRP","BNB","ADA","DOGE","LINK","AVAX","DOT"]
      .map((s,i)=>({symbol:s+"USDT", quoteVolume:String(9e9-i*1e7), priceChangePercent:"1"})));
    if (/binance|okx/i.test(u)) return reply(candles(320).map(c=>c.map(String)));
    return reply({}, 404);
  };
  const A = await import(file + "?t=" + Date.now());
  await A.default();
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  return { A, sent, cancels, cancelAll, fillCalls, st, log: st.cipher_log || [], ledger: st.cipher_ledger || [] };
}

let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log("  ok   "+n);} else {fail++;console.log("  FAIL "+n+(x!==undefined?" → "+x:""));} };
const stops = r => r.sent.filter(o => /^cipherStop/.test(o.clOrdID || ""));
const targets = r => r.sent.filter(o => /^cipherTarget/.test(o.clOrdID || ""));

const SINCE = Date.now() - 864e5;
const SOL_POS = [{ symbol:"SOLUSDT", posSide:"Short", side:"Sell", size:2.4, avgEntryPriceRp:"106.97" }];
const SOL_OPEN = { "SOL|short": { coin:"SOL", dir:"short", size:2.4, book:"fast", setup:"rollover", setupTf:"4H", quality:6.5,
  plan:{ entry:106.97, stop:109.67304813026509, target:100.88814170690355 }, since: SINCE, avgEntry:106.97 } };

console.log("\n1. Planned position, nothing visible at the venue — first run after the fix");
const r1 = await run({ label:"first", keep:"seq", state:{ cipher_open: SOL_OPEN }, positions: SOL_POS, marks:{ SOLUSDT: 105.2 } });
ok("the stacked conditionals on SOL are cleared once", r1.cancelAll.includes("SOLUSDT:untriggered"), JSON.stringify(r1.cancelAll));
ok("exactly ONE stop is placed", stops(r1).length === 1, stops(r1).length);
ok("exactly ONE take-profit is placed", targets(r1).length === 1, targets(r1).length);
const tp = targets(r1)[0] || {};
ok("the take-profit is a resting reduce-only LIMIT, good till cancelled", tp.ordType === "Limit" && tp.reduceOnly === true && tp.timeInForce === "GoodTillCancel", JSON.stringify(tp));
ok("at the plan's own target", Math.abs(Number(tp.priceRp) - 100.888) < 0.01, tp.priceRp);
ok("closing side + posSide for a short", tp.side === "Buy" && tp.posSide === "Short");
ok("logged as TARGET PLACED", r1.log.some(e => e.result === "TARGET PLACED" && e.coin === "SOL"));
ok("no 'NO TARGET RESTING' alarm once it is placed", !r1.log.some(e => e.result === "NO TARGET RESTING"));
ok("both orders recorded in the registry", r1.st.cipher_protect && r1.st.cipher_protect["SOL|short"] &&
   r1.st.cipher_protect["SOL|short"].stop && r1.st.cipher_protect["SOL|short"].target, JSON.stringify(r1.st.cipher_protect));
ok("the reset is announced", r1.log.some(e => e.result === "PROTECTION RESET"));

console.log("\n2. Next run — the conditional stop is STILL invisible, the limit target is visible");
const tgtID = r1.st.cipher_protect["SOL|short"].target.orderID;
const r2 = await run({ label:"second", keep:"seq", positions: SOL_POS, marks:{ SOLUSDT: 105.0 },
  activeRows:{ SOLUSDT: [{ orderID: tgtID, clOrdID: tp.clOrdID, posSide:"Short", side:"Buy", ordType:"Limit", reduceOnly:true, priceRp:"100.888" }] } });
ok("no second stop — the stacking bug is gone", stops(r2).length === 0, stops(r2).length);
ok("no second target", targets(r2).length === 0, targets(r2).length);
ok("no second reset", r2.cancelAll.length === 0, JSON.stringify(r2.cancelAll));
const attachedCount = r => r.log.filter(e => e.result === "STOP ATTACHED").length;
ok("no STOP ATTACHED spam (log count unchanged run to run)", attachedCount(r2) === attachedCount(r1), attachedCount(r1) + " → " + attachedCount(r2));

console.log("\n2b. Third run — even the TARGET is invisible (run #826: rows carry no ordType/posSide)");
const r2b = await run({ label:"third", keep:"seq", positions: SOL_POS, marks:{ SOLUSDT: 105.0 }, activeRows:{} });
ok("the target is NOT re-placed just because the book does not show it", targets(r2b).length === 0, targets(r2b).length);
ok("nor the stop", stops(r2b).length === 0, stops(r2b).length);

console.log("\n3. The plan's stop trails — the old order is cancelled, not stacked beside");
const st3 = JSON.parse(fs.readFileSync("/tmp/cipher-test/state-tp-seq.json", "utf8"));
st3.cipher_open["SOL|short"].plan.stop = 107.5;
const r3 = await run({ label:"trail", keep:"seq", state: st3, positions: SOL_POS, marks:{ SOLUSDT: 104.0 },
  activeRows:{ SOLUSDT: [{ orderID: tgtID, clOrdID: tp.clOrdID, posSide:"Short", side:"Buy", ordType:"Limit", reduceOnly:true, priceRp:"100.888" }] } });
const oldStopID = r1.st.cipher_protect["SOL|short"].stop.orderID;
ok("the old stop is cancelled by its orderID, with posSide", r3.cancels.some(q => q.includes("orderID=" + oldStopID) && /posSide=Short/.test(q)), JSON.stringify(r3.cancels));
ok("one new stop at the trailed level", stops(r3).length === 1 && Math.abs(Number(stops(r3)[0].stopPxRp) - 107.5) < 0.01, JSON.stringify(stops(r3).map(o=>o.stopPxRp)));

console.log("\n4. DOT: a long whose stop sits ABOVE entry (profit locked) and below the market");
const DOT_POS = [{ symbol:"DOTUSDT", posSide:"Long", side:"Buy", size:110, avgEntryPriceRp:"1.101" }];
const DOT_OPEN = { "DOT|long": { coin:"DOT", dir:"long", size:110, book:"swing", plan:{ entry:1.101, stop:1.1087956917698574, target:1.2219096935178206 }, since: SINCE, avgEntry:1.101 } };
const r4 = await run({ label:"dot", state:{ cipher_open: DOT_OPEN }, positions: DOT_POS, marks:{ DOTUSDT: 1.1342 } });
ok("the stop is placed — checked against the mark 1.1342, not the entry 1.101", stops(r4).length === 1, JSON.stringify(r4.log.filter(e=>e.coin==="DOT").map(e=>e.result+": "+(e.skipped||"").slice(0,90))));
ok("price keeps sub-dollar precision", stops(r4)[0] && stops(r4)[0].stopPxRp === "1.1088", stops(r4)[0] && stops(r4)[0].stopPxRp);

console.log("\n5. Same DOT, but the mark is already BELOW its stop");
const r5 = await run({ label:"breach", state:{ cipher_open: DOT_OPEN }, positions: DOT_POS, marks:{ DOTUSDT: 1.0950 } });
const breach = r5.sent.find(o => /^cipherBreach/.test(o.clOrdID || ""));
ok("no impossible stop is sent", stops(r5).length === 0);
ok("the position is closed at market instead", !!breach && breach.ordType === "Market" && breach.side === "Sell" && breach.posSide === "Long");
ok("and that close is reduce-only — it can only shrink the position", breach && breach.reduceOnly === true);
ok("logged plainly", r5.log.some(e => e.coin === "DOT" && e.result === "STOP BREACHED — CLOSED"));
ok("marked for the resolution pass", r5.st.cipher_open["DOT|long"] && r5.st.cipher_open["DOT|long"].closedBy === "stop_breach_close");

console.log("\n5b. APT: no mark readable, and the VENUE says the stop is already behind price (11043)");
const APT_POS = [{ symbol:"APTUSDT", posSide:"Short", side:"Sell", size:507, avgEntryPriceRp:"0.6124" }];
const APT_OPEN = { "APT|short": { coin:"APT", dir:"short", size:507, book:"fast", plan:{ entry:0.6124, stop:0.6321086289204303, target:0.5680555849290321 }, since: SINCE, avgEntry:0.6124 } };
const r5b = await run({ label:"apt", state:{ cipher_open: APT_OPEN }, positions: APT_POS, marks:{},
  postReply: b => /^cipherStop/.test(b.clOrdID || "") ? { code: 11043, msg: "TE_RISING_TRIGGER_DIRECTLY" } : null });
const aptClose = r5b.sent.find(o => /^cipherBreach/.test(o.clOrdID || ""));
ok("the venue's 'already past' answer leads to a close at market", !!aptClose && aptClose.side === "Buy" && aptClose.posSide === "Short" && aptClose.reduceOnly === true, JSON.stringify(r5b.sent.map(o=>o.clOrdID)));
ok("logged as STOP BREACHED — CLOSED, not as a failure to retry forever", r5b.log.some(e => e.coin === "APT" && e.result === "STOP BREACHED — CLOSED") && !r5b.log.some(e => e.coin === "APT" && e.result === "STOP ATTACH FAILED"));

console.log("\n6. De-hedge close: reduce-only, and no \"NaN\" anywhere in the body");
const HEDGE = [{ symbol:"ADAUSDT", posSide:"Long", side:"Buy", size:2007, avgEntryPriceRp:"0.2049", markPriceRp:"0.205" },
               { symbol:"ADAUSDT", posSide:"Short", side:"Sell", size:321, avgEntryPriceRp:"0.21", markPriceRp:"0.205" }];
const r6 = await run({ label:"dehedge", positions: HEDGE, marks:{ ADAUSDT: 0.205 } });
const dh = r6.sent.find(o => /^dehedge/.test(o.clOrdID || ""));
ok("a de-hedge close was sent", !!dh, JSON.stringify(r6.sent.map(o=>o.clOrdID)));
ok("it is reduce-only now (was forced to false)", dh && dh.reduceOnly === true, dh && dh.reduceOnly);
ok("the body carries no \"NaN\" (was stopLossRp:\"NaN\")", dh && !/NaN/.test(dh._raw), dh && dh._raw);
ok("and no stop field at all on a close", dh && dh.stopLossRp === undefined && dh.slTrigger === undefined);
ok("it closes the SMALLER leg", dh && dh.posSide === "Short" && dh.side === "Buy");

console.log("\n7. A position closes — the venue's fill says how");
const prev = { cipher_open: SOL_OPEN, cipher_protect: { "SOL|short": { symbol:"SOLUSDT", posSide:"Short", since: SINCE,
  stop:{ px:109.67, orderID:"S1", clOrdID:"cipherStop1" }, target:{ px:100.89, orderID:"T1", clOrdID:"cipherTarget1" } } } };
const fillAt = (px, clOrdID, ordType="Limit", orderID="") => ({ SOLUSDT: [{ symbol:"SOLUSDT", side:"Buy", posSide:"Short", execPriceRp:String(px), execQtyRq:"2.4",
  ordType, clOrdID, orderID, transactTimeNs: String((Date.now()-36e5)*1e6), closedPnlRv:"14.6" }] });
const r7 = await run({ label:"filled-target", state: prev, positions: [], fills: fillAt(100.89, "cipherTarget1", "Limit", "T1") });
const res7 = r7.ledger.find(e => e.kind === "resolved" && e.coin === "SOL");
ok("resolved as its own target", res7 && res7.how === "target" && res7.closedBy === "cipher_target", JSON.stringify(res7));
ok("counts toward the stats", res7 && res7.countsForStats === true && res7.outcome === "win");
ok("R from the REAL fill (≈ +2.25)", res7 && Math.abs(res7.R - 2.25) < 0.05, res7 && res7.R);
ok("the quality score and setup are on the record", res7 && res7.quality === 6.5 && res7.setup === "rollover" && res7.setupTf === "4H", JSON.stringify(res7 && { q: res7.quality, s: res7.setup }));
ok("the fill itself is kept (price, type, pnl)", res7 && res7.fill && res7.fill.px === 100.89 && res7.fill.pnl === 14.6);
ok("its leftover stop and target are cancelled", r7.cancels.some(q => q.includes("orderID=S1")) && r7.cancels.some(q => q.includes("orderID=T1")), JSON.stringify(r7.cancels));
ok("and dropped from the registry", !(r7.st.cipher_protect || {})["SOL|short"]);

console.log("\n8. Closed by a stop far from its own — an old stop from an earlier position");
const r8 = await run({ label:"stale", state: prev, positions: [], fills: fillAt(105.2, "cipherStop1700000", "Stop") });
const res8 = r8.ledger.find(e => e.kind === "resolved" && e.coin === "SOL");
ok("named a stale stop, not this trade's loss", res8 && res8.how === "stale_stop" && res8.countsForStats === false, JSON.stringify(res8));
ok("its real R is still recorded for the audit", res8 && Number.isFinite(res8.R));

console.log("\n8b. AUDIT: its OWN stop, gapped well past the level — still a counted loss");
const r8b = await run({ label:"gapped", state: prev, positions: [], fills: fillAt(111.5, "cipherStop1", "Stop", "S1") });
const res8b = r8b.ledger.find(e => e.kind === "resolved" && e.coin === "SOL");
ok("matched to its own stop by orderID", res8b && res8b.closedBy === "cipher_stop" && res8b.how === "stop", JSON.stringify(res8b));
ok("counted, with the real (worse than -1) R", res8b && res8b.countsForStats === true && res8b.R < -1.5, res8b && res8b.R);
ok("and the gap is named in the record", res8b && /past the level/.test(res8b.why || ""));

console.log("\n8c. AUDIT: a target order from an EARLIER position");
const r8c = await run({ label:"stale-tgt", state: prev, positions: [], fills: fillAt(100.5, "cipherTarget9999", "Limit", "OLD7") });
const res8c = r8c.ledger.find(e => e.kind === "resolved" && e.coin === "SOL");
ok("not credited as this trade's win", res8c && res8c.closedBy === "stale_target" && res8c.countsForStats === false, JSON.stringify(res8c));

console.log("\n9. Closed by something the bot did not send");
const r9 = await run({ label:"manual", state: prev, positions: [], fills: fillAt(104.39, "web-1234", "Market") });
const res9 = r9.ledger.find(e => e.kind === "resolved" && e.coin === "SOL");
ok("closedBy = outside_bot, not counted", res9 && res9.closedBy === "outside_bot" && res9.countsForStats === false, JSON.stringify(res9));

console.log("\n10. No fill to be found — falls back to the range, and says what the venue returned");
const r10 = await run({ label:"nofill", state: prev, positions: [], fills: {} });
ok("still resolved (range fallback)", r10.ledger.some(e => e.kind === "resolved" && e.coin === "SOL"));
ok("the empty lookup is logged once, with the venue's answer", r10.log.filter(e => e.result === "FILL LOOKUP EMPTY").length === 1);

console.log("\n10b. AUDIT: same coin and side REOPENED between runs (entry moved)");
const reopenPos = [{ symbol:"SOLUSDT", posSide:"Short", side:"Sell", size:3.0, avgEntryPriceRp:"104.00" }];
const r10b = await run({ label:"reopen", state: prev, positions: reopenPos, marks:{ SOLUSDT: 103.5 }, fills: fillAt(100.89, "cipherTarget1", "Limit", "T1") });
const res10b = r10b.ledger.find(e => e.kind === "resolved" && e.coin === "SOL");
ok("the OLD trade resolves (it used to be silently merged into the new one)", !!res10b && res10b.closedBy === "cipher_target", JSON.stringify(res10b));
ok("the old trade's stop and target are pulled", r10b.cancels.some(q => q.includes("orderID=S1")) && r10b.cancels.some(q => q.includes("orderID=T1")), JSON.stringify(r10b.cancels));
const newSol = r10b.st.cipher_open["SOL|short"];
ok("the new position starts clean (new since, not the old setup)", newSol && newSol.since > SINCE && newSol.setup === undefined, JSON.stringify(newSol && { since: newSol.since, setup: newSol.setup }));
ok("and gets its own fresh stop + target", stops(r10b).length === 1 && targets(r10b).length === 1, JSON.stringify({ s: stops(r10b).length, t: targets(r10b).length }));
ok("the old record is gone from the registry; the new one is live", r10b.st.cipher_protect["SOL|short"] && r10b.st.cipher_protect["SOL|short"].since === newSol.since && !r10b.st.cipher_protect[`SOL|short#${SINCE}`], JSON.stringify(Object.keys(r10b.st.cipher_protect)));

console.log("\n10c. AUDIT: a leftover order is pulled at the START of the run, before any new trade");
const r10c = await run({ label:"early-pull", state: prev, positions: [], fills: {} });
const firstCancel = r10c.cancels.findIndex(q => q.includes("orderID=S1") || q.includes("orderID=T1"));
ok("the finished position's orders are cancelled", firstCancel >= 0, JSON.stringify(r10c.cancels));
ok("and only once (not again at the end of the run)", r10c.cancels.filter(q => q.includes("orderID=S1")).length === 1, JSON.stringify(r10c.cancels));

console.log("\n10d. AUDIT: the de-hedged leg is NOT given a stop or target in the same run");
const r10d = await run({ label:"dehedge-noprotect", positions: [
  { symbol:"ADAUSDT", posSide:"Long", side:"Buy", size:2007, avgEntryPriceRp:"0.2049", markPriceRp:"0.205" },
  { symbol:"ADAUSDT", posSide:"Short", side:"Sell", size:321, avgEntryPriceRp:"0.21", markPriceRp:"0.205" }], marks:{ ADAUSDT: 0.205 },
  state:{ cipher_open:{ "ADA|long": { coin:"ADA", dir:"long", size:2007, book:"fast", plan:{ entry:0.2049, stop:0.1999, target:0.2161 }, since: SINCE, avgEntry:0.2049 },
                        "ADA|short": { coin:"ADA", dir:"short", size:321, book:"swing", plan:{ entry:0.21, stop:0.22, target:0.19 }, since: SINCE, avgEntry:0.21 } } } });
ok("the closed short leg gets no protective orders", !r10d.sent.some(o => /^cipher(Stop|Target)/.test(o.clOrdID || "") && o.posSide === "Short"), JSON.stringify(r10d.sent.map(o => o.clOrdID + "/" + o.posSide)));
ok("the remaining long still does", r10d.sent.some(o => /^cipherStop/.test(o.clOrdID || "") && o.posSide === "Long"));

console.log("\n10e. AUDIT: no Phemex mark → never a market close on the reference price");
const r10e = await run({ label:"nomark", state:{ cipher_open: DOT_OPEN }, positions: DOT_POS, marks:{} });
ok("no breach close without the venue's own price", !r10e.sent.some(o => /^cipherBreach/.test(o.clOrdID || "")));
ok("the stop is sent instead (the venue will say if it is already past)", stops(r10e).length === 1);

console.log("\n10f. AUDIT: recorded orders are checked by orderID — log only");
ok("a check line is saved to state", !!(r10e.st.cipher_protect_check && r10e.st.cipher_protect_check.checks.length), JSON.stringify(r10e.st.cipher_protect_check));
ok("and nothing was re-placed because of it", stops(r10e).length === 1 && targets(r10e).length === 1);

console.log("\n11. KILL switch");
const r11 = await run({ label:"kill", state:{ cipher_open: SOL_OPEN }, positions: SOL_POS, marks:{ SOLUSDT: 105.2 }, kill: true });
ok("no stop, no target, no reset with KILL on", stops(r11).length === 0 && targets(r11).length === 0 && r11.cancelAll.length === 0,
   JSON.stringify({ s: stops(r11).length, t: targets(r11).length, c: r11.cancelAll }));

console.log("\n12. Pure helpers");
const { attributeClose, pickClosingFill, levelMoved, findRestingStop, directOrder } = r11.A;
ok("levelMoved ignores float noise", levelMoved(109.673, 109.67304813026509) === false);
ok("levelMoved sees a real trail", levelMoved(109.67, 107.5) === true);
ok("a conditional with only closeOnTrigger counts as a resting stop",
   !!findRestingStop([{ posSide:"Short", side:"Buy", ordType:"Stop", closeOnTrigger:true }], "Short"));
ok("an OPENING stop order on the other side does not",
   !findRestingStop([{ posSide:"Short", side:"Sell", ordType:"Stop", closeOnTrigger:true }], "Short"));
ok("AUDIT: a fill with no readable time is not attributed to this position",
   pickClosingFill([{ side:"Buy", posSide:"Short", execPriceRp:"100" }], "Short", SINCE) === null);
ok("pickClosingFill ignores the opening fill",
   pickClosingFill([{ side:"Sell", posSide:"Short", execPriceRp:"107", transactTimeNs: String(Date.now()*1e6) }], "Short", SINCE) === null);
const liq = attributeClose({ dir:"long", plan:{ entry:100, stop:97, target:107 } }, { px: 80, ordType:"Liq", clOrdID:"", text:"", execStatus:"" });
ok("a liquidation is named, and counted as the loss it really was", liq && liq.closedBy === "liquidation" && liq.R < -6);
process.env.KILL = "0"; process.env.MODE = "dry";
const opening = await directOrder({ symbol:"SOLUSDT", side:"Buy", posSide:"Long", orderQtyRq:"1", refPx: 100, stopLossRp: 97, takeProfitRp: 107 });
ok("an OPENING order still carries its stop and target", opening.data.wouldSend.stopLossRp === "97" && opening.data.wouldSend.takeProfitRp === "107" && opening.data.wouldSend.reduceOnly === false, JSON.stringify(opening.data));
const noStop = await directOrder({ symbol:"SOLUSDT", side:"Buy", posSide:"Long", orderQtyRq:"1", refPx: 100 });
ok("and an opening order with no stop is still refused", noStop.status === 400 && /no stop/.test(noStop.data.error));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
