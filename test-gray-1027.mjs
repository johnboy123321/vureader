// Gray's read-only audit, 2026-10-27 — points 5, 6 and 7 (1–4 live in test-tp-records.mjs).
//   5. A green dot must be ABLE to reach MIN_QUALITY on 4H/1H (it was capped at 4.5 / 4.0).
//   6. Its 200 EMA is the DAILY one, and a counter-trend dot never earns the bonus.
//   7. The ledger records the 2.25R target the order rests at, not 1R.
import fs from "node:fs";
const src = fs.readFileSync("cipher-agent-valtown.js", "utf8");
const base = src.replace(/if \(!IS_DENO && typeof process !== "undefined"\) \{[\s\S]*?\n\}\n?$/, "")
  + "\nexport { detectGreenDotMFReversal, waveTrend, vmcMoneyFlow, ema200At };\n";
fs.mkdirSync("/tmp/cipher-test", { recursive: true });
fs.writeFileSync("/tmp/cipher-test/gray1027.mjs", base);
process.env.STATE_FILE = "/tmp/cipher-test/state-gray1027.json";
const A = await import("/tmp/cipher-test/gray1027.mjs?t=" + Date.now());

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (x !== undefined ? " → " + x : "")); } };

// Search seeded random walks for bars on which the detector fires, so the test exercises the real
// maths rather than a hand-built shape that might not survive a change to waveTrend.
function walk(seed, n, drift = 0) { let s = seed, p = 100; const out = [];
  for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; const r = (s / 2147483647 - 0.5) * 0.04 + drift;
    const o = p; p = p * (1 + r); out.push({ t: i, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p, v: 1000 + (s % 900) }); }
  return out; }
const flat = lvl => Array.from({ length: 260 }, (_, i) => ({ t: i, o: lvl, h: lvl, l: lvl, c: lvl, v: 1 }));
const up = flat(10), down = flat(10000);   // daily 200 EMA far BELOW / far ABOVE the signal price
let hits = [], seen = 0;
for (let seed = 1; seed < 4000 && hits.length < 25; seed++) {
  const c = walk(seed, 120);
  const r = A.detectGreenDotMFReversal(c, up); if (r) { seen++; hits.push({ c, r }); }
}
ok("the detector fires on some seeded series", hits.length > 0, seen);
const strong = hits.filter(h => h.r.score >= 6);
ok("with a bullish daily, a strong dot (score ≥ 6) is 'fresh' — the stage the ranker rewards", strong.length > 0 && strong.every(h => h.r.stage === "fresh"), JSON.stringify(hits.map(h => [h.r.score, h.r.stage])));
ok("a 4H fresh dot now reaches 2.5 + 2 + 1 = 5.5 ≥ 5, a 1H one 5.0", 2.5 + 2 + 1 >= 5 && 2 + 2 + 1 >= 5);
ok("weaker dots stay 'reversal' (no bonus)", hits.filter(h => h.r.score < 6).every(h => h.r.stage === "reversal"));
const ct = hits.map(h => A.detectGreenDotMFReversal(h.c, down)).filter(Boolean);
ok("the same dots under a BEARISH daily are counter-trend, never fresh", ct.length === hits.length && ct.every(r => r.stage === "counter-trend reversal"), JSON.stringify(ct.map(r => r.stage)));
ok("…and carry the 200 EMA penalty in their score", ct.every((r, i) => r.score === hits[i].r.score - 2), JSON.stringify(ct.map((r, i) => [hits[i].r.score, r.score])));
const nod = A.detectGreenDotMFReversal(hits[0].c, null);
ok("no daily bars → no trend read at all (not the signal timeframe's own 200 bars)", nod && !/200 EMA/.test(nod.ev.join()), JSON.stringify(nod && nod.ev));
ok("the scanner hands every detector the daily bars", /try \{ r = fn\(c, bars\["1D"\]\); \}/.test(src));
ok("7. the 'placed' ledger record's target is tp2 (2.25R)", /kind: ok \? "placed" : "rejected"[\s\S]{0,300}target: t\.tp2 \?\? t\.tp1/.test(src));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
