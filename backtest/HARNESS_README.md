# Cipher full-system backtest harness

Rebuilt 2026-08-17 (the first build lived in a sandbox that was reclaimed — keep this copy).

## Run it

```
cd <this folder>
mkdir -p data
# 25 coins + manifest, produced by the Cipher Backtest Data workflow in johnboy123321/vureader
for c in BTC ETH SOL XRP BNB DOGE ADA LINK AVAX DOT LTC BCH UNI ATOM NEAR APT ARB OP SUI TON TRX POL FIL INJ AAVE; do
  curl -sLo data/$c.json.gz https://raw.githubusercontent.com/johnboy123321/vureader/main/backtest-data/$c.json.gz
done
curl -sLo data/manifest.json https://raw.githubusercontent.com/johnboy123321/vureader/main/backtest-data/manifest.json
cp /path/to/cipher-agent-valtown.js agent.js

node test-engine.mjs     # 36 assertions, ~4 min
node run-backtest.mjs    # ~20 min, writes report.txt / trades.json / stats.json
node slices.mjs          # filter experiments on trades.json
```

`AGENT_FILE` and `DATA_DIR` override the paths.

## The one rule

`lib/rules.mjs` imports the LIVE agent file and exports its functions — it does not reimplement
anything. It strips only the Node bootstrap at the foot of the file (which would otherwise run a
real scan on import) and parses `TF_WEIGHT`, `DET_WEIGHT` and `MIN_QUALITY` out of the source text
because they are declared inside the scan loop. If a rename or an edit breaks the parse it
**throws** rather than falling back to a remembered value.

Re-run it after any change to the agent's maths. The header of every report prints the sha256 of
the agent file it tested.

## What is NOT in here, and why (2026-08-21)

Committed to the repo at `backtest/` so it stops living in a temp folder — it is the only tool
that can answer "is this strategy any good", and until tonight it existed in one sandbox and one
laptop.

Deliberately **not** committed:

- `agent.js` — a copy of the live agent, made by the command above. Committing a copy would
  create exactly the ghost this project has been bitten by twice: a second file that looks
  authoritative, drifts silently, and gets tested instead of the real one. Copy it fresh each run;
  the report prints the sha256 of what it actually tested.
- `data/` — fetched from `backtest-data/` in this same repo. One source, not two.
- `test-audit-fixes.mjs`, `test-fixes.mjs`, `test-hedge-rs.mjs`, `test-regime.mjs` — these live at
  the repo root and are run by `TEST_ALL.sh`. The copies that shipped inside the original zip were
  from 2026-08-18 and are now behind; they are left out rather than committed as a stale second
  set. `test-engine.mjs` IS here, because it tests the harness itself and nothing else does.

Verified against the live agent on 2026-08-21 (post-ledger, post-venue-bench, post-resolution
fix): `node test-engine.mjs` → 36 passed, 0 failed.
