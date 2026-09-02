import { useEffect, useState, useCallback } from "react";
import { api, fetchReceiptObjectUrl } from "../api.js";
import RevisionModal from "./RevisionModal.jsx";

function formatMoney(n, currency = "CAD") {
  if (n === null || n === undefined || n === "") return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(num);
  } catch {
    return `$${num.toFixed(2)}`;
  }
}

// Mirror of the worker's CATEGORY_TO_WBS_CODE — only used to name the fallback
// in the UI when the live cost-code list can't be loaded.
const FALLBACK_DEFAULT = {
  parking: "49-01-06-06.P",
  materials: "56.MC",
  mileage: "49-01-06-03.Mi",
  fuel: "49-01-06-03.F",
  per_diem: "49-01-06-05.Fo",
};

const FLAG_LABELS = {
  project_missing: "No project number",
  project_invalid: "Project not recognized",
  project_inactive: "Project is On Hold / Completed & Invoiced",
  geo_mismatch: "Location doesn't match the project",
  tax_estimated: "Tax estimated, not read off the receipt",
  amount_mismatch: "Numbers don't reconcile",
  low_confidence: "Low extraction confidence",
  category_conflict: "Receipt looks like a different category",
  duplicate_invoice: "Duplicate invoice number",
};

export default function SubmissionDetail({ id, onClose, onChanged }) {
  const [sub, setSub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [images, setImages] = useState([]); // [{key, url}]
  const [netAmount, setNetAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [showRevision, setShowRevision] = useState(false);

  // Cost-code picker: project's WBS/budget codes + the category default.
  const [costCodes, setCostCodes] = useState(null); // { codes, default_wbs_code_id, default_cost_code } | { error }
  const [chosenCode, setChosenCode] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getSubmission(id)
      .then((data) => {
        setSub(data.submission);
        setNetAmount(data.submission.net_amount ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Load the project's cost codes once we have a submission that can still be acted on.
  useEffect(() => {
    if (!sub || !sub.project_procore_id) return;
    if (sub.status === "approved" || sub.status === "rejected") return;
    let cancelled = false;
    api.getCostCodes(sub.id)
      .then((data) => {
        if (cancelled) return;
        setCostCodes(data);
        setChosenCode(data.default_wbs_code_id || "");
      })
      .catch((e) => { if (!cancelled) setCostCodes({ error: e.message }); });
    return () => { cancelled = true; };
  }, [sub?.id, sub?.project_procore_id, sub?.status]);

  useEffect(() => {
    let cancelled = false;
    const urls = [];
    setImages([]);
    if (sub && sub.receipt_keys && sub.receipt_keys.length) {
      Promise.all(
        sub.receipt_keys.map((key) =>
          fetchReceiptObjectUrl(sub.id, key)
            .then((url) => { urls.push(url); return { key, url }; })
            .catch(() => ({ key, url: null }))
        )
      ).then((loaded) => { if (!cancelled) setImages(loaded); });
    }
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [sub?.id, sub?.receipt_keys]);

  async function handleApprove() {
    if (!sub) return;
    setBusy(true);
    setActionError(null);
    try {
      const override = Number(netAmount) !== Number(sub.net_amount) ? Number(netAmount) : undefined;
      await api.approve(sub.id, { netAmount: override, costCode: chosenCode || undefined });
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    const reason = window.prompt("Reason for rejecting this submission?");
    if (!reason || !reason.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.reject(sub.id, reason.trim());
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="empty-state">Loading…</div>;
  if (error) return <div className="empty-state">{error}</div>;
  if (!sub) return null;

  const parsed = sub.parsed || {};
  const netDirty = netAmount !== "" && Number(netAmount) !== Number(sub.net_amount);
  const actionable = sub.status !== "approved" && sub.status !== "rejected";
  // Force a cost-code choice only when we actually loaded the list (if the lookup
  // failed, let the worker fall back to the category default).
  const mustPickCode = actionable && costCodes && !costCodes.error && !chosenCode;

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginBottom: 16 }}>
        ← Back to queue
      </button>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="card-title">{sub.invoice_number}</div>
            <h2 style={{ fontSize: 20 }}>{sub.employee_name || sub.employee_email || "(unknown employee)"}</h2>
          </div>
          <span className={`badge badge-${sub.status}`}>{sub.status.replace("_", " ")}</span>
        </div>
      </div>

      {sub.flags && sub.flags.length > 0 && (
        <div className="card">
          <div className="card-title">Flags</div>
          {sub.flags.map((f, i) => (
            <div className={`flag flag-${f.severity || "low"}`} key={i}>
              <div>
                <strong>{FLAG_LABELS[f.code] || f.code}</strong>
                <div>{f.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-title">Claim</div>
        <div className="kv-grid">
          <div className="kv">
            <span className="kv-label">Project</span>
            <span className="kv-value">{sub.project_number || "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-label">Category</span>
            <span className="kv-value" style={{ textTransform: "capitalize" }}>{(sub.category || "").replace("_", " ")}</span>
          </div>
          <div className="kv">
            <span className="kv-label">Province</span>
            <span className="kv-value">{sub.province || "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-label">Vendor</span>
            <span className="kv-value">{sub.vendor || "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-label">Receipt date</span>
            <span className="kv-value">{sub.receipt_date || "—"}</span>
          </div>
        </div>
      </div>

      {!sub.is_flat_claim && images.length > 0 && (
        <div className="card">
          <div className="card-title">Receipt</div>
          {images.map((img) =>
            img.url ? (
              <div className="receipt-pane" key={img.key} style={{ marginBottom: 8 }}>
                <img src={img.url} alt="Receipt" />
              </div>
            ) : (
              <div className="empty-state" key={img.key}>Couldn't load {img.key}</div>
            )
          )}
        </div>
      )}

      <div className="card">
        <div className="card-title">Amounts</div>
        <div className="tax-line-row">
          <span>Gross</span>
          <span className="kv-value mono">{formatMoney(sub.gross_amount, sub.currency)}</span>
        </div>
        {Array.isArray(parsed.tax_lines) && parsed.tax_lines.map((t, i) => (
          <div className="tax-line-row" key={i}>
            <span>{t.label}</span>
            <span className="kv-value mono">{formatMoney(t.amount, sub.currency)}</span>
          </div>
        ))}
        {sub.tax_source === "fallback_table" && (
          <div className="tax-line-row">
            <span>Tax (estimated)</span>
            <span className="kv-value mono">{formatMoney(sub.tax_amount, sub.currency)}</span>
          </div>
        )}
        <div className="tax-line-row tax-line-total">
          <span>Net (posts to Procore)</span>
          <span className="kv-value mono">{formatMoney(netAmount, sub.currency)}</span>
        </div>
        <div className="field" style={{ marginTop: 12, maxWidth: 200 }}>
          <label htmlFor="net-amount">Net amount</label>
          <input
            id="net-amount"
            type="number"
            step="0.01"
            value={netAmount}
            onChange={(e) => setNetAmount(e.target.value)}
          />
        </div>
        {netDirty && <div className="row-secondary" style={{ marginTop: 6 }}>Corrected from {formatMoney(sub.net_amount, sub.currency)} — will be saved on approve.</div>}
      </div>

      {actionable && (
        <div className="card">
          <div className="card-title">Cost code</div>
          {!costCodes ? (
            <div className="spinner-inline">Loading the project's cost codes…</div>
          ) : costCodes.error ? (
            <div className="row-secondary" style={{ color: "var(--yellow)" }}>
              Couldn't load cost codes ({costCodes.error}). Approve will fall back to the category default
              {" "}({FALLBACK_DEFAULT[sub.category] || "none — pick one in Procore"}).
            </div>
          ) : (
            <>
              <div className="field" style={{ maxWidth: 420 }}>
                <label htmlFor="cost-code">
                  {costCodes.default_cost_code
                    ? `Default for ${sub.category}: ${costCodes.default_cost_code}`
                    : `No default for "${sub.category}" — pick one`}
                </label>
                <select id="cost-code" value={chosenCode} onChange={(e) => setChosenCode(e.target.value)}>
                  <option value="">— select a cost code —</option>
                  {costCodes.codes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}{c.description ? ` — ${c.description}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              {mustPickCode && (
                <div className="row-secondary" style={{ marginTop: 6, color: "var(--yellow)" }}>
                  Choose a cost code to enable Approve.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {actionError && <div className="card" style={{ color: "var(--red)" }}>{actionError}</div>}

      {actionable && (
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <button className="btn btn-orange" disabled={busy || mustPickCode} onClick={handleApprove}>
            {busy ? "Working…" : "Approve"}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setShowRevision(true)}>
            Request Revision
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={handleReject}>
            Reject
          </button>
        </div>
      )}

      {sub.procore_direct_cost_id && (
        <div className="row-secondary" style={{ marginTop: 12 }}>
          Procore Direct Cost: {sub.procore_direct_cost_id}
        </div>
      )}

      {showRevision && (
        <RevisionModal
          submission={sub}
          onClose={() => setShowRevision(false)}
          onDone={() => {
            setShowRevision(false);
            onChanged?.();
            load();
          }}
        />
      )}
    </div>
  );
}
