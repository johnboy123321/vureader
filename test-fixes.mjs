// The two fixes, checked against the real functions rather than against my description of them.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const out = path.join(process.cwd(), '.fixes-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { buildOrder, buildTradePlan, planValid, staleIds, CFG, roundPx };\nexport function __setRelayCap(v){ RELAY_CAP = v; }\n');
const M = await import(pathToFileURL(out).href);

let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};

console.log('\n1. Sizing — the bot must risk what it says it risks');
{
  const risk = M.CFG.risk();
  for (const [name, t] of Object.entries({
    'long, 4% stop':   { coin:'SOL', dir:'long',  entry:200,  sl:192,   tp1:208,   tp2:218 },
    'long, 1% stop':   { coin:'BTC', dir:'long',  entry:60000,sl:59400, tp1:60600, tp2:61350 },
    'short, 5% stop':  { coin:'ETH', dir:'short', entry:3000, sl:3150,  tp1:2850,  tp2:2662 },
    'sub-$1 coin':     { coin:'FIL', dir:'long',  entry:0.7035, sl:0.6754, tp1:0.7316, tp2:0.7667 },
  })) {
    const b = M.buildOrder(t);
    ok(name + ': order builds', !b.err, b.err);
    if (b.err) continue;
    const isLong = t.dir === 'long';
    // what it will ACTUALLY risk: filled at about the entry price, stopped at sl
    const realRisk = Math.abs(t.entry - t.sl) * b.meta.qty;
    ok(name + ': real risk is the intended £' + risk, Math.abs(realRisk - risk) / risk < 0.02,
       '£' + realRisk.toFixed(2));
    ok(name + ': riskActual matches what it will really lose', Math.abs(b.meta.riskActual - realRisk) / risk < 0.02,
       b.meta.riskActual + ' vs ' + realRisk.toFixed(2));
    ok(name + ': it still crosses through to guarantee a fill',
       isLong ? b.order.priceRp > t.entry : b.order.priceRp < t.entry);
    ok(name + ': and records the price it sized off', b.meta.sizedOff === t.entry, b.meta.sizedOff);
  }
}

console.log('\n2. Structure mode still sizes off the resting price');
{
  process.env.ENTRY_MODE = 'structure';
  const t = { coin:'SOL', dir:'long', entry:200, sl:190, tp1:210, tp2:222.5,
              zone:{ src:'OB', top:196, bottom:193, awayPct:2 } };
  const b = M.buildOrder(t);
  ok('it rests at the zone, not through the market', b.order.priceRp === 196, b.order.priceRp);
  ok('and sizes off that resting price', b.meta.sizedOff === 196, b.meta.sizedOff);
  const realRisk = Math.abs(196 - 190) * b.meta.qty;
  ok('so the real risk is still £' + M.CFG.risk(), Math.abs(realRisk - M.CFG.risk())/M.CFG.risk() < 0.02, '£'+realRisk.toFixed(2));
  ok('the better entry buys a bigger position', b.meta.qty > 10/ Math.abs(200-190), b.meta.qty);
  delete process.env.ENTRY_MODE;
}

console.log('\n3. Nothing else about the order changed');
{
  const t = { coin:'SOL', dir:'long', entry:200, sl:192, tp1:208, tp2:218 };
  const b = M.buildOrder(t);
  ok('stop still goes to the exchange', b.order.stopLossRp === 192);
  ok('target is still T2', b.order.takeProfitRp === 218);
  ok('still a GoodTillCancel limit', b.order.ordType === 'Limit' && b.order.timeInForce === 'GoodTillCancel');
  ok('sub-$1 prices still round properly', M.roundPx(0.7035) === 0.7035 && M.roundPx(0.00063) > 0);
}

console.log('\n4. The notional cap still bites when it should');
{
  M.__setRelayCap(50);
  const b = M.buildOrder({ coin:'SOL', dir:'long', entry:200, sl:192, tp1:208, tp2:218 });
  ok('clamped', b.meta.clamped === true);
  ok('and it says it risked less than intended', b.meta.riskActual < M.CFG.risk(), b.meta.riskActual);
  M.__setRelayCap(null);
}

console.log('\n5. Entry expiry — ENTRY_EXPIRY_H is finally read');
{
  ok('CFG.entryExpiryH has a sane default', M.CFG.entryExpiryH() === 8, M.CFG.entryExpiryH());
  ok('the agent now reads it', /CFG\.entryExpiryH\(\)/.test(src) && /expireStaleOrders/.test(src));
  const now = 1_000_000_000_000;
  const book = {
    fresh:  { at: now - 1 * 3600e3, symbol:'SOLUSDT' },
    ripe:   { at: now - 8 * 3600e3, symbol:'SOLUSDT' },
    ancient:{ at: now - 90 * 3600e3, symbol:'BTCUSDT' },
  };
  const stale = M.staleIds(book, now, 8);
  ok('a one-hour-old order is left alone', !stale.includes('fresh'));
  ok('one exactly at the expiry is caught', stale.includes('ripe'));
  ok('an old one is caught', stale.includes('ancient'));
  ok('nothing else is', stale.length === 2, stale.join(','));
  ok('an empty book is handled', M.staleIds({}, now, 8).length === 0 && M.staleIds(null, now, 8).length === 0);
  ok('expiry of 0 disables the whole pass', /if \(!\(hours > 0\)\) return out;/.test(src));
}

console.log('\n6. The expiry pass can only ever cancel');
{
  const block = src.slice(src.indexOf('UNFILLED ORDERS MUST NOT LIVE FOREVER'), src.indexOf('MARKET REGIME (measurement only)'));
  ok('it never places an order', !/buildOrder|POST[^\n]*orders|directOrder\(/.test(block));
  ok('the only venue write is a cancel', (block.match(/phemexCall\(/g)||[]).length === 1 && /phemexCall\("DELETE", "\/g-orders\/cancel"/.test(block));
  ok('it refuses to act when it cannot read the book', /if \(!Array\.isArray\(live\)\) \{ out\.blind/.test(block));
  ok('and it only runs when armed', /if \(mode === "armed"\) \{[\s\S]{0,200}expireStaleOrders\(\)/.test(src));
}

fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
