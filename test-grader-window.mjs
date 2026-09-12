// ── TEST: the shadow graders must refuse to grade a decision the candle window cannot reach ──
// Runs the REAL functions, lifted out of the agent source by name rather than reimplemented, so
// this cannot pass against a copy of the code that isn't the one that ships. The agent file is an
// ES module with a top-level auto-run block, so it must never be imported here — importing it
// would start a live run against Phemex.
//
// Usage, from the folder holding the agent:   node test-grader-window.mjs
//        against another copy as well:        node test-grader-window.mjs ./cipher-agent-valtown.js /tmp/raw-agent.js
// The second path is the pre-fix copy (e.g. the deployed one off raw.githubusercontent) and is
// optional — that section is skipped when it isn't there.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHED = resolve(process.argv[2] || `${HERE}/cipher-agent-valtown.js`);
const DEPLOYED = process.argv[3] ? resolve(process.argv[3]) : resolve(`${HERE}/raw-agent.js`);

const NEED_FNS = ["decisionBar", "gradeOne", "gradeWithTimeStop", "walkFromBar", "gradeMakerEntry"];

// Pull `function NAME(...) { ... }` out of a source string by balancing braces.
function lift(src, name) {
  const sig = new RegExp(`^function ${name}\\(`, "m");
  const m = sig.exec(src);
  if (!m) return null;
  let i = src.indexOf("{", m.index), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  return null;
}

function buildScope(path) {
  const src = readFileSync(path, "utf8");
  const parts = [
    "const SHADOW_TIMEOUT_BARS = 40;",
    "const MAKER_FEE = 0.0001;",
    "const TAKER_FEE = 0.0006;",
  ];
  const present = [];
  for (const fn of NEED_FNS) {
    const body = lift(src, fn);
    if (body) { parts.push(body); present.push(fn); }
  }
  parts.push(`return { ${present.join(", ")} };`);
  // eslint-disable-next-line no-new-func
  const scope = new Function(parts.join("\n\n"))();
  return { scope, present };
}

// ── candle helpers ────────────────────────────────────────────────────────────────────────────
const H = 3600e3;
// A flat-ish series at `px`, `n` bars of `stepMs`, starting at `t0`.
function bars(t0, n, stepMs, px, spread = 0.5) {
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * stepMs, o: px, h: px + spread, l: px - spread, c: px, v: 1,
  }));
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = Object.is(got, want) || (typeof got === "number" && typeof want === "number" && Math.abs(got - want) < 1e-9);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
}
function checkTruthy(name, got, pred, desc) {
  if (pred(got)) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)}, wanted ${desc}`); }
}

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);      // the decision
const LONG  = { at: T0, dir: "long",  tf: "1D", tfMult: 4, entry: 100, stop: 95,  target: 111.25 };
const SHORT = { at: T0, dir: "short", tf: "1D", tfMult: 4, entry: 100, stop: 105, target: 88.75 };

// The bug case: the fetched window begins 30 DAYS AFTER the decision, in a market that has since
// run to 200. Nothing in this window can say what happened at the decision — but the old code
// walks it anyway, and every bar is already past a long's target and a short's stop.
const STALE = bars(T0 + 30 * 24 * H, 200, 4 * H, 200);
// A window that properly contains the decision and then rallies through the target.
const FRESH_WIN = [...bars(T0 - 10 * 24 * H, 60, 4 * H, 100), ...bars(T0 + 4 * H, 60, 4 * H, 115)];
// Same, but it drops through the stop first.
const FRESH_LOSE = [...bars(T0 - 10 * 24 * H, 60, 4 * H, 100), ...bars(T0 + 4 * H, 60, 4 * H, 90)];

if (!existsSync(DEPLOYED)) {
  console.log(`\n=== PRE-FIX COPY — skipped (no file at ${DEPLOYED}) ===`);
  console.log("   pass the pre-fix copy as the 2nd argument to prove the bug against it too");
} else {
  console.log(`\n=== PRE-FIX COPY (${DEPLOYED}) — showing the bug is real ===`);
  const { scope, present } = buildScope(DEPLOYED);
  check("deployed copy has no decisionBar guard", present.includes("decisionBar"), false);
  checkTruthy("gradeOne scores a stale-window LONG as a full win (the bug)",
    scope.gradeOne({ ...LONG }, STALE), v => v === 2.25, "2.25");
  checkTruthy("gradeOne scores a stale-window SHORT as a full stop (the bug)",
    scope.gradeOne({ ...SHORT }, STALE), v => v === -1, "-1");
  checkTruthy("gradeWithTimeStop does the same on a stale window (the bug)",
    scope.gradeWithTimeStop({ ...LONG }, STALE, 20), v => v === 2.25, "2.25");
  checkTruthy("gradeMakerEntry settles both arms off a stale window (the bug)",
    scope.gradeMakerEntry({ ...LONG }, STALE, 8), v => v && v.takerR > 0, "a positive takerR");
}

console.log(`\n=== PATCHED COPY (${PATCHED}) — the guard ===`);
{
  const { scope, present } = buildScope(PATCHED);
  check("decisionBar is present", present.includes("decisionBar"), true);

  console.log("\n  -- decisionBar itself --");
  check("refuses a window that starts after the decision", scope.decisionBar(LONG, STALE), -1);
  check("refuses an empty window", scope.decisionBar(LONG, []), -1);
  check("refuses a null window", scope.decisionBar(LONG, null), -1);
  check("finds the decision bar in a window that contains it", scope.decisionBar(LONG, FRESH_WIN), 60);
  check("accepts a window starting EXACTLY at the decision", scope.decisionBar(LONG, bars(T0, 60, 4 * H, 100)), 0);
  check("refuses a decision newer than the whole window",
    scope.decisionBar({ ...LONG, at: T0 + 999 * 24 * H }, FRESH_WIN), -1);

  console.log("\n  -- gradeOne --");
  check("stale-window LONG is no longer graded", scope.gradeOne({ ...LONG }, STALE), null);
  check("stale-window SHORT is no longer graded", scope.gradeOne({ ...SHORT }, STALE), null);
  check("a real winner still grades +2.25", scope.gradeOne({ ...LONG }, FRESH_WIN), 2.25);
  check("a real loser still grades -1", scope.gradeOne({ ...LONG }, FRESH_LOSE), -1);
  // 90 does not reach a short's 88.75 target, so FRESH_LOSE leaves a short genuinely unresolved
  // inside the candles available — null is the correct answer there, not a grade.
  check("a short with no resolution yet stays ungraded", scope.gradeOne({ ...SHORT }, FRESH_LOSE), null);
  check("a short that reaches its target grades +2.25",
    scope.gradeOne({ ...SHORT }, [...bars(T0 - 10 * 24 * H, 60, 4 * H, 100), ...bars(T0 + 4 * H, 60, 4 * H, 85)]), 2.25);
  check("a short that is stopped out grades -1",
    scope.gradeOne({ ...SHORT }, [...bars(T0 - 10 * 24 * H, 60, 4 * H, 100), ...bars(T0 + 4 * H, 60, 4 * H, 110)]), -1);

  console.log("\n  -- gradeWithTimeStop --");
  check("stale window is no longer graded", scope.gradeWithTimeStop({ ...LONG }, STALE, 20), null);
  check("fresh winner still grades +2.25", scope.gradeWithTimeStop({ ...LONG }, FRESH_WIN, 20), 2.25);
  checkTruthy("a flat market still marks to market at the cap",
    scope.gradeWithTimeStop({ ...LONG }, [...bars(T0 - 4 * H, 2, 4 * H, 100), ...bars(T0 + 4 * H, 60, 4 * H, 100)], 20),
    v => v !== null && Math.abs(v) < 0.01, "≈0R, not null");

  console.log("\n  -- gradeMakerEntry --");
  check("stale window settles neither arm", scope.gradeMakerEntry({ ...LONG }, STALE, 8), null);
  {
    // Price dips back through the signal price inside the 8h expiry, then runs to target:
    // the maker arm should FILL and both arms should settle.
    const pullback = [
      ...bars(T0 - 4 * H, 2, 1 * H, 101),
      ...bars(T0 + 1 * H, 3, 1 * H, 99.5),     // trades back through 100 → post-only fills
      ...bars(T0 + 5 * H, 80, 1 * H, 115),     // then runs to target
    ];
    const g = scope.gradeMakerEntry({ ...LONG, tf: "1D" }, pullback, 8);
    checkTruthy("a pullback fills the maker arm", g, v => v && v.filled === true, "filled: true");
    checkTruthy("both arms settle positive on that trade", g, v => v && v.takerR > 0 && v.makerR > 0, "takerR>0 and makerR>0");
    checkTruthy("the maker arm beats the taker arm when it does fill (fees)", g,
      v => v && v.makerR > v.takerR, "makerR > takerR");
  }
  {
    // Runs away from the signal price and never comes back inside expiry: MISSED, scored 0R.
    const runaway = [
      ...bars(T0 - 4 * H, 2, 1 * H, 100),
      ...bars(T0 + 1 * H, 100, 1 * H, 112, 0.2),   // never trades back down through 100
    ];
    const g = scope.gradeMakerEntry({ ...LONG, tf: "1D" }, runaway, 8);
    checkTruthy("a runaway is recorded as missed", g, v => v && v.filled === false, "filled: false");
    check("a missed trade scores the maker arm 0R", g && g.makerR, 0);
    checkTruthy("while the taker arm still banks it", g, v => v && v.takerR > 0, "takerR > 0");
  }
}

console.log("\n=== staleArms (one-time accumulator wipe) ===");
{
  const src = readFileSync(PATCHED, "utf8");
  const rev = /const SHADOW_GRADER_REV = "([^"]+)"/.exec(src);
  checkTruthy("SHADOW_GRADER_REV is declared", rev, v => !!v, "a revision string");
  const scope = new Function(`const SHADOW_GRADER_REV = "${rev[1]}";\n${lift(src, "staleArms")}\nreturn { staleArms };`)();
  const dirty = { arms: { taker: { sum: 1006.8, n: 1501 } } };
  check("first call on a populated arm says wipe", scope.staleArms(dirty), true);
  check("and it stamps the revision", dirty.graderRev, rev[1]);
  check("second call is a no-op", scope.staleArms(dirty), false);
  const empty = {};
  check("a fresh slot has nothing to wipe", scope.staleArms(empty), false);
  check("but is still stamped", empty.graderRev, rev[1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
