# What is actually live — 2026-08-20

Written after Codex's control-plane review. His point stood: with several overlapping
execution surfaces it was not possible to prove what runs and what happens when a
setting says armed. This file is the answer, and `test-preflight-safety.mjs` enforces it.

## PRODUCTION — these run

| file | where it runs | what arms it |
|---|---|---|
| `cipher-agent-valtown.js` | GitHub Actions, every 15–40 min | `MODE` (futures) and `ACCUM_EXEC` (spot), both from the workflow; the relay's live config overrides `MODE` when reachable |
| `.github/workflows/cipher-agent.yml` | GitHub Actions | the only place `ACCUM_EXEC: "armed"` is stated |
| `phemex-relay-valtown.js` | Val Town, imported by `jboy/cipher` as `?v=10` | serves the app; also the live-config store for `MODE`, caps and the accumulator timeframe |
| `index.html` | GitHub Pages | the app. Its exec path is for manual trades only; the server agent is what trades |

## DEAD — present in the working folder, in no deployment path

Confirmed 404 in the repo, so nothing can fetch them:

- `phemex-relay-worker.js` — the old Cloudflare worker. Still carries the
  `res.json()`-then-`res.text()` pattern that produced the bare 502s, and none of the
  stop-side validation the Val Town relay has. **Do not deploy.**
- `cipher_exec.js` — a standalone exec that builds market orders, uses `tp1`, and marks a
  trade fired before the call returns. Superseded by the agent's direct path.
- `agent-new.js` — **deleted 2026-08-20.** It was a stale copy of the agent, 1,073 lines
  behind, and four test suites were reading it instead of the live file. They passed, which
  is worse than failing: 120 safety assertions were green against code that had not been
  live for two days. Repointed and re-run — all still pass against the real agent, so
  nothing had regressed. But the safety net had been unplugged without anyone noticing.

## The one command

    ./TEST_ALL.sh

The preflight runs first and hard-stops the rest if it fails, because a control-plane fault
makes every strategy number below it meaningless.

## What the preflight proves

1. Default mode cannot place real orders — `MODE` defaults `dry`, `ACCUM_EXEC` defaults `dry`
2. KILL blocks every order path, and is checked before the armed test
3. No stop means no order — refused at plan level and again at order level
4. A wrong-side stop means no order — both layers, longs and shorts
5. Direct and relay caps agree, and the cap is re-enforced in direct mode
6. The spot accumulator cannot arm accidentally — arming stated exactly once
7. Phemex is testnet in the agent, the relay and the workflow preflight
8. No test reads a missing or stale source file

## Still ambiguous, deliberately

`MODE` has two sources: the workflow (`off`) and the relay live config (`armed`). That is by
design — the app panel is the control, the workflow is the fallback when the relay cannot be
read, and `off` is the safe direction to fail in. It is stated in the workflow comments now
rather than being folklore. It did cost an afternoon on 2026-08-20 when a relay timeout
silently idled the bot, which is why the accumulator no longer sits behind that return.
