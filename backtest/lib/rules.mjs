// Load the LIVE rules out of cipher-agent-valtown.js — do not reimplement them.
//
// The whole point of this harness is to answer "does the thing that is actually running make
// money". A second copy of the maths would answer "does my copy of it make money", which is a
// different and useless question. So: read the shipped agent, append an export list, import it.
// Every function under test below is the live body, byte for byte.
//
// The two weight tables and MIN_QUALITY are declared INSIDE the scan loop and cannot be
// imported. They are parsed out of the source text instead — and if a rename or an edit makes
// the parse fail, this module THROWS rather than falling back to a remembered value. A silently
// stale weight table would make every number in the report a lie.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT = process.env.AGENT_FILE || path.join(process.cwd(), 'agent.js');

const EXPORTS = [
  'emaArr', 'smaArr', 'waveTrend', 'vmcMoneyFlow', 'rsiArr', 'atrArr',
  'ema200At', 'volRatio', 'wtPivots', 'pricePivots', 'marketStructure',
  'findFVGs', 'findOrderBlocks', 'nearestZone', 'vmcVwapWave',
  'detectWTDivergence', 'detectMomentumRollover', 'detectGreenDotMFReversal',
  'analyzeTF', 'scoreCoin', 'buildTradePlan', 'planValid', 'buildOrder',
  'roundQty', 'roundPx', 'NOT_CRYPTO', 'CFG', 'VMC', 'TF_MS',
];

function loadSource() {
  if (!fs.existsSync(AGENT)) throw new Error(`agent file not found: ${AGENT}`);
  return fs.readFileSync(AGENT, 'utf8');
}

// ── the constants that live inside the loop ───────────────────────────────────────────────────
// Parsed, never remembered. A changed weight must change the backtest.
function parseInnerConstants(src) {
  const grab = (name) => {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\{[^}]*\\})`));
    if (!m) throw new Error(
      `rules.mjs could not find ${name} in the agent source. It was renamed, moved or reshaped — ` +
      `fix this loader rather than letting the backtest run on a remembered table.`);
    // eslint-disable-next-line no-new-func
    const obj = Function(`"use strict"; return (${m[1]});`)();
    if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) throw new Error(`${name} parsed empty`);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name}.${k} is not a finite number`);
    }
    return obj;
  };
  const TF_WEIGHT = grab('TF_WEIGHT');
  const DET_WEIGHT = grab('DET_WEIGHT');

  const mq = src.match(/const\s+MIN_QUALITY\s*=\s*num\(\s*"MIN_QUALITY"\s*,\s*([\d.]+)\s*\)/);
  if (!mq) throw new Error('rules.mjs could not find MIN_QUALITY in the agent source.');
  const MIN_QUALITY = parseFloat(mq[1]);

  // The stage bonus is a rule, not a number — assert its shape is still what we model.
  if (!/const\s+bonus\s*=\s*\(r\.stage\s*===\s*"extreme"\s*\|\|\s*r\.stage\s*===\s*"fresh"\)\s*\?\s*1\s*:\s*0/.test(src)) {
    throw new Error('the stage-bonus rule in the agent no longer matches what the harness models.');
  }
  // The detector list and its order.
  const dm = src.match(/\[\s*\["divergence",\s*detectWTDivergence\],\s*\["rollover",\s*detectMomentumRollover\],\s*\["greendot",\s*detectGreenDotMFReversal\]\s*\]/);
  if (!dm) throw new Error('the detector list in the agent no longer matches what the harness models.');
  // The timeframe sweep order.
  const tfm = src.match(/for\s*\(const tf of \["1D",\s*"4H",\s*"1H",\s*"30m",\s*"15m"\]\)/);
  if (!tfm) throw new Error('the detector timeframe list in the agent changed.');

  return { TF_WEIGHT, DET_WEIGHT, MIN_QUALITY };
}

let _mod = null, _consts = null, _hash = null;

export async function loadRules() {
  if (_mod) return { M: _mod, ..._consts, sourceHash: _hash };
  const src = loadSource();
  _consts = parseInnerConstants(src);
  _hash = (await import('node:crypto')).createHash('sha256').update(src).digest('hex').slice(0, 16);

  // Strip the Node/GitHub-Actions bootstrap at the foot of the file. It calls cipherAgent() and
  // then process.exit() — importing the module for its maths would otherwise run a live scan and
  // kill the harness. Nothing above it is touched.
  const BOOT = /\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/;
  if (!BOOT.test(src)) throw new Error(
    'rules.mjs could not find the agent\'s Node bootstrap to strip. Importing the file unmodified ' +
    'would run a live scan — refusing rather than guessing where it now ends.');
  const body = src.replace(BOOT, '\n');
  if (/cipherAgent\(\)\s*\n?\s*\.then/.test(body)) throw new Error('bootstrap strip left a self-invocation behind.');

  // Append the export list plus a test-only hook for the venue cap (RELAY_CAP is module-private
  // and is normally learned from the relay's /status; the backtest has to be able to drive it).
  const shim = `\nexport { ${EXPORTS.join(', ')} };\n` +
               `export function __setRelayCap(v) { RELAY_CAP = v; }\n` +
               `export function __getRelayCap() { return RELAY_CAP; }\n`;
  const out = path.join(path.dirname(AGENT), '.rules-under-test.mjs');
  fs.writeFileSync(out, body + shim);
  _mod = await import(pathToFileURL(out).href + '?v=' + _hash);

  for (const n of EXPORTS) {
    if (_mod[n] === undefined) throw new Error(`agent no longer exposes ${n} — the harness is testing something else.`);
  }
  return { M: _mod, ..._consts, sourceHash: _hash };
}
