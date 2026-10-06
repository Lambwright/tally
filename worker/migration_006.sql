-- migration_006: add submissions.form_employee_name
--
-- Run this ONCE against the live `tally` database — additive only, doesn't
-- touch existing rows (they stay null; the self-approval check then just
-- compares the current employee_name for those). The name Claude read off the
-- form is kept separately so a reviewer renaming the employee can't be used to
-- dodge the "nobody approves their own expense" rule.

alter table submissions add column if not exists form_employee_name text;
