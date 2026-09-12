// ── TEST: a fix to the order path un-latches what the broken path gave up on (2026-09-12) ─────
// The give-up counter is meant to be sticky. It is NOT meant to outlive the bug it recorded —
// which is what happened here: five legs latched on "refPx required to size-check the order",
// the bot's own guard refusing its own reduce-only close, and they stayed latched after the fix.
// Runs the REAL function, lifted out of the agent source by name. Never imports the module.
//
// Usage:  node test-dehedge-unlatch.mjs [./cipher-agent-valtown.js]
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
  if (Object.is(got, want)) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
}

const REV = (/const DEHEDGE_CODE_REV = "([^"]+)"/.exec(src) || [])[1];
const GIVE_UP = Number((/const DEHEDGE_GIVE_UP = (\d+)/.exec(src) || [])[1]);
const body = lift("unlatchDehedge");
if (!body || !REV) { console.log("  ✗ could not lift unlatchDehedge / DEHEDGE_CODE_REV — is this the patched file?"); process.exit(1); }
const unlatch = new Function([`const DEHEDGE_CODE_REV = ${JSON.stringify(REV)};`, body, "return unlatchDehedge;"].join("\n\n"))();

check("DEHEDGE_GIVE_UP is a real number", GIVE_UP > 0, true);

// The exact five entries that were stuck in the live state file on 2026-09-12.
const live = () => ({
  "ADAUSDT|short":  { n: 3, size: "321",   why: "refPx required to size-check the order", at: 1788161229802 },
  "AVAXUSDT|short": { n: 3, size: "9.1",   why: "refPx required to size-check the order", at: 1788816382317 },
  "UNIUSDT|short":  { n: 2, size: "36.57", why: "refPx required to size-check the order", at: 1788936290613 },
  "DOTUSDT|long":   { n: 3, size: "84.38", why: "refPx required to size-check the order", at: 1788998399872 },
  "FILUSDT|long":   { n: 3, size: "244.1", why: "refPx required to size-check the order", at: 1789060491872 },
});

console.log("\n=== the live latch, cleared once ===");
{
  const f = live();
  const n = unlatch(f, null);                     // no stamp stored yet — the state John has now
  check("all five legs are un-latched", n, 5);
  check("every counter is back to zero", Object.values(f).every(e => e.n === 0), true);
  check("none is still above the give-up bar", Object.values(f).some(e => (e.n || 0) >= GIVE_UP), false);
  check("the old count is kept as history", f["ADAUSDT|short"].prevN, 3);
  check("and the one that was mid-way too", f["UNIUSDT|short"].prevN, 2);
  check("the revision that cleared it is recorded", f["DOTUSDT|long"].unlatchedBy, REV);
  check("with a timestamp", typeof f["FILUSDT|long"].unlatchedAt, "number");
  check("the leg size is untouched", f["AVAXUSDT|short"].size, "9.1");
  check("the venue's reason is untouched", f["AVAXUSDT|short"].why, "refPx required to size-check the order");
  check("no entries are added or dropped", Object.keys(f).length, 5);
}

console.log("\n=== and only once ===");
{
  const f = live();
  unlatch(f, null);
  const again = unlatch(f, REV);                  // second run, stamp now matches
  check("a matching revision un-latches nothing", again, 0);
  const f2 = live();
  check("a matching revision on fresh state is a no-op", unlatch(f2, REV), 0);
  check("and mutates nothing", f2["ADAUSDT|short"].n, 3);
}

console.log("\n=== it re-latches after the fresh attempts are spent ===");
{
  const f = live();
  unlatch(f, null);
  // the code path that records a failure increments n; after GIVE_UP more refusals it is stuck again
  for (let i = 0; i < GIVE_UP; i++) f["ADAUSDT|short"].n++;
  check(`${GIVE_UP} genuine refusals latch it again`, f["ADAUSDT|short"].n >= GIVE_UP, true);
  check("so a real venue refusal costs three asks, not a loop", unlatch(f, REV), 0);
}

console.log("\n=== it does not trip over odd state ===");
{
  const f = { "A|short": { n: 0, size: "1" }, "B|long": null, "C|short": "nonsense", "D|long": {}, "E|short": { n: 2, size: "5" } };
  const n = unlatch(f, "an-older-revision");
  check("only legs with a live counter are touched", n, 1);
  check("the zero-counter leg is left alone", f["A|short"].prevN, undefined);
  check("a null entry does not throw", f["B|long"], null);
  check("a non-object entry does not throw", f["C|short"], "nonsense");
  check("the real one is cleared", f["E|short"].n, 0);
  check("an empty object is skipped", f["D|long"].prevN, undefined);
  check("an empty map is fine", unlatch({}, null), 0);
  check("a missing map is fine", unlatch(undefined, null), 0);
}

console.log("\n=== wiring ===");
const iUnlatch = src.indexOf("const unlatched = unlatchDehedge(");
const iGiveUp  = src.indexOf("(prevFail.n || 0) >= DEHEDGE_GIVE_UP");
check("un-latching runs before the give-up check", iUnlatch > 0 && iUnlatch < iGiveUp, true);
check("the stamp is written so it only runs once", /setJSON\(DEHEDGE_REV_KEY, DEHEDGE_CODE_REV\)/.test(src), true);
check("the stamp lives outside the failure map", /const DEHEDGE_REV_KEY\s*=\s*"cipher_dehedge_rev"/.test(src), true);
check("it says out loud how many legs it freed", /leg\(s\) un-latched/.test(src), true);
check("clearing the latch marks the state dirty so it is saved", /unlatched\)\s*\{[\s\S]{0,120}failedDirty = true;/.test(src), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
