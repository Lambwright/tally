-- TALLY database schema — dedicated Neon project `tally`, separate from PUNCH/others.
--
-- Holds in-flight expense-submission state (there is no Power Automate Approvals
-- feature giving this for free) plus a small cache of Procore's active projects
-- for the deterministic validation layer.
--
-- The `submissions` columns are deliberately shaped so the deferred company-wide
-- expenditure dashboard can be added later as a pure read layer (group by
-- employee / project / category / month) with NO migration.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- submissions — one row per expense claim, from intake through to Procore write
-- ---------------------------------------------------------------------------
create table submissions (
  id uuid primary key default gen_random_uuid(),

  -- The auto-generated invoice number off the (stripped) Procore form. Also the
  -- tracking token: revision-loop replies carry it in the subject so they merge
  -- back onto this row instead of creating a duplicate.
  invoice_number text unique not null,

  -- who submitted
  employee_name  text,
  employee_email text,
  province       text,                 -- 2-letter province code as stated on the form

  -- which project (project_number comes exact from the stripped form; the rest is
  -- resolved against projects_cache at intake time)
  project_number     text,
  project_procore_id bigint,
  project_name       text,
  project_stage      text,

  -- The columns on Einbau's Employee Expense Form: Parking, Materials, Fuel,
  -- Mileage, Per Diem, Other. One category per submission (the stripped form is a
  -- single dropdown).
  category text not null check (category in
    ('parking', 'materials', 'fuel', 'mileage', 'per_diem', 'other')),
  -- No receipt to parse — a flat claimed amount (per diem = daily allowance,
  -- mileage = km * rate). Skips the Claude extraction / gross-tax-net path.
  is_flat_claim boolean not null default false,

  -- what was on the receipt (or claimed, for per diem)
  vendor       text,
  receipt_date date,
  currency     text not null default 'CAD',

  gross_amount numeric(12, 2),         -- printed gross / claimed amount
  tax_amount   numeric(12, 2),         -- sum of tax line items (or fallback estimate)
  net_amount   numeric(12, 2),         -- pre-tax — THIS is what posts to Procore

  -- provenance of tax_amount. 'read' = taken straight off the receipt (trusted).
  -- 'fallback_table' = estimated from the province x category rate table because
  -- the receipt didn't itemize tax — always flagged, never treated as equal.
  -- 'none' = per diem / not applicable.
  tax_source text not null default 'none'
    check (tax_source in ('read', 'fallback_table', 'none')),

  confidence numeric(4, 3),            -- Claude's own 0..1 confidence on the figures

  status text not null default 'needs_review' check (status in
    ('needs_review', 'needs_revision', 'approved', 'rejected')),

  -- [{ code, severity, detail }] — deterministic validation results. Advisory:
  -- flags never block approval, they just surface in the queue.
  flags jsonb not null default '[]'::jsonb,

  receipt_keys jsonb not null default '[]'::jsonb,  -- R2 object keys for the images
  parsed       jsonb,                               -- full Claude output incl tax_lines[]

  -- The original email body. Only ever needed for a manual "view original" look —
  -- never selected into the list endpoint (see punch-worker's egress-overage note).
  raw_email text,

  history       jsonb not null default '[]'::jsonb, -- [{ at, type, text }]
  revision_note text,                               -- last note sent back to the employee

  reviewed_by text,
  reviewed_at timestamptz,

  cost_code text,                                  -- WBS/budget flat code the reviewer approved against (blank = category default)
  procore_direct_cost_id text,                      -- set once the Direct Cost is created

  submitted_at timestamptz,                         -- when the employee's email arrived
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_submissions_status       on submissions (status, created_at desc);
create index idx_submissions_invoice      on submissions (invoice_number);
-- Future-dashboard group-bys — present now so the dashboard is a read layer, not a migration:
create index idx_submissions_employee     on submissions (employee_name);
create index idx_submissions_project      on submissions (project_number);
create index idx_submissions_category     on submissions (category, submitted_at);

-- ---------------------------------------------------------------------------
-- projects_cache — refreshed from Procore every 6h by the scheduled handler.
-- Backs the project_missing / project_invalid / project_inactive / geo_mismatch
-- validation checks without a live Procore call on every intake.
-- ---------------------------------------------------------------------------
create table projects_cache (
  procore_id     bigint primary key,
  project_number text,
  name           text,
  stage          text,          -- Procore project_stage.name
  active         boolean not null default true,
  region         text,          -- Procore project_region.name
  province       text,          -- 2-letter, derived from the project's state/region
  refreshed_at   timestamptz not null default now()
);

create index idx_projects_cache_number on projects_cache (project_number);

-- Note: no row-level security here. TALLY is a single internal tenant (the Einbau
-- expense team) and there is no per-user data partition to enforce. If that ever
-- changes, add the same `app.user_id` SET-per-request scaffolding PUNCH uses.
