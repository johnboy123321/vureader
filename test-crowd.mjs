// The crowd-positioning experiment must MEASURE and never ACT, must refuse stale or thin data
// rather than guess, and must fall back to OKX when Binance blocks the runner — labelled as such.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'cipher-agent-valtown.js';
const src = fs.readFileSync(SRC, 'utf8');
const BOOT = /\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/;
if (!BOOT.test(src)) throw new Error('could not find the Node bootstrap to strip');
const out = path.join(process.cwd(), '.crowd-under-test.mjs');
fs.writeFileSync(out, src.replace(BOOT, '\n') +
  '\nexport { crowdZ, crowdClean, crowdFeatures, crowdBox, crowdBoxes, crowdVerdict, crowdSeries, walkHalfOff, walkDecision, shadowRecord, CROWD_BOXES, CROWD_MAX_AGE_H, CROWD_Z_BARS };\n');
const M = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' → ' + x : ''))); };
const H = 36e5, NOW = 1794513600000 + 20 * 60e3;
// 740 hourly readings ending at the top of the current hour; `end` sets the last value.
const series = (base, end, wob = 0.05) => Array.from({ length: 740 }, (_, i) => [NOW - 20 * 60e3 - (739 - i) * H, i === 739 ? end : base + wob * Math.sin(i)]);

console.log('\n1. It cannot place, block or resize anything');
{
  const a = src.indexOf('CROWD POSITIONING (measurement only, 2026-11-12)'), b = src.indexOf('const SHADOW_KEY', a);
  const block = src.slice(a, b);
  ok('the crowd slice is sane', a > 0 && block.length > 3000 && block.length < 14000, block.length);
  ok('it calls no order function', !/buildOrder|execOrder|directOrder|phemexCall|relay\(|placeOrder|cancelOrder/.test(block));
  ok('no guard in the scan loop reads the crowd', !/(opposes|held\.has|sameDir|placedToday)[^\n]*(crowd|cw\b)/i.test(src));
  ok('a crowd reading is never consulted before buildOrder', !/crowd[A-Za-z]*\([^\n]*\)[^\n]*\n[^\n]*buildOrder\(/.test(src));
}

console.log('\n2. z-score');
{
  ok('too little history → null, not a guess', M.crowdZ(Array.from({ length: 300 }, (_, i) => 1 + i * 0.001)) === null);
  ok('flat history → null (no spread to measure against)', M.crowdZ(Array(740).fill(2)) === null);
  const z = M.crowdZ(series(2, 3).map(x => x[1]));
  ok('a spike on a quiet series is a large positive z', z > 5, z);
  ok('the last value is not part of its own baseline', Math.abs(M.crowdZ([...Array(739).fill(0).map((_, i) => 2 + 0.05 * Math.sin(i)), 2]) ) < 0.5);
  ok('OKX-length history (720 readings) still scores', M.crowdZ(series(2, 3).slice(20).map(x => x[1])) !== null);
}

console.log('\n3. Features and boxes');
{
  // crowd heavily LONG (accounts ratio spikes); big accounts did not follow → gap falls
  const s = { src: 'binance', all: series(2, 3), top: series(2.2, 2.2, 0.02) };
  const short = M.crowdFeatures(s, 'short', NOW), long = M.crowdFeatures(s, 'long', NOW);
  ok('shorting a long-crowded coin is AGAINST the crowd', short.crowd < -1, short.crowd);
  ok('…and big accounts lean the short\'s way', short.gap > 0, short.gap);
  ok('→ box a', short.box === M.CROWD_BOXES[0], short.box);
  ok('going long the same coin is WITH the crowd, against big money → box d', long.box === M.CROWD_BOXES[3], long.box);
  ok('nothing unusual → box c', M.crowdFeatures({ src: 'binance', all: series(2, 2.01), top: series(2.2, 2.21, 0.02) }, 'long', NOW).box === M.CROWD_BOXES[2]);
  ok('against the crowd but big money not with us → box b', M.crowdBox(-1.5, -0.2) === M.CROWD_BOXES[1]);
  ok('missing either reading → no box', M.crowdBox(null, 1) === null && M.crowdBox(-2, null) === null);
  const old = M.crowdFeatures(s, 'short', NOW + 5 * H);
  ok('a reading older than the freshness limit is NO reading', old.stale === true && old.box === null && old.crowd === null, JSON.stringify(old));
  ok('…the limit is the measured 4 hours', M.CROWD_MAX_AGE_H === 4);
  ok('no series → null', M.crowdFeatures(null, 'long', NOW) === null);
  ok('no top-trader series → no gap, no box', M.crowdFeatures({ src: 'okx', all: series(2, 3), top: [] }, 'short', NOW).box === null);
}

console.log('\n4. The feed: Binance first, OKX when Binance refuses, and it says which');
{
  const real = globalThis.fetch; const calls = [];
  const bin = (s) => s.map(([t, v]) => ({ timestamp: t, longShortRatio: String(v) }));
  const okx = (s) => ({ code: '0', data: [...s].reverse().map(([t, v]) => [String(t), String(v)]) });
  globalThis.fetch = async (u) => { calls.push(u);
    if (u.includes('fapi.binance.com')) { const s = series(2, 3); const page = u.includes('endTime') ? s.slice(0, 240) : s.slice(240); return { ok: true, json: async () => bin(page) }; }
    return { ok: true, json: async () => okx(series(2, 3)) }; };
  const a = await M.crowdSeries('BTCUSDT');
  ok('Binance answers → source is binance', a && a.src === 'binance');
  ok('both pages stitched, ascending, no duplicates', a.all.length === 740 && a.all.every((x, i) => !i || x[0] > a.all[i - 1][0]), a.all.length);
  const n = calls.length; await M.crowdSeries('BTC');
  ok('second ask for the same coin is served from the run cache', calls.length === n);
  globalThis.fetch = async (u) => { calls.push(u); if (u.includes('fapi.binance.com')) return { ok: false, status: 451, json: async () => ({}) }; return { ok: true, json: async () => okx(series(2, 3).slice(20)) }; };
  const b = await M.crowdSeries('ETH');
  ok('Binance 451 → falls back to OKX, labelled okx', b && b.src === 'okx' && b.all.length === 720, b && b.src);
  ok('OKX newest-first rows are put in time order', b.all[0][0] < b.all[719][0]);
  const before = calls.filter(u => u.includes('binance')).length; await M.crowdSeries('SOL');
  ok('after one refusal Binance is not asked again this run', calls.filter(u => u.includes('binance')).length === before);
  globalThis.fetch = async () => { throw new Error('network down'); };
  ok('everything down → null, never a throw', (await M.crowdSeries('ADA')) === null);
  globalThis.fetch = real;
}

console.log('\n5. Half-off exit');
{
  const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
  const rec = { at: 1000, dir: 'long', entry: 100, stop: 98, target: 104.5 };
  ok('straight to the stop → −1R', M.walkHalfOff(rec, [bar(1000, 100, 100.5, 97.9, 98)]) === -1);
  ok('+1R then the target → 0.5 + 0.5×2.25 = 1.625R', Math.abs(M.walkHalfOff(rec, [bar(1000, 100, 102.1, 99.9, 102), bar(2000, 102, 104.6, 101, 104)]) - 1.625) < 1e-9);
  ok('+1R then back to entry → +0.5R, where the live exit would go on to lose', M.walkHalfOff(rec, [bar(1000, 100, 102.1, 100.2, 101), bar(2000, 101, 101.2, 99.9, 100)]) === 0.5);
  ok('…and the live walk on the same bars has not resolved yet', M.walkDecision(rec, [bar(1000, 100, 102.1, 100.2, 101), bar(2000, 101, 101.2, 99.9, 100)]) === null);
  ok('tags +1R and closes back under entry in ONE bar → remainder out flat', M.walkHalfOff(rec, [bar(1000, 100, 102.1, 98.5, 99)]) === 0.5);
  ok('stop and +1R in the same bar → the stop wins (pessimism)', M.walkHalfOff(rec, [bar(1000, 100, 102.1, 97.9, 99)]) === -1);
  const sh = { at: 1000, dir: 'short', entry: 100, stop: 102, target: 95.5 };
  ok('shorts mirror: +1R then target', Math.abs(M.walkHalfOff(sh, [bar(1000, 100, 100.1, 97.9, 98), bar(2000, 98, 99, 95.4, 96)]) - 1.625) < 1e-9);
  ok('window that starts after the decision → null', M.walkHalfOff(rec, [bar(5000, 100, 103, 99, 102)]) === null);
  ok('still open → null', M.walkHalfOff(rec, [bar(1000, 100, 101, 99, 100.5)]) === null);
}

console.log('\n6. Records and the verdict gate');
{
  const shd = {};
  M.shadowRecord(shd, 'rank_vs_threshold', 'baseline', { coin: 'BTC', dir: 'short', entry: 100, sl: 102, tp2: 95.5, planTf: '4H' },
    { quality: 5, crowd: -1.6, gap: 0.8, crowdBox: M.CROWD_BOXES[0], crowdSrc: 'binance' });
  const r = shd.rank_vs_threshold.records[0];
  ok('the record carries the crowd stamp', r.crowd === -1.6 && r.gap === 0.8 && r.crowdBox === M.CROWD_BOXES[0] && r.crowdSrc === 'binance');
  M.shadowRecord(shd, 'rank_vs_threshold', 'baseline', { coin: 'ETH', dir: 'long', entry: 10, sl: 9, tp2: 12.25, planTf: '1H' }, { quality: 5 });
  ok('a decision with no reading records nulls, not zeros', shd.rank_vs_threshold.records[1].crowdBox === null && shd.rank_vs_threshold.records[1].crowd === null);
  const T0 = 1787000000000, DAY = 864e5;
  const mk = (n, f, box = M.CROWD_BOXES[0], feed = 'binance', days = 14) => Array.from({ length: n }, (_, i) => ({ arm: 'baseline', dir: i % 2 ? 'long' : 'short', crowdBox: box, crowdSrc: feed, R: f(i), Rh: f(i) > 0 ? 1.625 : -1, at: T0 + i * (days * DAY / (n - 1)) }));
  const good = mk(60, i => i % 5 < 2 ? 2.25 : -1);
  let v = M.crowdVerdict(good, 'binance');
  ok('60 decisions over a fortnight, both halves positive → trustworthy, "pays"', v.ready && v.trustworthy[0].sign === 'pays', JSON.stringify(v.trustworthy));
  ok('win rate and half-off figures are reported', v.boxes[M.CROWD_BOXES[0]].winPct === 40 && v.boxes[M.CROWD_BOXES[0]].halfOffWinPct === 40);
  ok('the same records under the other feed are not counted', M.crowdVerdict(good, 'okx').boxes[M.CROWD_BOXES[0]].n === 0);
  v = M.crowdVerdict(mk(60, i => i < 30 ? 2.25 : -1), 'binance');
  ok('halves disagree → not believed, however good the average', !v.ready);
  ok('59 decisions → not enough to split', !M.crowdVerdict(mk(59, i => 2.25), 'binance').ready);
  ok('60 decisions in one afternoon → not believed', !M.crowdVerdict(mk(60, i => 2.25, M.CROWD_BOXES[0], 'binance', 0.2), 'binance').ready);
  ok('ungraded and variant-arm records are ignored', M.crowdBoxes([{ arm: 'baseline', crowdBox: M.CROWD_BOXES[0], crowdSrc: 'binance', R: null, at: T0 }, { arm: 'variant', crowdBox: M.CROWD_BOXES[0], crowdSrc: 'binance', R: 2.25, at: T0 }], 'binance')[M.CROWD_BOXES[0]].n === 0);
}

try { fs.unlinkSync(out); } catch { }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
