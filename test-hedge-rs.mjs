// Two safety fixes and one new measurement, checked against the real functions.
//   1. an existing hedge must be resolved by REDUCING, never by opening anything
//   2. relative strength must measure and never act
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = fs.readFileSync('cipher-agent-valtown.js', 'utf8');
const out = path.join(process.cwd(), '.hedge-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { hedgeCloseOrder, closeOrderFor, rsBand, rsBoxes, rsVerdict, RS_BANDS, RS_LOOKBACK_D, RS_MIN_FIELD, REGIME_MIN_PER_BOX, shadowRecord };\n');
const M = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + x : ''))); };

console.log('\n1. Closing a hedge leg can only ever REDUCE');
{
  const o = M.hedgeCloseOrder({ symbol: 'BTCUSDT', posSide: 'Long', size: 0.004, markPriceRp: 64000 });
  ok('it is reduce-only', o.reduceOnly === true);
  ok('and close-on-trigger', o.closeOnTrigger === true);
  ok('the side is the CLOSING side of a long', o.side === 'Sell');
  ok('size matches the position exactly', String(o.orderQtyRq) === '0.004');
  ok('it is labelled so it can be found in the log later', o.text === 'cipher-dehedge' && /^dehedge/.test(o.clOrdID));
  const sh = M.hedgeCloseOrder({ symbol: 'BTCUSDT', posSide: 'Short', size: 0.01, markPriceRp: 64000 });
  ok('closing a short buys', sh.side === 'Buy');
  ok('a zero-size position produces no order at all', M.hedgeCloseOrder({ symbol: 'X', posSide: 'Long', size: 0 }) === null);
}

console.log('\n2. It picks the SMALLER leg, so net exposure is unchanged');
{
  const block = src.slice(src.indexOf('AN EXISTING HEDGE IS A STANDING COST'), src.indexOf('RELATIVE STRENGTH (measurement only)'));
  ok('the smaller leg is chosen by notional, not by size', /notional\(biggestLong\) <= notional\(biggestShort\)/.test(block));
  ok('a coin with only one side is skipped', /if \(!longs\.length \|\| !shorts\.length\) continue;/.test(block));
  ok('nothing in the pass can build a new entry order', !/buildOrder|buildTradePlan/.test(block));
  ok('the only order it can make is the reduce-only closer', (block.match(/execOrder\(/g) || []).length === 1 && /hedgeCloseOrder\(smaller\)/.test(block));
  ok('it can be turned off', /env\("HEDGE_FIX", "1"\)/.test(block));
  ok('it only runs armed, and only when the book was readable', /if \(mode === "armed" && canSeeBook\)[\s\S]{0,120}resolveHedges/.test(src));
}

console.log('\n3. Relative strength measures and does not act');
{
  const block = src.slice(src.indexOf('RELATIVE STRENGTH (measurement only)'), src.indexOf('MARKET REGIME (measurement only)'));
  ok('no order function is reachable from it', !/buildOrder|execOrder|directOrder|phemexCall/.test(block));
  const guards = src.slice(src.indexOf('const key = `${coin}|${sig.bias}|${day}`'), src.indexOf('const built = buildOrder(t)'));
  ok('no rank term sits between the signal and the order', !/\bRS\b|relativeStrength|rsBand/.test(guards));
  ok('the whole field is ranked once per run, not per coin', (src.match(/await relativeStrength\(/g) || []).length === 1);
}

console.log('\n4. The rank itself');
{
  ok('a week is the horizon the ladder was found on', M.RS_LOOKBACK_D === 7);
  ok('a thin field is refused rather than guessed', M.RS_MIN_FIELD >= 12);
  ok('bands cover the whole 0-1 range', M.rsBand(0) && M.rsBand(0.5) && M.rsBand(1));
  ok('0.9 is "with the leader"', /with the leader/.test(M.rsBand(0.9)));
  ok('0.1 is "fighting the field"', /fighting the field/.test(M.rsBand(0.1)));
  ok('a missing rank produces no band, not a default one', M.rsBand(null) === null);
}

console.log('\n5. The same both-halves gate as the regime experiment');
{
  const mk = (rs, R, at) => ({ arm: 'baseline', rs, R, at });
  // a box that pays handsomely then gives it back must not be believed
  const flip = []; for (let i = 0; i < 60; i++) flip.push(mk(0.9, i < 30 ? 3 : -1, 1000 + i));
  ok('a box that flips is not believed', M.rsVerdict(flip).trustworthy.length === 0);
  const steady = []; for (let i = 0; i < 60; i++) steady.push(mk(0.9, i % 3 === 0 ? 2.25 : -0.4, 1000 + i));
  ok('a box that holds in both halves is', M.rsVerdict(steady).trustworthy.length === 1);
  const thin = []; for (let i = 0; i < 40; i++) thin.push(mk(0.9, 2, 1000 + i));
  ok('too small a sample is not believed however good', M.rsVerdict(thin).trustworthy.length === 0);
  const mixed = [...steady, ...Array.from({ length: 60 }, (_, i) => ({ ...mk(0.9, 5, i), arm: 'variant' }))];
  ok('variant-arm records are excluded', M.rsVerdict(mixed).boxes['d. with the leader'].n === 60);
  ok('ungraded records are excluded', M.rsVerdict([...steady, mk(0.9, null, 1)]).boxes['d. with the leader'].n === 60);
}

console.log('\n6. Records carry the rank');
{
  const sh = {};
  M.shadowRecord(sh, 'rank_vs_threshold', 'baseline',
    { coin: 'SOL', dir: 'long', entry: 100, sl: 95, tp2: 111, planTf: '4H' },
    { quality: 5.5, reg: 'bull', rs: 0.83 });
  const r = sh['rank_vs_threshold'].records[0];
  ok('rank is stamped on the decision', r.rs === 0.83);
  ok('a null rank stays null rather than becoming 0', (() => {
    const s2 = {}; M.shadowRecord(s2, 'x', 'baseline', { coin: 'A', dir: 'long', entry: 1, sl: 0.9, tp2: 1.2 }, { rs: null });
    return s2.x.records[0].rs === null;
  })());
}

fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
