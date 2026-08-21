// What the in-app chat is TOLD about the bot. This is the highest-consequence text in the app:
// the model will state whatever is in here as fact, so an omission does not read as an omission —
// it reads as a confident answer about the wrong bot. Found 2026-08-21: the chat's context was
// built when the APP placed orders, and had no idea the 24/7 agent, the ledger, the accumulator
// or the shadow book existed. Asked "how is the bot doing" it answered from a feed dormant since
// 2026-08-15.
import fs from 'node:fs';
const src = fs.readFileSync('index.html', 'utf8');
const a = src.indexOf('// ── WHAT THE 24/7 AGENT IS DOING');
const b = src.indexOf('function botContext() {');
if (a < 0 || b < 0) { console.log('FAIL: could not extract serverBotContext'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + String(x).slice(0, 200) : ''))); };

const build = snapshot => {
  const win = { getServerState: () => snapshot };
  return new Function('window', src.slice(a, b) + '; return serverBotContext();')(win);
};

const at = d => new Date(d).toISOString();
const now = Date.now();

console.log('\n1. With no state read, it says so rather than inventing');
{
  const o = build(null);
  ok('it admits the feed is missing', /has not been read yet/.test(o));
  ok('and warns the model off the dormant app feed', /dormant since 2026-08-15/.test(o));
  ok('it does not fabricate a record', !/win rate/.test(o));
}

console.log('\n2. The graded record, counted the same way the panel counts it');
{
  const st = { cipher_ledger: [
    { at: at(now - 1e6), kind: 'resolved', coin: 'BTC', how: 'target', klass: 'strategy', R: 2.25, countsForStats: true },
    { at: at(now - 2e6), kind: 'resolved', coin: 'ETH', how: 'stop', klass: 'strategy', R: -1, countsForStats: true },
    { at: at(now - 3e6), kind: 'resolved', coin: 'FIL', how: 'closed_by_hand', klass: 'execution_artifact', countsForStats: false },
    { at: at(now - 4e6), kind: 'rejected', coin: 'OP' },
    { at: at(now - 5e6), kind: 'rejected', coin: 'ADA' },
  ]};
  const o = build({ st, at: now });
  ok('two graded trades', /2 graded trades/.test(o), o.match(/\d+ graded trades/));
  ok('one won, one lost', /1 won, 1 lost/.test(o));
  ok('the win rate is stated', /50% win rate/.test(o));
  ok('total R is stated', /\+1\.25R/.test(o));
  ok('artifacts are named as not counted', /1 execution artifacts/.test(o));
  ok('rejections are named as not counted', /2 venue rejections/.test(o));
  ok('AND the model is told never to fold them in', /never fold artifacts or rejections into a win rate/.test(o));
  ok('it says the record came from the permanent ledger', /permanent ledger, 5 real events/.test(o));
}

console.log('\n3. Falling back to the debug log is disclosed, not hidden');
{
  const st = { cipher_log: [{ at: at(now), result: 'RESOLVED', skipped: 'BTC long target at 1 — through the target' }] };
  const o = build({ st, at: now });
  ok('it says the window is only about a day', /debug log only .* roughly a day/.test(o), o.match(/THE RECORD \([^)]*\)/));
  ok('the old prose shape is still read correctly', /1 graded trades, 1 won/.test(o));
}

console.log('\n4. Positions, and the ones with no stop on them');
{
  const st = { cipher_open: { 'ADA|long': { coin: 'ADA', dir: 'long', size: 717, plan: { stop: 0.17, target: 0.21 } } },
               cipher_unprotected: [{ coin: 'SOL', dir: 'long' }] };
  const o = build({ st, at: now });
  ok('open positions are listed with their plan', /ADA long size 717 \(stop 0\.17, target 0\.21\)/.test(o));
  ok('an unprotected position is flagged hard', /UNPROTECTED/.test(o) && /SOL long/.test(o));
}

console.log('\n5. The drawdown anchor is not passed off as a balance');
{
  const o = build({ st: { cipher_breaker: { dayEq: 134708.39, weekEq: 135619.66, streak: 2 } }, at: now });
  ok('the anchor is given', /measuring today from 134708 USDT/.test(o));
  ok('the streak is given', /Losing streak 2/.test(o));
  ok('and it is explicitly NOT the balance', /NOT the current balance/.test(o));
}

console.log('\n6. THE ACCUMULATOR — a second scoreboard, in coins');
{
  const st = { cipher_accum: { units: 0, cash: 536.12, pxNow: 69337, startUnits: 0.00767931, exec: 'armed',
                               liveFlip: { tf: '15m', sells: 11, trips: 10, holding: false } } };
  const o = build({ st, at: now });
  ok('it is named as a separate strategy', /ACCUMULATOR \(SPOT, a SECOND strategy/.test(o));
  ok('and scored in coins, not pounds', /COINS not pounds/.test(o));
  ok('the benchmark is stated', /buy-and-hold ends with exactly the starting units/.test(o));
  ok('the armed state is given', /Arming: armed/.test(o));
  ok('the live flip timeframe is named', /15m dot flip currently holds the real coins/.test(o));
  ok('and that the ladder is stood down', /pump ladder is stood down/.test(o));
  ok('THE JAM IS DISCLOSED so the chat cannot call the ladder healthy', /KNOWN DEFECT/.test(o) && /jammed/.test(o));
  ok('with the measured number attached', /0\.77 BTC against 1\.00 held/.test(o));
}

console.log('\n7. THE PAPER BOOK — the direction split, never a blended rate');
{
  // Spread the decisions across the whole 35 hours — the first version bunched them into three
  // minutes and then asserted the span was 35h, which the code correctly reported as 0. The
  // fixture was wrong, not the code; worth saying because that is the failure mode this whole
  // file exists to catch.
  const SPAN_H = 35;
  const mk = (dir, n, R) => Array.from({ length: n }, (_, i) =>
    ({ arm: 'baseline', dir, R, at: now - SPAN_H * 36e5 + i * (SPAN_H * 36e5 / n) }));
  const st = { cipher_shadow: { rank_vs_threshold: { records: [...mk('long', 113, 2.25), ...mk('short', 51, -1)] } } };
  const o = build({ st, at: now });
  ok('it is labelled as placing nothing', /places NOTHING/i.test(o));
  ok('longs and shorts are given separately', /LONGS 113 at 100%, SHORTS 51 at 0%/.test(o), o.match(/LONGS[^.]*/));
  ok('the span is given', /over 35 hours of decisions/.test(o));
  ok('the model is told to ALWAYS quote the split', /ALWAYS quote the direction split, never a single blended win rate/.test(o));
  ok('and the unwound promotion is disclosed', /has been unwound/.test(o));
  ok('with the new bar stated', /10 longs AND 10 shorts spanning a week/.test(o));
}

console.log('\n8. It never throws — a broken feed must not break the chat');
{
  for (const bad of [{ st: null, at: now }, { st: {}, at: now }, { st: { cipher_ledger: 'nonsense' }, at: now },
                     { st: { cipher_open: null, cipher_accum: {} }, at: now },
                     { st: { cipher_shadow: { rank_vs_threshold: { records: [{ R: null }] } } }, at: now }]) {
    let o = null, threw = false;
    try { o = build(bad); } catch (e) { threw = true; }
    ok('survives ' + JSON.stringify(bad.st).slice(0, 40), !threw && typeof o === 'string', threw ? 'THREW' : typeof o);
  }
  ok('and never emits NaN or undefined into the prompt',
     !/NaN|undefined/.test(build({ st: { cipher_accum: { exec: 'dry' } }, at: now })));
}

console.log('\n9. botContext actually calls it');
{
  ok('serverBotContext is wired into the prompt', /out \+= serverBotContext\(\);/.test(src));
  ok('the state cache is refreshed on a timer', /setInterval\(refreshServerState, 300000\)/.test(src));
  ok('and whenever a panel reads the file', (src.match(/SRV_STATE = st;/g) || []).length >= 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
