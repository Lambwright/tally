import { useState } from "react";
import { api } from "../api.js";
import { shownExpenseId } from "../expenseLabel.js";

// Asking the person who made an expense to change something. The message stays in TALLY: when they open the
// expense it pops up with your name on it, they can reopen it from the page while they fix things, and their reply
// comes back to you the same way when they resubmit. (Emailed expenses go back by email, outside this button.)
export default function RevisionModal({ submission, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSend(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.requestRevision(submission.id, note.trim());
      onDone();
    } catch (err) {
      setError(err.data?.detail || err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSend}>
          <div className="card-title" style={{ marginBottom: 4 }}>Request revision</div>
          <p className="row-secondary" style={{ marginBottom: 12 }}>
            What does {submission.employee_name || "the submitter"} need to change on {shownExpenseId(submission)}? They'll see
            this message, with your name on it, when they open the expense.
          </p>
          <div className="field">
            <label htmlFor="revision-note">Your message</label>
            <textarea id="revision-note" rows={5} autoFocus value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && <div className="login-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-orange" disabled={busy || !note.trim()}>
              {busy ? "Sending…" : "Send back for revision"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
