// ── THE DROPPED TRADES (2026-08-21) ─────────────────────────────────────────────────────────
// Nineteen of twenty order attempts in the 2026-08-20/21 window were refused by the venue. The
// classifier built the day before told us why; counting told us it was mostly the same two
// answers, asked again and again:
//
//     20005  the venue has this symbol switched off        ×9
//     11048/11052  stop on the wrong side of the MARK      ×3
//     39999  symbol not listed here                        ×2
//     "ERR de-hedge" — not a rejection at all, mislabelled ×5
//
// Every one of those burned the coin for the day. This file guards the three fixes, and the one
// property that matters across all of them: a venue's refusal is a fact about the VENUE, so it
// must never spend a trading slot, never enter the strategy's record, and never be silent.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js', 'utf8');
const out = path.join(process.cwd(), '.dropped-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { venueBlock, venueNote, venueClear, venueBench, markStopVerdict, markFrom, explainRejection, VENUE_RULES, MARK_BUFFER_PCT };\n');
const M = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + String(x).slice(0, 180) : ''))); };
const NOW = 1787000000000;
const H = 3600e3, D = 864e5;

console.log('\n1. A symbol the venue switched off is benched, not re-asked');
{
  let mem = {};
  ok('nothing is benched to begin with', M.venueBlock(mem, 'OPUSDT', NOW) === null);
  mem = M.venueNote(mem, 'OPUSDT', '20005', NOW);
  const b = M.venueBlock(mem, 'OPUSDT', NOW);
  ok('one refusal benches it', !!b);
  ok('for six hours', mem.OPUSDT.until - NOW === 6 * H, (mem.OPUSDT.until - NOW) / H + 'h');
  ok('the reason names the venue, not the setup', /venue has this symbol switched off/.test(b.why));
  ok('and the message says when it will try again', /trying again in 6h/.test(b.label), b.label);
  ok('it is NOT benched once the cooldown passes', M.venueBlock(mem, 'OPUSDT', NOW + 6 * H + 1) === null);
  ok('and other symbols are untouched', M.venueBlock(mem, 'BTCUSDT', NOW) === null);
}

console.log('\n2. A symbol that keeps saying no waits longer — but never forever');
{
  let mem = {};
  const waits = [];
  for (let i = 0; i < 6; i++) { mem = M.venueNote(mem, 'OPUSDT', '20005', NOW); waits.push((mem.OPUSDT.until - NOW) / H); }
  ok('the wait doubles each refusal', waits[0] === 6 && waits[1] === 12 && waits[2] === 24, waits.join(','));
  ok('and caps at 48h rather than growing without limit', waits[waits.length - 1] === 48, waits.join(','));
  ok('the strike count is kept so the log can say "refused 6×"', mem.OPUSDT.strikes === 6);
}

console.log('\n3. Not-listed is a longer answer than switched-off');
{
  const mem = M.venueNote({}, 'FOOUSDT', '39999', NOW);
  ok('a week, not six hours', mem.FOOUSDT.until - NOW === 7 * D, (mem.FOOUSDT.until - NOW) / D + 'd');
  ok('and it says the venue does not list it', /does not list this symbol/.test(mem.FOOUSDT.why));
}

console.log('\n4. Only refusals we UNDERSTAND bench a symbol');
{
  // A 502, a timeout, an unrecognised code: those are faults or unknowns, not the venue telling
  // us a symbol is unavailable. Benching on them would quietly shrink the universe for a reason
  // nobody could name.
  for (const code of ['11048', '10500', null, undefined, '', 'nonsense']) {
    const mem = M.venueNote({}, 'BTCUSDT', code, NOW);
    ok('code ' + JSON.stringify(code) + ' does not bench anything', Object.keys(mem).length === 0, JSON.stringify(mem));
  }
}

console.log('\n5. One good order clears the bench');
{
  let mem = M.venueNote({}, 'OPUSDT', '20005', NOW);
  mem = M.venueNote(mem, 'ADAUSDT', '39999', NOW);
  mem = M.venueClear(mem, 'OPUSDT');
  ok('the traded symbol is released', M.venueBlock(mem, 'OPUSDT', NOW) === null);
  ok('the other stays benched', !!M.venueBlock(mem, 'ADAUSDT', NOW));
  ok('clearing something never benched is harmless', Object.keys(M.venueClear(mem, 'NEVERUSDT')).length === 1);
}

console.log('\n6. The bench is never silent');
{
  let mem = M.venueNote({}, 'OPUSDT', '20005', NOW);
  mem = M.venueNote(mem, 'FOOUSDT', '39999', NOW);
  const b = M.venueBench(mem, NOW);
  ok('everything benched is listed', b.length === 2, b.join(' | '));
  ok('with its code and remaining time', /OPUSDT \(20005, \d+m\)/.test(b.join(' ')), b.join(' '));
  ok('expired entries drop off the list', M.venueBench(mem, NOW + 8 * D).length === 0);
}

console.log('\n7. THE MARK GUARD — asking Phemex\'s question before Phemex does');
{
  // A LONG whose stop sits ABOVE the mark is exactly the 11048 case.
  const long = { side: 'Buy', stopLossRp: 100 };
  ok('a long stop above the mark is caught', !!M.markStopVerdict(long, 99));
  ok('and named as aged out, not as a bad setup', /aged out/.test(M.markStopVerdict(long, 99).label));
  ok('classified as an execution artifact', M.markStopVerdict(long, 99).klass === 'execution_artifact');
  ok('caused by cadence, which is measurable', M.markStopVerdict(long, 99).cause === 'cadence');
  ok('the detail quotes both numbers', /stop 100 vs mark 99/.test(M.markStopVerdict(long, 99).detail));
  ok('a long stop safely below the mark passes', M.markStopVerdict(long, 200) === null);
  ok('and one only just below still passes', M.markStopVerdict({ side: 'Buy', stopLossRp: 100 }, 101) === null);
  ok('but one inside the buffer is caught', !!M.markStopVerdict({ side: 'Buy', stopLossRp: 100 }, 100.05));

  const short = { side: 'Sell', stopLossRp: 100 };
  ok('a short stop below the mark is caught (11052)', !!M.markStopVerdict(short, 101));
  ok('a short stop above the mark passes', M.markStopVerdict(short, 50) === null);
}

console.log('\n8. A guard that cannot see must not block');
{
  const o = { side: 'Buy', stopLossRp: 100 };
  for (const bad of [null, undefined, 0, -1, NaN, 'nonsense']) {
    ok('mark ' + JSON.stringify(bad) + ' → no interference', M.markStopVerdict(o, bad) === null);
  }
  ok('no stop on the order → a different guard\'s job', M.markStopVerdict({ side: 'Buy' }, 100) === null);
  ok('no order at all → null, not a throw', M.markStopVerdict(null, 100) === null);
}

console.log('\n9. Reading the mark out of whatever shape the venue sends');
{
  ok('markRp at the top level', M.markFrom({ markRp: 123 }) === 123);
  ok('nested in data', M.markFrom({ data: { result: { markPriceRp: 55.5 } } }) === 55.5);
  ok('an Rp value is preferred over an Ep one', M.markFrom({ markEp: 1230000, markRp: 123 }) === 123);
  ok('a shape with no mark reads as unknown, not zero', M.markFrom({ lastRp: 99, indexRp: 98 }) === null);
  ok('junk reads as unknown', M.markFrom(null) === null && M.markFrom('x') === null && M.markFrom({}) === null);
  ok('a zero or negative mark is not accepted', M.markFrom({ markRp: 0 }) === null && M.markFrom({ markRp: -5 }) === null);
}

console.log('\n10. Wired in at the order site — and the coin is NOT burned');
{
  // The whole point: a venue refusal must not spend the day's slot. `fired[key]` is what burns a
  // coin, so both new guards must `continue` BEFORE it is set.
  const i = src.indexOf('const benched = venueBlock(VENUE');
  const j = src.indexOf('const stale = markStopVerdict(built.order, mk);');
  const k = src.indexOf('fired[key] = Date.now();', i);
  ok('the bench check exists', i > 0);
  ok('the mark check exists', j > 0);
  ok('the bench check runs BEFORE the coin is burned', i < k, i + ' < ' + k);
  ok('so does the mark check', j < k, j + ' < ' + k);
  ok('the bench check runs before the order is even built', i < src.indexOf('const built = buildOrder(t);', i));
  ok('both are logged as not counting toward the record',
     (src.slice(i, k).match(/countsForStats: false/g) || []).length >= 2);
  ok('the venue memory is saved only when it changes', /if \(JSON\.stringify\(VENUE\) !== before\) await setJSON\(VENUE_KEY, VENUE\)/.test(src));
  ok('a successful order clears the symbol', /VENUE = ok \? venueClear\(VENUE, sym\)/.test(src));
  ok('the bench is printed every run', /venue bench \(\$\{bench\.length\}\)/.test(src));
  ok('and the memory fails OPEN if it cannot be read', /fails open — every symbol allowed/.test(src));
  ok('the mark is only fetched when actually arming', src.slice(i, k).includes("if (mode === \"armed\")"));
}

console.log('\n11. THE DE-HEDGE no longer reports a failure as a success');
{
  const i = src.indexOf('A FAILED CLOSE MUST NOT REPORT ITSELF AS A CLOSE');
  ok('the fix is present', i > 0);
  const blk = src.slice(i, i + 2200);
  ok('failure has its own result label', /result: ok \? "DE-HEDGED" : "DE-HEDGE FAILED"/.test(blk));
  ok('it is no longer labelled ERR, which parsed as a venue rejection', !/ERR de-hedge/.test(src));
  ok('a failure says the position is STILL hedged', /is STILL holding both sides/.test(blk));
  ok('and quotes what the venue actually said', /the venue refused: \$\{why/.test(blk));
  ok('the reason is captured from the response', /r\.data\.error \|\| r\.data\.msg/.test(blk));
  ok('and from a thrown error too', /catch \(e\) \{ ok = false; why = String\(e && e\.message \|\| e\)/.test(blk));
  ok('it never counts toward the strategy record either way', /countsForStats: false/.test(blk));
  ok('and it tells you it will retry rather than implying it is done', /retried next run/.test(blk));
}

console.log('\n12. The classifier still agrees with the bench rules');
{
  // The two tables have to name the same codes or one of them is lying about coverage.
  for (const code of Object.keys(M.VENUE_RULES)) {
    const r = M.explainRejection('phemex ' + code);
    ok('code ' + code + ' is classified as an execution artifact', r.klass === 'execution_artifact');
    ok('code ' + code + ' has a named cause', r.cause === 'venue' || r.cause === 'universe', r.cause);
  }
  ok('11048 is still cadence, and is NOT benched (it is a per-order timing fault)',
     M.explainRejection('phemex 11048').cause === 'cadence' && !M.VENUE_RULES['11048']);
}

fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
