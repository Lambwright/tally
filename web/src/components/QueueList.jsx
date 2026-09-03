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
      {submissions.map((s) => {
        const flagCount = (s.flags?.length || 0) + (Number(s.line_flag_count) || 0);
        return (
          <div className="row-item" key={s.id} onClick={() => onSelect(s.id)}>
            <div>
              <div className="row-primary">{s.employee_name || s.employee_email || "(unknown employee)"}</div>
              <div className="row-secondary">{s.expense_id}</div>
            </div>
            <div>
              <div className="row-primary">{s.project_number || "—"}</div>
              <div className="row-secondary">{s.project_name || ""}</div>
            </div>
            <div>
              <div className="row-primary">{Number(s.line_count) || 0} line{Number(s.line_count) === 1 ? "" : "s"}</div>
              <div className="row-secondary">{s.province || ""}</div>
            </div>
            <div className="row-amount">{formatMoney(s.net_total, "CAD")}</div>
            <div className="row-flags">{flagCount ? `${flagCount} flag${flagCount > 1 ? "s" : ""}` : ""}</div>
          </div>
        );
      })}
    </div>
  );
}
