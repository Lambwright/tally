import { describe, it, expect } from "vitest";
import { _test } from "../src/index.js";

const {
  extractInvoiceNumber,
  normalizeCategory,
  salvageByFieldBoundaries,
  computeFlags,
  sumTaxLines,
  money,
  normalizeAttachments,
} = _test;

describe("extractInvoiceNumber", () => {
  it("prefers the form's expense_id field", () => {
    expect(extractInvoiceNumber({ expense_id: "EXP-1024", subject: "whatever" })).toBe("EXP-1024");
  });
  it("falls back to invoice_number", () => {
    expect(extractInvoiceNumber({ invoice_number: "INV-77", subject: "x" })).toBe("INV-77");
  });
  it("pulls EXP/INV-style tokens out of the subject", () => {
    expect(extractInvoiceNumber({ subject: "Expense submission EXP-20481" })).toBe("EXP-20481");
    expect(extractInvoiceNumber({ subject: "RE: Expense EXP_7781AB — revision requested" })).toBe("EXP_7781AB");
  });
  it("pulls a YYYY_NNNN token", () => {
    expect(extractInvoiceNumber({ subject: "Fwd: receipt 2026_0412" })).toBe("2026_0412");
  });
  it("returns null when there's nothing to find", () => {
    expect(extractInvoiceNumber({ subject: "lunch" })).toBeNull();
  });
});

describe("normalizeCategory", () => {
  it("passes through the form's own column names", () => {
    for (const c of ["parking", "materials", "fuel", "mileage", "per_diem", "other"]) {
      expect(normalizeCategory(c)).toBe(c);
    }
  });
  it("folds synonyms", () => {
    expect(normalizeCategory("Gas")).toBe("fuel");
    expect(normalizeCategory("Material")).toBe("materials");
    expect(normalizeCategory("Per Diem")).toBe("per_diem");
  });
  it("unknown -> other", () => {
    expect(normalizeCategory("labour")).toBe("other");
    expect(normalizeCategory("")).toBe("other");
  });
});

describe("salvageByFieldBoundaries", () => {
  it("recovers fields from a body with unescaped HTML in a string value", () => {
    const raw =
      '{"subject":"Expense INV-5","from":"joe@einbau.ca","body":"<div class="x">hi "there"</div>","category":"gas"}';
    const out = salvageByFieldBoundaries(raw);
    expect(out.subject).toBe("Expense INV-5");
    expect(out.from).toBe("joe@einbau.ca");
    expect(out.category).toBe("gas");
    expect(out.body).toContain("hi");
  });
  it("returns null when no known fields are present", () => {
    expect(salvageByFieldBoundaries('{"totally":"different"}')).toBeNull();
  });
});

describe("money", () => {
  it("parses currency-formatted strings", () => {
    expect(money("$1,234.56")).toBe(1234.56);
    expect(money("42")).toBe(42);
    expect(money("")).toBeNull();
    expect(money(null)).toBeNull();
    expect(money("abc")).toBeNull();
  });
});

describe("sumTaxLines", () => {
  it("adds tax line amounts to the cent", () => {
    expect(sumTaxLines([{ label: "GST", amount: 5 }, { label: "QST", amount: 9.98 }])).toBe(14.98);
    expect(sumTaxLines([])).toBe(0);
    expect(sumTaxLines(undefined)).toBe(0);
  });
});

describe("normalizeAttachments", () => {
  it("handles Power Automate's contentBytes shape and sanitizes names", () => {
    const out = normalizeAttachments({
      attachments: [{ name: "receipt (1).jpg", contentType: "image/jpeg", contentBytes: "AAAA" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].base64).toBe("AAAA");
    expect(out[0].name).toBe("receipt _1_.jpg");
  });
  it("drops attachments with no content and accepts a single object", () => {
    expect(normalizeAttachments({ attachment: { name: "x", contentBytes: "" } })).toHaveLength(0);
  });
});

describe("computeFlags", () => {
  const baseReceiptSub = {
    category: "materials",
    is_flat_claim: false,
    province: "ON",
    project_number: "2026_0300",
    tax_source: "read",
    gross_amount: 113,
    tax_amount: 13,
    net_amount: 100,
    confidence: 0.9,
    parsed: { subtotal: 100, tax_lines: [{ label: "HST", amount: 13 }], category_guess: "materials" },
  };
  const activeProject = { stage: "Construction", province: "ON" };

  it("clean receipt on an active project => no flags", () => {
    expect(computeFlags(baseReceiptSub, activeProject)).toEqual([]);
  });

  it("missing project number", () => {
    const f = computeFlags({ ...baseReceiptSub, project_number: null }, null);
    expect(f.map((x) => x.code)).toContain("project_missing");
  });

  it("project not in cache", () => {
    const f = computeFlags(baseReceiptSub, null);
    expect(f.map((x) => x.code)).toContain("project_invalid");
  });

  it("inactive project stage", () => {
    const f = computeFlags(baseReceiptSub, { stage: "On Hold", province: "ON" });
    expect(f.map((x) => x.code)).toContain("project_inactive");
  });

  it("project marked inactive in Procore (active === false)", () => {
    const f = computeFlags(baseReceiptSub, { stage: "Cancelled", active: false, province: "ON" });
    expect(f.map((x) => x.code)).toContain("project_inactive");
  });

  it("geo mismatch only fires for site-tied categories", () => {
    const fuel = computeFlags({ ...baseReceiptSub, category: "fuel", province: "QC" }, activeProject);
    expect(fuel.map((x) => x.code)).toContain("geo_mismatch");
    const materials = computeFlags({ ...baseReceiptSub, category: "materials", province: "QC" }, activeProject);
    expect(materials.map((x) => x.code)).not.toContain("geo_mismatch");
  });

  it("fallback-table tax is always flagged", () => {
    const f = computeFlags({ ...baseReceiptSub, tax_source: "fallback_table" }, activeProject);
    expect(f.map((x) => x.code)).toContain("tax_estimated");
  });

  it("net disagreeing with the printed net", () => {
    const f = computeFlags(
      { ...baseReceiptSub, net_amount: 90, parsed: { ...baseReceiptSub.parsed, printed_net: 100 } },
      activeProject
    );
    expect(f.map((x) => x.code)).toContain("amount_mismatch");
  });

  it("low confidence", () => {
    const f = computeFlags({ ...baseReceiptSub, confidence: 0.4 }, activeProject);
    expect(f.map((x) => x.code)).toContain("low_confidence");
  });

  it("category conflict between form and receipt", () => {
    const f = computeFlags(
      { ...baseReceiptSub, parsed: { ...baseReceiptSub.parsed, category_guess: "fuel" } },
      activeProject
    );
    expect(f.map((x) => x.code)).toContain("category_conflict");
  });

  it("flat-claim (per diem / mileage) skips receipt-only checks", () => {
    const f = computeFlags(
      { category: "per_diem", is_flat_claim: true, province: "ON", project_number: "2026_0300",
        tax_source: "none", net_amount: 75, confidence: null, parsed: null },
      activeProject
    );
    expect(f.map((x) => x.code)).not.toContain("tax_estimated");
    expect(f.map((x) => x.code)).not.toContain("low_confidence");
  });
});
