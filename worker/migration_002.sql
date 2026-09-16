-- migration_002: add line_items.tax_code
--
-- Run this ONCE against the live `tally` database — additive only, doesn't
-- touch existing rows.

alter table line_items add column if not exists tax_code text;
