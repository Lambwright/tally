import { useEffect, useState } from "react";
import { api } from "../api.js";
import DirectCostPreview from "./DirectCostPreview.jsx";
import Thinking from "./Thinking.jsx";

// Submit Expense: step 1 shows exactly what will be posted to Procore (the same preview as
// Approve's dry run), step 2 picks who approves it. Only on "Submit" does the expense leave the
// submitter's drafts and land in that approver's queue. Who is offered is worked out by the server: the
// holders of the approve-portal-expenses permission (Leela today), plus the super admins when the person
// submitting holds it too. The submitter and the employee the expense is for are never offered.
export default function SubmitExpenseModal({ id, sub, costCodes, resubmit = false, onClose, onSubmitted }) {
  const [preview, setPreview] = useState(null); // dry-run payload
  const [previewError, setPreviewError] = useState(null);
  const [approvers, setApprovers] = useState(null); // [{ username, displayName, hasWaiver, isDefault }]
  const [approversError, setApproversError] = useState(null);
  const [approver, setApprover] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [duplicates, setDuplicates] = useState(false); // the server found receipts already submitted
  const [confirmDupes, setConfirmDupes] = useState(false);
  const [reply, setReply] = useState(""); // re-submitting after a revision request: what changed

  useEffect(() => {
    let cancelled = false;
    api.approve(id, { dryRun: true })
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setPreviewError(e.data?.detail || e.message); });
    api.listApprovers(id)
      .then((d) => {
        if (cancelled) return;
        setApprovers(d.approvers || []);
        const def = (d.approvers || []).find((a) => a.isDefault) || (d.approvers || [])[0];
        if (def) setApprover(def.username);
      })
      .catch((e) => { if (!cancelled) setApproversError(e.data?.detail || e.message); });
    return () => { cancelled = true; };
  }, [id]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.submitExpense(id, approver, { allowDuplicates: confirmDupes, reply: reply.trim() });
      onSubmitted();
    } catch (e) {
      setDuplicates(e.data?.error === "duplicate_receipts");
      setError(e.data?.detail || e.message);
      setBusy(false);
    }
  }

  const chosen = (approvers || []).find((a) => a.username === approver);
  const ready = !!preview && !previewError && !!chosen && (!resubmit || !!reply.trim());

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="card-title" style={{ marginBottom: 4 }}>{resubmit ? "Resubmit expense" : "Submit expense"}</div>
        <p className="row-secondary" style={{ marginBottom: 12 }}>
          Check what will be posted to Procore, then choose who approves it. It lands in their queue when you submit.
        </p>

        <div className="card-title" style={{ fontSize: 11 }}>1 · Payload preview</div>
        {!preview && !previewError && <Thinking label="Checking the lines, the cost codes against the project's budget, and the invoice number…" />}
        {previewError && <div className="login-error">{previewError}</div>}
        {preview && <DirectCostPreview dryRun={preview} sub={sub} costCodes={costCodes} />}

        <div className="card-title" style={{ fontSize: 11, marginTop: 16 }}>2 · Who approves it</div>
        {!approvers && !approversError && <div className="row-secondary">Looking up who can approve it…</div>}
        {approversError && <div className="login-error">{approversError}</div>}
        {approvers && approvers.length === 0 && (
          <div className="login-error">No one else can approve this expense right now. (It needs a TALLY approver who isn't you or the employee it's for.)</div>
        )}
        {approvers && approvers.length > 0 && (
          <div role="radiogroup" style={{ display: "grid", gap: 6 }}>
            {approvers.map((a) => (
              <label key={a.username} className={`approver-option${approver === a.username ? " selected" : ""}`}>
                <input type="radio" name="approver" value={a.username} checked={approver === a.username}
                  disabled={busy} onChange={() => setApprover(a.username)} />
                <span>{a.displayName}</span>
                {a.isSuperAdmin && !a.canApprovePortal && <span className="combobox-sub">super admin</span>}
              </label>
            ))}
          </div>
        )}

        {resubmit && (
          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="resubmit-reply">3 · Your reply to the approver (required)</label>
            <textarea id="resubmit-reply" rows={3} value={reply} disabled={busy} onChange={(e) => setReply(e.target.value)}
              placeholder="What did you change, or why is it fine as it is? They see this when they open the expense." />
          </div>
        )}

        {error && <div className="login-error" style={{ marginTop: 10 }}>{error}</div>}
        {duplicates && (
          <label className="row-secondary" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={confirmDupes} onChange={(e) => setConfirmDupes(e.target.checked)} />
            These are separate purchases, not the same receipts again. Submit anyway.
          </label>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-orange" onClick={submit} disabled={busy || !ready}>
            {busy ? "Submitting…" : chosen ? `Submit to ${chosen.displayName}` : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
