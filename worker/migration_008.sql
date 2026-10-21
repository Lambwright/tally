-- 008 — which pages of a stored PDF a receipt record is on, so clicking a line's receipt can
-- open just those pages of a 16-page bundle. Null for photos, and for receipts read before this
-- column existed (those open the whole file, as before). Safe to re-run.
alter table receipts add column if not exists page_start integer;
alter table receipts add column if not exists page_end integer;
