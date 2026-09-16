-- migration_001: add submissions.date_authorized
--
-- Run this ONCE against the live `tally` database — additive only, doesn't
-- touch existing rows. Do NOT re-run schema.sql on a database with real data;
-- it drops and recreates the tables.

alter table submissions add column if not exists date_authorized date;
