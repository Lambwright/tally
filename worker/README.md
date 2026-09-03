# tally-worker

Multi-line expense-form intake, Claude form + receipt parsing, line↔receipt
matching, deterministic validation, the review-queue API, and the Procore Direct
Cost write. See [`../README.md`](../README.md) for the full architecture.

One `submissions` row per emailed form; many `line_items` (one per expense row);
many `receipts` (one per attachment). Approval posts one Direct Cost header + one
line item per expense row.

## Local dev

```bash
npm install
npm test          # pure-helper unit tests: expense-id parsing, matching, net derivation, flags
npm run dev       # wrangler dev — needs the secrets below and a real DATABASE_URL
```

`npm run dev` talks to real Neon/R2/Procore/Anthropic — no local mock. Point
`DATABASE_URL` at a Neon **branch**, not production, while iterating.

## Smoke test (against a deployed Worker)

```bash
npm run smoke                     # multi-line pipeline + fully-manual build path
npm run smoke -- --probe <pid>    # hunt Procore endpoints (needs EINBAU_TOKEN)
```

`test/.env.smoke` (gitignored):

```
TALLY_WORKER_URL=https://tally-worker.ben-a90.workers.dev
TALLY_SERVICE_KEY=<same value as the Worker secret>
EINBAU_TOKEN=<token from auth-worker /auth/login — unlocks the gated build/match/approve steps>
```

The default run POSTs an intake with receipt images but **no form PDF**, so Claude
yields no lines and the submission lands flagged `form_parse_failed`. It then
builds a line by hand, matches a receipt, adds a flat-claim line, and does
`approve?dryRun=1` — proving Claude contributing nothing doesn't block a form.
Auto-extraction from a real Procore Forms PDF is proven separately by running one
through `/intake`.

## Deploy

1. R2 bucket (not public): `npx wrangler r2 bucket create tally-receipts`
2. Neon project `tally`, apply the schema: `psql "$DATABASE_URL" -f schema.sql`
   — **the schema drops and recreates `submissions` / `line_items` / `receipts`**;
   only run it on a project holding throwaway data.
3. Secrets (`npx wrangler secret put …`): `DATABASE_URL`, `ANTHROPIC_API_KEY`,
   `TALLY_SERVICE_KEY`, `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`
4. `npx wrangler deploy`
5. Prime `projects_cache` (admin Einbau ID token):
   ```bash
   curl.exe -X POST https://tally-worker.ben-a90.workers.dev/admin/refresh-projects -H "Authorization: Bearer <admin token>"
   ```

## Before `/submissions/:id/approve` can post for real

`src/procore-directcost.js` is built from Einbau's working "Payroll Direct Cost
Generator" flow: the endpoint, the `"item"` / `"line_item"` wrappers,
`wbs_code_id`, headers, two-step create, `[EXP:…]`-token dedup. Confirmed with
Ben: `direct_cost_type: "invoice"`, header `invoice_number` = the Expense ID,
tag the employee, per-category default WBS codes (`CATEGORY_TO_WBS_CODE`). Project
WBS codes come from `GET /rest/v1.0/projects/{id}/wbs_codes` (confirmed live).

`DIRECTCOST_VERIFIED = false` until one real write has been smoke-tested against
live Procore (the line-item `uom` still needs a live confirm). Until then
`approve` returns `501`; `approve?dryRun=1` returns the built header + every line
item with its resolved `wbs_code_id`. Once a live write lands and shows in the
NetSuite sync, flip `DIRECTCOST_VERIFIED` to `true`.

## Notes

- `/intake` is the only route Power Automate calls (`X-Tally-Service-Key`). Every
  other route needs a real Einbau ID session verified against `auth-worker`
  through the `AUTH_WORKER` service binding (a plain worker→worker `fetch()` is
  blocked with Cloudflare error 1042).
- No mail-polling cron. PA pushes each email to `/intake`; the only cron refreshes
  `projects_cache` every 6h.
- Attachments (form + receipts) live in a **private** R2 bucket, read back only
  through `GET /submissions/:id/receipt?key=` after checking the key belongs to
  the submission.
- **Subrequest budget**: intake does 1 Anthropic call + N R2 puts + ~3 Neon
  writes. Receipts are capped at 12. If a big multi-receipt form trips this
  account's low subrequest ceiling (watch `wrangler tail`), the fallback is for
  PA to POST the form first and each receipt to a follow-up route.
