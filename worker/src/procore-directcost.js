// ---------------------------------------------------------------------------
// procore-directcost.js — the ONLY place TALLY writes to Procore.
//
// The payload shape, headers, auth, two-step create, and dedup strategy below
// are lifted from Einbau's working "Payroll Direct Cost Generator" Power Automate
// flow (provided by Ben). That flow writes `payroll`-type Direct Costs; TALLY
// writes `invoice`-type ones so the existing Procore -> NetSuite invoice sync
// picks them up. The payload is settled; DIRECTCOST_VERIFIED stays false only
// until a real write has been smoke-tested against live Procore.
//
// CONFIRMED from the payroll flow:
//   - POST https://us02.procore.com/rest/v1.0/projects/{id}/direct_costs
//   - Header body wrapper is  "item"  — NOT "direct_cost". Procore's docs say
//     "direct_cost"; the API rejects it. (Their words: "discovered through trial
//     and error".)
//   - Line items are POSTed SEPARATELY, after the header, to
//     /rest/v1.0/projects/{id}/direct_costs/{dc_id}/line_items  with wrapper
//     "line_item", and the budget code field is  wbs_code_id  (not cost_code_id).
//   - Required headers: Accept, Content-Type, Authorization: Bearer, and
//     Procore-Company-Id: 562949953508586.
//   - status: "approved" on the header.
//   - Dedup = embed a unique token in the line-item description (payroll uses
//     [TC:<id>]); before writing, GET the project's existing line items and
//     string-search for the token. TALLY uses [INV:<invoice_number>].
//   - Einbau company vendor_id = 562949959021641.
// ---------------------------------------------------------------------------

// Armed at Ben's call (2026-09-08). Approve now posts real Direct Costs to
// Procore. First real Approve should still be done on a TEST project and eyeballed
// in Procore before using it for real — the "Preview payload" button in the UI
// shows exactly what will be sent.
export const DIRECTCOST_VERIFIED = true;

export const PROCORE_COMPANY_ID = "562949953508586";
export const EINBAU_VENDOR_ID = 562949959021641; // CONFIRMED (payroll flow) — used for payroll-type DCs, not these

// CONFIRMED (Ben, 2026-09-16): expense Direct Costs go against the "MISC EMP
// Expenses" vendor (id 562949966381888), not Einbau itself — set via the
// MISC_EMP_VENDOR_ID var in wrangler.jsonc. buildDirectCostHeader still throws
// if that var is ever unset rather than silently falling back to
// EINBAU_VENDOR_ID — posting to the wrong vendor is exactly the class of
// silent-wrong-data bug this file exists to avoid.

// CONFIRMED (Ben): invoice-type, so the existing Procore -> NetSuite invoice sync
// picks these up.
const DIRECT_COST_TYPE = "invoice";

// CONFIRMED (Ben): tag the DC header with the employee, same as the payroll flow.
// index.js resolves the id from the submitter's email; if that lookup fails the
// header just omits it rather than blocking the write.
export const SET_EMPLOYEE_ID = true;

// Default category -> budget/WBS "flat code" (Ben). The reviewer picks the actual
// code per-submission in the app, pre-selected to this default. "other" has no
// default and MUST be chosen before approval. resolveWbsCodeId() turns the chosen
// flat code into that project's real wbs_code_id.
export const CATEGORY_TO_WBS_CODE = {
  parking: "49-01-06-06.P",
  materials: "56.MC",
  mileage: "49-01-06-03.Mi",
  fuel: "49-01-06-03.F",
  per_diem: "49-01-06-05.Fo",
  other: null,
};

// CONFIRMED (Ben): the DC header `invoice_number` = the form's own generated
// Expense ID (submission.invoice_number). Wired in buildDirectCostHeader.

function normalizeCode(s) {
  return String(s || "").replace(/\s/g, "").toLowerCase();
}

// A project's budget WBS lines — { id, code, description } for the app's
// cost-code dropdown and for resolveWbsCodeId().
//
// Endpoint confirmed live: GET /rest/v1.0/projects/{id}/wbs_codes returns the
// project's active WBS lines, each with `id`, `flat_code` ("49-01-05-05.L") and
// `flat_name` ("Millwork Install.Labor"). Note: the list always includes a
// placeholder row with an empty flat_code — filtered out here.
// A project's WBS list includes codes that are NOT on its budget (parent levels like 59-01.O, and leaf codes
// nobody added to this project's budget). Procore only lets you charge a cost to a BUDGETED code and refuses
// anything else with 422 {"cost_code_id":["not chargeable"]}. A code is budgeted when the project's budget has
// a line with the same cost code AND the same line-item type as the code's two segments.
// Cost codes in the order people expect: by number, segment by segment (49-01-05-05.L, 49-01-05-11.L, 55.MH,
// 59-01-06-03.F), not as text (where 55 would sort after 49-01-... only by luck and 6 after 10).
export function compareCodes(a, b) {
  const tok = (s) => String(s || "").match(/\d+|\D+/g) || [];
  const x = tok(a), y = tok(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
    if (nx && ny) { const d = Number(x[i]) - Number(y[i]); if (d) return d; }
    else { const c = x[i].toLowerCase().localeCompare(y[i].toLowerCase()); if (c) return c; }
  }
  return 0;
}

// wbsRows: GET .../wbs_codes rows; budgetLines: GET /budget_line_items?project_id= rows. Sorted with compareCodes.
export function budgetedCodes(wbsRows, budgetLines) {
  const keys = new Set(
    (budgetLines || []).map((b) => `${b?.cost_code?.id}|${b?.line_item_type?.id}`)
  );
  return (wbsRows || [])
    .filter((w) => w && w.status !== "inactive" && w.flat_code)
    .filter((w) => {
      const items = Array.isArray(w.segment_items) ? w.segment_items : [];
      const cc = items.find((s) => s?.segment?.type === "cost_code");
      const lt = items.find((s) => s?.segment?.type === "line_item_type");
      return !!cc && !!lt && keys.has(`${cc.id}|${lt.id}`);
    })
    .map((w) => ({
      id: String(w.id ?? ""),
      code: String(w.flat_code),
      description: String(w.flat_name || w.description || ""),
    }))
    .filter((r) => r.id && r.code)
    .sort((p, q) => compareCodes(p.code, q.code));
}

async function listAllPages(env, token, procoreFetch, path) {
  const all = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 20; page++) {
    const rows = await procoreFetch(env, token, `${path}${sep}per_page=300&page=${page}`, { method: "GET" });
    const list = Array.isArray(rows) ? rows : rows?.data || [];
    all.push(...list);
    if (list.length < 300) break;
  }
  return all;
}

// Cost codes that can really be charged on this project: its WBS codes narrowed to the budgeted ones. Cached
// for two minutes per project, because one screen load, a submit and an approve all ask.
const codeCache = new Map(); // projectId -> { at, codes }
export async function listProjectWbsCodes(env, token, procoreFetch, projectId, { fresh = false } = {}) {
  const hit = codeCache.get(String(projectId));
  if (!fresh && hit && Date.now() - hit.at < 120000) return hit.codes;
  const wbs = await listAllPages(env, token, procoreFetch, `/rest/v1.0/projects/${projectId}/wbs_codes`);
  const budget = await listAllPages(env, token, procoreFetch, `/rest/v1.0/budget_line_items?project_id=${projectId}`);
  const codes = budgetedCodes(wbs, budget);
  codeCache.set(String(projectId), { at: Date.now(), codes });
  return codes;
}

export async function resolveWbsCodeId(env, token, procoreFetch, projectId, category, explicitChoice) {
  return resolveWbsFromCodes(await listProjectWbsCodes(env, token, procoreFetch, projectId), projectId, category, explicitChoice);
}

// The same lookup against a code list you already fetched, so approving a 16-line expense reads the
// project's cost codes once instead of sixteen times (that burst is what tripped Procore's rate limit).
export function resolveWbsFromCodes(codes, projectId, category, explicitChoice) {
  // Someone picked a code from the list: it must be one of this project's budgeted codes.
  if (explicitChoice) {
    const chosen = codes.find((c) => c.id === String(explicitChoice));
    if (chosen) return chosen.id;
    const byCode = codes.find((c) => normalizeCode(c.code) === normalizeCode(explicitChoice));
    if (byCode) return byCode.id;
    throw new Error(
      `The cost code chosen for this line isn't on project ${projectId}'s budget (it may be an unfinished branch like 59-01.O, or a code nobody added to the budget). Pick one of the project's budgeted codes.`
    );
  }

  const wantedFlat = CATEGORY_TO_WBS_CODE[category];
  if (!wantedFlat) {
    throw new Error(`Category "${category}" has no default cost code: pick one in the app before approving.`);
  }
  // Exactly the default, and only if it is budgeted. No "closest" or "starts with" guessing: a wrong code
  // that happens to be budgeted is worse than asking.
  const hit = codes.find((c) => normalizeCode(c.code) === normalizeCode(wantedFlat));
  if (!hit) {
    throw new Error(
      `Project ${projectId}'s budget has no line for ${wantedFlat} (the default for "${category}"). Pick one of the project's budgeted cost codes for this line.`
    );
  }
  return hit.id;
}

// CONFIRMED (Ben, 2026-09-16): payment terms is a plain `terms` string field
// on the Direct Cost header itself — seen on a live DC read back from Procore
// as "Net 10". NOT vendor-inherited (Ben confirmed), so TALLY has to send it.
const PAYMENT_TERMS = "Net 10";

// One header per emailed expense form. The amounts live on the line items.
// `env` supplies MISC_EMP_VENDOR_ID — see the note above on why this isn't
// allowed to silently fall back to EINBAU_VENDOR_ID.
export function buildDirectCostHeader(submission, { employeeId = null, env } = {}) {
  const vendorId = env?.MISC_EMP_VENDOR_ID;
  if (!vendorId) {
    throw new Error(
      "MISC_EMP_VENDOR_ID isn't configured — set that secret/var to the 'MISC EMP Expenses' vendor's Procore id before approving."
    );
  }
  const date =
    isoDate(submission.header_date) || isoDate(submission.receipt_date) || new Date().toISOString().slice(0, 10);
  const item = {
    direct_cost_type: DIRECT_COST_TYPE,
    status: "approved",
    direct_cost_date: date,
    received_date: date,
    invoice_number: submission.expense_id, // CONFIRMED (Ben): the form's Expense ID
    vendor_id: Number(vendorId),
    terms: PAYMENT_TERMS,
    description: `TALLY expense form ${submission.expense_id} — ${submission.employee_name || submission.employee_email || "employee"}`,
  };
  if (employeeId) item.employee_id = String(employeeId); // string, no int cast (payroll flow)

  return {
    method: "POST",
    path: `/rest/v1.0/projects/${submission.project_procore_id}/direct_costs`,
    data: { item },
  };
}

// One line item per expense row on the form. `line` is a line_items row (carries
// its own project_procore_id, denormalized). Amount posted is the NET.
// `taxCodeId` (optional) — CONFIRMED (Ben, 2026-09-16) field name `tax_code_id`
// from a live line item; the id->province mapping lives in
// PROCORE_TAX_CODE_IDS (index.js resolves it before calling this). Omitted
// entirely when the submission's province has no configured mapping.
// A date as YYYY-MM-DD whether the database driver handed back a string or a Date (a Date used to be
// pasted into line descriptions as "Fri Sep 25 2026 00:00:00 GMT+0000 (Coordinated Universal Time)").
export function isoDate(v) {
  if (!v) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export function buildDirectCostLineItem(line, wbsCodeId, expenseId, taxCodeId = null) {
  const net = Number(line.net_amount);
  if (!Number.isFinite(net) || net <= 0) {
    throw new Error(`Refusing to build a line item with net_amount=${line.net_amount}`);
  }
  // No separate date field on a Direct Cost line item (confirmed off a live
  // one) — the expense's own date goes into the description text instead.
  const label = (line.description || line.category || "expense").toString().slice(0, 120);
  const dateTag = isoDate(line.line_date) ? `${isoDate(line.line_date)} — ` : "";
  const item = {
    wbs_code_id: String(wbsCodeId),
    description: `${dateTag}${label} ${dedupToken({ expense_id: expenseId })}`,
    quantity: 1,
    unit_cost: net.toFixed(2),
    uom: "each", // TODO(ben): payroll uses "hours"; confirm the unit for a lump expense
  };
  if (taxCodeId) item.tax_code_id = Number(taxCodeId);
  return {
    method: "POST",
    // caller substitutes {dc_id}
    pathTemplate: `/rest/v1.0/projects/${line.project_procore_id}/direct_costs/{dc_id}/line_items`,
    data: { line_item: item },
  };
}

// The token embedded in every line-item description so a re-run / re-approval
// can't create a duplicate — same idea as the payroll flow's [TC:<id>].
// Takes anything with an `expense_id`.
export function dedupToken(x) {
  return `[EXP:${x.expense_id}]`;
}

// Given the project's existing direct-cost line items (raw array from
// GET /rest/v1.0/projects/{id}/direct_costs/line_items), is this form already in?
export function alreadyPosted(existingLineItems, submission) {
  const hay = JSON.stringify(existingLineItems || []);
  return hay.includes(dedupToken(submission));
}

// Resuming a Direct Cost that got its header (and maybe some lines) but not all of them: which of the
// line items we built are NOT on it yet? `have` is the DC's line_items as Procore returns them;
// `built` is the array from buildDirectCostLineItem. A built line counts as present when a not-yet-used
// existing line has the same description and amount (so two identical lines need two matches).
export function missingLineItems(have, built) {
  const pool = (Array.isArray(have) ? have : []).map((h) => ({
    description: String(h?.description || ""),
    amount: Number(h?.unit_cost ?? h?.amount),
    used: false,
  }));
  return built.filter((li) => {
    const want = li.data?.line_item || {};
    const hit = pool.find((p) => !p.used && p.description === String(want.description || "") && Math.abs(p.amount - Number(want.unit_cost)) < 0.005);
    if (hit) { hit.used = true; return false; }
    return true;
  });
}
