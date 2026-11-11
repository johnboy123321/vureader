// Robustness of the one positive finding in oi-test.mjs: trading AGAINST the crowded side
// (all-accounts long/short ratio more than 1 sd from its 30-day mean, on the other side from the
// trade). Run AFTER the pre-registered test. Everything here is a CHECK on that result — a way to
// break it — not a new search. Nothing here may be used to pick a better threshold.
import fs from 'node:fs';
import { ci95, mean } from './lib/report.mjs';
const T = JSON.parse(fs.readFileSync('trades-oi.json', 'utf8')).filter(t => t.oif && t.oif.crowdZ != null);
const out = []; const P = s => { console.log(s); out.push(s); };
const sum = a => a.reduce((x, y) => x + y, 0);
const isLong = t => /long|buy|bull/i.test(String(t.dir));
const A = T.filter(t => t.oif.crowdZ < -1), REST = T.filter(t => !(t.oif.crowdZ < -1));
const line = (lab, q) => { if (q.length < 20) return P(`  ${lab.padEnd(30)} n=${q.length} too few`);
  const c = ci95(q.map(t => t.netGbp)); const w = q.filter(t => t.netGbp > 0).length / q.length * 100;
  P(`  ${lab.padEnd(30)} n=${String(q.length).padStart(5)}  £${c.m.toFixed(2).padStart(6)}/trade  [${c.lo.toFixed(2).padStart(6)}, ${c.hi.toFixed(2).padStart(6)}]  win ${w.toFixed(0)}%  total £${sum(q.map(t => t.netGbp)).toFixed(0)}`); };
P('ROBUSTNESS — "trading AGAINST the crowd" (' + A.length + ' trades) vs everything else (' + REST.length + ')\n');
P('1. Is it just one direction?');
line('against crowd · longs', A.filter(isLong)); line('against crowd · shorts', A.filter(t => !isLong(t)));
line('everything else · longs', REST.filter(isLong)); line('everything else · shorts', REST.filter(t => !isLong(t)));
P('\n2. Year by year (by exit)');
for (const y of [...new Set(T.map(t => t.year))].sort()) { line(`against crowd · ${y}`, A.filter(t => t.year === y)); line(`everything else · ${y}`, REST.filter(t => t.year === y)); }
P('\n3. By timeframe and detector');
for (const k of [...new Set(A.map(t => t.tf))]) line(`against crowd · ${k}`, A.filter(t => t.tf === k));
for (const k of [...new Set(A.map(t => t.detector))]) line(`against crowd · ${k}`, A.filter(t => t.detector === k));
P('\n4. Is it a few coins?');
{ const by = {}; for (const t of A) (by[t.coin] ||= []).push(t.netGbp);
  const rows = Object.entries(by).map(([c, a]) => [c, a.length, mean(a), sum(a)]).sort((x, y) => y[3] - x[3]);
  const pos = rows.filter(r => r[2] > 0).length;
  P(`  ${pos} of ${rows.length} coins positive · top 3 by total: ${rows.slice(0, 3).map(r => `${r[0]} £${r[3].toFixed(0)} (n=${r[1]})`).join(', ')} · bottom 3: ${rows.slice(-3).map(r => `${r[0]} £${r[3].toFixed(0)} (n=${r[1]})`).join(', ')}`);
  const top3 = new Set(rows.slice(0, 3).map(r => r[0])); line('without its 3 best coins', A.filter(t => !top3.has(t.coin))); }
P('\n5. Is it a few big winners?');
{ const s = [...A].sort((a, b) => b.netGbp - a.netGbp); line('without its 10 best trades', s.slice(10)); line('without its best 5%', s.slice(Math.ceil(s.length * 0.05))); }
P('\n6. Dose-response — does a more crowded side pay more? (read-only: NOT for picking a threshold)');
for (const [lab, f] of [['z < -2', z => z < -2], ['-2 .. -1.5', z => z >= -2 && z < -1.5], ['-1.5 .. -1', z => z >= -1.5 && z < -1], ['-1 .. -0.5', z => z >= -1 && z < -0.5], ['-0.5 .. 0', z => z >= -0.5 && z < 0], ['0 .. 0.5', z => z >= 0 && z < 0.5], ['0.5 .. 1', z => z >= 0.5 && z < 1], ['1 .. 1.5', z => z >= 1 && z < 1.5], ['z > 1.5', z => z >= 1.5]]) line('crowd z ' + lab, T.filter(t => f(t.oif.crowdZ)));
P('\n7. Trades cluster in time, so the interval above is too narrow. Weekly totals instead:');
{ const wk = t => Math.floor(t.placedAt / (7 * 864e5)); const by = new Map(); for (const t of A) by.set(wk(t), (by.get(wk(t)) || 0) + t.netGbp);
  const w = [...by.values()], c = ci95(w); const posW = w.filter(x => x > 0).length;
  P(`  ${w.length} weeks with a trade · mean £${c.m.toFixed(2)}/week  [${c.lo.toFixed(2)}, ${c.hi.toFixed(2)}]  t=${(c.m / c.se).toFixed(2)} · ${posW} weeks up, ${w.length - posW} down`);
  // block bootstrap by week on the per-trade mean
  const weeks = [...new Set(A.map(wk))], g = new Map(); for (const t of A) { const k = wk(t); if (!g.has(k)) g.set(k, []); g.get(k).push(t.netGbp); }
  let above = 0; const N = 20000; const ms = [];
  for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let j = 0; j < weeks.length; j++) { const a = g.get(weeks[(Math.random() * weeks.length) | 0]); for (const x of a) { s += x; n++; } } const m = s / n; ms.push(m); if (m > 0) above++; }
  ms.sort((a, b) => a - b);
  P(`  week-block bootstrap of £/trade: 95% [${ms[Math.floor(N * 0.025)].toFixed(2)}, ${ms[Math.floor(N * 0.975)].toFixed(2)}] · P(edge > 0) ${(above / N * 100).toFixed(1)}%`); }
P('\n8. The other ratio in the file (top traders by account count) — an independent second look');
P('   (not available in trades-oi.json; see oi-test.mjs F3 for the all-accounts ratio)');
P('\n9. How often would it trade?');
{ const yrs = (Math.max(...T.map(t => t.exitAt)) - Math.min(...T.map(t => t.placedAt))) / (365.25 * 864e5);
  P(`  ${A.length} trades in ${yrs.toFixed(1)} years = ${(A.length / yrs).toFixed(0)} a year, about ${(A.length / yrs / 52).toFixed(1)} a week, at £10 risk = £${(sum(A.map(t => t.netGbp)) / yrs).toFixed(0)} a year`); }
fs.writeFileSync('OI_ROBUSTNESS.txt', out.join('\n') + '\n');
