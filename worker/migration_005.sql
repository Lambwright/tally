-- migration_005: add line_items.receipt_override_by / receipt_override_at
--
-- Run this ONCE against the live `tally` database — additive only, doesn't
-- touch existing rows. Lets someone in RECEIPT_OVERRIDE_USERS waive the
-- receipt requirement on a single line so it can still post to Procore.

alter table line_items add column if not exists receipt_override_by text;
alter table line_items add column if not exists receipt_override_at timestamptz;
