import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import worker, { _test } from "../src/index.js";

const {
  extractExpenseId,
  readAttachments,
  pageRange,
  dateFromExpenseId,
  buildFormFromTemplate,
  mdy,
  viewerIdentity,
  isAboutViewer,
  handleRequestRevision,
  bumpForm,
  historyEvent,
  chooseExpenseId,
  handleList,
  likePattern,
  attachSubmissionFiles,
  compareCodes,
  expenseIdFor,
  buildExpenseFormPdf,
  refusalCount,
  refusalOutcome,
  visitorHeaders,
  isPickableProject,
  pickApprovers,
  canApprovePortalExpense,
  positiveInt,
  resolveEmployeeId,
  missingLineItems,
  budgetedCodes,
  isoDate,
  procoreFetch,
  resolveWbsFromCodes,
  normalizeCategory,
  salvageByFieldBoundaries,
  matchLinesToReceipts,
  deriveLineNet,
  computeLineFlags,
  computeFormFlags,
  sumTaxLines,
  money,
  normalizeAttachments,
  resolveTier,
  selfApprovalReason,
  canOverrideReceipt,
  submitterDenial,
} = _test;

describe("extractExpenseId", () => {
  it("prefers the form's expense_id field", () => {
    expect(extractExpenseId({ expense_id: "020926-12345-6789", subject: "x" })).toBe("020926-12345-6789");
  });
  it("pulls the DDMMYY-JJJJJ-EEEE token out of the subject", () => {
    expect(extractExpenseId({ subject: "Expense Report 020926-A12B3-0007" })).toBe("020926-A12B3-0007");
  });
  it("falls back to an EXP/INV token", () => {
    expect(extractExpenseId({ subject: "Fwd: expense EXP-4471" })).toBe("EXP-4471");
  });
  it("returns null when there's nothing to find", () => {
    expect(extractExpenseId({ subject: "lunch receipts" })).toBeNull();
  });
});

describe("normalizeCategory", () => {
  it("passes through the form's column names", () => {
    for (const c of ["parking", "materials", "fuel", "mileage", "per_diem", "other"]) {
      expect(normalizeCategory(c)).toBe(c);
    }
  });
  it("folds synonyms and unknowns", () => {
    expect(normalizeCategory("Gas")).toBe("fuel");
    expect(normalizeCategory("Material")).toBe("materials");
    expect(normalizeCategory("Per Diem")).toBe("per_diem");
    expect(normalizeCategory("labour")).toBe("other");
    expect(normalizeCategory("")).toBe("other");
  });
});

describe("money", () => {
  it("parses currency strings; rejects non-numbers", () => {
    expect(money("$1,234.56")).toBe(1234.56);
    expect(money("42")).toBe(42);
    expect(money("")).toBeNull();
    expect(money(null)).toBeNull();
    expect(money("abc")).toBeNull();
  });
});

describe("sumTaxLines", () => {
  it("adds to the cent", () => {
    expect(sumTaxLines([{ label: "GST", amount: 5 }, { label: "QST", amount: 9.98 }])).toBe(14.98);
    expect(sumTaxLines([])).toBe(0);
    expect(sumTaxLines(undefined)).toBe(0);
  });
});

describe("normalizeAttachments", () => {
  it("handles Power Automate's contentBytes shape", () => {
    const out = normalizeAttachments({
      attachments: [{ name: "form.pdf", contentType: "application/pdf", contentBytes: "AAAA" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].base64).toBe("AAAA");
    expect(out[0].name).toBe("form.pdf");
  });
  it("drops empty attachments", () => {
    expect(normalizeAttachments({ attachment: { name: "x", contentBytes: "" } })).toHaveLength(0);
  });

  // ~N bytes of base64 — exact count doesn't matter, just clearly above/below a threshold.
  const fakeB64 = (bytes) => "A".repeat(Math.ceil(bytes / 3) * 4);

  it("drops Outlook's auto-named inline signature/logo graphics", () => {
    const out = normalizeAttachments({
      attachments: [
        { name: "image001.png", contentType: "image/png", contentBytes: fakeB64(5 * 1024) },
        { name: "IMG_20260908_171117.jpg", contentType: "image/jpeg", contentBytes: fakeB64(500 * 1024) },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("IMG_20260908_171117.jpg");
  });

  it("drops anything explicitly flagged inline, regardless of size", () => {
    const out = normalizeAttachments({
      attachments: [{ name: "receipt.jpg", contentType: "image/jpeg", contentBytes: fakeB64(500 * 1024), isInline: true }],
    });
    expect(out).toHaveLength(0);
  });

  it("drops tiny images outright and small PNGs, keeps a real form PDF near that size", () => {
    const out = normalizeAttachments({
      attachments: [
        { name: "tiny.jpg", contentType: "image/jpeg", contentBytes: fakeB64(2 * 1024) },
        { name: "logo.png", contentType: "image/png", contentBytes: fakeB64(40 * 1024) },
        { name: "expense-form.pdf", contentType: "application/pdf", contentBytes: fakeB64(175 * 1024) },
      ],
    });
    expect(out.map((a) => a.name)).toEqual(["expense-form.pdf"]);
  });
});

describe("matchLinesToReceipts", () => {
  const line = (row, over = {}) => ({
    row_index: row, category: "materials", is_flat_claim: false,
    gross_amount: 113, description: "Home Depot", line_date: "2026-09-01", ...over,
  });
  const rcpt = (id, idx, over = {}) => ({
    id, idx, vendor: "THE HOME DEPOT #7024", gross: 113, receipt_date: "2026-09-01",
    subtotal: 100, tax_json: [{ label: "HST", amount: 13 }], ...over,
  });

  it("locks an amount + vendor match", () => {
    const m = matchLinesToReceipts([line(1)], [rcpt("r1", 0)]);
    expect(m.get(1).receipt_id).toBe("r1");
    expect(m.get(1).method).toBe("auto");
    expect(m.get(1).flag).toBeNull();
  });

  it("amount-only with a single candidate -> low_confidence_match", () => {
    const m = matchLinesToReceipts(
      [line(1, { description: "supplies" })],
      [rcpt("r1", 0, { vendor: "STAPLES", receipt_date: "2026-01-01" })]
    );
    expect(m.get(1).receipt_id).toBe("r1");
    expect(m.get(1).flag.code).toBe("low_confidence_match");
  });

  it("amount collision with no corroboration -> ambiguous, unmatched", () => {
    const m = matchLinesToReceipts(
      [line(1, { description: "supplies" })],
      [rcpt("r1", 0, { vendor: "A", receipt_date: "2026-01-01" }), rcpt("r2", 1, { vendor: "B", receipt_date: "2026-01-02" })]
    );
    expect(m.get(1).receipt_id).toBeNull();
    expect(m.get(1).flag.code).toBe("ambiguous_match");
  });

  it("flat-claim lines are never matched", () => {
    const m = matchLinesToReceipts(
      [line(1, { category: "per_diem", is_flat_claim: true, gross_amount: 75 })],
      [rcpt("r1", 0, { gross: 75 })]
    );
    expect(m.has(1)).toBe(false);
  });

  it("no amount match -> line left absent (caller flags receipt_unmatched)", () => {
    const m = matchLinesToReceipts([line(1, { gross_amount: 999 })], [rcpt("r1", 0)]);
    expect(m.has(1)).toBe(false);
  });
});

describe("deriveLineNet", () => {
  it("flat claim: net = gross, no tax", () => {
    expect(deriveLineNet({ is_flat_claim: true, gross_amount: 75 }, null, "ON")).toEqual({ net: 75, tax: 0, tax_source: "none" });
  });
  it("no receipt: net null", () => {
    expect(deriveLineNet({ is_flat_claim: false, gross_amount: 100 }, null, "ON")).toEqual({ net: null, tax: null, tax_source: "none" });
  });
  it("no receipt but waived by an override user: province-rate estimate off the claimed gross", () => {
    const d = deriveLineNet({ is_flat_claim: false, gross_amount: 113, category: "materials", receipt_override_by: "leela@einbau.ca" }, null, "ON");
    expect(d.tax_source).toBe("fallback_table");
    expect(d.net).toBeCloseTo(100, 1);
    expect(d.tax).toBeCloseTo(13, 1);
  });
  it("waived line with no province or no gross: still null, never a guess", () => {
    expect(deriveLineNet({ is_flat_claim: false, gross_amount: 113, receipt_override_by: "leela@einbau.ca" }, null, null).net).toBeNull();
    expect(deriveLineNet({ is_flat_claim: false, gross_amount: null, receipt_override_by: "leela@einbau.ca" }, null, "ON").net).toBeNull();
  });
  it("receipt with printed tax: net = subtotal, source read", () => {
    const d = deriveLineNet(
      { is_flat_claim: false, gross_amount: 113 },
      { gross: 113, subtotal: 100, tax_json: [{ label: "HST", amount: 13 }] },
      "ON"
    );
    expect(d).toEqual({ net: 100, tax: 13, tax_source: "read" });
  });
  it("receipt with no itemized tax: province fallback, flagged as such", () => {
    const d = deriveLineNet(
      { is_flat_claim: false, gross_amount: 113 },
      { gross: 113, subtotal: null, tax_json: [] },
      "ON"
    );
    expect(d.tax_source).toBe("fallback_table");
    expect(d.net).toBeCloseTo(100, 1);
  });
  it("receipt unreadable + no province: net null", () => {
    const d = deriveLineNet({ is_flat_claim: false, gross_amount: 50 }, { gross: null, subtotal: null, tax_json: [] }, null);
    expect(d).toEqual({ net: null, tax: null, tax_source: "none" });
  });

  it("shared receipt: ignores the receipt's combined total, estimates from this line's own amount", () => {
    // One photo of $66.50 gas + $16.81 parking (combined receipt total $83.31,
    // $10.81 tax) backing two different lines — neither line's own amount
    // equals the receipt's total, and trusting the receipt's read tax/subtotal
    // for both would double count it.
    const receipt = { gross: 83.31, subtotal: 72.5, tax_json: [{ label: "HST", amount: 10.81 }] };
    const gasLine = deriveLineNet({ is_flat_claim: false, gross_amount: 66.5 }, receipt, "ON", { shared: true });
    const parkingLine = deriveLineNet({ is_flat_claim: false, gross_amount: 16.81 }, receipt, "ON", { shared: true });
    expect(gasLine.tax_source).toBe("fallback_table");
    expect(parkingLine.tax_source).toBe("fallback_table");
    expect(gasLine.net).toBeLessThan(66.5);
    expect(parkingLine.net).toBeLessThan(16.81);
    // Not shared -> the old (wrong) behaviour of applying the whole receipt to one line.
    const solo = deriveLineNet({ is_flat_claim: false, gross_amount: 66.5 }, receipt, "ON", { shared: false });
    expect(solo.net).toBe(72.5);
  });
});

describe("computeLineFlags", () => {
  const project = { stage: "Construction", active: true, province: "ON" };

  it("clean matched line: no flags", () => {
    const line = { category: "materials", is_flat_claim: false, receipt_id: "r1", gross_amount: 113, net_amount: 100, tax_amount: 13, tax_source: "read" };
    const receipt = { gross: 113, confidence: 0.95 };
    expect(computeLineFlags(line, receipt, "ON", project)).toEqual([]);
  });
  it("unmatched non-flat line -> receipt_unmatched", () => {
    const line = { category: "materials", is_flat_claim: false, receipt_id: null };
    expect(computeLineFlags(line, null, "ON", project).map((f) => f.code)).toContain("receipt_unmatched");
  });
  it("waived line: receipt_override instead of receipt_unmatched, plus tax_estimated", () => {
    const line = { category: "materials", is_flat_claim: false, receipt_id: null, receipt_override_by: "leela@einbau.ca", tax_source: "fallback_table", gross_amount: 113, net_amount: 100, tax_amount: 13 };
    const codes = computeLineFlags(line, null, "ON", project).map((f) => f.code);
    expect(codes).toContain("receipt_override");
    expect(codes).toContain("tax_estimated");
    expect(codes).not.toContain("receipt_unmatched");
  });
  it("fallback tax -> tax_estimated", () => {
    const line = { category: "materials", is_flat_claim: false, receipt_id: "r1", tax_source: "fallback_table", gross_amount: 113, net_amount: 100, tax_amount: 13 };
    expect(computeLineFlags(line, { gross: 113 }, "ON", project).map((f) => f.code)).toContain("tax_estimated");
  });
  it("form line vs receipt total mismatch", () => {
    const line = { category: "materials", is_flat_claim: false, receipt_id: "r1", tax_source: "read", gross_amount: 113, net_amount: 100, tax_amount: 13 };
    expect(computeLineFlags(line, { gross: 120 }, "ON", project).map((f) => f.code)).toContain("amount_mismatch");
  });
  it("geo mismatch only for site-tied categories", () => {
    const fuel = { category: "fuel", is_flat_claim: false, receipt_id: "r1", tax_source: "read" };
    expect(computeLineFlags(fuel, { gross: 50 }, "QC", project).map((f) => f.code)).toContain("geo_mismatch");
    const materials = { category: "materials", is_flat_claim: false, receipt_id: "r1", tax_source: "read" };
    expect(computeLineFlags(materials, { gross: 50 }, "QC", project).map((f) => f.code)).not.toContain("geo_mismatch");
  });
  it("flat-claim line skips receipt-only checks", () => {
    const line = { category: "per_diem", is_flat_claim: true, receipt_id: null, tax_source: "none" };
    const codes = computeLineFlags(line, null, "ON", project).map((f) => f.code);
    expect(codes).not.toContain("receipt_unmatched");
    expect(codes).not.toContain("tax_unknown");
  });

  it("shared receipt gets an informational flag, not receipt_unmatched", () => {
    const line = { category: "fuel", is_flat_claim: false, receipt_id: "r1", tax_source: "fallback_table", gross_amount: 66.5, net_amount: 58, tax_amount: 8.5 };
    const codes = computeLineFlags(line, { gross: 83.31 }, "ON", project, { shared: true }).map((f) => f.code);
    expect(codes).toContain("receipt_shared");
    expect(codes).toContain("tax_estimated");
    expect(codes).not.toContain("receipt_unmatched");
  });
});

describe("computeFormFlags", () => {
  const sub = { project_number: "2026_0300" };
  const project = { stage: "Construction", active: true, province: "ON" };

  it("clean form: no flags", () => {
    expect(computeFormFlags(sub, project, [{ id: "r1", kind: "receipt" }], [{ receipt_id: "r1" }])).toEqual([]);
  });
  it("no lines -> form_parse_failed", () => {
    expect(computeFormFlags(sub, project, [], []).map((f) => f.code)).toContain("form_parse_failed");
  });
  it("unmatched receipt -> receipt_orphan", () => {
    const f = computeFormFlags(sub, project, [{ id: "r1", kind: "receipt" }, { id: "r2", kind: "receipt" }], [{ receipt_id: "r1" }]);
    expect(f.map((x) => x.code)).toContain("receipt_orphan");
  });
  it("inactive project", () => {
    const f = computeFormFlags(sub, { stage: "Cancelled", active: false, province: "ON" }, [], [{ receipt_id: "r1" }]);
    expect(f.map((x) => x.code)).toContain("project_inactive");
  });
  it("project not in cache", () => {
    expect(computeFormFlags(sub, null, [], [{ receipt_id: "r1" }]).map((x) => x.code)).toContain("project_invalid");
  });
});

describe("salvageByFieldBoundaries", () => {
  it("recovers fields from a body with unescaped HTML", () => {
    const raw = '{"subject":"Expense 020926-12345-6789","from":"joe@einbau.ca","body":"<div class="x">hi "there"</div>"}';
    const out = salvageByFieldBoundaries(raw);
    expect(out.subject).toBe("Expense 020926-12345-6789");
    expect(out.from).toBe("joe@einbau.ca");
  });
});

describe("resolveTier (appRoles.TALLY, everything from HELM)", () => {
  const user = (username, appRoles, apps = ["TALLY"]) => ({ username, apps, appRoles });

  it("admin: reviewer + approver, not a scoped submitter", () => {
    expect(resolveTier(user("anyone", { TALLY: "admin" }))).toMatchObject({ ok: true, isReviewer: true, isPmApprover: true, isPmSubmitter: false });
  });
  it("submitter: scoped to own submissions, can't approve", () => {
    expect(resolveTier(user("josh@einbau.ca", { TALLY: "submitter" }))).toMatchObject({ ok: true, isReviewer: false, isPmApprover: false, isPmSubmitter: true });
  });
  it("the level decides, not the username", () => {
    expect(resolveTier(user("ben@einbau.ca", { TALLY: "submitter" })).isReviewer).toBe(false);
    expect(resolveTier(user("newadmin", { TALLY: "admin" })).isReviewer).toBe(true);
  });
  it("'access' (HELM switch off in the old days), no_access, missing key or appRoles, or an unrecognised level: denied 403", () => {
    for (const roles of [{ TALLY: "access" }, { TALLY: "no_access" }, {}, undefined, null, { TALLY: "superuser" }, { TALLY: "" }]) {
      expect(resolveTier(user("ben@einbau.ca", roles))).toMatchObject({ ok: false, status: 403 });
    }
  });
  it("apps fails closed: missing / non-array / without TALLY is denied even with an admin level", () => {
    expect(resolveTier({ username: "ben", appRoles: { TALLY: "admin" } }).ok).toBe(false);
    expect(resolveTier({ username: "ben", apps: "TALLY", appRoles: { TALLY: "admin" } }).ok).toBe(false);
    expect(resolveTier(user("ben", { TALLY: "admin" }, ["HANDOFF"])).ok).toBe(false);
  });
});

describe("selfApprovalReason", () => {
  const ben = { username: "ben", displayName: "Ben Wright", firstName: "Ben", lastName: "Wright", email: "ben@einbau.ca" };

  it("an email address never blocks anyone: the sender's address (employee_email) is ignored", () => {
    expect(selfApprovalReason(ben, { employee_email: "ben@einbau.ca", employee_name: "Mike Sefeldas" })).toBeNull();
    expect(selfApprovalReason({ username: "leela@einbau.ca", displayName: "Leela" }, { employee_email: "leela@einbau.ca", employee_name: "Mike Sefeldas" })).toBeNull();
  });
  it("(a) the name Claude read off the form is the approver's, even if it was renamed since", () => {
    expect(selfApprovalReason(ben, { form_employee_name: "ben  wright", employee_name: "Mike Sefeldas" })).toMatch(/form/);
  });
  it("(b) the employee name the push would use is the approver's", () => {
    expect(selfApprovalReason(ben, { employee_name: "BEN WRIGHT" })).toMatch(/expense/);
    // also "firstName lastName" when displayName is something else
    expect(selfApprovalReason({ ...ben, displayName: "Benny" }, { employee_name: "Ben Wright" })).toMatch(/expense/);
  });
  it("someone else's expense is not blocked, and blanks never match blanks", () => {
    expect(selfApprovalReason(ben, { employee_name: "Mike Sefeldas", employee_email: "mike@einbau.ca", form_employee_name: "Mike Sefeldas" })).toBeNull();
    expect(selfApprovalReason({ username: "x" }, { employee_name: "", employee_email: "", form_employee_name: null })).toBeNull();
  });
});

describe("canOverrideReceipt (HELM tool permission receipt_override)", () => {
  const withExtra = { username: "leela@einbau.ca", appExtras: { TALLY: ["receipt_override"] } };
  it("TALLY admin with the receipt_override extra: allowed", () => {
    expect(canOverrideReceipt(withExtra, "admin")).toBe(true);
  });
  it("TALLY admin without the extra: denied (Ben can approve a waived line but not waive one)", () => {
    expect(canOverrideReceipt({ username: "ben", appExtras: { TALLY: [] } }, "admin")).toBe(false);
    expect(canOverrideReceipt({ username: "ben", appExtras: {} }, "admin")).toBe(false);
  });
  it("a submitter holding the extra: denied", () => {
    expect(canOverrideReceipt(withExtra, "submitter")).toBe(false);
  });
  it("Live switch off (access), no level or unknown level: denied", () => {
    expect(canOverrideReceipt(withExtra, "access")).toBe(false);
    expect(canOverrideReceipt(withExtra, undefined)).toBe(false);
    expect(canOverrideReceipt(withExtra, "no_access")).toBe(false);
  });
  it("missing or malformed appExtras fail closed", () => {
    for (const appExtras of [undefined, null, "receipt_override", ["receipt_override"], { TALLY: "receipt_override" }, { TALLY: null }, { OTHER: ["receipt_override"] }]) {
      expect(canOverrideReceipt({ username: "x", appExtras }, "admin")).toBe(false);
    }
    expect(canOverrideReceipt(null, "admin")).toBe(false);
    expect(canOverrideReceipt(undefined, "admin")).toBe(false);
  });
});
describe("submitterDenial", () => {
  it("review and Procore-writing actions are admin-only for a submitter", () => {
    for (const seg of ["approve", "reject", "request-revision", "reparse", "retry-attachments"]) {
      expect(submitterDenial("POST", seg, "needs_review")).toMatchObject({ status: 403 });
    }
  });
  it("their own editing is allowed while it's not approved", () => {
    expect(submitterDenial("PATCH", undefined, "needs_review")).toBeNull();
    expect(submitterDenial("POST", "lines", "needs_revision")).toBeNull();
    expect(submitterDenial("DELETE", undefined, "rejected")).toBeNull();
    expect(submitterDenial("GET", undefined, "approved")).toBeNull();
  });
  it("an approved expense is frozen for them (reads still work)", () => {
    expect(submitterDenial("PATCH", undefined, "approved")).toMatchObject({ status: 409 });
    expect(submitterDenial("DELETE", undefined, "approved")).toMatchObject({ status: 409 });
    expect(submitterDenial("POST", "lines", "approved")).toMatchObject({ status: 409 });
  });
});

describe("readAttachments (one reader for every entry style)", () => {
  const att = () => ({ contentType: "application/pdf", base64: "QQ==" });
  const reply = (obj) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }] }) });
  const env = { ANTHROPIC_API_KEY: "sk-ant-x" };
  const withFetch = async (fn, body) => {
    const real = globalThis.fetch;
    globalThis.fetch = fn;
    try { return await body(); } finally { globalThis.fetch = real; }
  };

  it("keeps several receipts found in one file as separate receipts", async () => {
    await withFetch(async () => reply({
      form: null,
      receipts: [
        { file: 0, label: "1 of 3", vendor: "Green P", gross: 12 },
        { file: 0, label: "2 of 3", vendor: "Green P", gross: 9 },
        { file: 0, label: "3 of 3", vendor: "Impark", gross: 7 },
      ],
    }), async () => {
      const out = await readAttachments(env, [att()]);
      expect(out.form).toBeNull();
      expect(out.receipts.map((r) => r.gross)).toEqual([12, 9, 7]);
      expect(out.receipts.every((r) => r.file === 0)).toBe(true);
    });
  });

  it("reads more files than one call takes in batches, with global file numbers", async () => {
    let calls = 0;
    await withFetch(async () => {
      calls += 1;
      // every batch answers with a receipt in its own local file 1
      return reply({ form: null, receipts: [{ file: 1, vendor: "v" + calls, gross: calls }] });
    }, async () => {
      const out = await readAttachments(env, [att(), att(), att(), att(), att()]);
      expect(calls).toBe(2); // 5 files -> batches of 3 + 2
      expect(out.receipts.map((r) => r.file).sort()).toEqual([1, 4]);
    });
  });

  it("form + receipts in separate batches: the form is kept and matched from text", async () => {
    let calls = 0;
    await withFetch(async (_url, init) => {
      calls += 1;
      const text = JSON.parse(init.body).messages[0].content.map((c) => c.text || "").join(" ");
      if (text.includes("FORM ROWS:")) return reply({ matches: [{ row: 2, receipt_index: 0, confidence: 0.9 }] });
      if (text.includes("FILE 0:") && calls === 1) {
        return reply({ form: { file: 0, expense_id: "X", line_items: [{ row: 1, gross: 5 }, { row: 2, gross: 20 }] }, receipts: [] });
      }
      return reply({ form: null, receipts: [{ file: 0, vendor: "Shell", gross: 20 }] });
    }, async () => {
      const out = await readAttachments(env, [att(), att(), att(), att()]);
      expect(out.form.expense_id).toBe("X");
      expect(out.form.file).toBe(0);
      expect(out.receipts).toHaveLength(1);
      expect(out.receipts[0].file).toBe(3); // local file 0 of the second batch
      expect(out.matches).toEqual([{ row: 2, receipt_index: 0, confidence: 0.9 }]);
    });
  });
});

describe("readAttachments progress", () => {
  it("reports each finished batch to the progress callback", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ form: null, receipts: [] }) }] }) });
    try {
      const seen = [];
      const att = { contentType: "application/pdf", base64: "QQ==" };
      await readAttachments({ ANTHROPIC_API_KEY: "sk-ant-x" }, [att, att, att, att, att, att, att], (p) => seen.push(`${p.done}/${p.total}`));
      expect(seen[seen.length - 1]).toBe("3/3"); // 7 files -> 3 batches
      expect(seen.filter((x) => x === "1/3")).toHaveLength(1);
    } finally { globalThis.fetch = real; }
  });
  it("retries a busy (529) answer instead of failing", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 529, headers: { get: () => "0" }, text: async () => "overloaded" };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ form: null, receipts: [] }) }] }) };
    };
    try {
      const out = await readAttachments({ ANTHROPIC_API_KEY: "sk-ant-x" }, [{ contentType: "application/pdf", base64: "QQ==" }]);
      expect(calls).toBe(2);
      expect(out.receipts).toEqual([]);
    } finally { globalThis.fetch = real; }
  });
});

describe("pageRange", () => {
  it("accepts the shapes Claude might return", () => {
    expect(pageRange([5, 7])).toEqual({ ps: 5, pe: 7 });
    expect(pageRange([5])).toEqual({ ps: 5, pe: 5 });
    expect(pageRange(5)).toEqual({ ps: 5, pe: 5 });
    expect(pageRange("5-7")).toEqual({ ps: 5, pe: 7 });
    expect(pageRange(["6", "8"])).toEqual({ ps: 6, pe: 8 });
    expect(pageRange({ start: 2, end: 3 })).toEqual({ ps: 2, pe: 3 });
  });
  it("gives nulls for nothing usable", () => {
    for (const bad of [null, undefined, [], "", "none", [0, 2], [7, 3], { x: 1 }]) {
      expect(pageRange(bad)).toEqual({ ps: null, pe: null });
    }
  });
});

describe("isPickableProject", () => {
  const p = (project_number, name) => ({ project_number, name });
  it("keeps real projects and the overhead ones people expense to", () => {
    expect(isPickableProject(p("2026_0183", "ON - Forte Fixtures - Harry Rosen Cumberland"))).toBe(true);
    expect(isPickableProject(p("0000_0000", "Einbau Headquarters"))).toBe(true);
    expect(isPickableProject(p("0000_0100", "Van#2 - BB56319"))).toBe(true);
  });
  it("hides templates (no number, or Template in the name)", () => {
    expect(isPickableProject(p("", "Standard Project Template"))).toBe(false);
    expect(isPickableProject(p(null, "Standard Project Template - Time and Material"))).toBe(false);
    expect(isPickableProject(p("2026_0999", "Visual Elements Roll Out - Template"))).toBe(false);
  });
  it("hides the AVAILABILITY placeholders", () => {
    expect(isPickableProject(p("GTA - AVAILABILITY", "GTA - AAA - Availability"))).toBe(false);
    expect(isPickableProject(p("VANCOUVER - AVAILABILITY", "BC - VANCOUVER - AAA - Availability"))).toBe(false);
  });
});

describe("line amount flags", () => {
  const project = { active: true, stage: "Course of Construction", province: "ON" };
  it("a net that does not add up with the tax gets its own flag, not the receipt-total one", () => {
    const line = { category: "other", gross_amount: 8.3, net_amount: 7.35, tax_amount: 0.2, tax_source: "manual", receipt_id: "r" };
    const codes = computeLineFlags(line, { gross: 8.3 }, "ON", project).map((f) => f.code);
    expect(codes).toContain("net_tax_mismatch");
    expect(codes).not.toContain("amount_mismatch");
  });
  it("a line that adds up and matches its receipt total has neither", () => {
    const line = { category: "other", gross_amount: 8.3, net_amount: 7.35, tax_amount: 0.95, tax_source: "manual", receipt_id: "r" };
    const codes = computeLineFlags(line, { gross: 8.3 }, "ON", project).map((f) => f.code);
    expect(codes).not.toContain("net_tax_mismatch");
    expect(codes).not.toContain("amount_mismatch");
  });
});

describe("pickApprovers (approve_portal_expenses)", () => {
  const X = "approve_portal_expenses";
  const users = [
    { username: "ben@einbau.ca", displayName: "Ben Wright", level: "admin", extras: [], isSuperAdmin: true },
    { username: "leela@einbau.ca", displayName: "Leela Singh", level: "admin", extras: ["receipt_override", X], isSuperAdmin: false },
    { username: "josh@einbau.ca", displayName: "Josh Brown", level: "submitter", extras: [], isSuperAdmin: false },
  ];
  const sub = { employee_name: "Devid Manzke", form_employee_name: null };
  const names = (r) => r.map((x) => x.username);
  it("for an ordinary submitter the list is the permission holders only (Leela)", () => {
    const r = pickApprovers(users, { username: "josh@einbau.ca", appExtras: {} }, sub);
    expect(names(r)).toEqual(["leela@einbau.ca"]);
    expect(r[0].isDefault).toBe(true);
  });
  it("the super admin submitting still goes to Leela, never to himself", () => {
    expect(names(pickApprovers(users, { username: "ben@einbau.ca", appExtras: {} }, sub))).toEqual(["leela@einbau.ca"]);
  });
  it("Leela submitting: the other holders and the super admins, so Ben", () => {
    const r = pickApprovers(users, { username: "leela@einbau.ca", appExtras: { TALLY: [X] } }, sub);
    expect(names(r)).toEqual(["ben@einbau.ca"]);
    expect(r[0].isSuperAdmin).toBe(true);
  });
  it("more holders: a holder submitting offers the other holders first, then the super admins", () => {
    const more = [...users, { username: "ann", displayName: "Ann Lee", level: "admin", extras: [X] }];
    const r = pickApprovers(more, { username: "leela@einbau.ca", appExtras: { TALLY: [X] } }, sub);
    expect(names(r)).toEqual(["ann", "ben@einbau.ca"]);
    expect(r[0].isDefault).toBe(true);
  });
  it("never offers the employee the expense is for; with no other holder left it falls back to the super admins", () => {
    const r = pickApprovers(users, { username: "josh@einbau.ca", appExtras: {} }, { employee_name: "Leela Singh" });
    expect(names(r)).toEqual(["ben@einbau.ca"]);
    expect(pickApprovers(users, { username: "ben@einbau.ca", appExtras: {} }, { employee_name: "Leela Singh" })).toEqual([]);
  });
  it("a holder who is not a TALLY admin is not offered (they could not open the review screen)", () => {
    const r = pickApprovers([{ username: "x", displayName: "X", level: "submitter", extras: [X] }], { username: "josh@einbau.ca", appExtras: {} }, sub);
    expect(r).toEqual([]);
  });
  it("keeps the current approver as the default when re-sending, and handles no list", () => {
    const more = [...users, { username: "ann", displayName: "Ann Lee", level: "admin", extras: [X] }];
    const r = pickApprovers(more, { username: "josh@einbau.ca", appExtras: {} }, { ...sub, approver: "ann" });
    expect(r.find((x) => x.isDefault).username).toBe("ann");
    expect(pickApprovers(undefined, { username: "ben" }, sub)).toEqual([]);
  });
});

describe("canApprovePortalExpense", () => {
  it("needs the permission or to be the Super Admin (jobRole or isSuperAdmin)", () => {
    expect(canApprovePortalExpense({ username: "leela@einbau.ca", appExtras: { TALLY: ["approve_portal_expenses"] } })).toBe(true);
    expect(canApprovePortalExpense({ username: "ben@einbau.ca", jobRole: "superadmin", appExtras: {} })).toBe(true);
    expect(canApprovePortalExpense({ username: "ben@einbau.ca", isSuperAdmin: true })).toBe(true);
    expect(canApprovePortalExpense({ username: "josh@einbau.ca", appExtras: { TALLY: ["receipt_override"] } })).toBe(false);
    expect(canApprovePortalExpense({ username: "x" })).toBe(false);
  });
});

describe("resolveEmployeeId with a picked Procore user", () => {
  const env = { PROCORE_API_BASE: "https://p.test", PROCORE_COMPANY_ID: "1" };
  const withFetch = async (handler, body) => {
    const real = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(String(url)); return handler(String(url)); };
    try { return await body(urls); } finally { globalThis.fetch = real; }
  };
  const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

  it("uses the picked id when Procore still has that user under that name (no name search)", async () => {
    await withFetch(() => ok({ id: 77, name: "Michael Sefeldas" }), async (urls) => {
      const r = await resolveEmployeeId(env, "tok", "Michael Sefeldas", 77);
      expect(r).toEqual({ id: 77, reason: null });
      expect(urls.some((u) => u.includes("filters[search]"))).toBe(false);
    });
  });
  it("falls back to the name search when the name was edited since the pick", async () => {
    await withFetch((url) => (url.includes("/users/77") ? ok({ id: 77, name: "Michael Sefeldas" }) : ok([{ id: 99, name: "Pat Jones" }])), async (urls) => {
      const r = await resolveEmployeeId(env, "tok", "Pat Jones", 77);
      expect(r).toEqual({ id: 99, reason: null });
      expect(urls.some((u) => u.includes("filters[search]"))).toBe(true);
    });
  });
  it("falls back when the id lookup fails, and still reports no match with a reason", async () => {
    await withFetch((url) => (url.includes("/users/77") ? { ok: false, status: 404, text: async () => "{}" } : ok([])), async () => {
      const r = await resolveEmployeeId(env, "tok", "Nobody Here", 77);
      expect(r.id).toBeNull();
      expect(r.reason).toMatch(/No Procore user found/);
    });
  });
});

describe("positiveInt", () => {
  it("accepts whole positive numbers or numeric strings, nothing else", () => {
    expect(positiveInt(562949953508586)).toBe(562949953508586);
    expect(positiveInt("123")).toBe(123);
    for (const bad of [0, -3, 1.5, "abc", "", null, undefined, NaN, {}]) expect(positiveInt(bad)).toBeNull();
  });
});

describe("missingLineItems (resuming a half-posted Direct Cost)", () => {
  const built = (description, unit_cost) => ({ data: { line_item: { description, unit_cost } } });
  it("posts everything when the Direct Cost has no lines yet", () => {
    const b = [built("a [EXP:1]", "10.00"), built("b [EXP:1]", "5.00")];
    expect(missingLineItems([], b)).toEqual(b);
    expect(missingLineItems(undefined, b)).toEqual(b);
  });
  it("skips the lines already there and posts only the rest", () => {
    const b = [built("a [EXP:1]", "10.00"), built("b [EXP:1]", "5.00"), built("c [EXP:1]", "7.25")];
    const have = [{ description: "a [EXP:1]", unit_cost: "10.00" }, { description: "c [EXP:1]", unit_cost: 7.25 }];
    expect(missingLineItems(have, b)).toEqual([b[1]]);
  });
  it("two identical lines need two existing matches", () => {
    const b = [built("x [EXP:1]", "4.00"), built("x [EXP:1]", "4.00")];
    expect(missingLineItems([{ description: "x [EXP:1]", unit_cost: "4.00" }], b)).toEqual([b[1]]);
  });
  it("a line with a different amount is not a match", () => {
    const b = [built("a [EXP:1]", "10.00")];
    expect(missingLineItems([{ description: "a [EXP:1]", unit_cost: "9.00" }], b)).toEqual(b);
  });
});

describe("procoreFetch rate limiting", () => {
  const env = { PROCORE_API_BASE: "https://p.test", PROCORE_COMPANY_ID: "1" };
  const res429 = (resetInSec) => ({ ok: false, status: 429, headers: { get: (h) => (h === "x-rate-limit-reset" ? String(Math.floor(Date.now() / 1000) + resetInSec) : null) }, text: async () => "{\"message\":\"limit\"}" });
  const ok = { ok: true, status: 200, headers: { get: () => null }, text: async () => "{\"id\":5}" };

  it("waits out a short window and retries", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return calls === 1 ? res429(1) : ok; };
    try {
      const r = await procoreFetch(env, "tok", "/x", { method: "POST", body: { a: 1 } });
      expect(r).toEqual({ id: 5 });
      expect(calls).toBe(2);
    } finally { globalThis.fetch = real; }
  });
  it("fails fast with a clear message when the reset is far away (the hourly limit)", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return res429(1800); };
    try {
      await expect(procoreFetch(env, "tok", "/x")).rejects.toMatchObject({ status: 429, body: { rateLimited: true } });
      expect(calls).toBe(1);
    } finally { globalThis.fetch = real; }
  });
});

describe("budgeted cost codes only (Procore: cost_code_id not chargeable)", () => {
  const seg = (type, id) => ({ segment: { type }, id });
  const wbs = (id, flat_code, cc, lt) => ({ id, flat_code, flat_name: flat_code + " name", status: "active", segment_items: [seg("cost_code", cc), seg("line_item_type", lt)] });
  // the project has a budget line for 59-01-06-05 / Fo and 49-01-06-03 / F, but nothing for the 59-01.O branch
  const rows = [wbs(1, "49-01-06-05.Fo", 501, 9), wbs(2, "59-01.O", 500, 7), wbs(3, "49-01-06-03.F", 502, 8), wbs(4, "59-01-06-06.P", 503, 6)];
  const budget = [{ cost_code: { id: 501 }, line_item_type: { id: 9 } }, { cost_code: { id: 502 }, line_item_type: { id: 8 } }];

  it("keeps only the codes the budget has a line for (both the cost code and the type must match)", () => {
    const codes = budgetedCodes(rows, budget);
    expect(codes.map((x) => x.code)).toEqual(["49-01-06-03.F", "49-01-06-05.Fo"]);
    // right cost code, wrong type: not budgeted
    expect(budgetedCodes([wbs(5, "59-01-06-05.L", 501, 99)], budget)).toEqual([]);
  });
  it("an empty budget means nothing can be charged", () => {
    expect(budgetedCodes(rows, [])).toEqual([]);
    expect(budgetedCodes(undefined, undefined)).toEqual([]);
  });
  const codes = budgetedCodes(rows, budget);
  it("a pick must be one of the budgeted codes, by id or by code", () => {
    expect(resolveWbsFromCodes(codes, "p1", "other", "1")).toBe("1");
    expect(resolveWbsFromCodes(codes, "p1", "other", "49-01-06-03.F")).toBe("3");
    expect(() => resolveWbsFromCodes(codes, "p1", "other", "2")).toThrow(/on project p1.s budget/); // the 59-01.O branch
    expect(() => resolveWbsFromCodes(codes, "p1", "other", "59-01.O")).toThrow(/on project p1.s budget/);
  });
  it("a category default is used only when that exact code is budgeted, never a look-alike", () => {
    expect(resolveWbsFromCodes(codes, "p1", "per_diem", null)).toBe("1");
    expect(resolveWbsFromCodes(codes, "p1", "fuel", null)).toBe("3");
    expect(() => resolveWbsFromCodes(codes, "p1", "parking", null)).toThrow(/budget has no line for 49-01-06-06.P/);
    expect(() => resolveWbsFromCodes(codes, "p1", "other", null)).toThrow(/no default cost code/);
  });
});

describe("isoDate and the Direct Cost line description", () => {
  it("formats strings and Dates as YYYY-MM-DD", () => {
    expect(isoDate("2026-09-25")).toBe("2026-09-25");
    expect(isoDate("2026-09-25T00:00:00.000Z")).toBe("2026-09-25");
    expect(isoDate(new Date("2026-09-25T00:00:00Z"))).toBe("2026-09-25");
    expect(isoDate(null)).toBe("");
    expect(isoDate(new Date("nope"))).toBe("");
  });
});

describe("expenseIdFor (the Procore form's Expense ID)", () => {
  it("matches the IDs the Procore form makes", () => {
    expect(expenseIdFor({ date: "2026-07-31", projectNumber: "0000_0000_5", employeeName: "Dustin MacDougall" })).toBe("310726-000005-DUMA");
    expect(expenseIdFor({ date: "2026-09-21", projectNumber: "2026_0183", employeeName: "Michael Sefeldas" })).toBe("210926-260183-MISE");
    expect(expenseIdFor({ date: "2026-10-09", projectNumber: "0000_0000", employeeName: "Scott Carter-Nichols" })).toBe("091026-000000-SCCA");
  });
  it("copes with a middle name, a one-word name and a missing project", () => {
    expect(expenseIdFor({ date: "2026-01-02", projectNumber: "2025_0695", employeeName: "Mary Anne Smith" })).toBe("020126-250695-MASM");
    expect(expenseIdFor({ date: "2026-01-02", projectNumber: "2025_0695", employeeName: "Cher" })).toBe("020126-250695-CHXX");
    expect(expenseIdFor({ date: "2026-01-02", projectNumber: null, employeeName: "Ben Wright" })).toBe("020126-000000-BEWR");
  });
});

describe("buildExpenseFormPdf", () => {
  it("draws a PDF with the lines, and paginates a long one", async () => {
    const sub = { employee_name: "Ben Wright", project_number: "2026_0183", province: "ON", expense_id: "211026-260183-BEWR" };
    const mk = (i) => ({ category: ["parking", "materials", "fuel", "mileage", "per_diem", "other"][i % 6], line_date: "2026-10-0" + ((i % 9) + 1), description: "Line " + i + " a description long enough to wrap onto a second line of the form", gross_amount: 10 + i, net_amount: 9 + i });
    const small = await buildExpenseFormPdf({ sub, lines: [mk(1), mk(2)] });
    expect(String.fromCharCode(...small.slice(0, 5))).toBe("%PDF-");
    const big = await buildExpenseFormPdf({ sub, lines: Array.from({ length: 40 }, (_, i) => mk(i)), authorizedBy: "Leela Singh", authorizedDate: "2026-10-22" });
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(small)).getPageCount()).toBe(1);
    expect((await PDFDocument.load(big)).getPageCount()).toBeGreaterThan(1);
  });
});

describe("reporting refused requests to auth-worker", () => {
  it("refusalCount: one event per key per minute, carrying the count held back", () => {
    const k = "1.1.1.1|no_token|/x";
    expect(refusalCount(k, 1000)).toBe(1);
    expect(refusalCount(k, 5000)).toBe(0);
    expect(refusalCount(k, 9000)).toBe(0);
    expect(refusalCount(k, 62000)).toBe(3); // this one + the two held back
    expect(refusalCount("2.2.2.2|no_token|/x", 62000)).toBe(1); // another ip is separate
  });
  it("refusalOutcome maps status and a hint", () => {
    expect(refusalOutcome(401, false)).toBe("no_token");
    expect(refusalOutcome(401, true)).toBe("bad_session");
    expect(refusalOutcome(403, true)).toBe("forbidden");
    expect(refusalOutcome(429, true)).toBe("rate_limited");
    expect(refusalOutcome(401, false, "bad_service_key")).toBe("bad_service_key");
  });

  const makeEnv = () => {
    const sent = [];
    return {
      sent,
      env: {
        DATABASE_URL: "postgres://u:p@localhost/db", AUTH_SERVICE_KEY: "svc-key", TALLY_SERVICE_KEY: "right-key",
        AUTH_WORKER: { fetch: async (url, init) => { sent.push({ url: String(url), init }); return new Response(JSON.stringify({ ok: true, stored: 1 })); } },
      },
      ctx: { waitUntil: (p) => { sent.push({ pending: p }); } },
    };
  };
  const events = async (sent) => {
    await Promise.all(sent.filter((s) => s.pending).map((s) => s.pending));
    return sent.filter((s) => s.url).map((s) => ({ url: s.url, key: s.init.headers["X-Auth-Service-Key"], body: JSON.parse(s.init.body) }));
  };

  it("a request with no token is refused AND reported, without the response changing", async () => {
    const { env, ctx, sent } = makeEnv();
    const res = await worker.fetch(new Request("https://t.test/submissions?x=1", { headers: { "CF-Connecting-IP": "9.9.9.1", "User-Agent": "test-agent" } }), env, ctx);
    expect(res.status).toBe(401);
    const ev = await events(sent);
    expect(ev).toHaveLength(1);
    expect(ev[0].url).toBe("https://auth.ben-a90.workers.dev/auth/security/report");
    expect(ev[0].key).toBe("svc-key");
    expect(ev[0].body.events[0]).toMatchObject({ outcome: "no_token", route: "/submissions", method: "GET", ip: "9.9.9.1", count: 1 });
    expect(JSON.stringify(ev[0].body)).not.toMatch(/x=1|Bearer/); // no query string, no tokens
  });
  it("a wrong intake key is reported as bad_service_key; repeats within a minute are held back", async () => {
    const { env, ctx, sent } = makeEnv();
    const req = () => new Request("https://t.test/intake", { method: "POST", headers: { "X-Tally-Service-Key": "wrong", "CF-Connecting-IP": "9.9.9.2" }, body: "{}" });
    expect((await worker.fetch(req(), env, ctx)).status).toBe(401);
    expect((await worker.fetch(req(), env, ctx)).status).toBe(401);
    const ev = await events(sent);
    expect(ev).toHaveLength(1);
    expect(ev[0].body.events[0].outcome).toBe("bad_service_key");
  });
  it("OPTIONS preflights are not reported, and a missing AUTH_SERVICE_KEY just skips reporting", async () => {
    const a = makeEnv();
    await worker.fetch(new Request("https://t.test/submissions", { method: "OPTIONS" }), a.env, a.ctx);
    expect(await events(a.sent)).toHaveLength(0);
    const b = makeEnv();
    delete b.env.AUTH_SERVICE_KEY;
    const res = await worker.fetch(new Request("https://t.test/submissions", { headers: { "CF-Connecting-IP": "9.9.9.3" } }), b.env, b.ctx);
    expect(res.status).toBe(401);
    expect(await events(b.sent)).toHaveLength(0);
  });
});

describe("visitorHeaders (sent to auth-worker on /auth/verify)", () => {
  it("forwards the visitor's IP, location and browser, and leaves out what is empty", () => {
    const req = new Request("https://t.test/x", { headers: { "CF-Connecting-IP": "5.6.7.8", "User-Agent": "Mozilla/5.0" } });
    expect(visitorHeaders(req)).toEqual({ "X-Einbau-Client-IP": "5.6.7.8", "X-Einbau-Client-UA": "Mozilla/5.0" });
  });
  it("gives nothing for a bare request", () => {
    expect(visitorHeaders(new Request("https://t.test/x", { headers: { "User-Agent": "" } }))).toEqual({});
  });
});

describe("compareCodes (cost codes in numeric order)", () => {
  it("sorts by number, segment by segment, then by the cost-type letters", () => {
    const codes = ["59-01-06-10.O", "55.MH", "49-01-05-11.L", "59-01-06-03.F", "49-01-05-05.L", "49-01-06-02.L", "56.MH", "59-01-06-05.Fo", "49-01-05-11.O", "9.X", "10.X"];
    expect([...codes].sort(compareCodes)).toEqual([
      "9.X", "10.X", "49-01-05-05.L", "49-01-05-11.L", "49-01-05-11.O", "49-01-06-02.L", "55.MH", "56.MH", "59-01-06-03.F", "59-01-06-05.Fo", "59-01-06-10.O",
    ]);
  });
  it("budgetedCodes returns its list already in that order", () => {
    const seg = (type, id) => ({ segment: { type }, id });
    const w = (id, code, cc) => ({ id, flat_code: code, segment_items: [seg("cost_code", cc), seg("line_item_type", 1)] });
    const out = budgetedCodes([w(1, "59-01-06-10.O", 3), w(2, "49-01-05-05.L", 1), w(3, "55.MH", 2)], [1, 2, 3].map((n) => ({ cost_code: { id: n }, line_item_type: { id: 1 } })));
    expect(out.map((x) => x.code)).toEqual(["49-01-05-05.L", "55.MH", "59-01-06-10.O"]);
  });
});

describe("attachSubmissionFiles (checks the Direct Cost really shows the files)", () => {
  const rows = [{ r2_key: "k/Form.pdf" }, { r2_key: "k/Receipts.pdf" }, { r2_key: "k/Receipts.pdf" }]; // two files, one shared by two receipts
  const makeEnv = () => ({
    PROCORE_API_BASE: "https://p.test", PROCORE_COMPANY_ID: "1", ATTACH_SETTLE_MS: 0,
    RECEIPTS: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, httpMetadata: { contentType: "application/pdf" } }) },
  });
  // a pretend Procore: counts attachments; "mode" decides which attach style actually links files
  const pretendProcore = (mode) => {
    const calls = [];
    let attached = 0;
    globalThis.fetch = async (url, init = {}) => {
      url = String(url);
      calls.push(`${init.method || "GET"} ${url.replace("https://p.test", "")}`);
      const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
      if (url.includes("/uploads")) return ok({ url: "https://store.test/up", uuid: "u-" + calls.length, fields: {} });
      if (url.startsWith("https://store.test")) return ok({});
      if (init.method === "PATCH") {
        if (init.body instanceof FormData) { if (mode === "multipart") attached += init.body.getAll("attachments[]").length; }
        else if (mode === "upload_ids") attached += JSON.parse(init.body).item.upload_ids.length;
        return ok({});
      }
      return ok({ id: 1, attachments_count: attached });
    };
    return calls;
  };
  const real = globalThis.fetch;

  it("multipart works: both files attached once each, no second way tried", async () => {
    const calls = pretendProcore("multipart");
    try {
      const r = await attachSubmissionFiles(makeEnv(), "tok", "p1", "dc1", rows);
      expect(r.map((x) => x.ok)).toEqual([true, true]);
      expect(calls.some((c) => c.includes("/uploads"))).toBe(false);
    } finally { globalThis.fetch = real; }
  });
  it("multipart is accepted but nothing links: falls back to upload + upload_ids and reports success if that shows up", async () => {
    pretendProcore("upload_ids");
    try {
      const r = await attachSubmissionFiles(makeEnv(), "tok", "p1", "dc1", rows);
      expect(r.map((x) => x.ok)).toEqual([true, true]);
    } finally { globalThis.fetch = real; }
  });
  it("neither way links the files: both reported failed, with both reasons", async () => {
    pretendProcore("none");
    try {
      const r = await attachSubmissionFiles(makeEnv(), "tok", "p1", "dc1", rows);
      expect(r.every((x) => x.ok === false)).toBe(true);
      expect(r[0].error).toMatch(/Neither way attached/);
      expect(r[0].error).toMatch(/multipart attach answered OK/);
    } finally { globalThis.fetch = real; }
  });
});

describe("handleList filters and sorting", () => {
  const run = async (query, ownerFilter = null) => {
    let captured = null;
    const sql = { query: async (text, params) => { captured = { text, params }; return []; } };
    const res = await handleList(new URL("https://t.test/submissions" + query), sql, ownerFilter, "Leela@Einbau.ca");
    return { ...captured, body: await res.json() };
  };
  it("keeps drafts private and defaults to newest first", async () => {
    const { text, params } = await run("?status=approved");
    expect(text).toContain("s.status = $1");
    expect(text).toContain("s.status <> 'draft' or lower(s.created_by) = $2");
    expect(params.slice(0, 2)).toEqual(["approved", "leela@einbau.ca"]);
    expect(text).toContain("order by coalesce(s.reviewed_at, s.created_at) desc");
  });
  it("every keyword must match somewhere, special characters are escaped, and values are parameters, not SQL", async () => {
    const { text, params } = await run("?q=" + encodeURIComponent("park 50%; drop table"));
    expect(params).toContain("%park%");
    expect(params).toContain("%50\\%;%"); // the percent sign is escaped so it means a percent sign
    expect(text).not.toContain("drop table");
    expect((text.match(/ilike/g) || []).length).toBeGreaterThan(8);
  });
  it("project, employee and a date range narrow it; a bad date is ignored", async () => {
    const { text, params } = await run("?project=Cumberland&employee=Ben&from=2026-10-01&to=2026-10-31");
    expect(params).toEqual(expect.arrayContaining(["%Cumberland%", "%Ben%", "2026-10-01", "2026-10-31"]));
    expect(text).toContain("America/Toronto");
    const bad = await run("?from=yesterday");
    expect(bad.params).not.toContain("yesterday");
  });
  it("sorts only by the known keys, asc or desc", async () => {
    expect((await run("?sort=amount&dir=asc")).text).toContain("order by coalesce(li.net_total, 0) asc nulls last");
    expect((await run("?sort=employee")).text).toContain("order by lower(s.employee_name) desc nulls last");
    const odd = (await run("?sort=s.id;drop table x")).text;
    expect(odd).toContain("order by coalesce(s.reviewed_at, s.created_at) desc");
    expect(odd).not.toContain("drop table");
  });
  it("a general user sees what they created or what is about them, never other people's", async () => {
    const viewer = viewerIdentity({ username: "Scot@Einbau.ca", displayName: "Scot Carter-Nichols", firstName: "Scot", lastName: "Carter-Nichols", fields: { procoreUser: { id: 13628396 } } });
    const { text, params } = await run("?status=needs_review", viewer);
    expect(text).toContain("lower(s.created_by) = $");
    expect(text).toContain("= any($");
    expect(text).toContain("s.employee_procore_id = $");
    expect(params).toEqual(expect.arrayContaining(["scot@einbau.ca", ["scot carter-nichols"], 13628396]));
  });
});

describe("chooseExpenseId (what the preview shows and Submit assigns)", () => {
  const sub = { id: "s1", origin: "upload", expense_id: "pending-abc", project_number: "2026_0183", employee_name: "Ben Wright" };
  const fakeSql = (taken) => async (_strings, candidate) => (taken.includes(candidate) ? [{ x: 1 }] : []);
  it("gives the form-style id, and numbers a second one for the same person, project and day", async () => {
    const today = expenseIdFor({ projectNumber: "2026_0183", employeeName: "Ben Wright" });
    expect(await chooseExpenseId(fakeSql([]), sub)).toBe(today);
    expect(await chooseExpenseId(fakeSql([today]), sub)).toBe(today + "-2");
    expect(await chooseExpenseId(fakeSql([today, today + "-2"]), sub)).toBe(today + "-3");
  });
  it("leaves email expenses and ones that already have a real id alone", async () => {
    expect(await chooseExpenseId(fakeSql([]), { ...sub, origin: "email" })).toBe("pending-abc");
    expect(await chooseExpenseId(fakeSql([]), { ...sub, expense_id: "210926-260183-BEWR" })).toBe("210926-260183-BEWR");
  });
});

describe("revision requests (portal expenses only, message kept in the history)", () => {
  const user = { username: "leela@einbau.ca", displayName: "Leela Senthilnathan" };
  const makeSql = (sub) => {
    const calls = [];
    const sql = async (strings, ...vals) => {
      const text = strings.join("?");
      calls.push({ text, vals });
      if (text.includes("select * from submissions")) return sub ? [sub] : [];
      if (text.includes("update submissions set status = 'needs_revision'")) return [{ id: "s1", status: "needs_revision", expense_id: "X", created_by: "ben@einbau.ca" }];
      return [];
    };
    return { sql, calls };
  };
  const req = (note) => new Request("https://t.test/x", { method: "POST", body: JSON.stringify({ note }), headers: { "Content-Type": "application/json" } });
  const portal = { id: "s1", origin: "upload", status: "needs_review", approver: "leela@einbau.ca", history: [], expense_id: "X" };

  it("sends a portal expense back with the message, who sent it, and no email", async () => {
    const { sql, calls } = makeSql(portal);
    const res = await handleRequestRevision("s1", req("  Wrong project on line 2  "), sql, user);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.reply).toBeUndefined();
    const update = calls.find((c) => c.text.includes("needs_revision"));
    const history = JSON.parse(update.vals.find((v) => typeof v === "string" && v.startsWith("[{")));
    expect(history.at(-1)).toMatchObject({ type: "revision_requested", by: "leela@einbau.ca", name: "Leela Senthilnathan", message: "Wrong project on line 2" });
  });
  it("refuses an emailed expense, an empty note, a wrong status, and someone other than the assigned approver", async () => {
    expect((await handleRequestRevision("s1", req("x"), makeSql({ ...portal, origin: "email" }).sql, user)).status).toBe(422);
    expect((await handleRequestRevision("s1", req("   "), makeSql(portal).sql, user)).status).toBe(400);
    expect((await handleRequestRevision("s1", req("x"), makeSql({ ...portal, status: "approved" }).sql, user)).status).toBe(409);
    expect((await handleRequestRevision("s1", req("x"), makeSql({ ...portal, approver: "other@einbau.ca" }).sql, user)).status).toBe(409);
    expect((await handleRequestRevision("s1", req("x"), makeSql(null).sql, user)).status).toBe(404);
  });
});

describe("bumpForm only records history", () => {
  it("never changes the status (drafts stay drafts, sent-back stays sent back)", async () => {
    const seen = [];
    await bumpForm(async (strings) => { seen.push(strings.join("?")); return []; }, "s1", historyEvent("line_edited", "x"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/status/);
  });
  it("historyEvent can carry who and what was said", () => {
    expect(historyEvent("revision_reply", "t", { by: "ben", message: "m" })).toMatchObject({ type: "revision_reply", text: "t", by: "ben", message: "m" });
  });
});

describe("an expense that is about a general user (viewerIdentity / isAboutViewer)", () => {
  const scot = viewerIdentity({ username: "scot@einbau.ca", displayName: "Scot Carter-Nichols", firstName: "Scot", lastName: "Carter-Nichols", fields: { procoreUser: { id: "13628396" } } });
  it("matches by the employee name, ignoring case and spacing, on either name field", () => {
    expect(isAboutViewer(scot, { employee_name: "SCOT  Carter-Nichols" })).toBe(true);
    expect(isAboutViewer(scot, { employee_name: "someone else", form_employee_name: "scot carter-nichols" })).toBe(true);
    expect(isAboutViewer(scot, { employee_name: "Scott Carter" })).toBe(false);
  });
  it("matches by the Procore user id when the name differs", () => {
    expect(isAboutViewer(scot, { employee_name: "S. C-N", employee_procore_id: "13628396" })).toBe(true);
    expect(isAboutViewer(scot, { employee_name: "S. C-N", employee_procore_id: "999" })).toBe(false);
  });
  it("never matches blanks, and a user with no Procore link relies on the name", () => {
    expect(isAboutViewer(scot, { employee_name: "", form_employee_name: null })).toBe(false);
    const nobody = viewerIdentity({ username: "x", displayName: "Pat Jones" });
    expect(nobody.procoreId).toBeNull();
    expect(isAboutViewer(nobody, { employee_name: "Pat Jones" })).toBe(true);
    expect(isAboutViewer(nobody, { employee_name: "Pat Jones", employee_procore_id: null }) && !isAboutViewer(nobody, { employee_name: "Sam" })).toBe(true);
  });
});

describe("the real Einbau form, filled in", () => {
  const template = readFileSync(new URL("../assets/employee-expense-form-template.pdf", import.meta.url));
  const sub = { employee_name: "Ben Wright", project_number: "2026_0183", province: "ON", expense_id: "271026-260183-BEWR" };
  const mk = (i, category = "other") => ({ row_index: i, category, line_date: "2026-10-12", description: "Line " + i, gross_amount: 10 + i, net_amount: 9 + i });
  it("dates are written the way the form shows them (M/D/YY)", () => {
    expect(mdy("2026-10-05")).toBe("10/5/26");
    expect(mdy(new Date("2026-01-30T00:00:00Z"))).toBe("1/30/26");
    expect(mdy(null)).toBe("");
  });
  it("fills one page for up to 11 lines, more pages beyond that, and one for none", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pages = async (lines, extra = {}) => (await PDFDocument.load(await buildFormFromTemplate({ templateBytes: template, sub, lines, ...extra }))).getPageCount();
    expect(await pages([mk(1), mk(2, "fuel"), mk(3, "mileage"), mk(4, "per_diem")], { authorizedBy: "Leela", authorizedDate: "2026-10-28" })).toBe(1);
    expect(await pages(Array.from({ length: 11 }, (_, i) => mk(i + 1)))).toBe(1);
    expect(await pages(Array.from({ length: 12 }, (_, i) => mk(i + 1)))).toBe(2);
    expect(await pages(Array.from({ length: 25 }, (_, i) => mk(i + 1)))).toBe(3);
    expect(await pages([])).toBe(1);
  });
  it("copes with a long description, an unknown category and an odd province", async () => {
    const bytes = await buildFormFromTemplate({
      templateBytes: template, sub: { ...sub, province: "XX" },
      lines: [{ ...mk(1, "weird"), description: "A very long description ".repeat(20) }],
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
  });
});

describe("dateFromExpenseId (a redrawn form keeps its own date)", () => {
  it("reads DDMMYY from the start of an Expense ID", () => {
    expect(dateFromExpenseId("271026-000000-BEWR")).toBe("2026-10-27");
    expect(dateFromExpenseId("310726-000005-DUMA")).toBe("2026-07-31");
    expect(dateFromExpenseId("pending-abc")).toBeNull();
    expect(dateFromExpenseId("991326-000000-XXXX")).toBeNull(); // not a real day or month
    expect(dateFromExpenseId(null)).toBeNull();
  });
});
