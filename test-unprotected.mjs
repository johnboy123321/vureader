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
// ── CHANGED 2026-08-25: IT MAY ONLY SAY THAT WHEN IT IS TRUE ─────────────────────────────────
// The old assertion demanded the message always claim "NO stop and NO target at the venue". That
// sentence was never checked against the venue — snapshotOpen dropped the stopLoss field — and on
// 2026-08-25 the panel said it about an ETH long that Phemex was showing with TP/SL 2551.76 /
// 2376.1. A warning that cries wolf spends the attention the real ones need, and this one told
// John to go and set a stop on a position that already had one.
ok('it says there is no stop only when the venue says there is no stop',
   /if \(s === null\) \{[\s\S]{0,400}It has NO stop at the venue/.test(src));
ok('a venue stop it CAN see is reported as such, not as an emergency',
   /The venue IS holding a stop at \$\{formatPrice\(s\)\}/.test(src));
ok('and that case is not flagged unprotected', /pos\.unprotected = false;\s+\/\/ it has a stop/.test(src));
ok('an unreadable stop is stated as unreadable, never as absent',
   /I could not read a stop from the venue for it either way/.test(src));
ok('the venue fields are actually carried through the snapshot',
   /venueStop: venuePx\(p\.stopLossRp \?\? p\.stopLoss \?\? p\.stopLossEp\)/.test(src));
ok('0 means none and a missing field means unknown — they are different',
   /return n > 0 \? n : null;\s+\/\/ null = definitely none, undefined = cannot tell/.test(src));
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
