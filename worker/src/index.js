// tally-worker
//
// One `submissions` row per emailed Employee Expense Form; many `line_items`
// (one per expense row); many `receipts` (one per attachment). TALLY parses the
// form PDF into line items, parses each receipt, matches lines to receipts, and
// derives the net (pre-tax) amount per line from the matched receipt. On approval
// a form becomes one Procore Direct Cost header + one line item per expense row.
//
// Routes:
//   POST   /intake                              (X-Tally-Service-Key) PA forwards one email + attachments
//   GET    /submissions?status=                 (Einbau ID) queue list — per-form summary
//   GET    /submissions/:id                     (Einbau ID) { submission, line_items[], receipts[] }
//   GET    /submissions/:id/receipt?key=        (Einbau ID) stream an attachment from R2 (private bucket)
//   GET    /submissions/:id/cost-codes          (Einbau ID) project WBS codes + per-category defaults
//   POST   /submissions/:id/lines               (Einbau ID) add a line by hand
//   PATCH  /submissions/:id/lines/:lineId       (Einbau ID) edit a line { line_date?, description?, category?, gross_amount?, net_amount?, cost_code? }
//   DELETE /submissions/:id/lines/:lineId       (Einbau ID) remove a line
//   POST   /submissions/:id/lines/:lineId/match (Einbau ID) { receipt_id } -> attach a receipt, recompute net
//   POST   /submissions/:id/lines/:lineId/unmatch (Einbau ID) detach the receipt
//   POST   /submissions/:id/approve[?dryRun=1]  (Einbau ID) build 1 DC header + N line items, post at net
//   POST   /submissions/:id/request-revision    (Einbau ID) { note } -> needs_revision + a copy-ready reply
//   POST   /submissions/:id/reject              (Einbau ID) { reason } -> rejected
//   GET    /projects                            (Einbau ID) cached active-project list
//   POST   /admin/refresh-projects              (Einbau ID, admin) refresh projects_cache now
//   GET    /admin/procore-probe?path=           (Einbau ID, admin) proxy an arbitrary Procore GET (diagnostic)
//   scheduled (cron 0 */6 * * *)                refresh projects_cache from Procore
//
// Secrets: DATABASE_URL, ANTHROPIC_API_KEY, TALLY_SERVICE_KEY, PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET
//
// Design notes:
//  - Power Automate does intake ONLY. All parsing / validation / storage / the
//    Procore write live here.
//  - Claude is an accelerator, never a dependency: if the form parse fails, the
//    submission still lands (flag `claude_failed` / `form_parse_failed`) and the
//    reviewer builds the lines and matches receipts by hand.
//  - Claude reads the gross + tax printed on each receipt. FALLBACK_TAX_RATES is
//    a last resort for receipts that don't itemize tax — anything derived from it
//    is flagged `tax_estimated`.
//  - Procore receives the NET (pre-tax) amount. Tax is applied downstream in NetSuite.

import { neon } from "@neondatabase/serverless";
import {
  CATEGORY_TO_WBS_CODE,
  DIRECTCOST_VERIFIED,
  alreadyPosted,
  buildDirectCostHeader,
  buildDirectCostLineItem,
  listProjectWbsCodes,
  resolveWbsCodeId,
} from "./procore-directcost.js";

// Proven working on this Anthropic key in scout-worker. Bump when the suite moves.
const VISION_MODEL = "claude-sonnet-4-6";

// The two Procore stages that count as "not active" — identical to punch-worker's
// Stage Enforcer, on purpose.
const INACTIVE_STAGES = new Set(["On Hold", "Completed and Invoiced"]);

const LOW_CONFIDENCE_THRESHOLD = 0.75;
const MAX_RECEIPTS = 12; // parser handles this many cleanly; overflow is flagged

// The six columns on Einbau's Employee Expense Form.
const CATEGORIES = new Set(["parking", "materials", "fuel", "mileage", "per_diem", "other"]);
// Flat claim: no receipt, net = gross, no tax (per diem = daily allowance, mileage = km*rate).
const NO_RECEIPT_CATEGORIES = new Set(["per_diem", "mileage"]);
// Location should sit near the job site — applied only to these.
const SITE_TIED_CATEGORIES = new Set(["fuel", "parking", "per_diem", "mileage"]);

function normalizeCategory(raw) {
  const c = (raw || "").toLowerCase().trim().replace(/\s+/g, "_");
  const aliases = { gas: "fuel", fuel_$: "fuel", material: "materials", "per-diem": "per_diem", perdiem: "per_diem" };
  const mapped = aliases[c] || c;
  return CATEGORIES.has(mapped) ? mapped : "other";
}

// FALLBACK ONLY. Combined sales-tax rate (%) to back a net out of a gross when a
// receipt doesn't itemize tax. Province-level; deliberately coarse; always flagged.
const FALLBACK_TAX_RATES = {
  AB: 5, BC: 12, MB: 12, NB: 15, NL: 15, NS: 15, NT: 5,
  NU: 5, ON: 13, PE: 15, QC: 14.975, SK: 11, YT: 5,
};

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // tighten to the GitHub Pages origin once live
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tally-Service-Key",
    "Access-Control-Expose-Headers": "X-Refreshed-Token",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function stripHtml(text) {
  if (!text) return "";
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Fields /intake reads out of a JSON body — anchors for the salvage scan below
// (Power Automate often sends JSON that won't JSON.parse because raw HTML / quotes
// leak unescaped into string values).
const INTAKE_STRING_FIELDS = [
  "subject", "from", "body", "expense_id", "invoice_number",
  "employee_name", "employee_email", "province", "project_number",
];

function salvageByFieldBoundaries(raw) {
  const positions = [];
  for (const field of INTAKE_STRING_FIELDS) {
    const re = new RegExp(`"${field}"\\s*:\\s*"`, "g");
    let m;
    while ((m = re.exec(raw))) {
      positions.push({ field, keyStart: m.index, valueStart: m.index + m[0].length });
    }
  }
  if (positions.length === 0) return null;
  positions.sort((a, b) => a.valueStart - b.valueStart);

  const result = {};
  for (let i = 0; i < positions.length; i++) {
    const { field, valueStart } = positions[i];
    const nextKeyStart = i + 1 < positions.length ? positions[i + 1].keyStart : raw.length;
    let value = raw.slice(valueStart, nextKeyStart);
    value = value.replace(/[\s,}]*$/, "");
    if (value.endsWith('"')) value = value.slice(0, -1);
    value = value
      .replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t")
      .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    result[field] = value;
  }
  return result.subject || result.body ? result : null;
}

async function parseBody(request) {
  const raw = await request.text();
  try {
    return JSON.parse(raw);
  } catch (e) {
    const salvaged = salvageByFieldBoundaries(raw);
    if (salvaged) return salvaged;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        /* fall through */
      }
    }
    throw new Error(`Could not parse request body: ${raw.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function requireLogin(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { ok: false, reason: "No session token was sent with the request." };
  try {
    // Service binding, not a public fetch — a Worker calling another Worker's
    // *.workers.dev URL directly is blocked with Cloudflare error 1042.
    const res = await env.AUTH_WORKER.fetch("https://auth.ben-a90.workers.dev/auth/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "(no body)");
      return { ok: false, reason: `auth-worker rejected the verify call (HTTP ${res.status}): ${bodyText.slice(0, 200)}` };
    }
    const data = await res.json();
    if (!data.valid) return { ok: false, reason: "Session is invalid or expired — please log in again." };
    if (!data.user) return { ok: false, reason: "auth-worker returned no user for this session." };

    // TALLY is used by a named few (Ben + Josh). ALLOWED_USERS is the real gate —
    // a comma list of Einbau ID usernames. ALLOWED_ROLES stays as a coarser
    // fallback when ALLOWED_USERS isn't set.
    const allowedUsers = String(env.ALLOWED_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowedUsers.length) {
      if (!allowedUsers.includes(String(data.user.username || "").toLowerCase())) {
        return { ok: false, reason: `TALLY is limited to specific users — "${data.user.username}" isn't one of them.` };
      }
    } else {
      const allowedRoles = String(env.ALLOWED_ROLES || "admin,user").split(",").map((r) => r.trim());
      if (!allowedRoles.includes(data.user.role)) {
        return { ok: false, reason: `Logged in as "${data.user.username}" (role "${data.user.role}"), which isn't allowed in TALLY.` };
      }
    }
    return { ok: true, user: data.user, refreshedToken: data.refreshedToken || null };
  } catch (e) {
    return { ok: false, reason: `Couldn't reach auth-worker: ${e.message}` };
  }
}

function isServiceCaller(request, env) {
  const key = request.headers.get("X-Tally-Service-Key");
  return Boolean(key) && Boolean(env.TALLY_SERVICE_KEY) && key === env.TALLY_SERVICE_KEY;
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

function sqlFor(env) {
  return neon(env.DATABASE_URL);
}

// ---------------------------------------------------------------------------
// Claude — parse the form PDF + all receipts in one call
// ---------------------------------------------------------------------------

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in Claude's response: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

const FORM_PROMPT = `You are given ONE Einbau "Employee Expense Form" (usually a PDF) and ZERO OR MORE receipt images, each labelled "RECEIPT <n>:".

Return ONLY a JSON object, no prose, no markdown fences:
{
  "form": {
    "expense_id": string | null,        // the "Expense ID" field, format DDMMYY-JJJJJ-EEEE
    "employee_name": string | null,
    "project_number": string | null,    // format YYYY_NNNN
    "province": string | null,          // 2-letter code (ON, QC, BC, AB, ...)
    "line_items": [
      { "row": number,                  // 1-based row order on the form
        "date": "YYYY-MM-DD" | null,
        "description": string,
        "category": "parking" | "materials" | "fuel" | "mileage" | "per_diem" | "other",
        "gross": number }               // amount entered in that column (tax-in)
    ]
  },
  "receipts": [
    { "index": number,                  // the <n> from "RECEIPT <n>:"
      "vendor": string | null,
      "date": "YYYY-MM-DD" | null,
      "subtotal": number | null,        // pre-tax amount as printed
      "tax_lines": [ { "label": string, "amount": number } ],  // each printed tax line; [] if none
      "gross": number | null,           // total charged
      "confidence": number }            // 0..1 in the numbers above
  ],
  "matches": [
    { "row": number, "receipt_index": number | null, "confidence": number }
    // best guess which receipt backs each form row: amount first, then vendor vs
    // the row description, then date. null if unsure. mileage / per_diem never have one.
  ]
}

Rules:
- Read numbers exactly as printed. Never infer tax that isn't shown.
- One line_item per row the employee filled in — the amount is in exactly one of the
  six category columns (Parking $, Materials $, Fuel $, Mileage (KM), Per Diem $, Other $).
- IGNORE the "For Office Use Only" block (Subtotal / Net Total / Expense Total) and the
  "Authorized By" / "Date Authorized" fields — those are handled downstream, not by you.
- If the form is missing or unreadable, return "form" with null fields and "line_items": [].
- If a receipt is unreadable, still include its entry with nulls and confidence 0.`;

function attBlock(a) {
  const b64 = String(a.base64 || "").replace(/^data:[^,]+,/, "").replace(/\s/g, "");
  if ((a.contentType || "").toLowerCase().includes("pdf")) {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };
  }
  let mt = (a.contentType || "image/jpeg").toLowerCase();
  if (!/^image\/(jpe?g|png|gif|webp)$/.test(mt)) mt = "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: mt, data: b64 } };
}

async function parseFormAndReceipts(env, formAtt, receiptAtts) {
  const content = [];
  if (formAtt) {
    content.push({ type: "text", text: "FORM (Einbau Employee Expense Form):" });
    content.push(attBlock(formAtt));
  } else {
    content.push({ type: "text", text: "FORM: (not attached)" });
  }
  receiptAtts.forEach((a, i) => {
    content.push({ type: "text", text: `RECEIPT ${i}:` });
    content.push(attBlock(a));
  });
  content.push({ type: "text", text: FORM_PROMPT });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 4096, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const tb = (data.content || []).find((b) => b.type === "text");
  if (!tb) throw new Error("Anthropic returned no text block");
  return extractJSON(tb.text.replace(/```json|```/g, "").trim());
}

// ---------------------------------------------------------------------------
// Procore
// ---------------------------------------------------------------------------

async function getProcoreToken(env) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.PROCORE_CLIENT_ID,
    client_secret: env.PROCORE_CLIENT_SECRET,
  });
  const res = await fetch("https://login.procore.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Procore token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function procoreFetch(env, token, path, { method = "GET", body } = {}) {
  const res = await fetch(`${env.PROCORE_API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Procore-Company-Id": env.PROCORE_COMPANY_ID,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : { success: res.ok, status: res.status };
  if (!res.ok) {
    const err = new Error(`Procore ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function fetchProcoreProjects(env, token) {
  const projects = [];
  let page = 1;
  const perPage = 100;
  while (page <= 20) {
    const batch = await procoreFetch(
      env, token,
      `/rest/v1.0/projects?company_id=${env.PROCORE_COMPANY_ID}&page=${page}&per_page=${perPage}`
    );
    if (!Array.isArray(batch)) break;
    projects.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return projects;
}

async function refreshProjectsCache(env, sql) {
  const token = await getProcoreToken(env);
  const projects = await fetchProcoreProjects(env, token);
  const rows = projects.map((p) => ({
    procore_id: p.id,
    project_number: p.project_number || null,
    name: p.name || null,
    stage: p.project_stage?.name || p.stage || null,
    active: Boolean(p.active),
    region: p.project_region?.name || null,
    province: (p.state_code || "").toUpperCase() || null,
  }));
  await sql.transaction([
    sql`delete from projects_cache`,
    ...rows.map(
      (r) => sql`
        insert into projects_cache (procore_id, project_number, name, stage, active, region, province, refreshed_at)
        values (${r.procore_id}, ${r.project_number}, ${r.name}, ${r.stage}, ${r.active}, ${r.region}, ${r.province}, now())`
    ),
  ]);
  return rows.length;
}

async function projectForSubmission(sub, sql) {
  if (sub.project_procore_id) {
    const [p] = await sql`select * from projects_cache where procore_id = ${sub.project_procore_id} limit 1`;
    if (p) return p;
  }
  if (sub.project_number) {
    const [p] = await sql`select * from projects_cache where project_number = ${sub.project_number} limit 1`;
    return p || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// Einbau's Expense ID is DDMMYY-JJJJJ-EEEE. Prefer the form's own value (from
// Claude); fall back to a subject/body scan.
function extractExpenseId(body) {
  for (const k of ["expense_id", "invoice_number", "expenseId"]) {
    if (body[k] && String(body[k]).trim()) return String(body[k]).trim();
  }
  const hay = `${body.subject || ""}\n${stripHtml(body.body || "").slice(0, 500)}`;
  const m =
    hay.match(/\b\d{6}-[A-Za-z0-9]{2,}-[A-Za-z0-9]{2,}\b/) ||
    hay.match(/\b(?:EXP|INV)[-_ ]?(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,}\b/i);
  return m ? m[0].trim() : null;
}

function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]+,/, "").replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function normalizeAttachments(body) {
  const list = body.attachments || body.attachment || [];
  const arr = Array.isArray(list) ? list : [list];
  return arr
    .filter(Boolean)
    .map((a, i) => ({
      name: (a.name || a.fileName || `attachment-${i}`).replace(/[^\w.\- ]+/g, "_"),
      contentType: a.contentType || a.contentBytesType || "application/octet-stream",
      base64: a.contentBytes || a.content || a.$content || a.data || "",
    }))
    .filter((a) => a.base64);
}

function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, "");
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function sumTaxLines(taxLines) {
  if (!Array.isArray(taxLines)) return 0;
  return Math.round(taxLines.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100;
}

function historyEvent(type, text) {
  return { at: new Date().toISOString(), type, text };
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// matching + net derivation (pure — unit-tested)
// ---------------------------------------------------------------------------

// lines: [{ row_index, category, is_flat_claim, gross_amount, description, line_date }]
// receipts: [{ id, idx, vendor, gross, receipt_date, subtotal, tax_json }]
// claudeMatches: [{ row, receipt_index, confidence }]
// returns Map(row_index -> { receipt_id, method, confidence, flag })
function matchLinesToReceipts(lines, receipts, claudeMatches = []) {
  const result = new Map();
  const taken = new Set();
  const eligible = lines.filter((l) => !l.is_flat_claim);

  const days = (a, b) => (a && b ? Math.abs((new Date(a) - new Date(b)) / 86400000) : Infinity);
  const vendorHit = (vendor, desc) => {
    if (!vendor || !desc) return false;
    const d = String(desc).toLowerCase();
    return String(vendor).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3).some((t) => d.includes(t));
  };
  const amountExact = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= 0.01;
  const claudeSuggests = (row, ridx) =>
    claudeMatches.some((m) => Number(m.row) === Number(row) && m.receipt_index != null && Number(m.receipt_index) === Number(ridx));

  const cands = [];
  for (const l of eligible) {
    for (const r of receipts) {
      if (!amountExact(l.gross_amount, r.gross)) continue;
      const vh = vendorHit(r.vendor, l.description);
      const dc = days(l.line_date, r.receipt_date) <= 3;
      const cs = claudeSuggests(l.row_index, r.idx);
      cands.push({ line: l, receipt: r, corroborated: vh || dc || cs, score: 10 + (vh ? 3 : 0) + (dc ? 2 : 0) + (cs ? 1 : 0) });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  // pass 1 — corroborated, greedy 1:1
  for (const c of cands) {
    if (!c.corroborated) continue;
    if (result.has(c.line.row_index) || taken.has(c.receipt.id)) continue;
    result.set(c.line.row_index, { receipt_id: c.receipt.id, method: "auto", confidence: Math.min(1, c.score / 15), flag: null });
    taken.add(c.receipt.id);
  }

  // pass 2 — amount only
  for (const l of eligible) {
    if (result.has(l.row_index)) continue;
    const amtMatches = receipts.filter((r) => !taken.has(r.id) && amountExact(l.gross_amount, r.gross));
    if (amtMatches.length === 1) {
      result.set(l.row_index, {
        receipt_id: amtMatches[0].id, method: "auto", confidence: 0.4,
        flag: { code: "low_confidence_match", severity: "medium", detail: "Matched on amount alone — confirm the receipt is right." },
      });
      taken.add(amtMatches[0].id);
    } else if (amtMatches.length > 1) {
      result.set(l.row_index, {
        receipt_id: null, method: "none", confidence: null,
        flag: { code: "ambiguous_match", severity: "high", detail: `${amtMatches.length} receipts share this amount — match it by hand.` },
      });
    }
  }
  return result;
}

// receipt: a receipts row (tax_json) OR a claude receipt object (tax_lines). Either.
function deriveLineNet(line, receipt, province) {
  if (line.is_flat_claim) {
    const g = money(line.gross_amount);
    return { net: g, tax: g == null ? null : 0, tax_source: "none" };
  }
  if (!receipt) return { net: null, tax: null, tax_source: "none" };

  const taxLines = receipt.tax_json || receipt.tax_lines;
  const taxRead = sumTaxLines(taxLines);
  const rGross = money(receipt.gross) ?? money(line.gross_amount);
  const rSub = money(receipt.subtotal);

  if (Array.isArray(taxLines) && taxLines.length > 0 && taxRead > 0) {
    const net = rSub != null ? rSub : rGross != null ? round2(rGross - taxRead) : null;
    return { net, tax: taxRead, tax_source: "read" };
  }
  if (rGross != null && province && FALLBACK_TAX_RATES[province] != null) {
    const rate = FALLBACK_TAX_RATES[province] / 100;
    const net = round2(rGross / (1 + rate));
    return { net, tax: round2(rGross - net), tax_source: "fallback_table" };
  }
  return { net: null, tax: null, tax_source: "none" };
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

function computeFormFlags(sub, project, receipts, lines) {
  const flags = [];
  const add = (code, severity, detail) => flags.push({ code, severity, detail });

  if (!sub.project_number) add("project_missing", "high", "No project number on the form.");
  else if (!project) add("project_invalid", "high", `Project "${sub.project_number}" isn't in the projects cache.`);
  else if (project.active === false) add("project_inactive", "high", `Project not active in Procore (stage "${project.stage || "?"}").`);
  else if (INACTIVE_STAGES.has(project.stage)) add("project_inactive", "high", `Project stage is "${project.stage}".`);

  if (!lines || lines.length === 0) add("form_parse_failed", "high", "No expense lines — build them by hand.");

  const realReceipts = (receipts || []).filter((r) => r.kind === "receipt");
  const used = new Set((lines || []).map((l) => l.receipt_id).filter(Boolean));
  const orphans = realReceipts.filter((r) => !used.has(r.id));
  if (orphans.length) add("receipt_orphan", "medium", `${orphans.length} receipt(s) not matched to any line.`);
  if (realReceipts.length > MAX_RECEIPTS) add("too_many_receipts", "medium", `${realReceipts.length} receipts — over the ${MAX_RECEIPTS} the parser handles cleanly.`);

  return flags;
}

function computeLineFlags(line, receipt, formProvince, project) {
  const flags = [];
  const add = (code, severity, detail) => flags.push({ code, severity, detail });
  const flat = line.is_flat_claim;

  if (!flat && !line.receipt_id) add("receipt_unmatched", "high", "No receipt matched to this line.");
  if (!flat && line.receipt_id) {
    if (line.tax_source === "fallback_table") add("tax_estimated", "high", "Net is a province-rate estimate — the receipt didn't itemize tax.");
    if (line.tax_source === "none") add("tax_unknown", "high", "Receipt matched but no tax figure could be read.");
  }

  if (receipt) {
    const lg = money(line.gross_amount), rg = money(receipt.gross);
    if (lg !== null && rg !== null && Math.abs(lg - rg) > 0.02)
      add("amount_mismatch", "medium", `Form line ${lg} vs receipt total ${rg}.`);
    const ln = money(line.net_amount), lt = money(line.tax_amount);
    if (lg !== null && ln !== null && lt !== null && Math.abs(ln + lt - lg) > 0.02)
      add("amount_mismatch", "low", `net ${ln} + tax ${lt} != gross ${lg}.`);
    const conf = receipt.confidence;
    if (conf != null && Number(conf) < LOW_CONFIDENCE_THRESHOLD)
      add("low_confidence", "medium", `Receipt read confidence ${conf}.`);
  }

  if (SITE_TIED_CATEGORIES.has(line.category) && project && formProvince && project.province &&
      String(formProvince).toUpperCase() !== String(project.province).toUpperCase())
    add("geo_mismatch", "medium", `${line.category} on a ${project.province} project, form says ${formProvince}.`);

  return flags;
}

// ---------------------------------------------------------------------------
// /intake
// ---------------------------------------------------------------------------

async function handleIntake(request, env, sql) {
  const body = await parseBody(request);
  const rawEmail = body.body || null;
  const fromEmail = body.employee_email || body.from || null;

  const atts = normalizeAttachments(body);
  const formAtt = atts.find((a) => (a.contentType || "").toLowerCase().includes("pdf")) || null;
  const receiptAtts = atts.filter((a) => a !== formAtt).slice(0, MAX_RECEIPTS);
  const storeAtts = formAtt ? [formAtt, ...receiptAtts] : [...receiptAtts];

  // Best-effort parse — failure must not block intake.
  let claude = null, claudeError = null;
  try {
    claude = await parseFormAndReceipts(env, formAtt, receiptAtts);
  } catch (e) {
    claudeError = e.message;
  }
  const form = (claude && claude.form) || {};
  const claudeReceipts = claude && Array.isArray(claude.receipts) ? claude.receipts : [];
  const claudeMatches = claude && Array.isArray(claude.matches) ? claude.matches : [];

  const expenseId = (form.expense_id && String(form.expense_id).trim()) || extractExpenseId(body);
  if (!expenseId) {
    return json({ error: "no_expense_id", detail: "No Expense ID on the form or in the email." }, 422);
  }

  // Revision-loop dedup — a reply carrying the same Expense ID merges onto the row.
  const [existing] = await sql`select * from submissions where expense_id = ${expenseId}`;
  if (existing) {
    const note = stripHtml(rawEmail || "").slice(0, 500);
    const reopened = existing.status === "approved" || existing.status === "rejected";
    const hist = [...(existing.history || []), historyEvent("reply_received", note || "(reply, no readable body)")];
    const fl = reopened
      ? [...(existing.flags || []), { code: "reply_on_closed", severity: "high", detail: `Reply on an already-${existing.status} form.` }]
      : existing.flags;
    const [u] = await sql`
      update submissions set history = ${JSON.stringify(hist)}::jsonb, flags = ${JSON.stringify(fl)}::jsonb,
        status = 'needs_review', updated_at = now()
      where id = ${existing.id} returning id, expense_id, status`;
    return json({ merged: true, submission: u }, 200);
  }

  const projectNumber =
    (form.project_number && String(form.project_number).trim()) ||
    (body.project_number && String(body.project_number).trim()) || null;
  let project = null;
  if (projectNumber) {
    const [p] = await sql`select * from projects_cache where project_number = ${projectNumber} limit 1`;
    project = p || null;
  }
  const province = ((form.province || body.province || "") + "").toUpperCase().slice(0, 2) || null;
  const employeeName = form.employee_name || body.employee_name || null;

  // Store every attachment to R2 (private bucket).
  await Promise.all(
    storeAtts.map((a) =>
      env.RECEIPTS.put(`${expenseId}/${a.name}`, base64ToBytes(a.base64), { httpMetadata: { contentType: a.contentType } })
    )
  );

  const history = [historyEvent("intake", `Received from ${fromEmail || "(unknown)"}${claudeError ? ` — parse error: ${claudeError}` : ""}.`)];
  const [sub] = await sql`
    insert into submissions
      (expense_id, employee_name, employee_email, province, project_number, project_procore_id, project_name, project_stage, status, flags, raw_email, history, submitted_at)
    values
      (${expenseId}, ${employeeName}, ${fromEmail}, ${province}, ${projectNumber}, ${project?.procore_id || null}, ${project?.name || null}, ${project?.stage || null}, 'needs_review', '[]'::jsonb, ${rawEmail}, ${JSON.stringify(history)}::jsonb, now())
    returning *`;

  // Receipts (form first, then receipts in order) — one transaction.
  const receiptSpecs = [];
  if (formAtt) receiptSpecs.push({ att: formAtt, kind: "form", idx: null, c: {} });
  receiptAtts.forEach((a, i) => {
    receiptSpecs.push({ att: a, kind: "receipt", idx: i, c: claudeReceipts.find((r) => Number(r.index) === i) || {} });
  });
  const receiptRows = [];
  if (receiptSpecs.length) {
    const results = await sql.transaction(
      receiptSpecs.map((s) => sql`
        insert into receipts (submission_id, r2_key, kind, vendor, receipt_date, subtotal, tax_json, gross, currency, confidence)
        values (${sub.id}, ${`${expenseId}/${s.att.name}`}, ${s.kind}, ${s.c.vendor || null}, ${s.c.date || null},
                ${money(s.c.subtotal)}, ${s.c.tax_lines ? JSON.stringify(s.c.tax_lines) : null}::jsonb, ${money(s.c.gross)},
                ${(s.c.currency || "CAD")}, ${Number.isFinite(Number(s.c.confidence)) ? Number(s.c.confidence) : null})
        returning *`)
    );
    results.forEach((r, i) => receiptRows.push({ ...r[0], _idx: receiptSpecs[i].idx }));
  }

  // Form lines → match → net → insert.
  const formLines = Array.isArray(form.line_items) ? form.line_items : [];
  const lines = formLines.map((li, i) => {
    const category = normalizeCategory(li.category);
    return {
      row_index: Number.isFinite(Number(li.row)) ? Number(li.row) : i + 1,
      line_date: li.date || null,
      description: (li.description || "").toString().slice(0, 500),
      category,
      is_flat_claim: NO_RECEIPT_CATEGORIES.has(category),
      gross_amount: money(li.gross),
    };
  });
  const receiptsForMatch = receiptRows
    .filter((r) => r.kind === "receipt")
    .map((r) => ({ id: r.id, idx: r._idx, vendor: r.vendor, gross: r.gross, receipt_date: r.receipt_date, subtotal: r.subtotal, tax_json: r.tax_json }));
  const matches = matchLinesToReceipts(lines, receiptsForMatch, claudeMatches);

  const lineInserts = lines.map((l) => {
    const mm = matches.get(l.row_index) || null;
    const receiptId = mm?.receipt_id || null;
    const receiptRow = receiptId ? receiptRows.find((r) => r.id === receiptId) : null;
    const d = deriveLineNet(l, receiptRow, province);
    const lf = computeLineFlags(
      { ...l, receipt_id: receiptId, net_amount: d.net, tax_amount: d.tax, tax_source: d.tax_source },
      receiptRow, province, project
    );
    if (mm?.flag) lf.unshift(mm.flag);
    return sql`
      insert into line_items
        (submission_id, row_index, line_date, description, category, is_flat_claim, gross_amount, tax_amount, net_amount, tax_source,
         receipt_id, match_method, match_confidence, cost_code, flags, employee_name, project_number, project_procore_id)
      values
        (${sub.id}, ${l.row_index}, ${l.line_date}, ${l.description}, ${l.category}, ${l.is_flat_claim}, ${l.gross_amount}, ${d.tax}, ${d.net}, ${d.tax_source},
         ${receiptId}, ${mm?.method || "none"}, ${mm?.confidence ?? null}, ${""}, ${JSON.stringify(lf)}::jsonb, ${employeeName}, ${projectNumber}, ${project?.procore_id || null})`;
  });
  if (lineInserts.length) await sql.transaction(lineInserts);

  const linesMini = lines.map((l) => ({ receipt_id: matches.get(l.row_index)?.receipt_id || null }));
  const formFlags = computeFormFlags(sub, project, receiptRows.map((r) => ({ id: r.id, kind: r.kind })), linesMini);
  if (claudeError) formFlags.unshift({ code: "claude_failed", severity: "high", detail: `Automatic parsing failed: ${claudeError}. Build the lines by hand.` });
  await sql`update submissions set flags = ${JSON.stringify(formFlags)}::jsonb, updated_at = now() where id = ${sub.id}`;

  return json({ created: true, submission: { id: sub.id, expense_id: expenseId, status: "needs_review", line_count: lines.length, flags: formFlags } }, 201);
}

// ---------------------------------------------------------------------------
// review-queue routes
// ---------------------------------------------------------------------------

const SUB_SUMMARY = `
  s.id, s.expense_id, s.employee_name, s.employee_email, s.province,
  s.project_number, s.project_name, s.project_stage, s.status, s.flags,
  s.reviewed_by, s.reviewed_at, s.procore_direct_cost_id, s.submitted_at, s.created_at, s.updated_at`;

async function handleList(url, sql) {
  const status = url.searchParams.get("status");
  const rows = status
    ? await sql`
        select ${sql.unsafe(SUB_SUMMARY)},
               coalesce(li.n, 0) as line_count, coalesce(li.net_total, 0) as net_total,
               coalesce(li.flag_count, 0) as line_flag_count
        from submissions s
        left join (
          select submission_id, count(*) n, sum(net_amount) net_total, sum(jsonb_array_length(flags)) flag_count
          from line_items group by submission_id
        ) li on li.submission_id = s.id
        where s.status = ${status}
        order by s.created_at desc limit 500`
    : await sql`
        select ${sql.unsafe(SUB_SUMMARY)},
               coalesce(li.n, 0) as line_count, coalesce(li.net_total, 0) as net_total,
               coalesce(li.flag_count, 0) as line_flag_count
        from submissions s
        left join (
          select submission_id, count(*) n, sum(net_amount) net_total, sum(jsonb_array_length(flags)) flag_count
          from line_items group by submission_id
        ) li on li.submission_id = s.id
        order by s.created_at desc limit 500`;
  return json({ submissions: rows });
}

async function handleDetail(id, sql) {
  const [sub] = await sql`select * from submissions where id = ${id}`;
  if (!sub) return json({ error: "not_found" }, 404);
  const line_items = await sql`select * from line_items where submission_id = ${id} order by row_index asc nulls last, created_at asc`;
  const receipts = await sql`
    select id, submission_id, r2_key, kind, vendor, receipt_date, subtotal, tax_json, gross, currency, confidence, created_at
    from receipts where submission_id = ${id} order by (kind = 'form') desc, created_at asc`;
  return json({ submission: sub, line_items, receipts });
}

async function handleReceipt(id, url, env, sql) {
  const key = url.searchParams.get("key");
  if (!key) return json({ error: "key_required" }, 400);
  const [r] = await sql`select r2_key from receipts where submission_id = ${id} and r2_key = ${key} limit 1`;
  if (!r) return json({ error: "key_not_on_submission" }, 403);
  const obj = await env.RECEIPTS.get(key);
  if (!obj) return json({ error: "object_missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Project WBS codes for the review UI's per-line cost-code pickers, plus the
// resolved default for each category so a line pre-selects the right one.
async function handleCostCodes(id, env, sql) {
  const [sub] = await sql`select project_procore_id from submissions where id = ${id}`;
  if (!sub) return json({ error: "not_found" }, 404);
  if (!sub.project_procore_id) return json({ error: "no_project", detail: "Form isn't linked to a Procore project." }, 422);

  const token = await getProcoreToken(env);
  let codes = [];
  try {
    codes = await listProjectWbsCodes(env, token, procoreFetch, sub.project_procore_id);
  } catch (e) {
    return json({ error: "procore_lookup_failed", detail: e.message }, 502);
  }
  const norm = (s) => String(s || "").replace(/\s/g, "").toLowerCase();
  const defaults = {};
  for (const [cat, flat] of Object.entries(CATEGORY_TO_WBS_CODE)) {
    if (!flat) { defaults[cat] = { flat_code: null, wbs_code_id: null }; continue; }
    const hit = codes.find((c) => norm(c.code) === norm(flat)) ||
                codes.find((c) => norm(c.code).startsWith(norm(flat).split(".")[0]));
    defaults[cat] = { flat_code: flat, wbs_code_id: hit?.id || null };
  }
  return json({ codes, defaults });
}

// ---------------------------------------------------------------------------
// line CRUD + matching
// ---------------------------------------------------------------------------

async function recomputeFormFlags(sql, submissionId) {
  const [sub] = await sql`select * from submissions where id = ${submissionId}`;
  if (!sub) return [];
  const lines = await sql`select id, receipt_id, category, is_flat_claim from line_items where submission_id = ${submissionId}`;
  const receipts = await sql`select id, kind from receipts where submission_id = ${submissionId}`;
  const project = await projectForSubmission(sub, sql);
  // preserve any parse-failure flag that isn't recomputable
  const keep = (sub.flags || []).filter((f) => f.code === "claude_failed");
  const flags = [...keep, ...computeFormFlags(sub, project, receipts, lines)];
  await sql`update submissions set flags = ${JSON.stringify(flags)}::jsonb, updated_at = now() where id = ${submissionId}`;
  return flags;
}

async function bumpForm(sql, submissionId, event) {
  await sql`
    update submissions
    set history = coalesce(history, '[]'::jsonb) || ${JSON.stringify([event])}::jsonb,
        status = case when status in ('approved', 'rejected') then status else 'needs_review' end,
        updated_at = now()
    where id = ${submissionId}`;
}

async function handleLineAdd(subId, request, sql, user) {
  const body = await parseBody(request).catch(() => ({}));
  const category = normalizeCategory(body.category);
  if (!CATEGORIES.has(category)) return json({ error: "bad_category" }, 400);
  const [sub] = await sql`select * from submissions where id = ${subId}`;
  if (!sub) return json({ error: "not_found" }, 404);

  const gross = money(body.gross_amount);
  const isFlat = NO_RECEIPT_CATEGORIES.has(category);
  const line = {
    line_date: body.line_date || null,
    description: (body.description || "").toString().slice(0, 500),
    category, is_flat_claim: isFlat,
    gross_amount: gross,
  };
  const d = deriveLineNet(line, null, sub.province);
  const project = await projectForSubmission(sub, sql);
  const lf = computeLineFlags({ ...line, receipt_id: null, net_amount: d.net, tax_amount: d.tax, tax_source: d.tax_source }, null, sub.province, project);
  const [{ max }] = await sql`select coalesce(max(row_index), 0) as max from line_items where submission_id = ${subId}`;

  const [row] = await sql`
    insert into line_items
      (submission_id, row_index, line_date, description, category, is_flat_claim, gross_amount, tax_amount, net_amount, tax_source,
       match_method, cost_code, flags, employee_name, project_number, project_procore_id)
    values
      (${subId}, ${Number(max) + 1}, ${line.line_date}, ${line.description}, ${category}, ${isFlat}, ${gross}, ${d.tax}, ${d.net}, ${d.tax_source},
       'none', ${""}, ${JSON.stringify(lf)}::jsonb, ${sub.employee_name}, ${sub.project_number}, ${sub.project_procore_id})
    returning *`;
  await bumpForm(sql, subId, historyEvent("line_added", `${user.username} added a ${category} line`));
  const form_flags = await recomputeFormFlags(sql, subId);
  return json({ line: row, form_flags });
}

async function handleLinePatch(subId, lineId, request, sql, user) {
  const body = await parseBody(request).catch(() => ({}));
  const [line] = await sql`select * from line_items where id = ${lineId} and submission_id = ${subId}`;
  if (!line) return json({ error: "not_found" }, 404);
  const [sub] = await sql`select * from submissions where id = ${subId}`;

  const next = { ...line };
  if (body.line_date !== undefined) next.line_date = body.line_date || null;
  if (body.description !== undefined) next.description = (body.description || "").toString().slice(0, 500);
  if (body.category !== undefined) {
    next.category = normalizeCategory(body.category);
    next.is_flat_claim = NO_RECEIPT_CATEGORIES.has(next.category);
  }
  if (body.gross_amount !== undefined) next.gross_amount = money(body.gross_amount);
  if (body.cost_code !== undefined) next.cost_code = (body.cost_code || "").toString();

  let receipt = null;
  if (next.is_flat_claim) {
    next.receipt_id = null;
  } else if (next.receipt_id) {
    [receipt] = await sql`select * from receipts where id = ${next.receipt_id}`;
  }

  if (body.net_amount !== undefined) {
    next.net_amount = money(body.net_amount); // manual override, keep tax_source as-is
  } else {
    const d = deriveLineNet(next, receipt, sub.province);
    next.net_amount = d.net; next.tax_amount = d.tax; next.tax_source = d.tax_source;
  }

  const project = await projectForSubmission(sub, sql);
  const lf = computeLineFlags(next, receipt, sub.province, project);
  const [row] = await sql`
    update line_items set
      line_date = ${next.line_date}, description = ${next.description}, category = ${next.category},
      is_flat_claim = ${next.is_flat_claim}, gross_amount = ${next.gross_amount}, tax_amount = ${next.tax_amount},
      net_amount = ${next.net_amount}, tax_source = ${next.tax_source}, receipt_id = ${next.receipt_id},
      cost_code = ${next.cost_code}, flags = ${JSON.stringify(lf)}::jsonb, updated_at = now()
    where id = ${lineId} returning *`;
  await bumpForm(sql, subId, historyEvent("line_edited", `${user.username} edited line ${line.row_index}`));
  const form_flags = await recomputeFormFlags(sql, subId);
  return json({ line: row, form_flags });
}

async function handleLineDelete(subId, lineId, sql, user) {
  const rows = await sql`delete from line_items where id = ${lineId} and submission_id = ${subId} returning id`;
  if (!rows.length) return json({ error: "not_found" }, 404);
  await bumpForm(sql, subId, historyEvent("line_deleted", `${user.username} deleted a line`));
  const form_flags = await recomputeFormFlags(sql, subId);
  return json({ deleted: true, form_flags });
}

async function handleLineMatch(subId, lineId, request, sql, user) {
  const body = await parseBody(request).catch(() => ({}));
  if (!body.receipt_id) return json({ error: "receipt_id_required" }, 400);
  const [line] = await sql`select * from line_items where id = ${lineId} and submission_id = ${subId}`;
  if (!line) return json({ error: "not_found" }, 404);
  if (line.is_flat_claim) return json({ error: "flat_claim_line", detail: "Mileage / per diem lines don't take a receipt." }, 400);
  const [receipt] = await sql`select * from receipts where id = ${body.receipt_id} and submission_id = ${subId} and kind = 'receipt'`;
  if (!receipt) return json({ error: "receipt_not_found" }, 404);
  const [sub] = await sql`select * from submissions where id = ${subId}`;

  const d = deriveLineNet({ ...line, receipt_id: receipt.id }, receipt, sub.province);
  const project = await projectForSubmission(sub, sql);
  const lf = computeLineFlags({ ...line, receipt_id: receipt.id, net_amount: d.net, tax_amount: d.tax, tax_source: d.tax_source }, receipt, sub.province, project);
  const [row] = await sql`
    update line_items set receipt_id = ${receipt.id}, match_method = 'manual', match_confidence = 1,
      net_amount = ${d.net}, tax_amount = ${d.tax}, tax_source = ${d.tax_source},
      flags = ${JSON.stringify(lf)}::jsonb, updated_at = now()
    where id = ${lineId} returning *`;
  await bumpForm(sql, subId, historyEvent("line_matched", `${user.username} matched line ${line.row_index} to a receipt`));
  const form_flags = await recomputeFormFlags(sql, subId);
  return json({ line: row, form_flags });
}

async function handleLineUnmatch(subId, lineId, sql, user) {
  const [line] = await sql`select * from line_items where id = ${lineId} and submission_id = ${subId}`;
  if (!line) return json({ error: "not_found" }, 404);
  const [sub] = await sql`select * from submissions where id = ${subId}`;
  const project = await projectForSubmission(sub, sql);
  const lf = computeLineFlags({ ...line, receipt_id: null, net_amount: null, tax_amount: null, tax_source: "none" }, null, sub.province, project);
  const [row] = await sql`
    update line_items set receipt_id = null, match_method = 'none', match_confidence = null,
      net_amount = null, tax_amount = null, tax_source = 'none',
      flags = ${JSON.stringify(lf)}::jsonb, updated_at = now()
    where id = ${lineId} returning *`;
  await bumpForm(sql, subId, historyEvent("line_unmatched", `${user.username} cleared the receipt on line ${line.row_index}`));
  const form_flags = await recomputeFormFlags(sql, subId);
  return json({ line: row, form_flags });
}

// ---------------------------------------------------------------------------
// approve / revision / reject
// ---------------------------------------------------------------------------

async function handleApprove(subId, url, request, env, sql, user) {
  const [sub] = await sql`select * from submissions where id = ${subId}`;
  if (!sub) return json({ error: "not_found" }, 404);
  if (sub.status === "approved") return json({ error: "already_approved", procore_direct_cost_id: sub.procore_direct_cost_id }, 409);
  if (!sub.project_procore_id) return json({ error: "no_project", detail: "Form isn't linked to a Procore project." }, 422);

  const lines = await sql`select * from line_items where submission_id = ${subId} order by row_index asc nulls last, created_at asc`;
  if (!lines.length) return json({ error: "no_lines", detail: "This form has no expense lines." }, 422);

  const dryRun = url.searchParams.get("dryRun") === "1";
  await parseBody(request).catch(() => ({})); // tolerate an empty body

  const incomplete = lines.filter((l) => {
    const net = money(l.net_amount);
    const hasReceipt = l.is_flat_claim || l.receipt_id;
    return !hasReceipt || net === null || net <= 0;
  });
  if (incomplete.length) {
    return json({
      error: "lines_incomplete",
      detail: `${incomplete.length} line(s) still need a receipt and/or a net amount.`,
      lines: incomplete.map((l) => ({ row: l.row_index, description: l.description })),
    }, 422);
  }

  const token = await getProcoreToken(env);

  let employeeId = null;
  try {
    if (sub.employee_email) {
      const users = await procoreFetch(env, token, `/rest/v1.0/companies/${env.PROCORE_COMPANY_ID}/users?filters[search]=${encodeURIComponent(sub.employee_email)}`);
      employeeId = Array.isArray(users) && users[0] ? users[0].id : null;
    }
  } catch { /* omit */ }

  const resolved = [];
  for (const l of lines) {
    try {
      const wbs = await resolveWbsCodeId(env, token, procoreFetch, sub.project_procore_id, l.category, l.cost_code || null);
      resolved.push({ line: l, wbs });
    } catch (e) {
      return json({ error: "cost_code_unresolved", detail: `Line ${l.row_index} (${l.category}): ${e.message}` }, 422);
    }
  }

  const headerDate = lines.map((l) => l.line_date).filter(Boolean).sort()[0] || new Date().toISOString().slice(0, 10);
  const header = buildDirectCostHeader({ ...sub, header_date: headerDate }, { employeeId });
  const lineItems = resolved.map(({ line, wbs }) => buildDirectCostLineItem(line, wbs, sub.expense_id));

  if (dryRun) {
    return json({
      dryRun: true, direct_cost_verified: DIRECTCOST_VERIFIED, employeeId, header,
      line_items: lineItems.map((li, i) => ({ ...li, wbs_code_id: resolved[i].wbs, row: resolved[i].line.row_index })),
    });
  }
  if (!DIRECTCOST_VERIFIED) {
    return json({
      error: "directcost_not_reconciled",
      detail: "Direct Cost write not yet smoke-tested against live Procore (DIRECTCOST_VERIFIED). Use ?dryRun=1.",
      header, line_items: lineItems,
    }, 501);
  }

  const existing = await procoreFetch(env, token, `/rest/v1.0/projects/${sub.project_procore_id}/direct_costs/line_items`).catch(() => []);
  if (alreadyPosted(existing, sub)) {
    return json({ error: "already_in_procore", detail: "A Direct Cost line item tagged with this Expense ID already exists on the project." }, 409);
  }

  const headerResult = await procoreFetch(env, token, header.path, { method: "POST", body: header.data });
  const dcId = String(headerResult.id || headerResult.item?.id || "");
  if (!dcId) throw new Error(`Direct Cost header POST returned no id: ${JSON.stringify(headerResult).slice(0, 300)}`);

  const posted = [];
  for (const li of lineItems) {
    posted.push(await procoreFetch(env, token, li.pathTemplate.replace("{dc_id}", dcId), { method: "POST", body: li.data }));
  }

  const hist = [...(sub.history || []), historyEvent("approved", `Approved by ${user.username}; Procore Direct Cost ${dcId} with ${lineItems.length} line item(s).`)];
  const [row] = await sql`
    update submissions set status = 'approved', procore_direct_cost_id = ${dcId},
      reviewed_by = ${user.username}, reviewed_at = now(), history = ${JSON.stringify(hist)}::jsonb, updated_at = now()
    where id = ${subId} returning id, status, procore_direct_cost_id`;
  return json({ approved: true, submission: row, procore: { header: headerResult, line_items: posted } });
}

async function handleRequestRevision(subId, request, sql, user) {
  const body = await parseBody(request).catch(() => ({}));
  const note = (body.note || "").trim();
  if (!note) return json({ error: "note_required" }, 400);
  const [sub] = await sql`select * from submissions where id = ${subId}`;
  if (!sub) return json({ error: "not_found" }, 404);

  const replySubject = `RE: Expense ${sub.expense_id} — revision requested`;
  const hist = [...(sub.history || []), historyEvent("revision_requested", `${user.username}: ${note}`)];
  const [row] = await sql`
    update submissions set status = 'needs_revision', revision_note = ${note},
      reviewed_by = ${user.username}, reviewed_at = now(), history = ${JSON.stringify(hist)}::jsonb, updated_at = now()
    where id = ${subId} returning id, status, expense_id`;

  // The worker does NOT send mail (PA is intake-only). The reviewer sends this
  // reply from Outlook; keeping the Expense ID in the subject is what routes the
  // employee's reply back onto this form.
  return json({
    submission: row,
    reply: {
      subject: replySubject,
      body: `Hi${sub.employee_name ? " " + sub.employee_name.split(" ")[0] : ""},\n\nWe need a revision on expense ${sub.expense_id} before we can process it:\n\n${note}\n\nPlease reply to this email (keep the subject line as-is) with the corrected form or receipts.\n\nThanks.`,
    },
  });
}

async function handleReject(subId, request, sql, user) {
  const body = await parseBody(request).catch(() => ({}));
  const reason = (body.reason || "").trim();
  if (!reason) return json({ error: "reason_required" }, 400);
  const [sub] = await sql`select * from submissions where id = ${subId}`;
  if (!sub) return json({ error: "not_found" }, 404);

  const hist = [...(sub.history || []), historyEvent("rejected", `${user.username}: ${reason}`)];
  const [row] = await sql`
    update submissions set status = 'rejected', revision_note = ${reason},
      reviewed_by = ${user.username}, reviewed_at = now(), history = ${JSON.stringify(hist)}::jsonb, updated_at = now()
    where id = ${subId} returning id, status`;
  return json({ rejected: true, submission: row });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s || "");

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const sql = sqlFor(env);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      // /intake — service key only
      if (url.pathname === "/intake" && request.method === "POST") {
        if (!isServiceCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handleIntake(request, env, sql);
      }

      // everything else needs an Einbau ID session
      const auth = await requireLogin(request, env);
      if (!auth.ok) return json({ error: "unauthorized", reason: auth.reason }, 401);
      const refresh = auth.refreshedToken ? { "X-Refreshed-Token": auth.refreshedToken } : {};
      const withRefresh = (res) => {
        for (const [k, v] of Object.entries(refresh)) res.headers.set(k, v);
        return res;
      };

      if (url.pathname === "/projects" && request.method === "GET") {
        const rows = await sql`
          select procore_id, project_number, name, stage, active, region, province, refreshed_at
          from projects_cache
          where active = true and stage is distinct from 'On Hold' and stage is distinct from 'Completed and Invoiced'
          order by project_number desc`;
        return withRefresh(json({ projects: rows }));
      }

      if (url.pathname === "/admin/refresh-projects" && request.method === "POST") {
        if (auth.user.role !== "admin") return json({ error: "forbidden", reason: "admin only" }, 403);
        return withRefresh(json({ refreshed: await refreshProjectsCache(env, sql) }));
      }

      if (url.pathname === "/admin/procore-probe" && request.method === "GET") {
        if (auth.user.role !== "admin") return json({ error: "forbidden", reason: "admin only" }, 403);
        const path = url.searchParams.get("path");
        if (!path || !path.startsWith("/rest/")) return json({ error: "bad_path", detail: "pass ?path=/rest/..." }, 400);
        const token = await getProcoreToken(env);
        try {
          const b = await procoreFetch(env, token, path);
          return json({ path, ok: true, count: Array.isArray(b) ? b.length : undefined, preview: JSON.stringify(b).slice(0, 4000) });
        } catch (e) {
          return json({ path, ok: false, status: e.status || null, error: e.message.slice(0, 500) });
        }
      }

      if (parts[0] === "submissions") {
        if (parts.length === 1 && request.method === "GET") return withRefresh(await handleList(url, sql));

        if (parts.length >= 2 && isUuid(parts[1])) {
          const subId = parts[1];
          const seg = parts[2];

          if (!seg && request.method === "GET") return withRefresh(await handleDetail(subId, sql));
          if (seg === "receipt" && request.method === "GET") return await handleReceipt(subId, url, env, sql);
          if (seg === "cost-codes" && request.method === "GET") return withRefresh(await handleCostCodes(subId, env, sql));
          if (seg === "approve" && request.method === "POST") return withRefresh(await handleApprove(subId, url, request, env, sql, auth.user));
          if (seg === "request-revision" && request.method === "POST") return withRefresh(await handleRequestRevision(subId, request, sql, auth.user));
          if (seg === "reject" && request.method === "POST") return withRefresh(await handleReject(subId, request, sql, auth.user));

          if (seg === "lines") {
            const lineId = parts[3];
            if (!lineId && request.method === "POST") return withRefresh(await handleLineAdd(subId, request, sql, auth.user));
            if (lineId && isUuid(lineId)) {
              const act = parts[4];
              if (!act && request.method === "PATCH") return withRefresh(await handleLinePatch(subId, lineId, request, sql, auth.user));
              if (!act && request.method === "DELETE") return withRefresh(await handleLineDelete(subId, lineId, sql, auth.user));
              if (act === "match" && request.method === "POST") return withRefresh(await handleLineMatch(subId, lineId, request, sql, auth.user));
              if (act === "unmatch" && request.method === "POST") return withRefresh(await handleLineUnmatch(subId, lineId, sql, auth.user));
            }
          }
        }
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.log("tally-worker error:", e.message, e.stack);
      return json({ error: "internal_error", detail: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const sql = sqlFor(env);
    ctx.waitUntil(
      refreshProjectsCache(env, sql)
        .then((n) => console.log(`projects_cache refreshed: ${n} projects`))
        .catch((err) => console.error("projects_cache refresh failed:", err))
    );
  },
};

// Exported for unit tests.
export const _test = {
  extractExpenseId,
  normalizeCategory,
  salvageByFieldBoundaries,
  parseBody,
  matchLinesToReceipts,
  deriveLineNet,
  computeLineFlags,
  computeFormFlags,
  sumTaxLines,
  money,
  normalizeAttachments,
  FALLBACK_TAX_RATES,
  NO_RECEIPT_CATEGORIES,
};
