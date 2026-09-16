// A human-readable mockup of the Direct Cost approve would create — the raw
// dryRun payload is still available underneath for debugging, just collapsed.
const MISC_EMP_VENDOR_NAME = "MISC EMP Expenses";

function money(n, currency = "CAD") {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(num);
  } catch {
    return `$${num.toFixed(2)}`;
  }
}

const stripTag = (s) => (s || "").replace(/\s*\[EXP:[^\]]*\]\s*$/i, "").trim();

export default function DirectCostPreview({ dryRun, sub, costCodes }) {
  const header = dryRun?.header?.data?.item;
  const items = dryRun?.line_items || [];
  if (!header) return null;

  const codeLabel = (wbsId) => {
    const c = costCodes?.codes?.find((c) => c.id === wbsId);
    return c ? `${c.code}${c.description ? ` — ${c.description}` : ""}` : `(code ${wbsId})`;
  };
  const total = items.reduce((s, li) => s + (Number(li.data?.line_item?.unit_cost) || 0), 0);

  return (
    <div className="card dc-preview">
      <div className="card-title">
        Direct Cost preview{!dryRun.direct_cost_verified && " — not yet armed, nothing will be sent"}
      </div>

      <div className="dc-preview-head">
        <div className="kv"><span className="kv-label">Project</span><span className="kv-value">{sub.project_name || sub.project_number || "—"}</span></div>
        <div className="kv"><span className="kv-label">Invoice #</span><span className="kv-value mono">{header.invoice_number}</span></div>
        <div className="kv"><span className="kv-label">Date</span><span className="kv-value">{header.direct_cost_date}</span></div>
        <div className="kv"><span className="kv-label">Vendor</span><span className="kv-value">{MISC_EMP_VENDOR_NAME}</span></div>
        <div className="kv"><span className="kv-label">Terms</span><span className="kv-value">{header.terms || "—"}</span></div>
        <div className="kv"><span className="kv-label">Employee</span>
          <span className="kv-value">{sub.employee_name || "—"}{!dryRun.employeeId && dryRun.employeeIdReason ? " ⚠" : ""}</span>
        </div>
        <div className="kv"><span className="kv-label">Type</span><span className="kv-value" style={{ textTransform: "capitalize" }}>{header.direct_cost_type}</span></div>
        <div className="kv"><span className="kv-label">Tax code</span>
          <span className="kv-value">{dryRun.taxCodeId || "— (none)"}</span>
        </div>
      </div>

      {(dryRun.employeeIdReason || dryRun.taxCodeReason) && (
        <div className="row-secondary" style={{ color: "var(--yellow)", marginBottom: 8 }}>
          {dryRun.employeeIdReason && <div>⚠ {dryRun.employeeIdReason}</div>}
          {dryRun.taxCodeReason && <div>⚠ {dryRun.taxCodeReason}</div>}
        </div>
      )}

      <table className="dc-preview-table">
        <thead>
          <tr><th>#</th><th>Description</th><th>Cost code</th><th style={{ textAlign: "right" }}>Net amount</th></tr>
        </thead>
        <tbody>
          {items.map((li, i) => {
            const d = li.data.line_item;
            return (
              <tr key={i}>
                <td>{li.row}</td>
                <td>{stripTag(d.description)}</td>
                <td>{codeLabel(li.wbs_code_id)}</td>
                <td style={{ textAlign: "right" }} className="mono">{money(d.unit_cost, sub.currency)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} style={{ textAlign: "right", fontWeight: 700 }}>Total</td>
            <td style={{ textAlign: "right", fontWeight: 700 }} className="mono">{money(total, sub.currency)}</td>
          </tr>
        </tfoot>
      </table>

      <details style={{ marginTop: 12 }}>
        <summary className="row-secondary" style={{ cursor: "pointer" }}>Raw payload (debug)</summary>
        <pre style={{ overflowX: "auto", fontSize: 11, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(dryRun, null, 2)}
        </pre>
      </details>
    </div>
  );
}
