-- migration_003: allow tax_source = 'manual'
--
-- Run this ONCE against the live `tally` database. A reviewer typing a net
-- amount by hand now marks the line 'manual' so a shared-receipt resync
-- (another line joining/leaving the same receipt) doesn't silently overwrite
-- it with a recomputed value.

alter table line_items drop constraint if exists line_items_tax_source_check;
alter table line_items add constraint line_items_tax_source_check
  check (tax_source in ('read', 'fallback_table', 'none', 'manual'));
