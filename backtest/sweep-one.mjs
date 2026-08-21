import fs from 'node:fs';
import { loadCoin, listCoins } from './lib/data.mjs';
import { runBacktest } from './lib/engine.mjs';
const tR = parseFloat(process.argv[2]);
const coins = new Map();
for (const c of listCoins()) coins.set(c, loadCoin(c));
const { trades, stats } = await runBacktest(coins, { targetR: tR });
fs.writeFileSync(`sweep-${tR}.json`, JSON.stringify(trades.map(t => ({
  netR: t.netR, grossR: t.grossR, feeR: t.feeR, fundR: t.fundR, how: t.how,
  stopPct: t.stopPct, barsHeld: t.barsHeld, dir: t.dir, detector: t.detector, exitAt: t.exitAt,
}))));
console.log(`target ${tR}R → ${trades.length} trades`);
