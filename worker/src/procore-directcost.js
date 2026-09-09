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
export const EINBAU_VENDOR_ID = 562949959021641; // CONFIRMED (payroll flow)

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
export async function listProjectWbsCodes(env, token, procoreFetch, projectId) {
  const raw = await procoreFetch(
    env, token,
    `/rest/v1.0/projects/${projectId}/wbs_codes`,
    { method: "GET" }
  );
  const rows = Array.isArray(raw) ? raw : raw?.data || [];
  return rows
    .filter((w) => w && w.status !== "inactive" && w.flat_code)
    .map((w) => ({
      id: String(w.id ?? ""),
      code: String(w.flat_code),
      description: String(w.flat_name || w.description || ""),
    }))
    .filter((r) => r.id && r.code);
}

// Turn a chosen flat code (or the category default) into this project's
// wbs_code_id. `explicitChoice` is what the reviewer picked in the app — either a
// flat-code string or a raw wbs_code_id; both are accepted.
export async function resolveWbsCodeId(env, token, procoreFetch, projectId, category, explicitChoice) {
  const codes = await listProjectWbsCodes(env, token, procoreFetch, projectId);

  // Reviewer picked a raw id straight from the dropdown — trust it if it's real.
  if (explicitChoice && codes.some((c) => c.id === String(explicitChoice))) {
    return String(explicitChoice);
  }

  const wantedFlat = explicitChoice || CATEGORY_TO_WBS_CODE[category];
  if (!wantedFlat) {
    throw new Error(
      `Category "${category}" has no default cost code — pick one in the app before approving.`
    );
  }

  const wanted = normalizeCode(wantedFlat);
  const costPart = wanted.split(".")[0];
  const hit =
    codes.find((c) => normalizeCode(c.code) === wanted) ||
    codes.find((c) => normalizeCode(c.code).startsWith(costPart));

  if (!hit) {
    throw new Error(
      `Project ${projectId} has no budget line matching "${wantedFlat}" (category "${category}"). ` +
      `Its budget may not be set up for expense coding, or a different code needs to be selected.`
    );
  }
  return hit.id;
}

// One header per emailed expense form. The amounts live on the line items.
export function buildDirectCostHeader(submission, { employeeId = null } = {}) {
  const date =
    submission.header_date || submission.receipt_date || new Date().toISOString().slice(0, 10);
  const item = {
    direct_cost_type: DIRECT_COST_TYPE,
    status: "approved",
    direct_cost_date: date,
    received_date: date,
    invoice_number: submission.expense_id, // CONFIRMED (Ben): the form's Expense ID
    vendor_id: EINBAU_VENDOR_ID,
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
export function buildDirectCostLineItem(line, wbsCodeId, expenseId) {
  const net = Number(line.net_amount);
  if (!Number.isFinite(net) || net <= 0) {
    throw new Error(`Refusing to build a line item with net_amount=${line.net_amount}`);
  }
  const label = (line.description || line.category || "expense").toString().slice(0, 120);
  return {
    method: "POST",
    // caller substitutes {dc_id}
    pathTemplate: `/rest/v1.0/projects/${line.project_procore_id}/direct_costs/{dc_id}/line_items`,
    data: {
      line_item: {
        wbs_code_id: String(wbsCodeId),
        description: `${label} ${dedupToken({ expense_id: expenseId })}`,
        quantity: 1,
        unit_cost: net.toFixed(2),
        uom: "each", // TODO(ben): payroll uses "hours"; confirm the unit for a lump expense
      },
    },
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
