// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE GENERATOR — the brain proposing setups, and the filter answering
//
//  This is the half that was missing. The lab could score a setup; nothing was writing them. So
//  here the brain is handed the vocabulary, told what has already been tried and what happened to
//  it, and asked for new ideas — which are then validated, scored on three years of candles, and
//  either stored or thrown away with a reason.
//
//  Runs on a schedule, separately from the trading agent, because it has nothing to do with
//  trading: it is a research loop. Its only output is a file of setups that survived.
//
//  ── WHY THE FEEDBACK MATTERS MORE THAN THE MODEL ──────────────────────────────────────────────
//  Last night's brute-force search generated 2,955 setups and its survivors were indistinguishable
//  from random noise — 26.4% survival against a 25.3% control. Random combination does not work.
//  The bet here is that a model reasoning about WHY something might work does better than a dice
//  roll, and the way to find out is to feed it what failed and see whether round two beats round
//  one. So every rejection is written back into the next prompt in full.
//
//  If, after a few rounds, the brain's survival rate is no better than the control, that is the
//  answer and it gets reported as the answer. The point of a filter is that it is allowed to say
//  no to everybody, including the expensive idea.
//
//  ── COST ──────────────────────────────────────────────────────────────────────────────────────
//  One call per run, ten proposals per call. On a cheap provider that is fractions of a penny a
//  day. The expensive part of strategy research is not the thinking, it is the testing — and the
//  testing is local and free.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { scoreSetup, report, BASELINE_R } from './score.mjs';
import { validateSetup, vocabularyForPrompt } from './schema.mjs';

// Written next to THIS file, whichever layout it ended up in — a folder, or loose in the repo
// root. Deriving the path from import.meta.url rather than the working directory means the store
// cannot end up somewhere the reader is not looking, which is the failure that leaves a working
// generator and a permanently empty arm.
const HERE = new URL('.', import.meta.url).pathname;
const STORE = HERE + 'survivors.json';
const JOURNAL = HERE + 'journal.json';          // everything tried, and why it failed
const N_PER_RUN = Number(process.env.SETUPS_PER_RUN || 10);

const env = (k, d = '') => (process.env[k] ?? d);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ── The provider, mirroring the agent's so there is one way to configure a brain ──────────────
function provider() {
  const base = String(env('BRAIN_BASE_URL')).replace(/\/+$/, '');
  const key = env('BRAIN_API_KEY') || env('ANTHROPIC_API_KEY');
  if (!key) return null;
  if (!base) return { kind: 'anthropic', url: 'https://api.anthropic.com/v1/messages', key,
                      model: env('BRAIN_MODEL', 'claude-haiku-4-5') };
  return { kind: 'openai', url: base + '/chat/completions', key, model: env('BRAIN_MODEL', 'deepseek-chat') };
}

async function ask(prompt) {
  const p = provider();
  if (!p) return null;
  const anth = p.kind === 'anthropic';
  const r = await fetch(p.url, {
    method: 'POST',
    headers: anth ? { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
                  : { authorization: 'Bearer ' + p.key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: p.model, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('brain refused:', (j && j.error && (j.error.message || j.error)) || r.status); return null; }
  return anth ? (j.content?.[0]?.text || '') : (j.choices?.[0]?.message?.content || '');
}

// ── THE PROMPT ────────────────────────────────────────────────────────────────────────────────
// Three things it must contain, and the third is the one people leave out: what has already been
// tried. Without it the model proposes the same handful of obvious combinations every single run
// and the loop stops being a search.
function buildPrompt(journal, survivors) {
  const recent = journal.slice(-40);
  const failed = recent.filter(j => !j.survived).slice(-25);
  const L = [];
  L.push(`You are proposing candidate TRADING SETUPS for crypto (4H and 1D charts) that will be immediately backtested over 12 coins and 3 years of candles. Propose ${N_PER_RUN}.`);
  L.push('');
  L.push('Answer with a JSON array ONLY. No prose, no markdown fence. Each element:');
  L.push('{"name":"...","dir":"long|short","timeframe":"4H|1D","when":[...],"stop":{...},"target":{"kind":"rMultiple","value":2},"maxBars":60,"falsifier":"..."}');
  L.push('');
  L.push(vocabularyForPrompt());
  L.push('');
  L.push('HOW YOU ARE JUDGED — all of these, or it is discarded:');
  L.push(`  · at least 40 trades on the discovery coins AND 40 on six held-out coins you are not shown`);
  L.push(`  · expectancy above +${BASELINE_R}R on BOTH sets (this is the bot's own current record, not zero)`);
  L.push('  · positive in BOTH halves of the three years');
  L.push('  · positive on at least half the individual coins');
  L.push('  · costs of 0.22% per round trip are charged against your stop width, so tight stops are punished hard');
  L.push('  · any stop narrower than 2.2% of price is refused outright');
  L.push('');
  L.push('WHAT IS ALREADY KNOWN, so you do not repeat it:');
  L.push('  · a plain WaveTrend cross, on any timeframe, loses after costs');
  L.push('  · the money-flow band tested alone has no predictive power (1.02x base rate, 0.7% recall)');
  L.push('  · 2,955 randomly-combined setups produced survivors indistinguishable from noise');
  L.push('  · so combining conditions at random will not work; propose things for a REASON and say the reason in the falsifier');
  if (survivors.length) {
    L.push('');
    L.push('SETUPS THAT HAVE ALREADY SURVIVED (do not re-propose these; try to beat or extend them):');
    for (const s of survivors.slice(-10)) L.push('  · ' + JSON.stringify({ dir: s.dir, timeframe: s.timeframe, when: s.when, stop: s.stop }));
  }
  if (failed.length) {
    L.push('');
    L.push('RECENTLY TRIED AND FAILED — the reason is given, use it:');
    for (const f of failed) L.push(`  · ${f.name} → ${(f.reasons || ['invalid'])[0]}`);
  }
  return L.join('\n');
}

// A model asked for JSON will sometimes wrap it in a fence or add a sentence. Extract rather than
// demand — but never REPAIR the objects themselves; a proposal that is not valid gets rejected on
// its merits, not quietly rewritten into something that passes.
function extractArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('['), end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try { const v = JSON.parse(body.slice(start, end + 1)); return Array.isArray(v) ? v : null; } catch { return null; }
}

// ── RUN ───────────────────────────────────────────────────────────────────────────────────────
const survivors = readJson(STORE, []);
const journal = readJson(JOURNAL, []);

if (!provider()) {
  console.log('No brain configured — set ANTHROPIC_API_KEY, or BRAIN_BASE_URL + BRAIN_API_KEY.');
  console.log('Nothing was proposed. This is a config gap, not a failure.');
  process.exit(0);
}

const text = await ask(buildPrompt(journal, survivors));
const proposals = extractArray(text);
if (!proposals) { console.error('The brain did not return a JSON array. Nothing stored.'); process.exit(1); }
console.log(`${proposals.length} proposals came back.\n`);

let added = 0;
for (const p of proposals) {
  const v = validateSetup(p);
  if (!v.ok) {
    console.log(`✗ ${p && p.name || '(unnamed)'} — rejected: ${v.errors[0]}`);
    journal.push({ at: new Date().toISOString(), name: p && p.name || '(unnamed)', survived: false, reasons: v.errors });
    continue;
  }
  const res = scoreSetup(v.rule);
  console.log(report(res));
  console.log('');
  journal.push({ at: new Date().toISOString(), name: v.rule.name, survived: res.survives,
                 reasons: res.reasons, proposal: v.rule,
                 disc: +res.discovery.exp.toFixed(3), val: +res.validation.exp.toFixed(3),
                 n: res.discovery.n + res.validation.n });
  if (res.survives) {
    // Deduplicate on the RULE, not the name — the same setup with a different label is the same
    // setup, and a store full of near-identical entries would flatter the next round's prompt.
    const sig = JSON.stringify([v.rule.dir, v.rule.timeframe, v.rule.when, v.rule.stop, v.rule.target]);
    if (!survivors.some(s => JSON.stringify([s.dir, s.timeframe, s.when, s.stop, s.target]) === sig)) {
      survivors.push({ ...v.rule, foundAt: new Date().toISOString(),
                       discoveryR: +res.discovery.exp.toFixed(3), validationR: +res.validation.exp.toFixed(3),
                       trades: res.discovery.n + res.validation.n });
      added++;
    }
  }
}

fs.writeFileSync(STORE, JSON.stringify(survivors, null, 2));
fs.writeFileSync(JOURNAL, JSON.stringify(journal.slice(-400), null, 2));

const tried = journal.length, won = journal.filter(j => j.survived).length;
console.log('═'.repeat(80));
console.log(`this run: ${added} new survivor${added === 1 ? '' : 's'} · store now holds ${survivors.length}`);
console.log(`all time: ${won} of ${tried} proposals survived (${(won / Math.max(1, tried) * 100).toFixed(1)}%)`);
// The number that decides whether any of this is worth doing. The brute-force control survived at
// 25.3%; if the brain cannot beat that, it is an expensive dice roll and should be said so.
console.log(`the bar: random combination survived at 25.3%. Beating that is what "the brain helps" would mean.`);
