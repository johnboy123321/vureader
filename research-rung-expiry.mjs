// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  DOES AN EXPIRY RULE UNJAM THE ACCUMULATOR?
//
//  Found 2026-08-21: three ladders laid in October 2023 put rungs at $25.7k–26.4k. BTC never went
//  back. They are still resting, and because maxConcurrent counts them, all four ladder slots were
//  occupied by dead ladders from 2024-09-08 onward. The trigger fired 113 more times and was
//  refused every time. The strategy did not lose — it JAMMED.
//
//  This tests rules that let it give up. Nothing here touches the live agent: the expiry is applied
//  to state between calls, so accumStep runs exactly as deployed and the comparison is honest.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const mod = path.join(process.cwd(), '.rung-expiry.mjs');
fs.writeFileSync(mod, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/,'\n') +
  '\nexport { accumStep, accumFillPass, accumLevels };\n');
const M = await import(pathToFileURL(mod).href);

const all = JSON.parse(fs.readFileSync('bt/BTC.json','utf8')).tfs['1D'].map(([t,o,h,l,c,v])=>({t,o,h,l,c,v}));
const D = t => new Date(t).toISOString().slice(0,10);
const DAY = 864e5;
const dayNum = s => Math.round(new Date(s + 'T00:00:00Z').getTime() / DAY);

// ── THE RULES ─────────────────────────────────────────────────────────────────────────────────
// "none"    what is deployed today: a rung waits forever.
// "market"  after ttl days, cancel the rung and buy back at the current price. This BOOKS A LOSS
//           in units — you sold at 26k and are buying at 62k. That is the point: the loss is
//           already real, the rung was just hiding it, and the slot is worth more than the pretence.
// "reladder" after ttl days, cancel and re-lay the rung at a fresh level below the current price.
//           Keeps the cash hunting instead of surrendering it, but can strand again higher up.
function expire(st, bar, rule, ttl, fee, hist) {
  if (rule === 'none' || !st.open.length) return { st, freed: 0, unitsBought: 0, lost: 0 };
  const today = Math.round(bar.t / DAY);
  let freed = 0, unitsBought = 0, lost = 0;
  const relayLevels = rule === 'reladder' ? M.accumLevels(hist, bar.c, 4) : [];
  for (let k = st.open.length - 1; k >= 0; k--) {
    const r = st.open[k];
    if (today - dayNum(r.sinceDay) < ttl) continue;
    if (rule === 'market') {
      const got = (r.usdt / bar.c) * (1 - fee/1e4);
      st.units += got; st.cash -= r.usdt;
      unitsBought += got; lost += (r.soldUnits - got);
      st.open.splice(k, 1); freed++;
    } else {
      const lvl = relayLevels[freed % Math.max(1, relayLevels.length)];
      if (!lvl) continue;
      st.open.splice(k, 1);
      st.open.push({ ...r, px: lvl.px, src: lvl.src, sinceDay: D(bar.t) });
      freed++;
    }
  }
  return { st, freed, unitsBought, lost };
}

function run(rule, ttl, cfg = {}) {
  const c = { trigger:'pump1', mfGate:true, feeBps:10, corePct:0, ...cfg };
  let st = { units:1, cash:0, open:[], sells:0, fills:0, lastDay:null, startedAt:null,
             lastFillT:0, startUnits:1, coreUnits:null, highWater:null };
  let sells=0, fills=0, expired=0, unitsLost=0, lastSell='—';
  for (let i=60;i<all.length;i++) {
    const hist = all.slice(0,i+1);
    const f = M.accumFillPass(st, [all[i]], c); st = f.st; fills += f.events.length;
    const e = expire(st, all[i], rule, ttl, c.feeBps, hist); st = e.st; expired += e.freed; unitsLost += e.lost;
    const r = M.accumStep(st, hist, c); st = r.st;
    const s = r.events.filter(x=>x.kind==='sell').length;
    if (s) { sells += s; lastSell = D(all[i].t); }
  }
  const last = all[all.length-1].c;
  const u = st.units + (st.cash||0)/last;
  return { rule: rule==='none'?'no expiry (DEPLOYED)':`${rule} after ${ttl}d`, u, vs:(u-1)*100,
           sells, fills, expired, resting: st.open.length, cash: st.cash, lastSell };
}

console.log(`\n  BTC daily ${D(all[60].t)} → ${D(all[all.length-1].t)} · start 1.00000000 BTC · pump1 + money-flow gate\n`);
const rows = [ run('none',0), run('market',30), run('market',60), run('market',90), run('market',180),
               run('reladder',30), run('reladder',60), run('reladder',90) ];
console.log('  '+'rule'.padEnd(24)+'end units'.padStart(11)+'vs hold'.padStart(10)+'sells'.padStart(7)
          +'fills'.padStart(7)+'expired'.padStart(9)+'resting'.padStart(9)+'  last sell');
console.log('  '+'─'.repeat(92));
for (const r of rows)
  console.log('  '+r.rule.padEnd(24)+r.u.toFixed(6).padStart(11)+(r.vs.toFixed(2)+'%').padStart(10)
    +String(r.sells).padStart(7)+String(r.fills).padStart(7)+String(r.expired).padStart(9)
    +String(r.resting).padStart(9)+'  '+r.lastSell);

const best = rows.slice(1).reduce((a,b)=>b.u>a.u?b:a);
console.log(`\n  best rule: ${best.rule} → ${best.u.toFixed(6)} units (${best.vs>=0?'+':''}${best.vs.toFixed(2)}% vs holding)`);
console.log(`  deployed : ${rows[0].u.toFixed(6)} units (${rows[0].vs.toFixed(2)}% vs holding), frozen since ${rows[0].lastSell}`);
console.log(`  the fix is worth ${((best.u/rows[0].u - 1)*100).toFixed(1)}% more BTC than what is running now.\n`);
fs.unlinkSync(mod);
