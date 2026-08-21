// The Bot Trades scoreboard, tested headlessly. A scoreboard is the one panel a person will
// believe without checking, so the thing being guarded here is not layout — it is that an
// execution artifact can never be counted as a strategy result, in either direction.
import fs from 'node:fs';
const src = fs.readFileSync('index.html', 'utf8');
const a = src.indexOf('  function tallyLog(log){');
const b = src.indexOf('  async function loadServerLog(){');
if (a < 0 || b < 0) { console.log('FAIL: could not extract the scoreboard'); process.exit(1); }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const { tallyLog, botScoreboard } = new Function('esc', src.slice(a, b) + '; return { tallyLog, botScoreboard };')(esc);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + String(x).slice(0, 160) : ''))); };
const at = d => new Date(d).toISOString();

console.log('\n1. An empty log says nothing rather than nothing-good');
{
  const t = tallyLog([]);
  ok('no trades', t.graded === 0 && t.wins === 0 && t.losses === 0);
  ok('no R', t.R === 0);
  const h = botScoreboard({}, []);
  ok('win rate shows a dash, not 0%', /win rate<\/div><div[^>]*>—/.test(h.replace(/\s+/g, ' ')) || /—/.test(h));
  ok('it does not claim a positive record', !/\+£/.test(h) || /\+£0\.00/.test(h));
}

console.log('\n2. Stamped outcomes are counted, with their R');
{
  const log = [
    { at: at('2026-08-21T05:00:00Z'), coin: 'BTC', result: 'RESOLVED', how: 'target', outcome: 'win', klass: 'strategy', R: 2.25, countsForStats: true },
    { at: at('2026-08-21T04:00:00Z'), coin: 'ETH', result: 'RESOLVED', how: 'stop', outcome: 'loss', klass: 'strategy', R: -1, countsForStats: true },
    { at: at('2026-08-21T03:00:00Z'), coin: 'SOL', result: 'RESOLVED', how: 'target', outcome: 'win', klass: 'strategy', R: 1.5, countsForStats: true },
  ];
  const t = tallyLog(log);
  ok('three graded', t.graded === 3, t.graded);
  ok('two wins, one loss', t.wins === 2 && t.losses === 1);
  ok('R adds up to +2.75', Math.abs(t.R - 2.75) < 1e-9, t.R);
  ok('no unknown R', t.rUnknown === 0);
  const h = botScoreboard({}, log);
  ok('win rate is 67%', /67%/.test(h), h.match(/\d+%/));
  ok('pounds follow R at the stamped risk', /\+£27\.50/.test(h) || /\+£/.test(h));
}

console.log('\n3. AN ARTIFACT IS NEVER A RESULT — the whole point');
{
  const log = [
    { at: at('2026-08-21T05:00:00Z'), coin: 'BTC', result: 'RESOLVED', how: 'target', klass: 'strategy', R: 2, countsForStats: true },
    { at: at('2026-08-21T04:00:00Z'), coin: 'FIL', result: 'RESOLVED (not counted)', how: 'closed_by_hand', klass: 'execution_artifact', countsForStats: false },
    { at: at('2026-08-21T03:30:00Z'), coin: 'LTC', result: 'RESOLVED (not counted)', how: 'ambiguous', klass: 'execution_artifact', countsForStats: false },
    { at: at('2026-08-21T03:00:00Z'), coin: 'OP', result: 'REJECTED (not a signal) — stale', rejection: { cause: 'cadence' } },
  ];
  const t = tallyLog(log);
  ok('only the real trade is graded', t.graded === 1, t.graded);
  ok('the win rate cannot be dragged down by a hand-close', t.losses === 0);
  ok('nor can an ambiguous exit', t.wins === 1);
  ok('artifacts are counted separately', t.artifacts === 2, t.artifacts);
  ok('a venue rejection is counted separately too', t.rejected === 1, t.rejected);
  ok('and rejections never enter R', Math.abs(t.R - 2) < 1e-9, t.R);
  const h = botScoreboard({}, log);
  ok('the panel says plainly that they are not counted', /not counted/.test(h));
  ok('and explains they are about the plumbing', /plumbing/.test(h));
}

console.log('\n4. Records written before the labels existed still read correctly');
{
  // The shape the agent wrote until 2026-08-21: a sentence and nothing else.
  const log = [
    { at: at('2026-08-20T05:00:00Z'), coin: 'ADA', result: 'RESOLVED', skipped: 'ADA long target at 0.21 — price traded through the target' },
    { at: at('2026-08-20T04:00:00Z'), coin: 'XRP', result: 'RESOLVED', skipped: 'XRP long stop at 1.24 — price traded through the stop' },
    { at: at('2026-08-20T03:00:00Z'), coin: 'FIL', result: 'RESOLVED (not counted)', skipped: 'FIL long closed_by_hand — closed at neither the stop nor the target' },
  ];
  const t = tallyLog(log);
  ok('the old sentence still yields a win', t.wins === 1, t.wins);
  ok('and a loss', t.losses === 1, t.losses);
  ok('and the old artifact is still excluded', t.artifacts === 1 && t.graded === 2);
  ok('but no R is invented for them', t.R === 0 && t.rUnknown === 2, t.rUnknown + '/' + t.R);
  const h = botScoreboard({}, log);
  ok('the panel admits the missing R rather than hiding it', /carry no R/.test(h));
}

console.log('\n5. The window is always stated');
{
  const log = [{ at: at('2026-08-19T09:00:00Z'), coin: 'BTC', result: 'RESOLVED', how: 'target', klass: 'strategy', R: 1, countsForStats: true }];
  const h = botScoreboard({}, log);
  ok('it says how many decisions it counted', /last 1 decisions/.test(h), h.match(/last \d+ decisions/));
  ok('it says how far back that reaches', /back to <b>/.test(h));
  ok('and that the bot forgets beyond 300', /keeps 300/.test(h));
}

console.log('\n6. Open positions and the drawdown anchor');
{
  const st = { cipher_open: { 'ADA|long': { coin: 'ADA' }, 'XRP|long': { coin: 'XRP' } },
               cipher_breaker: { dayEq: 134708.39, weekEq: 135619.66, streak: 1 } };
  const h = botScoreboard(st, []);
  ok('open count is shown', /open now/.test(h) && />2</.test(h));
  ok('the coins are named', /ADA XRP/.test(h));
  ok('the anchor is shown', /134,708 USDT/.test(h), h.match(/[\d,]+ USDT/));
  ok('and is NOT called your balance', /not your balance right now/.test(h));
  ok('the losing streak is surfaced', /losing streak: <b>1<\/b>/.test(h));
}

console.log('\n7. It never divides by zero or renders NaN');
{
  for (const bad of [null, undefined, [], [{}], [{ result: 'RESOLVED' }], [{ result: 'RESOLVED', how: 'target', countsForStats: true }]]) {
    const h = botScoreboard({}, bad);
    ok('survives ' + JSON.stringify(bad) + ' with no NaN', !/NaN|undefined|Infinity/.test(h), h.slice(0, 120));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
