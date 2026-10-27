-- 011 — when a sent-back expense was re-submitted by its creator (shown as "Re-submitted" to the approver).
-- The revision messages themselves live in submissions.history (types revision_requested / revision_reply).
-- Safe to re-run.
alter table submissions add column if not exists resubmitted_at timestamptz;
