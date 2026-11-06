-- 014 — the line item ERP IDs a Direct Cost had when it was unlocked, as { lineId: originId }, so a re-lock can put
-- them back. A DC stays locked while any line has an ID, so an unlock has to blank them.
-- The worker also adds this itself (ensureErpLinkLog). Safe to re-run.
alter table erp_link_log add column if not exists old_lines jsonb;
