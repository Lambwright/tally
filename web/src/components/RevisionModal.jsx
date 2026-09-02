import { useState } from "react";
import { api } from "../api.js";

// The worker never sends mail itself (Power Automate is intake-only per the
// kickoff) — it hands back a copy-ready reply whose subject carries the invoice
// number, and a human sends it from Outlook. The employee's reply keeps that
// token in the subject, so when PA forwards it back to /intake it merges onto
// this same submission instead of creating a duplicate.
export default function RevisionModal({ submission, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reply, setReply] = useState(null);
  const [copied, setCopied] = useState(false);

  async function handleSend(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestRevision(submission.id, note.trim());
      setReply(result.reply);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    const text = `Subject: ${reply.subject}\n\n${reply.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard API unavailable — the text is still visible to select by hand.
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!reply ? (
          <form onSubmit={handleSend}>
            <div className="card-title" style={{ marginBottom: 4 }}>Request Revision</div>
            <p className="row-secondary" style={{ marginBottom: 12 }}>
              What does {submission.employee_name || "the employee"} need to fix on {submission.invoice_number}?
            </p>
            <div className="field">
              <label htmlFor="revision-note">Note</label>
              <textarea
                id="revision-note"
                rows={4}
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {error && <div className="login-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-orange" disabled={busy || !note.trim()}>
                {busy ? "Saving…" : "Save & Get Reply"}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <div className="card-title" style={{ marginBottom: 4 }}>Reply ready</div>
            <p className="row-secondary" style={{ marginBottom: 12 }}>
              Send this from Outlook — keep the subject exactly as-is so the employee's reply routes back here.
            </p>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Subject</label>
              <input readOnly value={reply.subject} />
            </div>
            <div className="field">
              <label>Body</label>
              <textarea readOnly rows={6} value={reply.body} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="btn btn-orange" onClick={() => onDone(reply)}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
