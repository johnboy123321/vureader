// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE LAB — score setups against three years of candles
//
//    node setup-lab/run.mjs                     score the stored library
//    node setup-lab/run.mjs my-idea.json        score one proposal (or a file of several)
//    node setup-lab/run.mjs --vocab             print the vocabulary for the brain's prompt
//
//  Whatever the brain proposes lands here as JSON and gets the same treatment as everything else:
//  discovered on six coins, validated on six it has never been scored on, and required to hold in
//  both halves of the history. No exceptions for a good story.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { scoreSetup, report } from './score.mjs';
import { vocabularyForPrompt } from './schema.mjs';

const arg = process.argv[2];
if (arg === '--vocab') { console.log(vocabularyForPrompt()); process.exit(0); }

const file = arg || 'setup-lab/library.json';
let proposals;
try { proposals = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`could not read ${file}: ${e.message}`); process.exit(1); }
if (!Array.isArray(proposals)) proposals = [proposals];

const started = Date.now();
console.log('═'.repeat(92));
console.log(`SETUP LAB — ${proposals.length} proposal${proposals.length===1?'':'s'} against 12 coins, 3 years`);
console.log('every figure is after costs (0.22% round trip, charged in R against the actual stop width)');
console.log('═'.repeat(92));

const out = [];
const survivors = [];
for (const p of proposals) {
  const res = scoreSetup(p);
  const card = report(res);
  console.log(card); console.log('');
  out.push(card);
  if (res.ok && res.survives) survivors.push(res.rule.name);
}

console.log('═'.repeat(92));
console.log(survivors.length
  ? `SURVIVED: ${survivors.join(' · ')}`
  : 'Nothing survived. That is the normal outcome and it is the filter working, not a failure.');
console.log(`scored in ${((Date.now()-started)/1000).toFixed(1)}s`);

fs.writeFileSync('SETUP_LAB.txt', out.join('\n\n') + '\n\n' +
  (survivors.length ? `SURVIVED: ${survivors.join(' · ')}\n` : 'Nothing survived.\n'));
console.log('written → SETUP_LAB.txt');
