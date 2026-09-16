import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { api, fetchReceiptObjectUrl } from "../api.js";
import RevisionModal from "./RevisionModal.jsx";
import EditableText from "./EditableText.jsx";
import DirectCostPreview from "./DirectCostPreview.jsx";

// pdf-lib is bulky and only needed once someone opens an attachment.
const Lightbox = lazy(() => import("./Lightbox.jsx"));

const CATEGORIES = ["parking", "materials", "fuel", "mileage", "per_diem", "other"];
const FLAT_CATEGORIES = new Set(["per_diem", "mileage"]);

const FLAG_LABELS = {
  project_missing: "No project number",
  project_invalid: "Project not recognized",
  project_inactive: "Project inactive / On Hold / Completed",
  form_parse_failed: "Form couldn't be parsed — build lines by hand",
  claude_failed: "Automatic parsing failed",
  receipt_orphan: "Receipt(s) not matched to any line",
  too_many_receipts: "More receipts than the parser handles",
  reply_on_closed: "Reply arrived on a closed form",
  receipt_unmatched: "No receipt matched",
  ambiguous_match: "Multiple receipts share this amount",
  low_confidence_match: "Matched on amount alone",
  tax_estimated: "Tax estimated, not read off the receipt",
  tax_unknown: "Receipt matched but no tax figure",
  amount_mismatch: "Numbers don't reconcile",
  low_confidence: "Low extraction confidence",
  geo_mismatch: "Location doesn't match the project",
  attachments_failed: "Some files didn't attach in Procore — attach by hand",
  receipt_shared: "Receipt also backs another line",
  tax_code_unmapped: "No Procore tax code for this province — added without one",
  employee_not_tagged: "Employee not tagged on the Direct Cost",
};

const PARSE_FAILURE_FLAGS = new Set(["parse_failed", "claude_failed", "form_parse_failed"]);

const dateOnly = (s) => (s ? String(s).slice(0, 10) : "");

function money(n, currency = "CAD") {
  if (n === null || n === undefined || n === "") return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(num);
  } catch {
    return `$${num.toFixed(2)}`;
  }
}

function FlagList({ flags }) {
  if (!flags || !flags.length) return null;
  return (
    <>
      {flags.map((f, i) => (
        <div className={`flag flag-${f.severity || "low"}`} key={i}>
          <div>
            <strong>{FLAG_LABELS[f.code] || f.code}</strong>
            {f.detail ? <div>{f.detail}</div> : null}
          </div>
        </div>
      ))}
    </>
  );
}

export default function SubmissionDetail({ id, onClose, onChanged }) {
  const [data, setData] = useState(null); // { submission, line_items, receipts }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [costCodes, setCostCodes] = useState(null); // { codes, defaults } | { error }
  const [receiptUrls, setReceiptUrls] = useState({}); // r2_key -> objectURL
  const [busy, setBusy] = useState(false);
  const [busyLine, setBusyLine] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showRevision, setShowRevision] = useState(false);
  const [dryRun, setDryRun] = useState(null);
  const [lightboxIdx, setLightboxIdx] = useState(null);
  const [newLine, setNewLine] = useState({ line_date: "", description: "", category: "materials", gross_amount: "" });
  const [selectedLineIds, setSelectedLineIds] = useState(new Set());
  const [bulkCostCodeText, setBulkCostCodeText] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getSubmission(id)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const sub = data?.submission;
  const lines = data?.line_items || [];
  const receipts = data?.receipts || [];
  const actionable = sub && sub.status !== "approved" && sub.status !== "rejected";

  // cost codes
  useEffect(() => {
    if (!sub || !sub.project_procore_id || !actionable) return;
    let cancelled = false;
    api.getCostCodes(id)
      .then((d) => { if (!cancelled) setCostCodes(d); })
      .catch((e) => { if (!cancelled) setCostCodes({ error: e.message }); });
    return () => { cancelled = true; };
  }, [id, sub?.project_procore_id, actionable]);

  // fetch each attachment as a blob URL (+ its mime type) for thumbnails / lightbox
  useEffect(() => {
    let cancelled = false;
    const made = [];
    Promise.all(
      receipts.map((r) =>
        fetchReceiptObjectUrl(id, r.r2_key)
          .then((res) => { made.push(res.url); return [r.r2_key, res]; })
          .catch(() => [r.r2_key, null])
      )
    ).then((pairs) => { if (!cancelled) setReceiptUrls(Object.fromEntries(pairs)); });
    return () => { cancelled = true; made.forEach((u) => u && URL.revokeObjectURL(u)); };
  }, [id, data?.receipts?.map((r) => r.r2_key).join(",")]);

  // drop selections for lines that no longer exist (deleted, or a fresh load)
  useEffect(() => {
    setSelectedLineIds((prev) => {
      const next = new Set([...prev].filter((lid) => lines.some((l) => l.id === lid)));
      return next.size === prev.size ? prev : next;
    });
  }, [lines]);

  // "code" or "code — description" -> the cost-code entry, for the searchable inputs
  const findCodeByText = useCallback((text) => {
    const norm = String(text || "").trim().toLowerCase();
    if (!norm) return null;
    return (costCodes?.codes || []).find(
      (c) => c.code.toLowerCase() === norm || `${c.code} — ${c.description}`.toLowerCase() === norm
    ) || null;
  }, [costCodes]);
  const codeLabelById = useMemo(
    () => Object.fromEntries((costCodes?.codes || []).map((c) => [c.id, c.code])),
    [costCodes]
  );

  // same idea for tax codes — matched by name, e.g. "ONTARIO"
  const findTaxCodeByText = useCallback((text) => {
    const norm = String(text || "").trim().toLowerCase();
    if (!norm) return null;
    return (costCodes?.tax_codes || []).find((c) => c.name.toLowerCase() === norm) || null;
  }, [costCodes]);
  const taxCodeLabelById = useMemo(
    () => Object.fromEntries((costCodes?.tax_codes || []).map((c) => [String(c.id), c.name])),
    [costCodes]
  );

  const receiptById = useMemo(() => Object.fromEntries(receipts.map((r) => [r.id, r])), [receipts]);
  // A receipt can legitimately back more than one line (one photo of several
  // receipts) — so "used" only means "at least one line", not "spoken for".
  // Every receipt stays pickable for every line.
  const linesForReceipt = (receiptId) => lines.filter((l) => l.receipt_id === receiptId);
  const pickableReceipts = receipts.filter((r) => r.kind === "receipt");
  const formDoc = receipts.find((r) => r.kind === "form");

  // ordered attachment list for the lightbox: form first, then receipts
  const lightboxItems = useMemo(() => {
    const ordered = [...receipts].sort((a, b) => (a.kind === "form" ? -1 : 0) - (b.kind === "form" ? -1 : 0));
    return ordered
      .map((r) => {
        const res = receiptUrls[r.r2_key];
        if (!res) return null;
        const forLines = linesForReceipt(r.id);
        return {
          url: res.url,
          type: res.type,
          name: r.r2_key.split("/").pop(),
          label: r.kind === "form" ? "Expense form" : `${r.vendor || "Receipt"}${forLines.length ? ` → line ${forLines.map((l) => l.row_index).join(", ")}` : ""}`,
          receiptId: r.id,
        };
      })
      .filter(Boolean);
  }, [receipts, receiptUrls, lines]);

  const openLightbox = (receiptId) => {
    const i = lightboxItems.findIndex((it) => it.receiptId === receiptId);
    if (i >= 0) setLightboxIdx(i);
  };

  async function mutate(fn) {
    setActionError(null);
    try {
      await fn();
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    }
  }

  const patchLine = (lineId, fields) =>
    mutate(async () => { setBusyLine(lineId); try { await api.patchLine(id, lineId, fields); } finally { setBusyLine(null); } });

  const lineComplete = (l) => {
    const hasReceipt = FLAT_CATEGORIES.has(l.category) || l.receipt_id;
    const net = Number(l.net_amount);
    const codeOk = l.cost_code || (costCodes && !costCodes.error && costCodes.defaults?.[l.category]?.wbs_code_id);
    return hasReceipt && Number.isFinite(net) && net > 0 && codeOk;
  };
  const allComplete = lines.length > 0 && lines.every(lineComplete);

  async function handleApprove() {
    setBusy(true);
    await mutate(() => api.approve(id));
    setBusy(false);
  }
  async function handleDryRun() {
    setBusy(true);
    setActionError(null);
    setDryRun(null);
    try {
      setDryRun(await api.approve(id, { dryRun: true }));
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }
  async function handleReject() {
    const reason = window.prompt("Reason for rejecting this form?");
    if (!reason || !reason.trim()) return;
    setBusy(true);
    await mutate(() => api.reject(id, reason.trim()));
    setBusy(false);
  }
  async function handleDelete() {
    if (!window.confirm(`Permanently delete ${sub.expense_id}? This removes the row, its lines, and the stored files — and frees the Expense ID.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteSubmission(id);
      onChanged?.();
      onClose();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
      setBusy(false);
    }
  }
  async function handleRetryParse() {
    setBusy(true);
    setActionError(null);
    try {
      await api.reparseSubmission(id);
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }
  async function handleAddLine() {
    if (!newLine.category) return;
    setBusy(true);
    await mutate(() => api.addLine(id, newLine));
    setNewLine({ line_date: "", description: "", category: "materials", gross_amount: "" });
    setBusy(false);
  }
  async function handleRetryAttachments() {
    setBusy(true);
    setActionError(null);
    try {
      await api.retryAttachments(id);
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }
  async function handleDeleteReceipt(receiptId) {
    if (!window.confirm("Remove this attachment? Any line matched to it goes back to unmatched.")) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteReceipt(id, receiptId);
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }

  const toggleLineSelected = (lineId) =>
    setSelectedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId); else next.add(lineId);
      return next;
    });
  const allLinesSelected = lines.length > 0 && selectedLineIds.size === lines.length;
  const toggleSelectAllLines = () =>
    setSelectedLineIds(allLinesSelected ? new Set() : new Set(lines.map((l) => l.id)));

  async function handleBulkApplyCostCode() {
    const match = findCodeByText(bulkCostCodeText);
    if (!match) { setActionError(`"${bulkCostCodeText}" doesn't match a cost code for this project.`); return; }
    setBusy(true);
    setActionError(null);
    try {
      await Promise.all([...selectedLineIds].map((lid) => api.patchLine(id, lid, { cost_code: match.id })));
      setSelectedLineIds(new Set());
      setBulkCostCodeText("");
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="empty-state">Loading…</div>;
  if (error)
    return (
      <div>
        <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginBottom: 16 }}>← Back to queue</button>
        <div className="empty-state">
          {error === "not_found" ? "That submission no longer exists." : error}
        </div>
      </div>
    );
  if (!sub) return null;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>← Back to queue</button>
        <button className="btn btn-ghost btn-sm" onClick={load} title="Refresh">↻ Refresh</button>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div className="expense-id-heading">
              <EditableText value={sub.expense_id} disabled={!actionable}
                onSave={(v) => v && mutate(() => api.patchSubmission(id, { expense_id: v }))} />
            </div>
            <div style={{ fontSize: 17, marginTop: 6 }}>
              <EditableText value={sub.employee_name} placeholder="(no employee)" disabled={!actionable}
                onSave={(v) => mutate(() => api.patchSubmission(id, { employee_name: v }))} />
            </div>
            <div className="row-secondary" style={{ marginTop: 4 }}>
              <EditableText value={sub.project_number} placeholder="(no project #)" disabled={!actionable}
                onSave={(v) => mutate(() => api.patchSubmission(id, { project_number: v }))} />
              {" · "}
              {sub.project_name || (sub.project_number ? "not in cache" : "")}
              {sub.province ? ` · ${sub.province}` : ""}
              {sub.employee_email ? ` · ${sub.employee_email}` : ""}
            </div>
          </div>
          <span className={`badge badge-${sub.status}`}>{sub.status.replace("_", " ")}</span>
        </div>
      </div>

      {sub.flags?.some((f) => f.code === "parsing") && (
        <div className="card" style={{ color: "var(--yellow)" }}>
          Still reading the form and receipts in the background — <button className="btn btn-ghost btn-sm" onClick={load}>refresh</button> in a minute to see the lines.
        </div>
      )}

      {sub.flags?.some((f) => PARSE_FAILURE_FLAGS.has(f.code)) && (
        <div className="card" style={{ color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span>Automatic parsing didn't finish (often a temporary API issue) — the original form and receipts are still saved.</span>
          <button className="btn btn-ghost btn-sm" onClick={handleRetryParse} disabled={busy}>
            {busy ? "Retrying…" : "↻ Retry parse"}
          </button>
        </div>
      )}

      {sub.flags?.length > 0 && (
        <div className="card">
          <div className="card-title">Form flags</div>
          <FlagList flags={sub.flags} />
        </div>
      )}

      {costCodes && !costCodes.error && (
        <datalist id="cost-code-options">
          {(costCodes.codes || []).map((c) => (
            <option key={c.id} value={c.code}>{c.description}</option>
          ))}
        </datalist>
      )}
      {costCodes && !costCodes.error && (
        <datalist id="tax-code-options">
          {(costCodes.tax_codes || []).map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      )}

      <div className="card">
        <div className="card-title">Lines</div>

        {actionable && selectedLineIds.size > 0 && (
          <div className="bulk-action-bar">
            <span className="row-secondary">{selectedLineIds.size} selected</span>
            <input list="cost-code-options" placeholder="Cost code…" value={bulkCostCodeText}
              onChange={(e) => setBulkCostCodeText(e.target.value)} style={{ minWidth: 220 }} />
            <button className="btn btn-ghost btn-sm" disabled={busy || !bulkCostCodeText.trim()} onClick={handleBulkApplyCostCode}>
              Apply to {selectedLineIds.size} selected
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedLineIds(new Set())}>Clear</button>
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table className="lines-table">
            <thead>
              <tr>
                <th>{actionable && (
                  <input type="checkbox" checked={allLinesSelected} onChange={toggleSelectAllLines}
                    aria-label="Select all lines" />
                )}</th>
                <th>Date</th><th>Description</th><th>Category</th><th>Gross</th>
                <th>Receipt</th><th>Net</th><th>Cost code</th><th>Tax code</th><th>Flags</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const flat = FLAT_CATEGORIES.has(l.category);
                const matched = l.receipt_id ? receiptById[l.receipt_id] : null;
                const codeDefault = costCodes && !costCodes.error ? costCodes.defaults?.[l.category]?.wbs_code_id || "" : "";
                const codeText = codeLabelById[l.cost_code] || codeLabelById[codeDefault] || "";
                const taxCodeDefault = costCodes?.default_tax_code_id ? String(costCodes.default_tax_code_id) : "";
                const taxCodeText = taxCodeLabelById[l.tax_code] || taxCodeLabelById[taxCodeDefault] || "";
                return (
                  <tr key={l.id} className={busyLine === l.id ? "row-busy" : ""}>
                    <td>
                      {actionable && (
                        <input type="checkbox" checked={selectedLineIds.has(l.id)}
                          onChange={() => toggleLineSelected(l.id)} aria-label={`Select line ${l.row_index ?? ""}`} />
                      )}
                    </td>
                    <td>
                      <input type="date" defaultValue={dateOnly(l.line_date)} disabled={!actionable}
                        onBlur={(e) => e.target.value !== dateOnly(l.line_date) && patchLine(l.id, { line_date: e.target.value })} />
                    </td>
                    <td>
                      <input defaultValue={l.description || ""} disabled={!actionable}
                        onBlur={(e) => e.target.value !== (l.description || "") && patchLine(l.id, { description: e.target.value })} />
                    </td>
                    <td>
                      <select value={l.category} disabled={!actionable} onChange={(e) => patchLine(l.id, { category: e.target.value })}>
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
                      </select>
                    </td>
                    <td>
                      <input type="number" step="0.01" defaultValue={l.gross_amount ?? ""} disabled={!actionable}
                        onBlur={(e) => String(e.target.value) !== String(l.gross_amount ?? "") && patchLine(l.id, { gross_amount: e.target.value })} />
                    </td>
                    <td>
                      {flat ? (
                        <span className="row-secondary">— flat claim</span>
                      ) : matched ? (
                        <span className="receipt-chip">
                          {receiptUrls[matched.r2_key]?.url && (
                            <button type="button" className="receipt-chip-img" title="Open receipt"
                              onClick={() => openLightbox(matched.id)}>
                              <img src={receiptUrls[matched.r2_key].url} alt="" />
                            </button>
                          )}
                          <span>{matched.vendor || "receipt"} · {money(matched.gross)}</span>
                          {actionable && (
                            <button className="chip-x" title="Unmatch"
                              onClick={() => mutate(() => api.unmatchLine(id, l.id))}>×</button>
                          )}
                        </span>
                      ) : (
                        <select defaultValue="" disabled={!actionable}
                          onChange={(e) => e.target.value && mutate(() => api.matchLine(id, l.id, e.target.value))}>
                          <option value="">— match a receipt —</option>
                          {pickableReceipts.map((r) => {
                            const usedOn = linesForReceipt(r.id);
                            return (
                              <option key={r.id} value={r.id}>
                                {r.vendor || "receipt"} · {money(r.gross)}
                                {usedOn.length ? ` (also line ${usedOn.map((x) => x.row_index).join(", ")})` : ""}
                              </option>
                            );
                          })}
                        </select>
                      )}
                    </td>
                    <td>
                      <input type="number" step="0.01" defaultValue={l.net_amount ?? ""} disabled={!actionable}
                        onBlur={(e) => String(e.target.value) !== String(l.net_amount ?? "") && patchLine(l.id, { net_amount: e.target.value })} />
                    </td>
                    <td>
                      {costCodes && costCodes.error ? (
                        <span className="row-secondary" style={{ color: "var(--yellow)" }}>codes unavailable</span>
                      ) : (
                        <input list="cost-code-options" defaultValue={codeText} disabled={!actionable}
                          placeholder="Search codes…"
                          onBlur={(e) => {
                            const text = e.target.value.trim();
                            if (!text) { if (l.cost_code) patchLine(l.id, { cost_code: "" }); return; }
                            const match = findCodeByText(text);
                            if (match && match.id !== (l.cost_code || codeDefault)) patchLine(l.id, { cost_code: match.id });
                          }} />
                      )}
                    </td>
                    <td>
                      <input list="tax-code-options" defaultValue={taxCodeText} disabled={!actionable}
                        placeholder="Auto (province)"
                        onBlur={(e) => {
                          const text = e.target.value.trim();
                          if (!text) { if (l.tax_code) patchLine(l.id, { tax_code: "" }); return; }
                          const match = findTaxCodeByText(text);
                          if (match && String(match.id) !== (l.tax_code || taxCodeDefault)) patchLine(l.id, { tax_code: String(match.id) });
                        }} />
                    </td>
                    <td className="line-flags-cell">
                      {(l.flags || []).map((f, i) => (
                        <span key={i} className={`flag-pill flag-${f.severity || "low"}`} title={f.detail}>
                          {FLAG_LABELS[f.code] || f.code}
                        </span>
                      ))}
                    </td>
                    <td>
                      {actionable && (
                        <button className="chip-x" title="Delete line" onClick={() => mutate(() => api.deleteLine(id, l.id))}>×</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {lines.length === 0 && (
                <tr><td colSpan={11} className="row-secondary" style={{ padding: 12 }}>No lines yet — add them below.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {actionable && (
          <div className="add-line-row">
            <input type="date" value={newLine.line_date} onChange={(e) => setNewLine({ ...newLine, line_date: e.target.value })} />
            <input placeholder="Description" value={newLine.description} onChange={(e) => setNewLine({ ...newLine, description: e.target.value })} />
            <select value={newLine.category} onChange={(e) => setNewLine({ ...newLine, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
            </select>
            <input type="number" step="0.01" placeholder="Gross" value={newLine.gross_amount}
              onChange={(e) => setNewLine({ ...newLine, gross_amount: e.target.value })} />
            <button className="btn btn-ghost btn-sm" onClick={handleAddLine} disabled={busy}>+ Add line</button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Attachments</div>
        <div className="receipt-strip">
          {formDoc && (
            <button type="button" className="receipt-thumb is-form" onClick={() => openLightbox(formDoc.id)}
              disabled={!receiptUrls[formDoc.r2_key]?.url}>
              FORM
            </button>
          )}
          {receipts.filter((r) => r.kind === "receipt").map((r) => {
            const forLines = linesForReceipt(r.id);
            const label = (
              <span className="receipt-thumb-label">
                {money(r.gross)}{forLines.length ? ` → line ${forLines.map((l) => l.row_index).join(", ")}` : ""}
              </span>
            );
            return (
              <div className="receipt-thumb-wrap" key={r.id}>
                {receiptUrls[r.r2_key]?.url ? (
                  <button type="button" className={`receipt-thumb ${forLines.length ? "is-matched" : "is-unmatched"}`}
                    onClick={() => openLightbox(r.id)} title={r.vendor || "Open receipt"}>
                    <img src={receiptUrls[r.r2_key].url} alt="" />
                    {label}
                  </button>
                ) : (
                  <div className={`receipt-thumb ${forLines.length ? "is-matched" : "is-unmatched"}`} title={`${r.vendor || "receipt"} — didn't load`}>
                    <span>?</span>
                    {label}
                  </div>
                )}
                {actionable && (
                  <button type="button" className="receipt-thumb-delete" title="Remove this attachment"
                    onClick={() => handleDeleteReceipt(r.id)}>×</button>
                )}
              </div>
            );
          })}
          {receipts.length === 0 && <span className="row-secondary">No attachments.</span>}
        </div>
      </div>

      {actionError && <div className="card" style={{ color: "var(--red)" }}>{actionError}</div>}

      <div className="modal-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        {actionable && (
          <>
            <button className="btn btn-orange" disabled={busy || !allComplete} onClick={handleApprove}>
              {busy ? "Working…" : "Approve"}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={handleDryRun}>Preview payload</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setShowRevision(true)}>Request Revision</button>
            <button className="btn btn-danger" disabled={busy} onClick={handleReject}>Reject</button>
          </>
        )}
        <button className="btn btn-danger" disabled={busy} onClick={handleDelete}
          title="Permanently remove this submission and free its Expense ID" style={{ marginLeft: "auto" }}>
          Delete
        </button>
        {actionable && !allComplete && lines.length > 0 && (
          <span className="row-secondary" style={{ alignSelf: "center", width: "100%" }}>
            Every line needs a receipt (or be flat-claim), a net amount, and a cost code.
          </span>
        )}
      </div>

      {dryRun && <DirectCostPreview dryRun={dryRun} sub={sub} costCodes={costCodes} />}

      {sub.procore_direct_cost_id && (
        <div className="row-secondary" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            Procore Direct Cost: {sub.procore_direct_cost_id}
            {" · "}
            <a href={`https://us02.procore.com/${sub.project_procore_id}/project/direct_costs/${sub.procore_direct_cost_id}/edit`}
              target="_blank" rel="noreferrer">open in Procore ↗</a>
          </span>
          {sub.flags?.some((f) => f.code === "attachments_failed") && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={handleRetryAttachments}>
              {busy ? "Retrying…" : "↻ Retry attachments"}
            </button>
          )}
        </div>
      )}

      {showRevision && (
        <RevisionModal
          submission={sub}
          onClose={() => setShowRevision(false)}
          onDone={() => { setShowRevision(false); onChanged?.(); load(); }}
        />
      )}

      {lightboxIdx !== null && lightboxItems[lightboxIdx] && (
        <Suspense fallback={null}>
          <Lightbox
            items={lightboxItems}
            index={lightboxIdx}
            onIndex={setLightboxIdx}
            onClose={() => setLightboxIdx(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
