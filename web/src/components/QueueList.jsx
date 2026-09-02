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

export default function QueueList({ submissions, loading, onSelect }) {
  if (loading) return <div className="empty-state">Loading…</div>;
  if (!submissions.length) return <div className="empty-state">Nothing here.</div>;

  return (
    <div className="row-list">
      {submissions.map((s) => (
        <div className="row-item" key={s.id} onClick={() => onSelect(s.id)}>
          <div>
            <div className="row-primary">{s.employee_name || s.employee_email || "(unknown employee)"}</div>
            <div className="row-secondary">{s.invoice_number}</div>
          </div>
          <div>
            <div className="row-primary">{s.project_number || "—"}</div>
            <div className="row-secondary">{s.project_name || ""}</div>
          </div>
          <div>
            <div className="row-primary" style={{ textTransform: "capitalize" }}>
              {(s.category || "").replace("_", " ")}
            </div>
            <div className="row-secondary">{s.vendor || (s.is_flat_claim ? "no receipt" : "")}</div>
          </div>
          <div className="row-amount">{formatMoney(s.net_amount, s.currency)}</div>
          <div className="row-flags">
            {s.flags && s.flags.length ? `${s.flags.length} flag${s.flags.length > 1 ? "s" : ""}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
