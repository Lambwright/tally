# TALLY

Automates the middle of Einbau's expense-reimbursement pipeline: an employee's
receipt email in → Claude reads the receipt → deterministic checks flag anything
off → a human approves in a review queue → a correct **net-of-tax** Direct Cost
lands in Procore, tagged with the form's invoice number. Everything before
("employee emails a form") and after ("Procore→NetSuite sync, payroll
reimbursement") already exists and stays exactly as-is.

Full design context lives in the kickoff prompt this was built from (v4) and the
approved build plan; the load-bearing constraints, repeated here because they
shape every file in this repo:

- **Zero Azure / Entra / Graph, anywhere.** Login is the existing Einbau ID
  system. Receipt images live in Cloudflare R2. Mail detection is Power
  Automate's native folder trigger — no app registration involved.
- **Power Automate does intake only.** It watches a folder and POSTs each new
  email + attachment to `tally-worker`. Every other piece of logic — parsing,
  validation, storage, the Procore write — lives in the Worker.
- **No tax-law engine.** Claude reads the gross and tax printed on the receipt.
  A province rate table is a fallback for receipts that don't itemize tax, and
  anything derived from it is flagged `tax_estimated` — never trusted equally.
- **Procore gets the net (pre-tax) amount only.** Tax is applied downstream in
  NetSuite by an existing, unrelated sync.
- **MVP only.** The company-wide expenditure dashboard is deferred, but the
  schema (see `worker/schema.sql`) is already shaped for it.

## Layout

```
worker/   tally-worker — Cloudflare Worker: intake, Claude extraction,
          validation, Neon + R2, the review-queue API, the Procore write.
web/      React + Vite review-queue frontend (Einbau ID gated).
.github/  GitHub Pages deploy workflow for web/.
```

See [`worker/README.md`](worker/README.md) for the Worker's own deploy steps.

## Architecture at a glance

```
 employee fills the (stripped) Employee Expense Form, emails it to expenses@einbau.ca
        │
        ▼
 Ben's inbox ── Outlook rule ──▶ dedicated folder
        │
        ▼
 Power Automate "new email in folder" trigger
   (its own connector auth — no Azure app registration)
        │  POST { subject, from, body, attachments[], province, employee_name,
        │         project_number, category, claimed_amount? }
        │  category ∈ parking | materials | fuel | mileage | per_diem | other
        ▼
 tally-worker  POST /intake
   ├─ per_diem / mileage?  → flat claimed amount, no receipt, no Claude call
   └─ else                 → store image(s) in R2 → Claude vision extraction
                             → read tax, or fall back to a province rate table (flagged)
   → deterministic validation (active project, geo sanity, amount checks)
   → insert into Neon `submissions`, status = needs_review
        │
        ▼
 review queue (web/, Einbau ID login)
   reviewer approves / requests revision / rejects
        │  approve
        ▼
 tally-worker  POST /submissions/:id/approve
   → resolve the project's wbs_code_id live (never hardcode a per-project id)
   → POST an invoice-type Direct Cost header + line item to Procore at the NET amount
        │
        ▼
 existing Procore → NetSuite sync (untouched, out of scope)
```

## Deploy order

1. **Neon** — create a dedicated `tally` project, apply `worker/schema.sql`.
2. **Cloudflare R2** — create the `tally-receipts` bucket. Leave it **private**;
   the Worker is the only thing that ever reads or writes it.
3. **tally-worker** — set secrets, `wrangler deploy`. See
   [`worker/README.md`](worker/README.md).
4. **Power Automate** —
   - Ben joins the `expenses@einbau.ca` distribution group (it has no mailbox of
     its own to poll, so mail has to land somewhere with an actual inbox).
   - An Outlook rule files mail sent to `expenses@einbau.ca` into a dedicated
     folder.
   - A flow on the built-in "When a new email arrives in a folder" trigger reads
     the message + "Get attachment content" (already base64) and POSTs both to
     `https://tally-worker.<subdomain>.workers.dev/intake` with header
     `X-Tally-Service-Key: <the secret>`.
   - **Confirm the base64 attachment doesn't hit Power Automate's HTTP action
     body-size cap before assuming it "just works"** — phone photos are usually
     fine (2-8MB) but worth checking once for real.
5. **Frontend** — create a `tally` (or similar) GitHub repo, push `web/`, set
   the `VITE_TALLY_API` / `VITE_AUTH_API` repository variables the
   `.github/workflows/pages.yml` workflow reads, enable Pages (Source: GitHub
   Actions). Confirm `https://lambwright.github.io/tally/` loads and logs in —
   no `auth-worker` change needed, its CORS is already locked to that origin.
6. **Accounts** — create reviewer logins via `auth-worker`'s
   `/auth/admin/create-user` (see `auth-worker/README.md`).

## What the payroll flow settled

Ben's working "Payroll Direct Cost Generator" Power Automate flow pinned down the
Direct Cost API — `worker/src/procore-directcost.js` is built from it:

- `POST https://us02.procore.com/rest/v1.0/projects/{id}/direct_costs`, header
  body wrapper **`"item"`** (not `"direct_cost"` — Procore's docs are wrong here).
- Line items are a **separate** POST to `.../direct_costs/{dc_id}/line_items`,
  wrapper `"line_item"`, budget field **`wbs_code_id`**.
- Headers: `Accept`, `Content-Type`, `Authorization: Bearer`,
  `Procore-Company-Id: 562949953508586`. `status: "approved"`.
- Idempotency = embed a token in the line-item description and string-search
  existing line items for it before writing. TALLY uses `[INV:<expense id>]`
  (the payroll flow uses `[TC:<timecard id>]`).
- Einbau company vendor id `562949959021641`.

Confirmed with Ben since:

- **`direct_cost_type: "invoice"`** — so the Procore→NetSuite invoice sync picks
  these up.
- **The DC header `invoice_number`** = the form's own generated Expense ID.
- **Tag the employee** on the header (`employee_id`, resolved from the submitter's
  email via `GET /companies/{co}/users?filters[search]=<email>`, same as the
  payroll flow). Omitted only if the lookup fails.
- **Cost codes are picked per-submission in the review UI**, pre-selected to a
  category default, fully overrideable. Defaults (`CATEGORY_TO_WBS_CODE` in
  `procore-directcost.js`):
  | category | default WBS flat code |
  |---|---|
  | Parking | `49-01-06-06.P` |
  | Materials | `56.MC` |
  | Mileage | `49-01-06-03.Mi` |
  | Fuel | `49-01-06-03.F` |
  | Per Diem | `49-01-06-05.Fo` |
  | Other | *(none — reviewer must choose)* |

## Still open

The Procore write stays gated off (`DIRECTCOST_VERIFIED = false`) until it's been
smoke-tested once against live Procore — approve returns the exact payload it
*would* send via `?dryRun=1` until then. Specifically still to verify live:

1. **The WBS/budget-code endpoint + field names.** `listProjectWbsCodes()` reads
   `/rest/v1.0/projects/{id}/budget_line_items` and matches on the flat code
   string; the payroll flow got these from a report column, never the API, so the
   exact shape needs one real check. The dry-run response shows the resolved
   `wbsCodeId` for exactly this reason.
2. **`uom` on the line item** — payroll uses `"hours"`; TALLY sends `"each"` for a
   lump expense. Confirm Procore accepts it.
3. **The Expense ID → email subject wiring** (see the revision-loop note below).
4. The dedicated Outlook folder name (intake address is `expenses@einbau.ca` — a
   distribution group; Ben joins it so a real mailbox receives the mail).

### Revision loop — manual for MVP

Reply-threading (an employee's revision reply auto-matching back to the original
claim) needs the Expense ID in the email subject, which depends on how the
stripped form sends mail — not yet settled. For the MVP the expense team links a
revision reply to its original claim **by hand**. `POST
/submissions/:id/request-revision` still produces a copy-ready reply carrying
`[INV:<id>]`; the `/intake` dedup will pick threading up automatically once the
Expense ID reliably lands in the subject, with no code change.

## Verification

- `cd worker && npm test` — unit tests over the pure logic (invoice-number
  parsing, PA-body salvage, every validation flag, tax math). No live
  Neon/R2/Procore/Anthropic needed.
- `cd worker && npm run dev` + `cd web && npm run dev` — full local loop against
  real Neon/R2/Procore/Anthropic (point `DATABASE_URL` at a Neon branch, not
  production, while iterating). Vite's dev proxy keeps the browser same-origin
  so `auth-worker`'s CORS lock doesn't get in the way locally.
- Full checklist in [`worker/README.md`](worker/README.md) and the build plan.
