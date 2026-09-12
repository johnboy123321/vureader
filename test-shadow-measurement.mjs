// ── TEST: the two measurement fixes of 2026-09-12 ─────────────────────────────────────────────
//   1. shadowRecord records one decision once, not once per run
//   2. walkDecision exposes WHY a decision resolved, and a finer resolution can disagree
//      (the 1D-graded-on-4H artefact, reproduced end to end)
// Runs the REAL functions, lifted out of the agent source by name rather than reimplemented.
// The agent is an ES module with a top-level auto-run block, so it must never be imported here.
//
// Usage:  node test-shadow-measurement.mjs [./cipher-agent-valtown.js]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = resolve(process.argv[2] || `${HERE}/cipher-agent-valtown.js`);
const src = readFileSync(AGENT, "utf8");

function lift(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(src);
  if (!m) return null;
  let depth = 0;
  for (let j = src.indexOf("{", m.index); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  return null;
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = Object.is(got, want) || (typeof got === "number" && typeof want === "number" && Math.abs(got - want) < 1e-3);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
}

const H = 3600e3;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const bar = (t, h, l, c = null) => ({ t, o: (h + l) / 2, h, l, c: c === null ? (h + l) / 2 : c, v: 1 });

// ══════════════════ 1. ONE RECORD PER DECISION ══════════════════
console.log("\n=== shadowRecord: one record per decision, not one per run ===");
{
  const parts = [
    "const SHADOW_MAX_RECORDS = 600;",
    "let SHADOW_DUPS_THIS_RUN = 0;",
    lift("shadowSlot"),
    lift("shadowRecord"),
    "return { shadowRecord, shadowSlot, dups: () => SHADOW_DUPS_THIS_RUN };",
  ];
  if (!lift("shadowRecord") || !lift("shadowSlot")) { fail++; console.log("  ✗ could not lift shadowRecord/shadowSlot"); }
  else {
    const s = new Function(parts.join("\n\n"))();
    const sh = {};
    const plan = { coin: "ADA", dir: "short", planTf: "1D", entry: 0.2172, sl: 0.2621, tp2: 0.1301 };
    const meta = { quality: 6, note: "rollover" };

    // the ADA case from the live state file: the same offer, fourteen runs running
    for (let i = 0; i < 14; i++) s.shadowRecord(sh, "rank_vs_threshold", "baseline", plan, meta);
    check("14 identical offers produce 1 record", sh.rank_vs_threshold.records.length, 1);
    check("the other 13 are counted as duplicates", s.dups(), 13);

    // the variant arm is a DIFFERENT experiment on the same decision — it must still be recorded
    s.shadowRecord(sh, "rank_vs_threshold", "variant", plan, meta);
    check("the variant arm still records the same decision", sh.rank_vs_threshold.records.length, 2);
    s.shadowRecord(sh, "rank_vs_threshold", "variant", plan, meta);
    check("but not twice", sh.rank_vs_threshold.records.length, 2);

    // genuinely different decisions are all still recorded
    s.shadowRecord(sh, "rank_vs_threshold", "baseline", { ...plan, entry: 0.2200 }, meta);
    check("a different entry is a different decision", sh.rank_vs_threshold.records.length, 3);
    s.shadowRecord(sh, "rank_vs_threshold", "baseline", { ...plan, sl: 0.2700 }, meta);
    check("a different stop is a different decision", sh.rank_vs_threshold.records.length, 4);
    s.shadowRecord(sh, "rank_vs_threshold", "baseline", { ...plan, coin: "DOT" }, meta);
    check("a different coin is a different decision", sh.rank_vs_threshold.records.length, 5);
    s.shadowRecord(sh, "rank_vs_threshold", "baseline", { ...plan, dir: "long" }, meta);
    check("the other direction is a different decision", sh.rank_vs_threshold.records.length, 6);
    s.shadowRecord(sh, "rank_vs_threshold", "baseline", { ...plan, planTf: "4H" }, meta);
    check("the same levels on another timeframe is a different decision", sh.rank_vs_threshold.records.length, 7);

    // a second slot is independent
    s.shadowRecord(sh, "regime_direction", "baseline", plan, meta);
    check("another experiment's slot is unaffected", sh.regime_direction.records.length, 1);

    const r0 = sh.rank_vs_threshold.records[0];
    check("the kept record still carries its entry", r0.entry, 0.2172);
    check("the kept record still carries its stop", r0.stop, 0.2621);
    check("the kept record still carries its target", r0.target, 0.1301);
    check("the kept record still starts ungraded", r0.R, null);
  }
}

// ══════════════════ 2. walkDecision, AND THE ARTEFACT ══════════════════
console.log("\n=== walkDecision: why a decision resolved, and what resolution hides ===");
{
  const parts = [
    "const SHADOW_TIMEOUT_BARS = 40;",
    lift("decisionBar"),
    lift("walkDecision"),
    lift("gradeOne"),
    "return { decisionBar, walkDecision, gradeOne };",
  ];
  if (!lift("walkDecision")) { fail++; console.log("  ✗ could not lift walkDecision — is this the patched file?"); }
  else {
    const s = new Function(parts.join("\n\n"))();

    // A real 1D short, at this project's own median geometry: 6.6% stop, 14.8% target = 2.24R.
    const oneD = { at: T0, dir: "short", tf: "1D", entry: 100, stop: 106.6, target: 85.2 };

    // THE 4H VIEW: a single bar that ran to 107 and to 84. Both levels inside one candle. The
    // walk checks the stop first, so this scores a full loss — and cannot know which came first.
    const coarse = [bar(T0 - 4 * H, 101, 99), bar(T0, 107, 84, 90)];
    const g4 = s.walkDecision(oneD, coarse);
    check("4H: one bar spanning both levels resolves as a stop", g4.how, "stop");
    check("4H: and scores a full loss", g4.R, -1);
    check("4H: the ambiguity is flagged, not hidden", g4.ambiguous, true);
    check("4H: and counted on the record", oneD.ambiguous, 1);

    // THE 1H VIEW OF THE SAME DECISION: price fell to the target first; the 107 print came later.
    const fine = [
      bar(T0 - 1 * H, 101, 99),
      bar(T0 + 0 * H, 101, 97),
      bar(T0 + 1 * H, 99, 90),
      bar(T0 + 2 * H, 92, 84),        // target touched — 84 <= 85.2, nothing near the stop yet
      bar(T0 + 3 * H, 95, 88),
      bar(T0 + 9 * H, 107, 100),      // the stop print, hours AFTER the trade was already won
    ];
    const rec2 = { ...oneD };
    const g1 = s.walkDecision(rec2, fine, 40 * 24);
    check("1H: the same decision resolves as a target", g1.how, "target");
    check("1H: and scores the full 2.24R", g1.R, 14.8 / 6.6);
    check("1H: with no ambiguity to flag", g1.ambiguous, false);
    check("so the two resolutions disagree on the sign", (g4.R > 0) === (g1.R > 0), false);

    // The check must not be biased towards flipping: when the stop genuinely came first, agree.
    const fineStopFirst = [
      bar(T0 - 1 * H, 101, 99),
      bar(T0 + 0 * H, 103, 99),
      bar(T0 + 1 * H, 107, 102),      // stop first, on fine data too
      bar(T0 + 2 * H, 100, 84),       // target only afterwards
    ];
    const g1b = s.walkDecision({ ...oneD }, fineStopFirst, 40 * 24);
    check("1H: a genuine stop-first still resolves as a stop", g1b.how, "stop");
    check("1H: and both resolutions agree", g1b.R, -1);

    // A trade that never reaches either level inside the cap is marked to market, not guessed.
    const flat = [bar(T0 - 1 * H, 101, 99), ...Array.from({ length: 80 }, (_, i) => bar(T0 + i * H, 100.5, 99.5, 100))];
    const g1c = s.walkDecision({ ...oneD }, flat, 48);
    check("a cap reached with neither level hit marks to market", g1c.how, "timeout");
    check("and the cap is honoured in the bars passed in", Math.abs(g1c.R) < 0.01, true);

    // gradeOne must be unchanged for every caller that only wants the number.
    check("gradeOne still returns the bare R", s.gradeOne(oneD, coarse), -1);
    check("gradeOne still returns null while open", s.gradeOne({ ...oneD, at: T0 + 999 * 24 * H }, coarse), null);
  }
}

// ══════════════════ 3. the wiring is actually in place ══════════════════
console.log("\n=== wiring ===");
check("secondOpinion is called from gradeShadow", /await secondOpinion\(sh\);/.test(src), true);
check("secondOpinion never writes R", !/\brec\.R\s*=(?!=)/.test(lift("secondOpinion") || ""), true);
check("secondOpinion writes R2 instead", /rec\.R2 = /.test(lift("secondOpinion") || ""), true);
check("1D is re-checked on 1H", /SECOND_OPINION_TF\s*=\s*\{\s*"1D":\s*"1H"\s*\}/.test(src), true);
check("with an equal wall-clock cap (24 x 1H per 1D)", /SECOND_OPINION_MULT\s*=\s*\{\s*"1D":\s*24\s*\}/.test(src), true);
check("no gate reads R2", !/\bR2\b/.test(lift("armStats") || "") && !/\bR2\b/.test(lift("shadowJudge") || ""), true);
check("the duplicate count reaches the log line", /duplicate offer\(s\) not re-recorded/.test(src), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
