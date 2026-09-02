// Smoke test for a DEPLOYED tally-worker. Uses Node's fetch — no shell quoting.
//
//   node test/smoke.mjs                 # per-diem intake (DB only — no R2/Claude)
//   node test/smoke.mjs --receipt       # also fire the receipt path (R2 + Claude)
//
// Reads config from env or a local test/.env.smoke file (gitignored):
//   TALLY_WORKER_URL=https://tally-worker.ben-a90.workers.dev
//   TALLY_SERVICE_KEY=<the same value set as the Worker secret>
//   EINBAU_TOKEN=<optional: a token from auth-worker /auth/login, to hit the gated routes>

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// tiny .env loader (KEY=VALUE lines)
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

const withReceipt = process.argv.includes("--receipt");

async function show(label, res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  console.log(`\n${label} -> ${res.status}`);
  console.dir(body, { depth: 6 });
  return { status: res.status, body };
}

async function main() {
  // 1. liveness — gated route with no token should 401
  await show("GET /submissions (no auth)", await fetch(`${URL}/submissions`));

  // 2. intake — per diem (writes a row; no R2/Claude)
  const perdiem = JSON.parse(readFileSync(join(here, "fixtures/sample-intake-perdiem.json"), "utf8"));
  perdiem.subject = `Expense EXP-${Date.now()}`; // fresh invoice number each run
  await show(
    "POST /intake (per diem)",
    await fetch(`${URL}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tally-Service-Key": KEY },
      body: JSON.stringify(perdiem),
    })
  );

  // 3. intake — receipt path (R2 put + Claude vision). Opt-in.
  if (withReceipt) {
    const receipt = JSON.parse(readFileSync(join(here, "fixtures/sample-intake-receipt.json"), "utf8"));
    receipt.subject = `Expense EXP-${Date.now()}R`;
    await show(
      "POST /intake (receipt)",
      await fetch(`${URL}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tally-Service-Key": KEY },
        body: JSON.stringify(receipt),
      })
    );
  }

  // 4. if a token was supplied, exercise the gated side
  if (TOKEN) {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    await show("GET /submissions (auth)", await fetch(`${URL}/submissions`, { headers: auth }));
    await show(
      "POST /admin/refresh-projects",
      await fetch(`${URL}/admin/refresh-projects`, { method: "POST", headers: auth })
    );
  } else {
    console.log("\n(no EINBAU_TOKEN set — skipped the gated routes and projects_cache refresh)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
