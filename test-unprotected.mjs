// UNPROTECTED POSITIONS (2026-08-20) — found live: a SOL long the bot never opened sat 13 hours
// with no plan, no stop, no book, silently blocking every SOL trade. The adoption failed on a
// bare `continue`. These pin both halves of the fix: it must speak, and it must keep speaking.
import fs from 'node:fs';
const src = fs.readFileSync('cipher-agent-valtown.js', 'utf8');
const app = fs.readFileSync('index.html', 'utf8');
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};

console.log('\n  THE AGENT SPEAKS WHEN IT CANNOT ADOPT');
ok('a failed adoption is no longer a bare continue',
   !/const plan = buildTradePlan\(bars, pos\.dir, cur\);\s*\n\s*if \(!plan\) continue;/.test(src));
ok('it logs an UNPROTECTED decision', /result: "UNPROTECTED"/.test(src));
ok('the log names the size and notional', /Size \$\{pos\.size\} \(~\$\{notional\.toFixed\(0\)\} USDT\)/.test(src));
ok('it says there is no stop at the venue', /NO stop and NO target at the venue/.test(src));
ok('it says the position blocks other trades in that coin', /blocking new \$\{pos\.coin\} trades in both books/.test(src));
ok('it says the bot did not open it', /This bot did not open it/.test(src));
ok('it still refuses to invent a plan', /continue;/.test(src) && !/plan = \{ *entry: cur, *stop: cur/.test(src));
ok('it marks the position', /pos\.unprotected = true/.test(src));

console.log('\n  AND IT KEEPS SPEAKING, EVERY RUN');
ok('orphans are recomputed each run', /const orphans = Object\.values\(nowOpen\)\.filter\(p => p && !p\.plan && p\.size > 0\)/.test(src));
ok('they are written to state for the app', /setJSON\(ORPHAN_KEY/.test(src));
ok('the key exists', /const ORPHAN_KEY = "cipher_unprotected"/.test(src));
ok('the console warns every run, not once', /UNPROTECTED position\(s\) — no stop, no target/.test(src));
ok('the list is rewritten even when empty, so it clears itself',
   /await setJSON\(ORPHAN_KEY, orphans\.map/.test(src));

console.log('\n  AND THE APP PUTS IT WHERE IT CANNOT BE MISSED');
ok('the panel reads the key', /st\.cipher_unprotected/.test(app));
ok('it renders above the run summary', app.indexOf('UNPROTECTED POSITION') < app.indexOf('last run '));
ok('it is red, not a grey note', /border:1px solid #e88/.test(app));
ok('it shows the notional', /o\.notional/.test(app));
ok('it says what to do about it', /close by hand or set a stop yourself/.test(app));
ok('nothing renders when there are none', /if\(orphans\.length\)\{/.test(app));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
