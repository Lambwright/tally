-- migration_004: add submissions.origin, submissions.created_by
--
-- Run this ONCE against the live `tally` database — additive only, doesn't
-- touch existing rows (they backfill to origin='email', created_by=null,
-- which is correct: everything before this migration came in by email).

alter table submissions add column if not exists origin text not null default 'email'
  check (origin in ('email', 'upload', 'pm_direct'));
alter table submissions add column if not exists created_by text;
