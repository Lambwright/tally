// What to call an expense on screen. Until Submit gives it its real Expense ID it carries a long internal
// placeholder ("pending-<uuid>"), which nobody needs to read: show "Pending expense #7" instead, where 7 is how many
// expenses that person has created so far (the worker sends it as creator_seq). The placeholder stays internal.
export function shownExpenseId(sub) {
  if (!sub) return "";
  if (/^pending-/i.test(String(sub.expense_id || ""))) {
    return sub.creator_seq ? `Pending expense #${sub.creator_seq}` : "Pending expense";
  }
  return sub.expense_id || "";
}
export const isPendingId = (sub) => /^pending-/i.test(String(sub?.expense_id || ""));
