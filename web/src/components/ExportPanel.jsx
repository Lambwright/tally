import { useState } from "react";
import { downloadExportCsv } from "../api.js";

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Defaults to the current calendar month — the common case for a payroll run.
function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: isoDate(from), to: isoDate(now) };
}

export default function ExportPanel({ onClose }) {
  const [range, setRange] = useState(defaultRange);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleDownload() {
    if (!range.from || !range.to) return;
    setBusy(true);
    setError(null);
    try {
      await downloadExportCsv(range.from, range.to);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title" style={{ marginBottom: 4 }}>Export approved expenses</div>
        <p className="row-secondary" style={{ marginBottom: 12 }}>
          One row per line item, for a payroll run or a period report. Rows with no PDF form attached (PM-submitted expenses) are flagged in the "has_form" column.
        </p>

        <div className="field">
          <label htmlFor="export-from">From</label>
          <input id="export-from" type="date" value={range.from} disabled={busy}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="export-to">To</label>
          <input id="export-to" type="date" value={range.to} disabled={busy}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
        </div>

        {error && <div className="login-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          <button type="button" className="btn btn-orange" onClick={handleDownload} disabled={busy || !range.from || !range.to}>
            {busy ? "Downloading…" : "Download CSV"}
          </button>
        </div>
      </div>
    </div>
  );
}
