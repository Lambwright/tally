import { useState } from "react";

// TALLY's own confirm / ask-a-reason dialog, so nothing in the app falls back to the browser's plain pop-ups.
// `dialog` = { title, body, confirmLabel, danger, reason?: { label, placeholder }, run(reasonText) }.
export default function DialogModal({ dialog, onClose }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const needsReason = !!dialog.reason;
  const ready = !needsReason || !!reason.trim();

  async function go(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await dialog.run(reason.trim());
    } finally {
      onClose();
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={go}>
          <div className="card-title" style={{ marginBottom: 4 }}>{dialog.title}</div>
          {dialog.body && <p className="row-secondary" style={{ marginBottom: 12, whiteSpace: "pre-wrap" }}>{dialog.body}</p>}
          {needsReason && (
            <div className="field">
              <label htmlFor="dialog-reason">{dialog.reason.label}</label>
              <textarea id="dialog-reason" rows={4} autoFocus value={reason} disabled={busy}
                placeholder={dialog.reason.placeholder} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={`btn ${dialog.danger ? "btn-danger" : "btn-orange"}`} disabled={busy || !ready}>
              {busy ? "Working…" : dialog.confirmLabel || "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
