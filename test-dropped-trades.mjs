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
  '\nexport { venueBlock, venueNote, venueClear, venueBench, markStopVerdict, markFrom, explainRejection, VENUE_RULES, MARK_BUFFER_PCT, PERP_MIN, collectPerps };\n');
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
  // Anchored on the function's REAL end, not on a character count. The first version sliced a
  // fixed 2,200 characters, so when the give-up logic was added in the middle, four assertions
  // silently fell off the end of the window and went red on code that was perfectly correct.
  // A test whose scope is a magic number is a test that breaks when the file breathes.
  const end = src.indexOf('═══════════════ CIRCUIT BREAKER', i);
  const blk = src.slice(i, end > i ? end : i + 2200);
  ok('the de-hedge block was located by its own boundary, not a byte count', end > i, end);
  ok('failure has its own result label', /result: ok \? "DE-HEDGED" : "DE-HEDGE FAILED"/.test(blk));
  ok('it is no longer labelled ERR, which parsed as a venue rejection', !/ERR de-hedge/.test(src));
  ok('a failure says the position is STILL hedged', /is STILL holding both sides/.test(blk));
  ok('and quotes what the venue actually said', /the venue refused: \$\{why/.test(blk));
  ok('the reason is captured from the response', /r\.data\.error \|\| r\.data\.msg/.test(blk));
  ok('and from a thrown error too', /catch \(e\) \{ ok = false; why = String\(e && e\.message \|\| e\)/.test(blk));
  ok('it never counts toward the strategy record either way', /countsForStats: false/.test(blk));
  ok('and it tells you it will retry rather than implying it is done', /retried next run/.test(blk));
}

console.log('\n11b. A de-hedge that CANNOT work stops asking (2026-08-25)');
{
  // Found on John's exchange screen: ADA, ETH and XRP each holding both sides, the short leg a
  // tenth to a thirtieth the size of the long. Those are stubs left by an IOC market close that
  // partially filled — below the venue's minimum order size, so no number of retries can clear
  // them, and the bot was asking again every fifteen minutes for ever.
  ok('there is a persisted memory of what the venue refused', /const DEHEDGE_KEY = "cipher_dehedge_failed"/.test(src));
  ok('it gives up after a fixed count rather than a timeout', /const DEHEDGE_GIVE_UP = 3;/.test(src));
  ok('a leg already refused that many times is skipped without another order',
     /\(prevFail\.n \|\| 0\) >= DEHEDGE_GIVE_UP\) \{\s*\n\s*out\.givenUp\+\+;\s*\n\s*continue;/.test(src));
  // The key includes the SIZE, so a leg that changed — meaning something did work — gets another
  // go. Giving up permanently on a leg that is still moving would be the opposite failure.
  ok('the memory is keyed on the size, so a change earns another attempt',
     /failed\[legKey\] = \{ n, size: legSize, why, at: Date\.now\(\) \}/.test(src) &&
     /prevFail\.size !== legSize\) \{ delete failed\[legKey\]/.test(src));
  ok('a successful close clears the record', /if \(ok\) \{ if \(failed\[legKey\]\) \{ delete failed\[legKey\]/.test(src));
  ok('giving up is said ONCE, loudly, with the venue\'s own reason',
     /DE-HEDGE GIVEN UP: \$\{sym\}/.test(src) && /Venue says: \$\{why/.test(src));
  ok('and the ledger line tells John exactly what to do about it',
     /Close it by hand on the exchange; it takes one click/.test(src));
  ok('it still never counts toward the strategy record',
     /result: "DE-HEDGE GIVEN UP", countsForStats: false/.test(src));
  ok('the run summary reports how many are waiting on a human',
     /given up on \(waiting for you to close by hand\)/.test(src));
  ok('the memory is only written when it changed — the state file is committed every run',
     /if \(failedDirty\) \{ try \{ await setJSON\(DEHEDGE_KEY, failed\)/.test(src));
}

console.log('\n11c. The ladder arm measures, and only measures (2026-08-25)');
{
  // The one strategy with evidence behind it: +53.2% median vs holding across 12 coins at real
  // fees, against −7.7% for the flip it varies. It runs as PAPER, because a three-year backtest
  // is a filter and not proof.
  ok('the ladder step exists', /function accumLadderStep\(state, bars, cfg = \{\}\)/.test(src));
  ok('three spacings run at once, so a plateau can be told from a lucky setting',
     /\{ id: "L3x4", rungs: 3, stepPct: 4 \}/.test(src) && /\{ id: "L2x5"/.test(src) && /\{ id: "L5x2"/.test(src));
  ok('rungs are checked BEFORE the dots on the same bar',
     /Rungs are checked BEFORE the dots on the same bar/.test(src));
  ok('the green dot stays as a backstop, or it can strand in cash',
     /else if \(green && st\.cash > 0\) \{[\s\S]{0,200}st\.cash = 0; st\.open = \[\]; st\.trips\+\+;/.test(src));
  ok('a red dot replaces stale rungs rather than bidding an old level',
     /Replace any stale bids/.test(src));
  ok('it is marked back to COINS including cash still out in rungs',
     /r\.st\.unitsNow = \+\(r\.st\.units \+ r\.st\.cash \/ lpx\)/.test(src));
  ok('it reuses bars already fetched — no extra network', /const lbars = flipBars\["1D"\];/.test(src));
  {
    // The whole safety property: this arm can compute and print and nothing else.
    // Anchored end again — see 11a. A byte count would have been wrong here too, and the block
    // it needs to cover is exactly "from the banner to the catch that guards it".
    const i = src.indexOf('THE LADDER ARMS (2026-08-25)');
    const e = src.indexOf('ladder arms skipped (paper only, harmless)', i);
    const blk = src.slice(i, e > i ? e + 60 : i + 2000);
    ok('the ladder block was located by its own boundary', i > 0 && e > i, `${i}..${e}`);
    ok('it places no orders', !/sendSpotOrder|execOrder|phemexCall|placeOrder/.test(blk));
    ok('and one failure in it cannot take the accumulator down',
     /catch \(e\) \{ console\.error\("ladder arms skipped \(paper only, harmless\)/.test(blk));
  }
  ok('it is printed against the 1D flip, the thing it would replace',
     /vs flip 1D/.test(src));
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

console.log('\n13. ASK THE VENUE WHAT IT CARRIES, rather than finding out one refusal at a time');
{
  // John: "can't we just get the list of futures coins from Phemex and forget the rest." The
  // bench stops the SECOND refusal; this stops the first.
  const fn = src.slice(src.indexOf('// ── DO NOT GUESS WHICH KEY THE PERPS ARE UNDER'),
                       src.indexOf('// ═══════════ WHAT THE VENUE WILL NOT TRADE'));
  ok('the product list is read', /phemexPublic\("\/public\/products"\)/.test(fn));
  ok('spot symbols are excluded by their lowercase s, not an uppercased one',
     /if \(raw\[0\] === "s"\) continue;/.test(fn));
  ok('only USDT-margined perps are kept', /sym\.endsWith\("USDT"\)/.test(fn));
  ok('a delisted symbol is dropped', /delist\|unlist\|suspend/.test(fn));
  ok('proved, not just asserted', M.collectPerps({ p: [{ symbol: 'XUSDT', status: 'Delisted' }] }).symbols.size === 0);
  ok('but a MISSING status does not exclude it — unknown is not the same as no',
     M.collectPerps({ p: [{ symbol: 'XUSDT' }] }).symbols.has('X'));
  ok('and neither does one nobody anticipated',
     M.collectPerps({ p: [{ symbol: 'YUSDT', status: 'SomethingNew' }] }).symbols.has('Y'));
  ok('the symbol is reduced to the coin', /out\.add\(sym\.slice\(0, -4\)\)/.test(fn));
  ok('every array in the response is searched, not one guessed key', /const arrays = \[\];/.test(fn));
  ok('and a short parse prints the keys it DID see', /Arrays seen: \$\{seenKeys\.join/.test(src));

  // The guard that matters: a bad parse must not silently empty the universe.
  ok('an implausibly short list is not believed', /if \(symbols\.size < PERP_MIN\)/.test(fn));
  ok('and says so out loud', /NOT filtering the universe this run/.test(fn));
  ok('the floor is 20, not 1', M.PERP_MIN === 20, M.PERP_MIN);
  ok('a failed read fails OPEN', /universe unfiltered this run/.test(fn));
  ok('the list is cached so it is read once per run', /if \(_perpSymbols\) return _perpSymbols;/.test(fn));

  const site = src.slice(src.indexOf('const perps = await perpSymbols();'), src.indexOf('const allowed = await relayWhitelist();'));
  ok('the universe is filtered before anything is scanned', site.length > 0);
  ok('what was dropped is named, never quietly removed', /not listed here: \$\{dropped\.join/.test(site));
  ok('the count is reported both ways', /of \$\{before\} carried by phemex/.test(site));
  ok('and if the filter would empty the universe, it is abandoned', /falling back to the unfiltered list/.test(site));

  ok('the bench survives alongside it — 20005 is temporary and cannot show in a product list',
     !!M.VENUE_RULES['20005']);
}

console.log('\n14. THE PARSE ITSELF — proved against the shape that broke it');
{
  // The first live run answered "only 0 perpetuals parsed". Two reasons, both now fixtures.
  const spotOnly = { products: [{ symbol: 'sBTCUSDT' }, { symbol: 'sETHUSDT' }] };
  ok('a body with only spot pairs yields nothing', M.collectPerps(spotOnly).symbols.size === 0);

  // …because Phemex keeps the USDT perps in their own array.
  const real = {
    products: [{ symbol: 'sBTCUSDT' }, { symbol: 'BTCUSD', type: 'Perpetual' }],
    perpProductsV2: [
      { symbol: 'BTCUSDT', type: 'PerpetualV2', status: 'Listed' },
      { symbol: 'SOLUSDT', type: 'PerpetualV2', status: 'Listed' },
      { symbol: 'SUIUSDT', type: 'PerpetualV2', status: 'Listed' },
      { symbol: 'OLDUSDT', type: 'PerpetualV2', status: 'Delisted' },
    ],
  };
  const got = M.collectPerps(real).symbols;
  ok('perps are found wherever the venue put them', got.size === 3, [...got].join(','));
  ok('SOL is NOT thrown away for starting with S', got.has('SOL'));
  ok('nor is SUI', got.has('SUI'));
  ok('the inverse BTCUSD contract is not counted as a USDT perp', !got.has('BTCUS'));
  ok('the spot pair is still excluded', ![...got].some(x => x.startsWith('S') && x.length > 3 && x !== 'SOL' && x !== 'SUI'));
  ok('a delisted symbol is dropped', !got.has('OLD'));

  // A shape nobody anticipated must still be searched rather than assumed empty.
  const odd = { data: { result: { contracts: [{ symbol: 'ADAUSDT', type: 'PerpetualV2' }] } } };
  ok('a nested, differently-named array is still found', M.collectPerps(odd).symbols.has('ADA'));

  // And the diagnosis is in the log, not in a browser.
  ok('the arrays it saw are reported', M.collectPerps(real).seenKeys.some(k => /perpProductsV2\[4\]/.test(k)),
     M.collectPerps(real).seenKeys.join(','));
  ok('junk in, no throw out', M.collectPerps(null).symbols.size === 0 && M.collectPerps('x').symbols.size === 0);
}

fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
