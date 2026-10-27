// The back-and-forth about an expense: the approver's revision request, the creator's reply, and so on. It opens by
// itself when someone arrives at an expense that is waiting on THEM (the creator on a sent-back one, the approver on
// a re-submitted one), and it can be reopened from the page. The latest message is the big one; earlier ones follow.

// history -> [{ at, kind: "request" | "reply", name, message }], oldest first
export function revisionThread(history) {
  return (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.type === "revision_requested" || h.type === "revision_reply"))
    .map((h) => ({
      at: h.at,
      kind: h.type === "revision_requested" ? "request" : "reply",
      name: h.name || h.by || "Someone",
      message: h.message || String(h.text || "").replace(/^[^:]*:\s*/, ""),
    }));
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

function Message({ m, big }) {
  const isRequest = m.kind === "request";
  return (
    <div style={{
      border: `1px solid ${isRequest ? "var(--red-border)" : "var(--border-color)"}`,
      background: isRequest ? "var(--red-light)" : "var(--bg-input)",
      borderRadius: "var(--radius-sm)", padding: big ? "14px 16px" : "10px 12px",
    }}>
      <div className="row-secondary" style={{ marginBottom: 6 }}>
        <strong style={{ color: "var(--text-primary)" }}>{m.name}</strong>
        {isRequest ? " asked for a revision" : " replied"} · {when(m.at)}
      </div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: big ? 15 : 13 }}>{m.message}</div>
    </div>
  );
}

export default function RevisionPopup({ thread, expenseId, onClose }) {
  if (!thread.length) return null;
  const latest = thread[thread.length - 1];
  const earlier = thread.slice(0, -1).reverse();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title" style={{ marginBottom: 4 }}>
          {latest.kind === "request" ? "Revision requested" : "Reply to the revision request"}
        </div>
        <p className="row-secondary" style={{ marginBottom: 12 }}>{expenseId}</p>
        <Message m={latest} big />
        {earlier.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="card-title" style={{ fontSize: 10 }}>Earlier in this conversation</div>
            <div style={{ display: "grid", gap: 8, marginTop: 6, maxHeight: 240, overflowY: "auto" }}>
              {earlier.map((m, i) => <Message key={i} m={m} />)}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-orange" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
