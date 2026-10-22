-- 009 — Submit Expense workflow. An expense created in the app now starts as a 'draft'
-- (visible only to whoever created it) until they click Submit Expense, preview the payload and
-- pick who approves it; only then does it become 'needs_review' in that approver's queue.
-- Email intake is unchanged (it arrives as needs_review with no approver, any admin can take it).
-- Safe to re-run.
alter table submissions drop constraint if exists submissions_status_check;
alter table submissions add constraint submissions_status_check
  check (status in ('draft', 'needs_review', 'needs_revision', 'approved', 'rejected'));
alter table submissions add column if not exists approver text;                    -- Einbau ID username who must approve it
alter table submissions add column if not exists submitted_for_review_at timestamptz;
