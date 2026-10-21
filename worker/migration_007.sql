-- 007 — several receipts can live in one stored file (a photo of five parking stubs, a PDF
-- of six invoices). TALLY now keeps one receipts row per receipt, sharing r2_key, and `note`
-- says which one it is ("2 of 5 - Green P, Sep 3"). Safe to re-run.
alter table receipts add column if not exists note text;
