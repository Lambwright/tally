-- TALLY database schema — dedicated Neon project `tally`, separate from PUNCH/others.
--
-- Model: one `submissions` row per emailed Employee Expense Form (the "header"),
-- many `line_items` (one per expense row on the form), many `receipts` (one per
-- attached image/PDF). TALLY parses the form PDF into line items, parses each
-- receipt, matches lines to receipts, and derives the net (pre-tax) amount per
-- line from the matched receipt. On approval a form becomes one Procore Direct
-- Cost header + one line item per expense row.
--
-- Only throwaway test rows existed before this rewrite — safe to drop.

create extension if not exists pgcrypto;

drop table if exists line_items cascade;
drop table if exists receipts cascade;
drop table if exists submissions cascade;

-- ---------------------------------------------------------------------------
-- submissions — one emailed expense form
-- ---------------------------------------------------------------------------
create table submissions (
  id uuid primary key default gen_random_uuid(),

  -- The form's auto-generated Expense ID (DDMMYY-JJJJJ-EEEE). Also the tracking
  -- token: a revision-loop reply carrying it merges back onto this row.
  expense_id text unique not null,

  employee_name  text,
  employee_email text,
  province       text,                 -- 2-letter province/territory code

  project_number     text,
  project_procore_id bigint,
  project_name       text,
  project_stage      text,

  status text not null default 'needs_review' check (status in
    ('needs_review', 'needs_revision', 'approved', 'rejected')),

  -- Form-level deterministic checks: [{ code, severity, detail }]. Advisory —
  -- they surface in the queue, they don't block. (Per-line flags live on line_items.)
  flags jsonb not null default '[]'::jsonb,

  raw_email     text,                              -- original body, never in list endpoints
  history       jsonb not null default '[]'::jsonb,
  revision_note text,

  reviewed_by text,
  reviewed_at timestamptz,

  procore_direct_cost_id text,                     -- set once the Direct Cost is created

  submitted_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_submissions_status  on submissions (status, created_at desc);
create index idx_submissions_expense  on submissions (expense_id);

-- ---------------------------------------------------------------------------
-- receipts — one attached image/PDF (the form itself is stored too, kind='form')
-- ---------------------------------------------------------------------------
create table receipts (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,

  r2_key text not null,                  -- object key in the tally-receipts bucket
  kind   text not null default 'receipt' check (kind in ('receipt', 'form')),

  -- what Claude read off it (null for kind='form' and for anything unreadable)
  vendor       text,
  receipt_date date,
  subtotal     numeric(12, 2),           -- printed pre-tax amount
  tax_json     jsonb,                     -- [{ label, amount }]
  gross        numeric(12, 2),           -- printed total
  currency     text default 'CAD',
  confidence   numeric(4, 3),

  matched_line_item_id uuid,             -- back-pointer; the source of truth is line_items.receipt_id

  created_at timestamptz not null default now()
);

create index idx_receipts_submission on receipts (submission_id);

-- ---------------------------------------------------------------------------
-- line_items — one expense row on the form
-- ---------------------------------------------------------------------------
create table line_items (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,

  row_index   integer,
  line_date   date,
  description text,
  category    text not null check (category in
    ('parking', 'materials', 'fuel', 'mileage', 'per_diem', 'other')),
  -- mileage / per diem: flat claim, no receipt, net = gross, no tax
  is_flat_claim boolean not null default false,

  gross_amount numeric(12, 2),           -- amount entered in the category column
  tax_amount   numeric(12, 2),
  net_amount   numeric(12, 2),           -- pre-tax — THIS is what posts to Procore
  tax_source   text not null default 'none'
    check (tax_source in ('read', 'fallback_table', 'none')),

  receipt_id       uuid references receipts(id) on delete set null,
  match_method     text not null default 'none' check (match_method in ('auto', 'manual', 'none')),
  match_confidence numeric(4, 3),

  cost_code text,                        -- chosen WBS flat code; blank = category default

  -- per-line deterministic checks: [{ code, severity, detail }]
  flags jsonb not null default '[]'::jsonb,

  -- denormalized from the parent so the future company-wide dashboard is a pure
  -- line_items scan (group by employee / project / category / month)
  employee_name      text,
  project_number     text,
  project_procore_id bigint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_line_items_submission on line_items (submission_id);
create index idx_line_items_category   on line_items (category, created_at);
create index idx_line_items_project    on line_items (project_number);
create index idx_line_items_employee   on line_items (employee_name);

-- ---------------------------------------------------------------------------
-- projects_cache — refreshed from Procore every 6h by the scheduled handler.
-- Backs the project_missing / project_invalid / project_inactive / geo checks
-- without a live Procore call on every intake.
-- ---------------------------------------------------------------------------
create table if not exists projects_cache (
  procore_id     bigint primary key,
  project_number text,
  name           text,
  stage          text,
  active         boolean not null default true,
  region         text,
  province       text,
  refreshed_at   timestamptz not null default now()
);

create index if not exists idx_projects_cache_number on projects_cache (project_number);

-- No row-level security: TALLY is a single internal tenant (the Einbau expense
-- team), no per-user data partition to enforce.
