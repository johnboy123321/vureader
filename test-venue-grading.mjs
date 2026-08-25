// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  GRADING ON THE VENUE — and the scale check that stops it inventing a range
//
//  This exists because of one failure mode with a very ugly shape. Phemex returns some contract
//  prices as scaled integers. If the reader gets the scale wrong by 1e4, every range it builds is
//  ten thousand times too wide, every stop and every target falls inside it, and classifyResolution
//  cheerfully grades the entire book as "ambiguous — both levels touched". The record would fill
//  with confident nonsense and nothing would look broken.
//
//  So the reader refuses more often than it guesses, and sections 2 and 3 are about proving it
//  refuses in exactly the cases where it cannot know.
//
//  Section 5 is the other half: the SIGNAL path must not have moved. Signals are supposed to be
//  read from the deep mainnet book; only grading follows the venue. A patch that quietly pointed
//  the scanner at a thin testnet order book would be far worse than the bug it fixed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';

const src = fs.readFileSync(process.env.AGENT_FILE || 'cipher-agent-valtown.js', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n))
                            : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + String(x).slice(0, 200) : ''))); };

const a = src.indexOf('const PHEMEX_RES = {');
const b = src.indexOf('async function phemexCandles');
if (a < 0 || b < 0) { console.log('  FAIL could not extract the kline reader'); process.exit(1); }
const parse = new Function(src.slice(a, b) + '; return parsePhemexKlines;')();

// ── FIXTURES TAKEN FROM THE REAL API, NOT FROM WHAT I ASSUMED IT RETURNED ──────────────────────
// Probed 2026-08-23. The row is TEN columns, prices are STRINGS in real units (not scaled
// integers), and rows arrive NEWEST FIRST:
//   [ t(sec), interval, lastClose, open, high, low, close, volume, turnover, symbol ]
const REAL_MAINNET = {"code":0,"msg":"OK","data":{"total":-1,"rows":[
  [1787510700,900,"77304.8","77310.2","77317.6","77243.4","77317.6","30.024","2319964.3468","BTCUSDT"],
  [1787509800,900,"77315.8","77320.1","77339.9","77274.1","77304.8","27.456","2122509.9602","BTCUSDT"],
  [1787508900,900,"77318.6","77310","77375.6","77235.9","77315.8","35.505","2745119.1794","BTCUSDT"],
  [1787508000,900,"77162","77160","77374.9","77082","77318.6","39.167","3023098.7239","BTCUSDT"],
  [1787507100,900,"77218.8","77219.5","77300","77162","77162","41.181","3180288.8757","BTCUSDT"]]}};
// Phemex TESTNET, same call, same moment: 38.5 days stale and 16% away.
const REAL_TESTNET_STALE = {"code":0,"msg":"OK","data":{"total":-1,"rows":[
  [1784184300,900,"64709.2","64675","64770.6","64675","64748.6","160.288","10377403.4217","BTCUSDT"],
  [1784183400,900,"64794","64799.6","64804.6","64603.4","64709.2","168.07","10875285.4887","BTCUSDT"]]}};
// Phemex TESTNET SOL: a flat line at zero volume.
const REAL_TESTNET_FLAT = {"code":0,"msg":"OK","data":{"total":-1,"rows":[
  [1784177100,900,"81.14","81.14","81.14","81.14","81.14","0","0","SOLUSDT"],
  [1784176200,900,"81.14","81.14","81.14","81.14","81.14","0","0","SOLUSDT"]]}};
const NOW_MAINNET = 1787512500000;   // just after the newest mainnet bar

// Synthetic builder, matching the real shape (10 cols, newest first, string prices).
const body = (bars, scale = 1, tsSec = true) => ({
  data: { rows: [...bars].reverse().map(x => [
    tsSec ? Math.floor(x.t / 1000) : x.t, 900, String(x.o * scale),
    String(x.o * scale), String(x.h * scale), String(x.l * scale), String(x.c * scale),
    "100", "1000", "TESTUSDT" ]) } });
const T0 = 1787400000000;
const NOW = T0 + 20e5;               // just after the last synthetic bar
const BARS = [
  { t: T0, o: 100, h: 103, l: 99, c: 102 },
  { t: T0 + 9e5, o: 102, h: 105, l: 101, c: 104 },
  { t: T0 + 18e5, o: 104, h: 106, l: 97, c: 100 },
];

console.log('\n1. A well-formed response parses, at any of the scales Phemex uses');
{
  for (const s of [1, 1e2, 1e4, 1e8]) {
    const got = parse(body(BARS, s), '15m', 100, NOW);
    ok(`scale ${s} is detected and removed`, !!got && Math.abs(got[2].c - 100) < 1e-6,
       got ? got[2].c : 'null');
  }
  const got = parse(body(BARS, 1), '15m', 100, NOW);
  ok('all bars come back', got && got.length === 3, got && got.length);
  ok('the high is the real high', got && Math.abs(got[2].h - 106) < 1e-6);
  ok('and the low is the real low', got && Math.abs(got[2].l - 97) < 1e-6);
  ok('second timestamps are converted to ms', got && got[0].t === T0, got && got[0].t);
  const ms = parse(body(BARS, 1, false), '15m', 100, NOW);
  ok('millisecond timestamps are left alone', ms && ms[0].t === T0, ms && ms[0].t);
}

console.log('\n1b. THE REAL API RESPONSE — pinned as a fixture, not as an assumption');
{
  const got = parse(REAL_MAINNET, '15m', 77300, NOW_MAINNET);
  ok('the live mainnet response parses', !!got && got.length === 5, got && got.length);
  ok('prices arrive as STRINGS in real units and come through unscaled',
     got && Math.abs(got[got.length - 1].c - 77317.6) < 1e-6, got && got[got.length - 1].c);
  ok('rows are re-ordered oldest-first', got && got[0].t < got[got.length - 1].t,
     got && [got[0].t, got[got.length - 1].t].join(' → '));
  ok('so the LAST element is the newest bar, which is what the pass reads as "price now"',
     got && got[got.length - 1].t === 1787510700 * 1000);
  ok('the high of the newest bar is right', got && Math.abs(got[got.length - 1].h - 77317.6) < 1e-6);
  ok('and the low', got && Math.abs(got[got.length - 1].l - 77243.4) < 1e-6);
}

console.log('\n2b. A FROZEN OR DEAD VENUE FEED IS REFUSED — the finding that nearly shipped');
{
  // Phemex testnet was 38.5 days behind mainnet. Nothing in the scale check catches that: the
  // stale close is 64748 against a reference of 78511, a ratio of 0.82, well inside the window.
  // Only the freshness gate stops it, and without it this "fix" would have graded today's trades
  // against mid-July prices — a far bigger error than the one it was written to remove.
  const ratio = 64748.6 / 78511.5;
  ok('the stale price WOULD pass the scale check on its own', ratio > 0.33 && ratio < 3, ratio.toFixed(3));
  ok('but the freshness gate refuses it', parse(REAL_TESTNET_STALE, '15m', 78511.5, NOW_MAINNET) === null);
  ok('a flat zero-volume series is refused too', parse(REAL_TESTNET_FLAT, '15m', 81, 1784177200000) === null);
  // ...and fresh data of the same shape is still accepted, so the gate is not just "always no".
  const fresh = JSON.parse(JSON.stringify(REAL_TESTNET_STALE));
  const shift = Math.floor((NOW_MAINNET / 1000) - 1784184300);
  for (const r of fresh.data.rows) r[0] += shift;
  ok('the same feed, but current, IS accepted', !!parse(fresh, '15m', 64748, NOW_MAINNET));
  ok('a bar just inside the age limit passes',
     !!parse(body(BARS, 1), '15m', 100, T0 + 18e5 + 2.9 * 36e5));
  ok('and one just outside does not',
     parse(body(BARS, 1), '15m', 100, T0 + 18e5 + 3.1 * 36e5) === null);
}

console.log('\n1c. The request itself — the endpoint and limit Phemex actually accepts');
{
  const fn = src.slice(src.indexOf('async function phemexCandles'), src.indexOf('async function topUniverse'));
  ok('it calls /kline/last, not /kline', /md\/v2\/kline\/last/.test(fn) && !/md\/v2\/kline"/.test(fn));
  ok('the limit is snapped to a value Phemex allows', /PHEMEX_LIMITS\.find\(x => x >= want\)/.test(fn));
  ok('the allowed set is the documented one', /\[5, 10, 50, 100, 500, 1000\]/.test(src));
  ok('96 bars snaps up to 100, never down', [5,10,50,100,500,1000].find(x => x >= 96) === 100);
}

console.log('\n2. WITHOUT A REFERENCE IT REFUSES — the whole safety property');
{
  for (const ref of [undefined, null, 0, -5, NaN, 'abc'])
    ok('refuses with ref=' + JSON.stringify(ref), parse(body(BARS, 1), '15m', ref, NOW) === null);
  ok('and refuses when no scale lands near the reference',
     parse(body(BARS, 1), '15m', 999999, NOW) === null);
  ok('a reference off by 1000x is not force-fitted', parse(body(BARS, 1), '15m', 0.1, NOW) === null);
  ok('but a reference within a factor of 3 is accepted', !!parse(body(BARS, 1), '15m', 250, NOW));
  ok('and one just outside is not', parse(body(BARS, 1), '15m', 350, NOW) === null);
}

console.log('\n3. Malformed input returns null and never throws');
{
  const junk = [null, undefined, {}, { data: null }, { data: {} }, { data: { rows: [] } },
                { data: { rows: 'nope' } }, { data: { rows: [1, 2, 3] } },
                { data: { rows: [[1, 2, 3]] } },                       // too short
                { data: { rows: [[1, 900, 1, 'x', 'y', 'z', 'w', 1, 1]] } },   // non-numeric
                { data: { rows: [[1, 900, 1, 100, 90, 110, 100, 1, 1]] } }];   // high < low
  for (const j of junk) {
    let threw = false, out;
    try { out = parse(j, '15m', 100, NOW); } catch { threw = true; }
    // JSON.stringify(undefined) is undefined, not a string — label it explicitly.
    const label = j === undefined ? 'undefined' : String(JSON.stringify(j)).slice(0, 42);
    ok('survives ' + label, !threw && out === null, threw ? 'THREW' : out);
  }
  ok('a candle whose close sits outside its own high/low is dropped',
     parse({ data: { rows: [[1, 900, 1, 100, 101, 99, 150, 1, 1]] } }, '15m', 100, NOW) === null);
}

console.log('\n4. The resolution pass asks the venue first, and says which answered');
{
  const fn = src.slice(src.indexOf('const ranges = {}, exitPx = {}, gradedOn = {};'),
                       src.indexOf('const resolved = resolvedSince'));
  ok('the venue is tried first', fn.indexOf('phemexCandles') < fn.indexOf('fetchCandles'),
     'phemex@' + fn.indexOf('phemexCandles') + ' fetch@' + fn.indexOf('fetchCandles'));
  ok('the reference market is still the fallback', /fetchCandles\(coin, "15m", 96\)/.test(fn));
  ok('the venue grade is labelled', /gradedOn\[coin\] = src/.test(fn) && /"venue"/.test(fn));
  ok('and so is the fallback', /"reference"/.test(fn));
  ok('the reference price comes from the plan we already trusted', /prevOpen\[k\]\.plan && prevOpen\[k\]\.plan\.entry/.test(fn));
  ok('a failure cannot break the pass', /catch \{/.test(fn));
  ok('the split is reported', /resolution graded on:/.test(src));
  ok('and a reference grade is called out as weaker', /cannot see a venue-only stop-out/.test(src));
}

console.log('\n5. gradedOn reaches the record — a fact and an approximation must not look alike');
{
  ok('it is attached to every resolution', /\.\.\.r, gradedOn: gradedOn\[r\.coin\] \|\| "none"/.test(src));
  ok('and written to the log/ledger', /gradedOn: r\.gradedOn/.test(src));
  ok('"none" is the honest default when nothing could grade it', /\|\| "none"/.test(src));
}

console.log('\n6. THE SIGNAL PATH MUST NOT HAVE MOVED');
{
  // Grading follows the venue. Deciding must not: the thin testnet book would make the structure
  // this bot reads meaningless. If phemexCandles ever appears in the scan loop, that is a defect.
  // Anchored on the line that actually loads the decision timeframes, not on a function name —
  // the first version of this test looked for `scanCoin`, which does not exist in this file, so it
  // passed vacuously against an empty string and protected nothing. A test that cannot fail is
  // worse than no test: it reports safety it never checked.
  // Re-anchored 2026-08-25 when the five timeframes went parallel. The PROPERTY is unchanged and
  // is the whole point of this block: the scanner decides on the reference market and never on the
  // venue. Only the line that loads them moved.
  const anchor = src.indexOf('const fetched = await Promise.all(SCAN_TFS.map(tf => fetchCandles(coin, tf, 260)))');
  ok('the decision path was located', anchor > 0, anchor);
  const scan = src.slice(anchor, anchor + 6000);
  ok('the scanner still reads the reference market', /fetchCandles\(coin, tf, 260\)/.test(scan));
  ok('and all five decision timeframes are still loaded',
     /const SCAN_TFS = \["1D", "4H", "1H", "30m", "15m"\];/.test(src));
  ok('and never the venue', !/phemexCandles\(/.test(scan));
  ok('phemexCandles is used in exactly one place', (src.match(/await phemexCandles\(/g) || []).length === 1,
     (src.match(/await phemexCandles\(/g) || []).length);
  ok('fetchCandles still points at Binance', /api\.binance\.com\/api\/v3\/klines/.test(src));
  ok('with the OKX fallback intact', /okx\.com\/api\/v5\/market\/candles/.test(src));
  ok('the venue base URL is still hard-locked to testnet',
     /const PHEMEX_BASE = "https:\/\/testnet-api\.phemex\.com"/.test(src));
}

console.log('\n7. The file records what was measured, not what was assumed');
{
  ok('the probed response shape is written down', /PROBED AGAINST THE REAL API/.test(src));
  ok('with the endpoint that actually works', /kline\/last/.test(src));
  ok('the testnet staleness is recorded with its numbers', /38\.5d old/.test(src) && /64748\.6/.test(src));
  ok('and it says plainly that this will refuse on testnet',
     /return null every time and the pass will fall back/.test(src));
  ok('and why that is the right answer', /cannot be settled here/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
