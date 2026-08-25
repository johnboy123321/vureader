// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE DISCOVERED SETUPS REACH THE AGENT — AND CANNOT DO ANYTHING (2026-08-24)
//
//  John: "let the brain trade." This is the wire that carries a setup the lab found back to the
//  live bot. The whole point of the wire is that it ends at the shadow ledger and not at an order,
//  because a setup that passed a backtest has cleared a filter, not proved an edge — a distinction
//  the control run made vivid: 2,955 generated setups survived at 26.4% against random noise at
//  25.3%.
//
//  So these tests are mostly about what it CANNOT do.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+String(x).slice(0,150):'')));};

console.log('\n1. It loads, and copes with not being there');
ok('there is a loader', /async function setupLab\(\)/.test(src));
ok('the lab is imported dynamically, so the agent stays a single file',
   /await import\(dir \+ "engine\.mjs"\)/.test(src));
// A web upload of a folder does not reliably produce a folder — John's landed loose in the repo
// root. A hardcoded path fails INSIDE the catch, so the arm would have stayed dark with nothing
// in the log to explain it. Both layouts, and it says which one it found.
ok('both layouts are tried', /for \(const dir of \["\.\/setup-lab\/", "\.\/"\]\)/.test(src));
ok('survivors.json is looked for in both places too',
   /for \(const f of \["setup-lab\/survivors\.json", "survivors\.json"\]\)/.test(src));
ok('and finding neither is reported, not swallowed',
   /engine\.mjs not found in setup-lab\/ or the repo root/.test(src));
ok('it says where it loaded from', /setup lab: loaded from \$\{from\}/.test(src));
ok('a missing lab is the quiet normal case, not an error',
   /Cannot find module\|ENOENT/.test(src));
ok('it is loaded once per run, not once per coin', /if \(_setupLab !== undefined\) return _setupLab;/.test(src));
ok('an empty store says so rather than looking like a silent failure',
   /setup lab: no survivors stored yet/.test(src));
ok('the number of setups is capped', /num\("SETUPS_MAX", 20\)/.test(src));

console.log('\n2. A rule it cannot evaluate is benched BY NAME, never run');
{
  // The subtle failure: a condition with no implementation returns false on every bar, which is
  // indistinguishable from a setup that simply never triggered. That would hide a broken rule
  // inside a perfectly normal-looking quiet arm.
  ok('the engine publishes what it can compute', /CONDITION_NAMES/.test(src));
  ok('and the loader checks each rule against it', /const bad = \(r\.when \|\| \[\]\)\.map\(w => w\.fn\)\.filter/.test(src));
  ok('benched rules are named in the log', /setup lab: benched \$\{benched\.length\}/.test(src));
  const eng = fs.readFileSync('setup-lab/engine.mjs','utf8');
  ok('the export exists on the engine side too', /export const CONDITION_NAMES/.test(eng));
}

console.log('\n3. It records, and that is ALL it does');
{
  const start = src.indexOf('function shadowDiscovered(');
  const end = src.indexOf('const SHADOW_KEY = "cipher_shadow";', start);
  const block = src.slice(start, end);
  ok('the function was located', block.length > 300, block.length);
  ok('the only thing it calls is shadowRecord', /shadowRecord\(SHADOW, "discovered_setups", "variant"/.test(block));
  ok('it can place nothing',
     !/sendSpotOrder|execOrder|directOrder|buildOrder|phemexCall|placeOrder/.test(block));
  ok('it cannot change a setting', !/setJSON\(|applyLiveConfig|CFG\./.test(block));
  ok('one bad rule cannot take the arm down', /catch \{ \/\* one bad rule must never stop the others/.test(block));
  ok('only a signal on the newest closed bar counts as a live decision',
     /if \(last\.i < c\.length - 2\) continue;/.test(block));
}

console.log('\n4. It must not cost the scan its coverage');
// Was a hardcoded 30s against a hardcoded 45s budget. Both are configurable now, and the gate
// tracks the budget rather than restating a number — two magic numbers that have to agree are two
// numbers that eventually will not.
ok('the pass is gated on a fraction of the scan budget, not a magic number',
   /if \(Date\.now\(\) - started < num\("SCAN_BUDGET_MS", 90000\) \* 0\.67\) \{/.test(src));
ok('and the budget itself is configurable', /num\("SCAN_BUDGET_MS", 90000\)/.test(src));
ok('and it says so rather than going quiet', /the scan used its time budget on coverage, which comes first/.test(src));
{
  // This anchored on the old sequential 30m/15m fetch line, which the parallel-fetch change
  // deleted — so indexOf returned -1, and `-1 < anything` is true. It went green while checking
  // nothing at all. Third time tonight a test has been caught doing that; both indexes are now
  // asserted to EXIST before they are compared, which is the part that was missing.
  const iFetch = src.indexOf('const fetched = await Promise.all(SCAN_TFS.map');
  const iLab = src.indexOf('_setupsFired += shadowDiscovered');
  ok('both anchors exist — a -1 here would make the comparison meaningless', iFetch > 0 && iLab > 0, `${iFetch}/${iLab}`);
  ok('it reuses bars already fetched — no extra network', iFetch > 0 && iLab > 0 && iFetch < iLab);
}
ok('what fired is reported', /shadow decision\(s\) recorded from discovered setups — none of them placed anything/.test(src));

console.log('\n5. The generator writes only to the store, never to the bot');
{
  const gen = fs.readFileSync('setup-lab/propose.mjs','utf8');
  ok('it writes survivors and a journal', /writeFileSync\(STORE/.test(gen) && /writeFileSync\(JOURNAL/.test(gen));
  ok('and touches nothing else', !/cipher-agent|agent-state|writeFileSync\((?!STORE|JOURNAL)/.test(gen));
  ok('a proposal is never repaired into something that passes',
     /never REPAIR the objects themselves/.test(gen));
  ok('no brain configured is a config gap, not a failure', /This is a config gap, not a failure/.test(gen));
  ok('the prompt tells it what already failed, so the loop is a search',
     /RECENTLY TRIED AND FAILED/.test(gen));
  ok('and it is judged against the noise floor, not against zero', /25\.3%/.test(gen));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
