import { describe, it, expect } from "vitest";
import { _test } from "../src/index.js";

const {
  extractExpenseId,
  normalizeCategory,
  salvageByFieldBoundaries,
  matchLinesToReceipts,
  deriveLineNet,
  computeLineFlags,
  computeFormFlags,
  sumTaxLines,
  money,
  normalizeAttachments,
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
