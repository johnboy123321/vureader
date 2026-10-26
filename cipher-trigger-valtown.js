// ═══════════ CIPHER TRIGGER — make the bot actually run every 15 minutes (2026-10-26) ═══════════
// GitHub's own schedule ("*/15 * * * *") is best-effort and in practice fires every 2–6 HOURS.
// For 15m/1H/4H setups that means most signals are hours old before the bot looks, and stops and
// targets go unchecked for just as long. This val is a dependable clock: Val Town runs it every 15
// minutes, and it asks GitHub to start the Cipher Agent workflow ("Run workflow", by API).
//
// NO OVERLAP — two layers, because overlapping runs could place duplicate orders:
//   1. this val first asks GitHub whether a Cipher Agent run is already in progress or queued,
//      and if so does nothing this time;
//   2. the workflow itself has `concurrency: group: cipher-agent`, so even if two starts raced,
//      GitHub would run them one after the other, never together.
//
// SETUP (Val Town):
//   • New val → type "Cron" → paste this file → schedule: every 15 minutes  (*/15 * * * *)
//   • Environment variable GH_DISPATCH_TOKEN = a GitHub fine-grained token with access to ONLY
//     johnboy123321/vureader and ONLY the permission "Actions: Read and write". It can start and
//     read workflow runs; it cannot read or change the code.
// The GitHub schedule in the workflow stays as a backup clock.

const REPO = "johnboy123321/vureader";
const WORKFLOW = "cipher-agent.yml";

export default async function cipherTrigger() {
  const token = Deno.env.get("GH_DISPATCH_TOKEN");
  if (!token) { console.error("GH_DISPATCH_TOKEN is not set — nothing triggered"); return; }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cipher-trigger",
  };
  const base = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}`;

  // 1. Never stack runs. If GitHub cannot be asked, do not guess — skip this slot.
  for (const status of ["in_progress", "queued"]) {
    const r = await fetch(`${base}/runs?status=${status}&per_page=1`, { headers });
    if (!r.ok) { console.error(`could not check for a ${status} run (HTTP ${r.status}) — skipping this slot`); return; }
    const j = await r.json();
    if ((j.total_count || 0) > 0) { console.log(`a run is already ${status} — not starting another`); return; }
  }

  // 2. Start one.
  const r = await fetch(`${base}/dispatches`, { method: "POST", headers, body: JSON.stringify({ ref: "main" }) });
  if (r.status === 204) console.log("Cipher Agent run started");
  else console.error(`start failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
