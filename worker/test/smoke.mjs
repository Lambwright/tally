// Smoke test for a DEPLOYED tally-worker. Node's fetch — no shell quoting.
//
//   node test/smoke.mjs                     # multi-line pipeline + manual-build path
//   node test/smoke.mjs --probe <projectId> # hunt Procore endpoints (needs EINBAU_TOKEN)
//
// Config from env or test/.env.smoke (gitignored):
//   TALLY_WORKER_URL=https://tally-worker.ben-a90.workers.dev
//   TALLY_SERVICE_KEY=<same value as the Worker secret>
//   EINBAU_TOKEN=<token from auth-worker /auth/login — unlocks the gated routes>

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const envFile = join(here, ".env.smoke");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const URL = process.env.TALLY_WORKER_URL;
const KEY = process.env.TALLY_SERVICE_KEY;
const TOKEN = process.env.EINBAU_TOKEN || "";
if (!URL || !KEY) {
  console.error("Set TALLY_WORKER_URL and TALLY_SERVICE_KEY (env or test/.env.smoke).");
  process.exit(1);
}
const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : null;

async function show(label, res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  console.log(`\n${label} -> ${res.status}`);
  console.dir(body, { depth: 6 });
  return { status: res.status, body };
}

async function probe(pid) {
  if (!auth) { console.error("--probe needs EINBAU_TOKEN"); process.exit(1); }
  const candidates = [
    `/rest/v1.0/projects/${pid}/wbs_codes`,
    `/rest/v1.0/projects/${pid}/budget_line_items`,
    `/rest/v1.0/budget_line_items?project_id=${pid}`,
    `/rest/v1.0/projects/${pid}/direct_costs/line_items`,
  ];
  for (const path of candidates) {
    await show(`probe ${path}`, await fetch(`${URL}/admin/procore-probe?path=${encodeURIComponent(path)}`, { headers: auth }));
  }
}

async function main() {
  if (process.argv.includes("--probe")) {
    return probe(process.argv[process.argv.indexOf("--probe") + 1]);
  }

  await show("GET /submissions (no auth)", await fetch(`${URL}/submissions`));

  // Intake with receipt images but NO form PDF -> Claude yields no lines ->
  // submission still lands, flagged for a manual build.
  const receipt = JSON.parse(readFileSync(join(here, "fixtures/sample-intake-receipt.json"), "utf8"));
  const expenseId = `020926-SMK${Date.now().toString().slice(-5)}-0001`;
  const payload = {
    subject: `Expense Report ${expenseId}`,
    from: "test.employee@einbau.ca",
    employee_name: "Test Employee",
    province: "ON",
    project_number: "000_000_1",
    body: "Smoke test — no form attached.",
    attachments: receipt.attachments, // reuse the 1x1 jpeg fixture(s)
  };
  const intake = await show(
    "POST /intake (receipts only, no form)",
    await fetch(`${URL}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tally-Service-Key": KEY },
      body: JSON.stringify(payload),
    })
  );
  const subId = intake.body?.submission?.id;
  if (!subId) { console.error("no submission id back — stopping"); return; }

  if (!auth) {
    console.log("\n(no EINBAU_TOKEN — skipped the gated build/match/approve steps)");
    return;
  }

  const detail = await show("GET /submissions/:id", await fetch(`${URL}/submissions/${subId}`, { headers: auth }));
  const receiptId = detail.body?.receipts?.find((r) => r.kind === "receipt")?.id;

  // Build a line by hand, then match it to a receipt.
  const added = await show(
    "POST /submissions/:id/lines (manual materials line)",
    await fetch(`${URL}/submissions/${subId}/lines`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ category: "materials", description: "Home Depot", gross_amount: "113.00", line_date: "2026-09-01" }),
    })
  );
  const lineId = added.body?.line?.id;

  if (lineId && receiptId) {
    await show(
      "POST /submissions/:id/lines/:lineId/match",
      await fetch(`${URL}/submissions/${subId}/lines/${lineId}/match`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ receipt_id: receiptId }),
      })
    );
  }

  // A flat-claim line needs no receipt.
  await show(
    "POST /submissions/:id/lines (per diem)",
    await fetch(`${URL}/submissions/${subId}/lines`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ category: "per_diem", description: "Per diem", gross_amount: "75.00", line_date: "2026-09-01" }),
    })
  );

  await show(
    "POST /submissions/:id/approve?dryRun=1",
    await fetch(`${URL}/submissions/${subId}/approve?dryRun=1`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" })
  );

  await show("POST /admin/refresh-projects", await fetch(`${URL}/admin/refresh-projects`, { method: "POST", headers: auth }));
}

main().catch((e) => { console.error(e); process.exit(1); });
