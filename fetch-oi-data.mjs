// One-off job: download Binance USD-M open-interest + long/short "metrics" (free public archive,
// data.binance.vision) for the 25 backtest coins and save one hourly file per coin:
//   backtest-data/oi/<COIN>.json.gz  =  { coin, cols:[...], rows:[[t_ms, ...values]], missingDays:n }
// It also saves buy/sell volume per hour (taker-buy volume from the futures candle files):
//   backtest-data/flow/<COIN>.json.gz  =  { coin, cols:["volume","taker_buy_volume","trades"], rows:[[t_ms, ...]] }
// Runs on GitHub's servers (they can reach Binance). READ-ONLY against Binance, no keys, no orders.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

const COINS = "BTC ETH SOL XRP BNB DOGE ADA LINK AVAX DOT LTC BCH UNI ATOM NEAR APT ARB OP SUI TON TRX POL FIL INJ AAVE".split(" ");
const START = Date.UTC(2023, 7, 1), END = Date.UTC(2026, 6, 31);   // Aug 2023 .. Jul 2026, same as the price files
const BASE = "https://data.binance.vision/data/futures/um/daily/metrics";
const OUT = "backtest-data/oi", OUT_FLOW = "backtest-data/flow";
const KBASE = "https://data.binance.vision/data/futures/um/monthly/klines";
const CONC = 12;

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",").map(s => s.trim());
  const col = n => head.indexOf(n);
  const iT = col("create_time");
  if (iT < 0) throw new Error("no create_time column: " + head.join("|"));
  const want = ["sum_open_interest", "sum_open_interest_value", "count_toptrader_long_short_ratio",
    "sum_toptrader_long_short_ratio", "count_long_short_ratio", "sum_taker_long_short_vol_ratio"];
  const idx = want.map(col);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    const t = /^\d+$/.test(f[iT]) ? Number(f[iT]) : Date.parse(f[iT].replace(" ", "T") + "Z");
    if (!Number.isFinite(t) || new Date(t).getUTCMinutes() !== 0) continue;   // keep the on-the-hour row only
    rows.push([t, ...idx.map(k => { const v = k < 0 ? NaN : parseFloat(f[k]); return Number.isFinite(v) ? v : null; })]);
  }
  return { want, rows };
}

async function getDay(sym, day) {
  const url = `${BASE}/${sym}/${sym}-metrics-${day}.zip`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url);
      if (r.status === 404 || r.status === 403) return null;             // not listed that day
      if (!r.ok) throw new Error("http " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const tmp = `${tmpdir()}/oi-${process.pid}-${Math.random().toString(36).slice(2)}.zip`;
      writeFileSync(tmp, buf);
      const u = spawnSync("unzip", ["-p", tmp], { maxBuffer: 64 * 1024 * 1024 });
      try { unlinkSync(tmp); } catch {}
      if (u.status !== 0) throw new Error("unzip failed");
      return parseCsv(u.stdout.toString("utf8"));
    } catch (e) { if (a === 3) return { err: String(e.message || e) }; await new Promise(r => setTimeout(r, 800 * (a + 1))); }
  }
}

async function doCoin(coin) {
  const sym = coin + "USDT", days = [];
  for (let t = START; t <= END; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  const res = new Array(days.length); let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < days.length) { const i = next++; res[i] = await getDay(sym, days[i]); }
  }));
  let missing = 0, errs = 0, cols = null; const rows = [];
  for (const r of res) {
    if (!r) { missing++; continue; }
    if (r.err) { errs++; continue; }
    cols = r.want; rows.push(...r.rows);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const dedup = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
  writeFileSync(`${OUT}/${coin}.json.gz`, gzipSync(JSON.stringify({ coin, sym, cols, rows: dedup, missingDays: missing, errorDays: errs })));
  console.log(`${coin}: ${dedup.length} hourly rows, ${missing} days not in archive, ${errs} download errors, first ${dedup[0] ? new Date(dedup[0][0]).toISOString().slice(0, 10) : "-"}`);
}

// ---- buy/sell volume: monthly 1h futures candle files carry the taker-buy volume ----
export function parseKlines(text) {
  const rows = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const f = line.split(",");
    if (!/^\d+$/.test(f[0])) continue;                               // header row
    let t = Number(f[0]); if (t > 1e14) t = Math.floor(t / 1000);     // microseconds -> ms if ever needed
    const n = k => { const v = parseFloat(f[k]); return Number.isFinite(v) ? v : null; };
    rows.push([t, n(5), n(9), n(8)]);                                 // volume, taker_buy_volume, trade count
  }
  return rows;
}

async function getMonth(sym, ym) {
  const url = `${KBASE}/${sym}/1h/${sym}-1h-${ym}.zip`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url);
      if (r.status === 404 || r.status === 403) return null;
      if (!r.ok) throw new Error("http " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const tmp = `${tmpdir()}/kl-${process.pid}-${Math.random().toString(36).slice(2)}.zip`;
      writeFileSync(tmp, buf);
      const u = spawnSync("unzip", ["-p", tmp], { maxBuffer: 64 * 1024 * 1024 });
      try { unlinkSync(tmp); } catch {}
      if (u.status !== 0) throw new Error("unzip failed");
      return { rows: parseKlines(u.stdout.toString("utf8")) };
    } catch (e) { if (a === 3) return { err: String(e.message || e) }; await new Promise(r => setTimeout(r, 800 * (a + 1))); }
  }
}

async function doFlow(coin) {
  const sym = coin + "USDT", months = [];
  for (let y = 2023, m = 8; y < 2026 || (y === 2026 && m <= 7); m++) { if (m > 12) { m = 1; y++; } if (y === 2026 && m > 7) break; months.push(`${y}-${String(m).padStart(2, "0")}`); }
  const res = await Promise.all(months.map(ym => getMonth(sym, ym)));
  let missing = 0, errs = 0; const rows = [];
  for (const r of res) { if (!r) { missing++; continue; } if (r.err) { errs++; continue; } rows.push(...r.rows); }
  rows.sort((a, b) => a[0] - b[0]);
  const dedup = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
  writeFileSync(`${OUT_FLOW}/${coin}.json.gz`, gzipSync(JSON.stringify({ coin, sym, cols: ["volume", "taker_buy_volume", "trades"], rows: dedup, missingMonths: missing, errorMonths: errs })));
  console.log(`${coin} flow: ${dedup.length} hourly rows, ${missing} months not in archive, ${errs} download errors`);
}

if (process.argv[1] && process.argv[1].endsWith("fetch-oi-data.mjs")) {
  mkdirSync(OUT, { recursive: true }); mkdirSync(OUT_FLOW, { recursive: true });
  for (const c of COINS) { await doCoin(c); await doFlow(c); }
}
