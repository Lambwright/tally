# tally-worker

Expense-receipt intake, Claude vision extraction, deterministic validation, the
review-queue API, and the Procore Direct Cost write. See the top-level
[`../README.md`](../README.md) for the full architecture and infra checklist.

## Local dev

```bash
npm install
npm test         # pure-helper unit tests (invoice parsing, salvage, flags, tax math)
npm run dev      # wrangler dev — needs the secrets below and a real DATABASE_URL
```

`npm run dev` talks to real Neon/R2/Procore/Anthropic — there's no local mock for
those. Point `DATABASE_URL` at a Neon **branch**, not production, while iterating.

## Smoke test (against a deployed Worker)

```bash
npm run smoke              # per-diem intake — exercises Neon only
npm run smoke -- --receipt  # also the receipt path (R2 put + Claude vision)
```

Create `test/.env.smoke` (gitignored) first:

```
TALLY_WORKER_URL=https://tally-worker.ben-a90.workers.dev
TALLY_SERVICE_KEY=<same value as the Worker secret>
EINBAU_TOKEN=<optional: a token from auth-worker /auth/login — unlocks the gated
             routes and POST /admin/refresh-projects>
```

Uses Node's `fetch`, so no PowerShell quoting to fight. Each run uses a fresh
invoice number. A successful per-diem run returns `{ created: true, submission: … }`
— that means routing, the service key, and the Neon connection are all good.

## Deploy

1. Create the R2 bucket (not public):
   ```bash
   npx wrangler r2 bucket create tally-receipts
   ```
2. Create the Neon project `tally`, then apply the schema:
   ```bash
   psql "$DATABASE_URL" -f schema.sql
   ```
3. Set secrets:
   ```bash
   npx wrangler secret put DATABASE_URL
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put TALLY_SERVICE_KEY      # openssl rand -hex 24 — Power Automate sends this as X-Tally-Service-Key
   npx wrangler secret put PROCORE_CLIENT_ID
   npx wrangler secret put PROCORE_CLIENT_SECRET
   ```
4. Deploy:
   ```bash
   npx wrangler deploy
   ```
5. Prime `projects_cache` instead of waiting up to 6h for the first cron tick —
   with an admin Einbau ID token:
   ```bash
   curl.exe -X POST https://tally-worker.ben-a90.workers.dev/admin/refresh-projects \
     -H "Authorization: Bearer <admin token>"
   ```

## Before `/submissions/:id/approve` can post for real

`src/procore-directcost.js` is built from Einbau's working "Payroll Direct Cost
Generator" flow: the endpoint, the `"item"` / `"line_item"` body wrappers,
`wbs_code_id`, the headers, the two-step create, and the `[INV:…]`-token dedup.
`direct_cost_type: "invoice"`, the header `invoice_number`, tagging the employee,
and the per-category cost-code defaults are all confirmed with Ben. The reviewer
picks the cost code per submission in the app (`GET /submissions/:id/cost-codes`
feeds the dropdown; the choice rides on the approve call as `cost_code`).

`DIRECTCOST_VERIFIED = false` until a real write has been smoke-tested once
against live Procore — the WBS/budget-code endpoint (`listProjectWbsCodes`) and
the line-item `uom` still need a live confirm. Until then:

- `POST /submissions/:id/approve` returns `501` and does not call Procore.
- `POST /submissions/:id/approve?dryRun=1` returns the built header + line item
  (with the resolved `wbsCodeId` and `employeeId`) without sending anything.

Once a live write succeeds and shows up in the NetSuite sync, flip
`DIRECTCOST_VERIFIED` to `true`.

## Notes

- `/intake` is the only route Power Automate calls, authenticated with the
  `X-Tally-Service-Key` shared secret (no interactive login available to a flow).
  Every other route requires a real Einbau ID session, verified against
  `auth-worker` through the `AUTH_WORKER` service binding — a plain `fetch()` to
  another Worker's `*.workers.dev` URL from inside a Worker is blocked with
  Cloudflare error 1042, so the binding is required, not optional.
- There is deliberately no mail-polling cron. PA pushes each email to `/intake`
  as it arrives, so every invocation does one email's worth of work. The only
  cron here refreshes `projects_cache` from Procore every 6h.
- Receipt images live in a **private** R2 bucket. The frontend only ever reads
  them back through `GET /submissions/:id/receipt?key=`, which checks the
  submission's own `receipt_keys` before streaming anything.
