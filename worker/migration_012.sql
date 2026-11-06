-- 012 — who added which file to which Direct Cost through the Procore side panel.
-- Procore only sees TALLY's service account, so this is the only record of the person.
-- The worker also creates this itself on first use (ensureDcAttachmentLog). Safe to re-run.
create table if not exists dc_attachment_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  username text not null,
  display_name text,
  project_id text not null,
  direct_cost_id text not null,
  direct_cost_number text,
  origin_id text,
  filename text not null,
  content_type text,
  size_bytes bigint,
  status text not null default 'pending', -- pending | attached | failed | unverified
  detail text
);
