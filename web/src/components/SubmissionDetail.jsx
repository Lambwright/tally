import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fetchReceiptObjectUrl } from "../api.js";
import RevisionModal from "./RevisionModal.jsx";
import RevisionPopup, { revisionThread } from "./RevisionPopup.jsx";
import DialogModal from "./DialogModal.jsx";
import Loader, { workingText } from "./Loader.jsx";
import { shownExpenseId, isPendingId } from "../expenseLabel.js";
import EditableText from "./EditableText.jsx";
import DirectCostPreview from "./DirectCostPreview.jsx";
import ParseProgress, { STALL_MS } from "./ParseProgress.jsx";
import SubmitExpenseModal from "./SubmitExpenseModal.jsx";

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
  amount_mismatch: "Amount differs from receipt",
  net_tax_mismatch: "Net + tax ≠ gross",
  low_confidence: "Low extraction confidence",
  geo_mismatch: "Location doesn't match the project",
  attachments_failed: "Some files didn't attach in Procore — attach by hand",
  receipt_shared: "Receipt also backs another line",
  tax_code_unmapped: "No Procore tax code for this province — added without one",
  employee_not_tagged: "Employee not tagged on the Direct Cost",
  duplicate_expense_id: "Duplicate Expense ID — Approve is blocked",
  receipt_override: "Posting without a receipt (waived)",
};

// What a submitter sees instead of the review-queue status names.
const SUBMITTER_STATUS = {
  needs_review: "waiting on approval",
  needs_revision: "sent back",
  approved: "approved",
  rejected: "rejected",
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

// The lines table's columns. `w` is the starting width in px; drag the edge of a header to resize (double-click
// the edge to put one back). Widths are remembered in this browser. The tick box and delete columns are fixed.
const LINE_COLS = [
  { key: "sel", w: 38, fixed: true },
  { key: "date", label: "Date", w: 150 },
  { key: "desc", label: "Description", w: 230 },
  { key: "cat", label: "Category", w: 110 },
  { key: "gross", label: "Gross", w: 90 },
  { key: "receipt", label: "Receipt", w: 180 },
  { key: "net", label: "Net", w: 90 },
  { key: "code", label: "Cost code", w: 170 },
  { key: "tax", label: "Tax code", w: 120 },
  { key: "flags", label: "Flags", w: 170 },
  { key: "del", w: 42, fixed: true },
];
const COLS_KEY = "tally_line_cols_v1";
const MIN_COL = 56;

function useLineColumnWidths() {
  const defaults = useMemo(() => Object.fromEntries(LINE_COLS.map((c) => [c.key, c.w])), []);
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || "{}");
      return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in defaults && Number.isFinite(v) && v >= MIN_COL)) };
    } catch {
      return defaults;
    }
  });
  const save = (next) => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(next)); } catch { /* storage blocked: it just won't be remembered */ }
  };
  const startResize = (key) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[key];
    const move = (ev) => setWidths((w) => ({ ...w, [key]: Math.max(MIN_COL, Math.round(startW + ev.clientX - startX)) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidths((w) => { save(w); return w; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = (key) => setWidths((w) => { const next = { ...w, [key]: defaults[key] }; save(next); return next; });
  return { widths, startResize, reset };
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

export default function SubmissionDetail({ id, onClose, onChanged, me }) {
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
  const [addOpen, setAddOpen] = useState(false);
  const cols = useLineColumnWidths();
  const [showSubmit, setShowSubmit] = useState(false);
  const [showThread, setShowThread] = useState(false);
  const [pushing, setPushing] = useState(false); // Approve is posting to Procore
  const [dialog, setDialog] = useState(null); // TALLY's own confirm / ask-a-reason dialog (see DialogModal)
  const threadAutoShown = useRef(false);
  const [selectedLineIds, setSelectedLineIds] = useState(new Set());
  const [bulkCostCodeText, setBulkCostCodeText] = useState("");

  // quiet = true: a background refresh (polling while it parses) — no loading spinner, no flicker.
  const load = useCallback((quiet) => {
    if (quiet !== true) setLoading(true);
    setError(null);
    api.getSubmission(id)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const sub = data?.submission;
  const parsingFlag = sub?.flags?.find((f) => f.code === "parsing") || null;
  const parseKicked = useRef(false);
  const [parseNow, setParseNow] = useState(Date.now());
  const [parseRestarting, setParseRestarting] = useState(false);

  // A submission that is still "parsing" and not being worked on (an app upload just
  // finished, or a parse that went quiet) is started from here: the request runs the whole
  // parse with no background time cap and the worker reports progress into the flag.
  const startParse = useCallback(() => {
    setParseRestarting(true);
    setActionError(null);
    return api.parsePending(id)
      .then(() => { onChanged?.(); load(true); })
      .catch((e) => setActionError(e.data?.detail || e.message))
      .finally(() => setParseRestarting(false));
  }, [id, load, onChanged]);

  useEffect(() => {
    if (!parsingFlag || parseKicked.current) return;
    const quiet = !parsingFlag.running || Date.now() - Date.parse(parsingFlag.updated_at || "") > STALL_MS;
    if (!quiet) return; // someone (another tab, the email background task) is already on it
    parseKicked.current = true;
    startParse();
  }, [parsingFlag, startParse]);

  // while parsing: refresh the progress every 2.5 s and tick the clock every second
  const isParsing = !!parsingFlag;
  // when a parse finishes cleanly, let the creature hop for a couple of seconds before the card goes
  const wasParsing = useRef(false);
  const [justFinished, setJustFinished] = useState(false);
  const parseFailed = !!sub?.flags?.some((f) => PARSE_FAILURE_FLAGS.has(f.code));
  useEffect(() => {
    if (wasParsing.current && !isParsing && !parseFailed) {
      setJustFinished(true);
      const t = setTimeout(() => setJustFinished(false), 2400);
      wasParsing.current = isParsing;
      return () => clearTimeout(t);
    }
    wasParsing.current = isParsing;
    return undefined;
  }, [isParsing, parseFailed]);
  useEffect(() => {
    if (!isParsing) return;
    const poll = setInterval(() => load(true), 2500);
    const tick = setInterval(() => setParseNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [isParsing, load]);
  const lines = data?.line_items || [];
  const receipts = data?.receipts || [];
  // Submit Expense replaces Approve for the person who made the expense: a draft, or one sent back to them.
  const isCreator = !!sub && !!me?.username && String(sub.created_by || "").toLowerCase() === String(me.username).toLowerCase();
  // A general user can open an expense that is ABOUT them (it came in by email, or someone submitted it for them),
  // but only its creator changes it.
  const viewOnly = !!sub && !!me?.isPmSubmitter && !me?.isReviewer && !isCreator;
  const actionable = sub && sub.status !== "approved" && sub.status !== "rejected" && !viewOnly;
  const canSubmit = !!sub && isCreator && (sub.status === "draft" || sub.status === "needs_revision");
  const canReassign = !!sub && !!me?.isReviewer && sub.status === "needs_review" && (!!sub.approver || isCreator);

  // The revision conversation (requests and replies, oldest first). It pops up by itself for whoever the expense is
  // waiting on: the creator when it was sent back, the approver when it came back re-submitted.
  const thread = useMemo(() => revisionThread(sub?.history), [sub?.history]);
  const sentBackToMe = !!sub && isCreator && sub.status === "needs_revision";
  const resubmittedToMe = !!sub && !!me?.isReviewer && !isCreator && sub.status === "needs_review" && !!sub.resubmitted_at;
  useEffect(() => {
    if (threadAutoShown.current || !thread.length || !(sentBackToMe || resubmittedToMe)) return;
    threadAutoShown.current = true;
    setShowThread(true);
  }, [thread.length, sentBackToMe, resubmittedToMe]);

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
          label: r.kind === "form" ? "Expense form" : `${r.vendor || "Receipt"}${r.note ? ` (${r.note})` : ""}${r.page_start ? ` · p.${r.page_start}${r.page_end > r.page_start ? `–${r.page_end}` : ""}` : ""}${forLines.length ? ` → line ${forLines.map((l) => l.row_index).join(", ")}` : ""}`,
          receiptId: r.id,
          // which pages of a multi-page PDF this receipt is on (null: show the whole file)
          pages: r.page_start ? [r.page_start, r.page_end || r.page_start] : null,
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
    const hasReceipt = FLAT_CATEGORIES.has(l.category) || l.receipt_id || l.receipt_override_by;
    const net = Number(l.net_amount);
    const codeOk = l.cost_code || (costCodes && !costCodes.error && costCodes.defaults?.[l.category]?.wbs_code_id);
    return hasReceipt && Number.isFinite(net) && net > 0 && codeOk;
  };
  const allComplete = lines.length > 0 && lines.every(lineComplete);
  const dupFlag = sub?.flags?.find((f) => f.code === "duplicate_expense_id");
  const needsPmApproval = sub?.origin === "pm_direct" && !me?.isPmApprover;
  // A submitter-only user (a PM sending in their own expense) never reviews:
  // no approve / preview / revision / reject / retry controls, and who it's
  // for stays fixed. The server enforces the same; this just hides what they
  // can't use.
  const isSubmitter = !!me?.isPmSubmitter && !me?.isReviewer;
  // Server-computed: the viewer is the employee on this expense (or its sender),
  // so someone else has to approve it. Enforced server-side; this just explains.
  const selfBlock = data?.self_approval || null;

  async function handleApprove() {
    setBusy(true);
    setPushing(true);
    await mutate(() => api.approve(id));
    setPushing(false);
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
  function handleReject() {
    setDialog({
      title: "Reject this expense",
      body: "Say why. The reason stays on the expense, and the person who made it will see it.",
      reason: { label: "Reason for rejecting", placeholder: "What's wrong with it?" },
      confirmLabel: "Reject expense",
      danger: true,
      run: async (reason) => {
        setBusy(true);
        await mutate(() => api.reject(id, reason));
        setBusy(false);
      },
    });
  }
  function handleDelete() {
    setDialog({
      title: "Delete this expense?",
      body: `This permanently removes ${shownExpenseId(sub)}, its lines and its stored files, and frees its Expense ID. It can't be undone.`,
      confirmLabel: "Delete it",
      danger: true,
      run: async () => {
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
      },
    });
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
  // The approved expense as one PDF: summary table of the lines, then the form and every receipt.
  async function handleExportPdf() {
    setBusy(true);
    setActionError(null);
    try {
      const cc = costCodes && !costCodes.error ? costCodes : await api.getCostCodes(id).catch(() => null); // not loaded once approved
      const codeById = Object.fromEntries((cc?.codes || []).map((c) => [c.id, c.code]));
      const taxById = Object.fromEntries((cc?.tax_codes || []).map((c) => [String(c.id), c.name]));
      const taxDefault = cc?.default_tax_code_id ? String(cc.default_tax_code_id) : "";
      const { buildExpensePdf } = await import("../exportPdf.js"); // pdf-lib is bulky: only load it when asked
      const bytes = await buildExpensePdf({
        sub, lines, receipts,
        labels: {
          costCode: (l) => codeById[l.cost_code] || codeById[cc?.defaults?.[l.category]?.wbs_code_id] || "",
          taxCode: (l) => taxById[l.tax_code] || taxById[taxDefault] || "",
        },
        getFile: async (key) => {
          const r = receiptUrls[key];
          if (!r?.url) return null;
          return { bytes: new Uint8Array(await (await fetch(r.url)).arrayBuffer()), type: r.type };
        },
      });
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(sub.employee_name || "expense").replace(/[^A-Za-z0-9]+/g, "-")}_${isPendingId(sub) ? "pending" : sub.expense_id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setActionError(`Couldn't build the PDF: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }
  async function handleAddLine() {
    if (!newLine.category) return;
    setBusy(true);
    await mutate(() => api.addLine(id, newLine));
    setNewLine({ line_date: "", description: "", category: "materials", gross_amount: "" });
    setAddOpen(false);
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
  async function handleReceiptOverride(line, enable) {
    if (!enable) return mutate(() => api.receiptOverride(id, line.id, enable));
    setDialog({
      title: `Post line ${line.row_index ?? ""} without a receipt?`,
      body: "It posts to Procore with no receipt. This is recorded under your name, and the net is estimated from the claimed amount at the province tax rate.",
      confirmLabel: "Waive the receipt",
      run: () => mutate(() => api.receiptOverride(id, line.id, enable)),
    });
  }
  // Draw the Employee Expense Form again from the lines as they are now (reviewers; only a form TALLY drew).
  async function handleRedrawForm() {
    setBusy(true);
    setActionError(null);
    try {
      await api.redrawForm(id);
      onChanged?.();
      load();
    } catch (e) {
      setActionError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }
  function handleDeleteReceipt(receiptId) {
    setDialog({
      title: "Remove this attachment?",
      body: "Any line matched to it goes back to unmatched.",
      confirmLabel: "Remove it",
      danger: true,
      run: async () => {
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
      },
    });
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

  if (loading) return <div className="empty-state"><Loader size={110} /></div>;
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
              {isPendingId(sub)
                ? <span title="It gets its real Expense ID when it is submitted">{shownExpenseId(sub)}</span>
                : <EditableText value={sub.expense_id} disabled={!actionable || isSubmitter}
                    onSave={(v) => v && mutate(() => api.patchSubmission(id, { expense_id: v }))} />}
            </div>
            <div style={{ fontSize: 17, marginTop: 6 }}>
              <EditableText value={sub.employee_name} placeholder="(no employee)" disabled={!actionable || isSubmitter}
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
          <span className={`badge badge-${sub.status}`}>{isSubmitter ? SUBMITTER_STATUS[sub.status] || sub.status : sub.status.replace("_", " ")}</span>
          {!isSubmitter && sub.origin === "pm_direct" && <span className="badge" title="Submitted directly by the employee, no PDF form">PM</span>}
        </div>
      </div>

      {viewOnly && (
        <div className="card row-secondary">
          This expense is for you, but {sub.created_by ? `${String(sub.created_by).split("@")[0]} submitted it` : "it came in by email"}. You can follow it here; they're the one who changes it.
        </div>
      )}
      {isSubmitter && !viewOnly && (
        <div className="card" style={{ color: sub.status === "approved" ? "var(--green)" : sub.status === "needs_revision" || sub.status === "rejected" ? "var(--red)" : "var(--yellow)" }}>
          {sub.status === "needs_review" && "Submitted — waiting on an admin's approval. Add a line for each expense and attach its receipt."}
          {sub.status === "approved" && "Approved and posted. It can't be changed now."}
          {sub.status === "rejected" && "Rejected."}
          {sub.revision_note && (sub.status === "needs_revision" || sub.status === "rejected") && (
            <div style={{ marginTop: 6 }}>{sub.revision_note}</div>
          )}
        </div>
      )}

      {sub.status === "needs_revision" && (
        <div className="card" style={{ color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span>
            Sent back for a revision{thread.length ? ` by ${[...thread].reverse().find((m) => m.kind === "request")?.name || "the approver"}` : ""}.
            {isCreator ? " Make the changes, then Resubmit Expense and tell them what you did." : ""}
          </span>
          {thread.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setShowThread(true)}>View the message</button>}
        </div>
      )}
      {sub.status === "needs_review" && sub.resubmitted_at && (
        <div className="card" style={{ color: "var(--yellow)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span>Re-submitted after a revision request.</span>
          {thread.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setShowThread(true)}>View the conversation</button>}
        </div>
      )}

      {!parsingFlag && justFinished && <ParseProgress finished />}
      {parsingFlag && (
        <ParseProgress flag={parsingFlag} now={parseNow} restarting={parseRestarting} onRestart={() => { parseKicked.current = true; startParse(); }} />
      )}

      {sub.flags?.some((f) => PARSE_FAILURE_FLAGS.has(f.code) && !(sub.origin === "pm_direct" && f.code === "form_parse_failed")) && (
        <div className="card" style={{ color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span>Automatic parsing didn't finish (often a temporary API issue) — the original form and receipts are still saved.</span>
          {isSubmitter ? (
            <span className="row-secondary">Ask an admin to retry it.</span>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={handleRetryParse} disabled={busy}>
              {busy ? "Retrying…" : "↻ Retry parse"}
            </button>
          )}
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
          <table className="lines-table is-resizable"
            style={{ width: LINE_COLS.reduce((a, c) => a + cols.widths[c.key], 0), minWidth: 0 }}>
            <colgroup>
              {LINE_COLS.map((c) => <col key={c.key} style={{ width: cols.widths[c.key] }} />)}
            </colgroup>
            <thead>
              <tr>
                <th>{actionable && (
                  <input type="checkbox" checked={allLinesSelected} onChange={toggleSelectAllLines}
                    aria-label="Select all lines" />
                )}</th>
                {LINE_COLS.filter((c) => !c.fixed).map((c) => (
                  <th key={c.key}>
                    {c.label}
                    <span className="col-resizer" title="Drag to resize · double-click to reset"
                      onPointerDown={cols.startResize(c.key)} onDoubleClick={() => cols.reset(c.key)} />
                  </th>
                ))}
                <th></th>
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
                        <>
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
                          {l.receipt_override_by ? (
                            <div className="row-secondary" style={{ color: "var(--yellow)", marginTop: 4 }}>
                              No receipt — waived by {l.receipt_override_by}
                              {actionable && me?.canOverrideReceipt && (
                                <button className="chip-x" title="Require a receipt again"
                                  onClick={() => handleReceiptOverride(l, false)}>×</button>
                              )}
                            </div>
                          ) : actionable && me?.canOverrideReceipt ? (
                            <button className="btn btn-ghost btn-sm" style={{ marginTop: 4 }}
                              onClick={() => handleReceiptOverride(l, true)}>Post without receipt</button>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td>
                      <input type="number" step="0.01" defaultValue={l.net_amount ?? ""} disabled={!actionable}
                        title={l.tax_source === "manual" ? "Set by hand — won't be recalculated" : ""}
                        style={l.tax_source === "manual" ? { borderColor: "var(--orange)" } : undefined}
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
                <tr><td colSpan={11} className="row-secondary" style={{ padding: 12 }}>No lines yet — add one below.</td></tr>
              )}
              {actionable && (addOpen ? (
                <tr className="add-line-tr">
                  <td />
                  <td><input type="date" value={newLine.line_date} onChange={(e) => setNewLine({ ...newLine, line_date: e.target.value })} /></td>
                  <td><input placeholder="Description" value={newLine.description} onChange={(e) => setNewLine({ ...newLine, description: e.target.value })} /></td>
                  <td>
                    <select value={newLine.category} onChange={(e) => setNewLine({ ...newLine, category: e.target.value })}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
                    </select>
                  </td>
                  <td><input type="number" step="0.01" placeholder="Gross" value={newLine.gross_amount}
                    onChange={(e) => setNewLine({ ...newLine, gross_amount: e.target.value })} /></td>
                  <td colSpan={6}>
                    <button className="btn btn-ghost btn-sm" onClick={handleAddLine} disabled={busy}>Add line</button>{" "}
                    <button className="btn btn-ghost btn-sm" onClick={() => setAddOpen(false)} disabled={busy}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr className="add-line-tr">
                  <td />
                  <td colSpan={10}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setAddOpen(true)}>+ Add Line Item</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </div>

      <div className="card">
        <div className="card-title">Attachments</div>
        <div className="receipt-strip">
          {formDoc && (
            <button type="button" className="receipt-thumb is-form" onClick={() => openLightbox(formDoc.id)}
              disabled={!receiptUrls[formDoc.r2_key]?.url} title={formDoc.r2_key.split("/").pop()}>
              FORM
              <span className="receipt-thumb-filename">{formDoc.r2_key.split("/").pop()}</span>
            </button>
          )}
          {receipts.filter((r) => r.kind === "receipt").map((r) => {
            const forLines = linesForReceipt(r.id);
            const filename = r.r2_key.split("/").pop();
            const label = (
              <span className="receipt-thumb-label">
                {money(r.gross)}{forLines.length ? ` → line ${forLines.map((l) => l.row_index).join(", ")}` : ""}
                <span className="receipt-thumb-filename">{filename}</span>
              </span>
            );
            return (
              <div className="receipt-thumb-wrap" key={r.id}>
                {receiptUrls[r.r2_key]?.url ? (
                  <button type="button" className={`receipt-thumb ${forLines.length ? "is-matched" : "is-unmatched"}`}
                    onClick={() => openLightbox(r.id)} title={r.vendor ? `${r.vendor}${r.note ? ` (${r.note})` : ""} — ${filename}` : filename}>
                    <img src={receiptUrls[r.r2_key].url} alt="" />
                    {label}
                  </button>
                ) : (
                  <div className={`receipt-thumb ${forLines.length ? "is-matched" : "is-unmatched"}`} title={`${r.vendor || "receipt"} (${filename}) — didn't load`}>
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

      {pushing && (
        <div className="card"><Loader text="Posting to Procore and attaching the files. This can take a minute." size={100} /></div>
      )}
      {actionError && <div className="card" style={{ color: "var(--red)" }}>{actionError}</div>}

      <div className="modal-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        {canSubmit && (
          <>
            <button className="btn btn-orange" disabled={busy || !allComplete || lines.length === 0 || !!parsingFlag || !!dupFlag}
              onClick={() => setShowSubmit(true)}
              title={parsingFlag ? "Claude is still reading the files." : !allComplete ? "Every line needs a receipt (or be flat-claim, or waived) and a net amount first." : undefined}>
              {sub.status === "needs_revision" ? "Resubmit Expense" : "Submit Expense"}
            </button>
            {!allComplete && lines.length > 0 && (
              <span className="row-secondary" style={{ alignSelf: "center" }}>Every line needs a receipt (or flat-claim, or waived) and a net amount first.</span>
            )}
          </>
        )}
        {sub.status === "approved" && (me?.isReviewer || isCreator) && (
          <button className="btn btn-orange" disabled={busy} onClick={handleExportPdf}
            title="One PDF: a table of the lines, the expense form, and every receipt">
            {busy ? "Building PDF…" : "Export PDF"}
          </button>
        )}
        {me?.isReviewer && sub.origin !== "email" && receipts.some((r) => r.kind === "form" && r.note === "Form generated by TALLY") && (
          <button className="btn btn-ghost" disabled={busy} onClick={handleRedrawForm}
            title="Draw the Employee Expense Form again from the lines as they are now">
            ↻ Redraw form
          </button>
        )}
        {canReassign && (
          <button className="btn btn-ghost" disabled={busy} onClick={() => setShowSubmit(true)}>
            {sub.approver ? `Assigned to ${String(sub.approver).split("@")[0].replace(/^./, (c) => c.toUpperCase())} · Change approver` : "Assign approver"}
          </button>
        )}
        {actionable && !isSubmitter && !canSubmit && (
          <>
            <button className="btn btn-orange" disabled={busy || !allComplete || !!dupFlag || needsPmApproval || !!selfBlock || sub.status === "needs_revision"} onClick={handleApprove}
              title={selfBlock ? `You can't approve this one — ${selfBlock}.` : dupFlag ? dupFlag.detail : needsPmApproval ? "Needs an admin's approval first." : undefined}>
              {busy ? workingText() : "Approve"}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={handleDryRun}>Preview payload</button>
            {sub.origin !== "email" && (
              <button className="btn btn-ghost" disabled={busy || sub.status !== "needs_review"} onClick={() => setShowRevision(true)}
                title={sub.status !== "needs_review" ? "Only an expense waiting for review can be sent back." : undefined}>Request Revision</button>
            )}
            <button className="btn btn-danger" disabled={busy} onClick={handleReject}>Reject</button>
          </>
        )}
        {!viewOnly && !(isSubmitter && sub.status === "approved") && (
          <button className="btn btn-danger" disabled={busy} onClick={handleDelete}
            title="Permanently remove this submission and free its Expense ID" style={{ marginLeft: "auto" }}>
            Delete
          </button>
        )}
        {actionable && !isSubmitter && dupFlag && (
          <span className="row-secondary" style={{ alignSelf: "center", width: "100%", color: "var(--red)" }}>
            {dupFlag.detail}
          </span>
        )}
        {actionable && !isSubmitter && selfBlock && (
          <span className="row-secondary" style={{ alignSelf: "center", width: "100%", color: "var(--yellow)" }}>
            You can't approve this one — {selfBlock}. Another admin has to.
          </span>
        )}
        {actionable && !isSubmitter && !dupFlag && !selfBlock && needsPmApproval && allComplete && (
          <span className="row-secondary" style={{ alignSelf: "center", width: "100%", color: "var(--yellow)" }}>
            Waiting on an admin's approval before this can post to Procore.
          </span>
        )}
        {actionable && !isSubmitter && !dupFlag && !allComplete && lines.length > 0 && (
          <span className="row-secondary" style={{ alignSelf: "center", width: "100%" }}>
            Every line needs a receipt (or be flat-claim, or waived), a net amount, and a cost code.
          </span>
        )}
      </div>

      {dryRun && <DirectCostPreview dryRun={dryRun} sub={sub} costCodes={costCodes} />}

      {showSubmit && (
        <SubmitExpenseModal id={id} sub={sub} costCodes={costCodes} resubmit={sub.status === "needs_revision"}
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => { setShowSubmit(false); onChanged?.(); onClose(); }} />
      )}

      {sub.procore_direct_cost_id && (
        <div className="row-secondary" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            Procore Direct Cost: {sub.procore_direct_cost_id}
            {" · "}
            <a href={`https://us02.procore.com/${sub.project_procore_id}/project/direct_costs/${sub.procore_direct_cost_id}/edit`}
              target="_blank" rel="noreferrer">open in Procore ↗</a>
          </span>
          {!isSubmitter && sub.flags?.some((f) => f.code === "attachments_failed") && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={handleRetryAttachments}>
              {busy ? "Retrying…" : "↻ Retry attachments"}
            </button>
          )}
        </div>
      )}

      {thread.length > 0 && (
        <div className="card">
          <div className="card-title">Revision history</div>
          <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
            {thread.map((m, i) => (
              <div key={i}>
                <div className="row-secondary">
                  <strong style={{ color: "var(--text-primary)" }}>{m.name}</strong>{m.kind === "request" ? " asked for a revision" : " replied"} ·{" "}
                  {new Date(m.at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {dialog && <DialogModal dialog={dialog} onClose={() => setDialog(null)} />}

      {showThread && <RevisionPopup thread={thread} expenseId={shownExpenseId(sub)} onClose={() => setShowThread(false)} />}

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
