-- 013 — every ERP link lock and unlock made through the Procore side panel: who, why, and the old and new
-- origin_id, so a change can be traced and undone. Procore only sees TALLY's service account.
-- The worker also creates this itself on first use (ensureErpLinkLog). Safe to re-run.
create table if not exists erp_link_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  username text not null,
  display_name text,
  project_id text not null,
  record_type text not null,
  record_id text not null,
  record_number text,
  action text not null, -- lock | unlock
  old_origin_id text,
  new_origin_id text,
  reason text not null,
  status text not null default 'pending', -- pending | done | failed | unverified
  detail text
);
