# TALLY

Automates the middle of Einbau's expense-reimbursement pipeline: an employee
emails their multi-line Employee Expense Form (as a Procore Forms PDF) plus
receipt photos → Claude parses the form into line items and reads each receipt →
TALLY matches lines to receipts and derives the **net-of-tax** amount per line →
a human reviews and fixes anything in a queue → one Procore Direct Cost (one
header, one line item per expense row) lands, tagged with the form's Expense ID.
Everything before ("employee fills the form") and after ("Procore→NetSuite sync,
payroll reimbursement") already exists and stays as-is. The only form change:
Einbau removes the embedded province tax script (it was fragile, esp. for QC).

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
 employee fills the Employee Expense Form (Procore Forms), emails it + receipts to expenses@einbau.ca
        │
        ▼
 Ben's inbox ── Outlook rule ──▶ dedicated folder
        │
        ▼
 Power Automate "new email in folder" trigger  (own connector auth — no Azure app reg)
        │  POST { subject, from, body, attachments[] }   ← one form PDF + N receipt images
        ▼
 tally-worker  POST /intake
   → store every attachment in R2 (private)
   → ONE Claude call: parse the form into line_items, read each receipt, propose line↔receipt matches
   → deterministic match layer (amount + vendor/date, strictly 1:1; unsure → flagged, left for a human)
   → per line: net = receipt subtotal (or gross − printed tax); province rate table only as a flagged fallback;
               mileage / per_diem = flat claim (net = gross, no receipt)
   → insert submissions (1) + line_items (N) + receipts (M);  status = needs_review
      (Claude failing entirely still creates the row — reviewer builds the lines by hand)
        │
        ▼
 review queue (web/, Einbau ID login)
   lines table + receipt strip: fix fields, match/unmatch receipts, add/delete lines, set per-line cost codes
        │  approve  (enabled only when every line is complete)
        ▼
 tally-worker  POST /submissions/:id/approve
   → resolve each line's wbs_code_id live from GET /rest/v1.0/projects/{id}/wbs_codes
   → POST ONE invoice-type Direct Cost header + one line item per expense row, at each line's NET
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
     the message and **all** attachments (form PDF + receipt photos, each already
     base64 from "Get attachment content") and POSTs them as
     `{ subject, from, body, attachments: [{ name, contentType, contentBytes }] }`
     to `https://tally-worker.ben-a90.workers.dev/intake` with header
     `X-Tally-Service-Key: <the secret>`.
   - **Check the combined base64 payload doesn't hit Power Automate's HTTP action
     body cap** — phone photos run 2–8MB each; a form with many receipts adds up.
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
  existing line items for it before writing. TALLY uses `[EXP:<expense id>]`
  (the payroll flow uses `[TC:<timecard id>]`).
- Einbau company vendor id `562949959021641`.
- Project WBS codes: `GET /rest/v1.0/projects/{id}/wbs_codes` (confirmed live) →
  rows with `id` + `flat_code` (`"49-01-05-05.L"`) + `flat_name`.

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

The Procore write stays gated off (`DIRECTCOST_VERIFIED = false`) until one real
write has been smoke-tested against live Procore — `approve?dryRun=1` returns the
exact header + per-line payloads (with resolved `wbs_code_id`s) until then.

1. **First live Direct Cost write** on a budgeted test project → confirm one
   header + N line items appear and flow to NetSuite → flip the flag.
2. **`uom` on the line item** — payroll uses `"hours"`; TALLY sends `"each"`.
   Confirm Procore accepts it.
3. **The form change** — Einbau removes the province tax script + the Net Total
   row calc; keeps the layout, the six columns, the mileage km×rate math (must
   still output a dollar), and the `DDMMYY-JJJJJ-EEEE` Expense ID. Ideally the
   Expense ID also lands in the email subject (for the deferred revision loop).
4. **Power Automate flow** — folder trigger → forward the email + *all*
   attachments to `/intake` with `X-Tally-Service-Key`. Check phone-photo
   attachments don't hit PA's HTTP body cap, and watch `wrangler tail` on a big
   multi-receipt form for the subrequest ceiling (fallback: POST form first, each
   receipt to a follow-up route).
5. The dedicated Outlook folder name (`expenses@einbau.ca` is a distribution
   group; Ben joins it so a real mailbox receives the mail).

### Revision loop — manual for MVP

Auto-threading a revision reply back to its form needs the Expense ID in the
email subject, which depends on the form change. Until then the expense team
links a reply to its form by hand. `POST /submissions/:id/request-revision`
already produces a copy-ready reply carrying the Expense ID; `/intake`'s dedup
picks up threading automatically once it reliably lands in the subject.

## Verification

- `cd worker && npm test` — pure-logic unit tests (expense-id parsing,
  line↔receipt matching, net derivation, form + line flags). No live services.
- `cd worker && npm run smoke` — against the deployed Worker: the multi-line
  pipeline end to end plus the fully-manual build path.
- `cd worker && npm run dev` + `cd web && npm run dev` — full local loop against
  real Neon/R2/Procore/Anthropic (point `DATABASE_URL` at a Neon branch). Vite's
  dev proxy keeps the browser same-origin so `auth-worker`'s CORS lock is a
  non-issue locally.
- Full checklist in [`worker/README.md`](worker/README.md).
