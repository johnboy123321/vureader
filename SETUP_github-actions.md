# Cipher Agent on GitHub Actions

Runs the bot every 15 minutes on GitHub's machines. **Your laptop can be off.**
No new accounts — it uses the repo you already have.

Cost: free (public repos get unlimited Actions minutes).

---

## What you upload

Two files into `johnboy123321/vureader`:

| File | Where it goes |
|---|---|
| `cipher-agent-valtown.js` | repo root (same place as `index.html`) |
| `cipher-agent.yml` | `.github/workflows/cipher-agent.yml` |

The folder path for the workflow matters — GitHub only looks in `.github/workflows/`.
When you upload on github.com, type the whole path into the filename box:
`.github/workflows/cipher-agent.yml` and it creates the folders for you.

---

## Two secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → *New repository secret*

| Name | Value |
|---|---|
| `RELAY_URL` | `https://jboy--cc5bad508df411f1b9601607ee4eb77e.web.val.run` |
| `RELAY_TOKEN` | the exec token from the app's Settings |

Secrets are encrypted. Nobody browsing the repo can read them, even though it's public.

---

## First run

Repo → **Actions** tab → **Cipher Agent** → **Run workflow**.

Open the run and read the last line of the "Run the agent" step:

```
cipher-agent: scanned 20, 3 candidates, 1 placed (dry) in 14200ms
```

- `scanned 0` → check the secrets are set.
- Runs longer than a few minutes → lower `BATCH` in the workflow file.
- A second commit appears afterwards ("agent state ...") — that's the bot saving
  its memory. Expected.

It starts in **dry** mode: it does everything except actually place the order.

---

## Going live

Edit `.github/workflows/cipher-agent.yml`, change `MODE: dry` to `MODE: armed`,
commit. Then **turn the app's exec OFF** (the mode button on the exec pill) so
only one of them is trading — they keep separate memories of what they've fired,
so two armed copies can double up on the same signal.

To stop it: set `MODE: off`, or Actions → Cipher Agent → ⋯ → Disable workflow.
The app's KILL button still works — it talks to the relay, which holds the positions.

---

## Things worth knowing

**Scheduling is best-effort.** GitHub sometimes runs a scheduled job late when
it's busy — occasionally by 10+ minutes. Irrelevant for 4H/Daily setups.

**It's public.** The repo is public (that's what makes Pages and unlimited
Actions free), so the decision log in `agent-state.json` and the run logs are
visible to anyone who looks. No keys are exposed — but your trade decisions are.
If that bothers you, say so and we'll move the state somewhere private.

**The server is a cut-down bot.** It has the confluence scoring, trade plans,
guards and T2 exits — but *not* the divergence detector, momentum rollover,
confirmation watcher, discovery-lab patterns or the shadow brain. Those live in
the app. Porting them is the next job.

---

## Verified before shipping

Run against the real script with mocked market data and a mock relay:

- Runs unmodified under Node — same file still works on Val Town (Deno).
- State survives between runs: rotation cursor advanced 6 → 12, fired-set and
  decision log persisted to `agent-state.json`.
- Armed run produces a correct order: limit exactly 1.00% through the market,
  stop attached on the right side, take-profit at 2.25R, position sized to
  exactly £10 risk.
- **Found and fixed a real bug in the process:** order prices were rounded with
  `.toFixed(1)`, which turned a 0.7035 entry into a 0.70 buy limit (below market
  — rests unfilled) and 0.0006307 into 0.0 (rejected). Only coins above ~$10
  worked. This was almost certainly the "Phemex testnet has no liquidity"
  problem. Fixed in both the agent and the app.
