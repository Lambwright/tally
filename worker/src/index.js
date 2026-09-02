// tally-worker
//
// Routes:
//   POST   /intake                      (X-Tally-Service-Key) Power Automate pushes one email here as it arrives
//   GET    /submissions?status=         (Einbau ID) review-queue list — omits raw_email/parsed/base64
//   GET    /submissions/:id             (Einbau ID) full detail
//   GET    /submissions/:id/receipt?key= (Einbau ID) stream a receipt image out of R2 (bucket is private)
//   GET    /submissions/:id/cost-codes  (Einbau ID) project's WBS/budget codes + category default, for the approve picker
//   POST   /submissions/:id/approve[?dryRun=1]  (Einbau ID) { net_amount?, cost_code? } -> two-step Procore Direct Cost at the net amount
//   POST   /submissions/:id/request-revision    (Einbau ID) { note } -> status needs_revision + canonical reply subject
//   POST   /submissions/:id/reject              (Einbau ID) { reason } -> status rejected
//   GET    /projects                    (Einbau ID) the cached active-project list
//   POST   /admin/refresh-projects      (Einbau ID, admin) refresh projects_cache now instead of waiting for cron
//   scheduled (cron 0 */6 * * *)        refresh projects_cache from Procore
//
// Secrets (wrangler secret put):
//   DATABASE_URL, ANTHROPIC_API_KEY, TALLY_SERVICE_KEY, PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET
//
// Design notes worth keeping in view:
//  - Power Automate does intake ONLY. Everything below /intake — parsing, validation,
//    storage, the Procore write — lives here.
//  - Claude reads the gross + tax printed on the receipt. It does NOT do tax law.
//    FALLBACK_TAX_RATES is a last resort for receipts that don't itemize tax, and
//    anything derived from it is flagged `tax_estimated`, never trusted equally.
//  - Procore receives the NET (pre-tax) amount. Tax is applied downstream in NetSuite.
//  - Per diem is its own branch: a flat claimed amount, no receipt, no Claude call.

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

// The two Procore stages that count as "not active" for new financial activity —
// identical to punch-worker's Stage Enforcer, on purpose (kickoff: don't invent a
// separate definition of "active").
const INACTIVE_STAGES = new Set(["On Hold", "Completed and Invoiced"]);

const LOW_CONFIDENCE_THRESHOLD = 0.75;

// Canonical expense categories — the columns on Einbau's Employee Expense Form
// (Parking, Materials, Fuel, Mileage, Per Diem, Other). normalizeCategory() folds
// common synonyms (gas -> fuel, material -> materials) onto these.
const CATEGORIES = new Set(["parking", "materials", "fuel", "mileage", "per_diem", "other"]);

// Categories with no receipt to parse — a flat claimed amount, no Claude call,
// no gross/tax extraction. Per diem is a daily allowance; mileage is km * rate.
const NO_RECEIPT_CATEGORIES = new Set(["per_diem", "mileage"]);

// Categories where the receipt/claim location should sit near the job site. Applied
// ONLY to these — crews routinely buy materials far from site, and flagging that
// just trains people to ignore flags.
const SITE_TIED_CATEGORIES = new Set(["fuel", "parking", "per_diem", "mileage"]);

function normalizeCategory(raw) {
  const c = (raw || "").toLowerCase().trim().replace(/\s+/g, "_");
  const aliases = { gas: "fuel", fuel_$: "fuel", material: "materials", "per-diem": "per_diem", perdiem: "per_diem" };
  const mapped = aliases[c] || c;
  return CATEGORIES.has(mapped) ? mapped : "other";
}

// FALLBACK ONLY. Combined sales-tax rate (%) used to back a net figure out of a
// gross when the receipt doesn't itemize tax. Province-level; deliberately coarse.
// Any submission that touches this is flagged `tax_estimated`.
const FALLBACK_TAX_RATES = {
  AB: 5, BC: 12, MB: 12, NB: 15, NL: 15, NS: 15, NT: 5,
  NU: 5, ON: 13, PE: 15, QC: 14.975, SK: 11, YT: 5,
};

// ---------------------------------------------------------------------------
// HTTP plumbing (ported from punch-worker)
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // tighten to the GitHub Pages origin once live
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tally-Service-Key",
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

// Fields /intake reads out of the body. Only string-valued ones — used as anchors
// for the salvage scan below (Power Automate frequently sends JSON that won't
// JSON.parse because it drops raw unescaped HTML/quotes into string values).
const INTAKE_STRING_FIELDS = [
  "subject", "from", "body", "invoice_number", "employee_name", "employee_email",
  "province", "project_number", "category", "claimed_amount",
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

// Every queue route needs a real Einbau ID session. Verified against auth-worker
// through the service binding — a plain fetch() to its *.workers.dev URL from in
// here is blocked with Cloudflare error 1042. Returns { ok, reason, user } so the
// frontend can show *why* a login was rejected instead of guessing at a bare 401.
async function requireLogin(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { ok: false, reason: "No session token was sent with the request." };
  try {
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

    const allowed = String(env.ALLOWED_ROLES || "admin,user").split(",").map((r) => r.trim());
    if (!data.user || !allowed.includes(data.user.role)) {
      return { ok: false, reason: `Logged in as "${data.user && data.user.username}" (role "${data.user && data.user.role}"), which isn't allowed in TALLY.` };
    }
    return { ok: true, user: data.user, refreshedToken: data.refreshedToken || null };
  } catch (e) {
    return { ok: false, reason: `Couldn't reach auth-worker: ${e.message}` };
  }
}

// Power Automate can't do an interactive login, so /intake also accepts a static
// shared secret it sends as a header. Same pattern as punch-worker / scout-worker.
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
// Claude — receipt vision extraction
// ---------------------------------------------------------------------------

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in Claude's response: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

const RECEIPT_PROMPT = `You are reading a photo of an expense receipt for a millwork installation company.

Return ONLY a JSON object, no prose, no markdown fences, with exactly these keys:
{
  "vendor": string | null,               // merchant name as printed
  "receipt_date": "YYYY-MM-DD" | null,    // transaction date
  "currency": string,                     // ISO code, "CAD" if not shown
  "subtotal": number | null,              // pre-tax amount as printed
  "tax_lines": [ { "label": string, "amount": number } ],  // EACH tax line printed (GST, HST, QST, PST, TPS, TVQ...). Empty array if none printed.
  "gross": number | null,                 // final total charged
  "printed_net": number | null,           // a pre-tax / "net" total if the receipt explicitly prints one, else null
  "category_guess": "parking" | "materials" | "fuel" | "per_diem" | "other" | null,
  "confidence": number                    // 0..1, your confidence in the numeric fields above
}

Rules:
- Read numbers exactly as printed. Do not compute or infer tax that isn't shown.
- If the image is unreadable or not a receipt, set numeric fields to null and confidence to 0.
- "fuel" = gasoline/diesel. "parking" = parking or tolls. "materials" = supplies/hardware/lumber.
  "per_diem" only if the receipt itself says per diem/meal allowance. Otherwise "other".`;

async function extractReceipt(env, images) {
  const content = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));
  content.push({ type: "text", text: RECEIPT_PROMPT });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Anthropic returned no text block");
  return extractJSON(textBlock.text.replace(/```json|```/g, "").trim());
}

// ---------------------------------------------------------------------------
// Procore
// ---------------------------------------------------------------------------

// Client Credentials tokens are short-lived (~90 min); fetch fresh per run rather
// than caching (matches punch-worker).
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
      env,
      token,
      `/rest/v1.0/projects?company_id=${env.PROCORE_COMPANY_ID}&page=${page}&per_page=${perPage}`
    );
    if (!Array.isArray(batch)) break;
    projects.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return projects;
}

// Refresh projects_cache. One paginated read — small, well under the subrequest
// ceiling. Full replace inside a txn so a mid-run failure doesn't half-empty it.
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

// ---------------------------------------------------------------------------
// intake helpers
// ---------------------------------------------------------------------------

// Einbau's Employee Expense Form has an auto-generated "Expense ID" field. It is
// the tracking token: it must ride in the email subject so revision-loop replies
// ("RE: Expense <id> ...") carry it back to the same submission.
//
// TODO(ben) #5: confirm the exact Expense ID format the stripped form emits, and
// that it lands in the SUBJECT (the current SOP has employees typing name +
// project number into the Description instead — the stripped form has to change
// this). The patterns below are permissive until then.
function extractInvoiceNumber(body) {
  for (const k of ["expense_id", "invoice_number", "expenseId"]) {
    if (body[k] && String(body[k]).trim()) return String(body[k]).trim();
  }
  const subject = body.subject || "";
  const m =
    // EXP-000123 / INV_7781AB — prefix, optional separator, then an alnum run that
    // must contain at least one digit (so "Expense" itself doesn't match).
    subject.match(/\b(?:EXP|INV)[-_ ]?(?=[A-Z0-9]*\d)[A-Z0-9]{3,}\b/i) ||
    subject.match(/\b\d{4}[-_]\d{3,}\b/) || // 2026_0123-style
    subject.match(/#\s*([A-Z0-9-]{4,})/i);
  return m ? m[0].replace(/^#\s*/, "").trim() : null;
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
    .map((a) => ({
      name: (a.name || a.fileName || "receipt").replace(/[^\w.\- ]+/g, "_"),
      contentType: a.contentType || a.contentBytesType || "image/jpeg",
      base64: a.contentBytes || a.content || a.$content || a.data || "",
    }))
    .filter((a) => a.base64);
}

// Round to cents, tolerant of strings with $ / commas.
function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, "");
  if (!/\d/.test(cleaned)) return null; // e.g. "abc" strips to "" — that's not zero, it's nothing
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function sumTaxLines(taxLines) {
  if (!Array.isArray(taxLines)) return 0;
  return Math.round(taxLines.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100;
}

// Deterministic validation. `project` is the matched projects_cache row or null.
// Flags are advisory — they never block approval, they surface in the queue.
function computeFlags(sub, project) {
  const flags = [];
  const add = (code, severity, detail) => flags.push({ code, severity, detail });

  if (!sub.project_number) {
    add("project_missing", "high", "No project number on the submission.");
  } else if (!project) {
    add("project_invalid", "high", `Project "${sub.project_number}" isn't in the projects cache.`);
  } else if (project.active === false) {
    add("project_inactive", "high", `Project is not active in Procore (stage "${project.stage || "?"}").`);
  } else if (INACTIVE_STAGES.has(project.stage)) {
    add("project_inactive", "high", `Project stage is "${project.stage}".`);
  }

  if (SITE_TIED_CATEGORIES.has(sub.category) && project && sub.province && project.province &&
      sub.province.toUpperCase() !== project.province.toUpperCase()) {
    add("geo_mismatch", "medium",
      `${sub.category} claimed in ${sub.province} but project is in ${project.province}.`);
  }

  if (!sub.is_flat_claim && sub.tax_source !== "read") {
    add("tax_estimated", "high",
      sub.tax_source === "fallback_table"
        ? "Tax wasn't itemized on the receipt — net is a province-rate estimate, not a read value."
        : "No tax information available for this submission.");
  }

  if (!sub.is_flat_claim) {
    const parsed = sub.parsed || {};
    const gross = money(sub.gross_amount);
    const tax = money(sub.tax_amount);
    const net = money(sub.net_amount);
    const printedNet = money(parsed.printed_net);
    if (printedNet !== null && net !== null && Math.abs(net - printedNet) > 0.01) {
      add("amount_mismatch", "medium",
        `Computed net ${net} disagrees with the net printed on the receipt (${printedNet}).`);
    }
    const subtotal = money(parsed.subtotal);
    if (subtotal !== null && gross !== null && tax !== null &&
        Math.abs(subtotal + tax - gross) > 0.02) {
      add("amount_mismatch", "low",
        `subtotal ${subtotal} + tax ${tax} != gross ${gross}.`);
    }
    if (sub.confidence !== null && sub.confidence !== undefined && sub.confidence < LOW_CONFIDENCE_THRESHOLD) {
      add("low_confidence", "medium", `Claude's confidence in the figures was ${sub.confidence}.`);
    }
    const guess = (parsed.category_guess || "").toLowerCase();
    if (guess && guess !== sub.category) {
      add("category_conflict", "low", `Form says "${sub.category}", the receipt looks like "${guess}".`);
    }
  }

  return flags;
}

function historyEvent(type, text) {
  return { at: new Date().toISOString(), type, text };
}

// ---------------------------------------------------------------------------
// /intake
// ---------------------------------------------------------------------------

async function handleIntake(request, env, sql) {
  const body = await parseBody(request);

  const invoiceNumber = extractInvoiceNumber(body);
  if (!invoiceNumber) {
    return json({ error: "no_invoice_number", detail: "Couldn't find an invoice number in the subject or body." }, 422);
  }

  const category = normalizeCategory(body.category);
  const isFlatClaim = NO_RECEIPT_CATEGORIES.has(category);
  const province = (body.province || "").toUpperCase().slice(0, 2) || null;
  const rawEmail = body.body || null;

  // --- revision-loop dedup: same invoice number => merge onto the existing row.
  const [existing] = await sql`select * from submissions where invoice_number = ${invoiceNumber}`;
  if (existing) {
    const note = stripHtml(rawEmail || "").slice(0, 500);
    const newHistory = [...(existing.history || []), historyEvent("reply_received", note || "(reply with no readable body)")];
    // Don't silently reopen a closed claim — flag it and force human eyes.
    const reopened = existing.status === "approved" || existing.status === "rejected";
    const mergedFlags = reopened
      ? [...(existing.flags || []), { code: "duplicate_invoice", severity: "high", detail: `Reply arrived on an already-${existing.status} claim.` }]
      : existing.flags;
    const [updated] = await sql`
      update submissions
      set history = ${JSON.stringify(newHistory)}::jsonb,
          flags = ${JSON.stringify(mergedFlags)}::jsonb,
          status = 'needs_review',
          updated_at = now()
      where id = ${existing.id}
      returning id, invoice_number, status`;
    return json({ merged: true, submission: updated }, 200);
  }

  // --- resolve the project against the cache
  let project = null;
  if (body.project_number) {
    const [p] = await sql`
      select * from projects_cache where project_number = ${String(body.project_number).trim()} limit 1`;
    project = p || null;
  }

  // --- flat-claim branch (per diem, mileage): claimed amount, no receipt, no Claude
  let gross = null, tax = null, net = null, taxSource = "none", confidence = null;
  let parsed = null;
  let receiptKeys = [];

  if (isFlatClaim) {
    net = money(body.claimed_amount);
    gross = net;
    tax = 0;
    if (net === null) {
      return json({ error: "flat_claim_needs_amount", detail: `${category} submission had no claimed_amount.` }, 422);
    }
  } else {
    // --- receipt branch
    const attachments = normalizeAttachments(body);
    if (attachments.length === 0) {
      return json({ error: "no_receipt", detail: `${category} submission arrived with no attachment.` }, 422);
    }

    // Store every image in R2 first (bucket is private; only the authed receipt
    // route reads them back).
    for (const a of attachments) {
      const key = `${invoiceNumber}/${a.name}`;
      await env.RECEIPTS.put(key, base64ToBytes(a.base64), {
        httpMetadata: { contentType: a.contentType },
      });
      receiptKeys.push(key);
    }

    parsed = await extractReceipt(
      env,
      attachments.map((a) => ({ mediaType: a.contentType, base64: a.base64.replace(/^data:[^,]+,/, "").replace(/\s/g, "") }))
    );

    gross = money(parsed.gross);
    confidence = Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null;

    const readTax = sumTaxLines(parsed.tax_lines);
    if (Array.isArray(parsed.tax_lines) && parsed.tax_lines.length > 0 && readTax > 0) {
      tax = readTax;
      taxSource = "read";
      net = gross !== null ? Math.round((gross - tax) * 100) / 100 : null;
    } else if (gross !== null && province && FALLBACK_TAX_RATES[province] != null) {
      const rate = FALLBACK_TAX_RATES[province] / 100;
      net = Math.round((gross / (1 + rate)) * 100) / 100;
      tax = Math.round((gross - net) * 100) / 100;
      taxSource = "fallback_table";
    } else {
      // Nothing to go on — record gross, leave net null, let the flag carry it.
      net = null;
      tax = null;
      taxSource = "none";
    }
  }

  // --- assemble + validate
  const draft = {
    invoice_number: invoiceNumber,
    employee_name: body.employee_name || null,
    employee_email: body.employee_email || body.from || null,
    province,
    project_number: body.project_number ? String(body.project_number).trim() : null,
    project_procore_id: project?.procore_id || null,
    project_name: project?.name || null,
    project_stage: project?.stage || null,
    category,
    is_flat_claim: isFlatClaim,
    vendor: parsed?.vendor || null,
    receipt_date: parsed?.receipt_date || null,
    currency: (parsed?.currency || "CAD").toUpperCase().slice(0, 3),
    gross_amount: gross,
    tax_amount: tax,
    net_amount: net,
    tax_source: taxSource,
    confidence,
    parsed,
  };
  const flags = computeFlags(draft, project);

  const history = [historyEvent("intake", `Received via email from ${draft.employee_email || "(unknown)"}.`)];

  const [row] = await sql`
    insert into submissions (
      invoice_number, employee_name, employee_email, province,
      project_number, project_procore_id, project_name, project_stage,
      category, is_flat_claim, vendor, receipt_date, currency,
      gross_amount, tax_amount, net_amount, tax_source, confidence,
      status, flags, receipt_keys, parsed, raw_email, history, submitted_at
    ) values (
      ${draft.invoice_number}, ${draft.employee_name}, ${draft.employee_email}, ${draft.province},
      ${draft.project_number}, ${draft.project_procore_id}, ${draft.project_name}, ${draft.project_stage},
      ${draft.category}, ${draft.is_flat_claim}, ${draft.vendor}, ${draft.receipt_date}, ${draft.currency},
      ${draft.gross_amount}, ${draft.tax_amount}, ${draft.net_amount}, ${draft.tax_source}, ${draft.confidence},
      'needs_review', ${JSON.stringify(flags)}::jsonb, ${JSON.stringify(receiptKeys)}::jsonb,
      ${parsed ? JSON.stringify(parsed) : null}::jsonb, ${rawEmail}, ${JSON.stringify(history)}::jsonb, now()
    )
    returning id, invoice_number, status, flags, net_amount`;

  return json({ created: true, submission: row }, 201);
}

// ---------------------------------------------------------------------------
// review-queue routes
// ---------------------------------------------------------------------------

const LIST_COLUMNS = `
  id, invoice_number, employee_name, employee_email, province,
  project_number, project_name, project_stage, category, is_flat_claim,
  vendor, receipt_date, currency, gross_amount, tax_amount, net_amount,
  tax_source, confidence, status, flags, receipt_keys,
  reviewed_by, reviewed_at, cost_code, procore_direct_cost_id,
  submitted_at, created_at, updated_at`;

async function handleList(url, sql) {
  const status = url.searchParams.get("status");
  const rows = status
    ? await sql`select ${sql.unsafe(LIST_COLUMNS)} from submissions where status = ${status} order by created_at desc limit 500`
    : await sql`select ${sql.unsafe(LIST_COLUMNS)} from submissions order by created_at desc limit 500`;
  return json({ submissions: rows });
}

async function handleDetail(id, sql) {
  const [row] = await sql`select * from submissions where id = ${id}`;
  if (!row) return json({ error: "not_found" }, 404);
  return json({ submission: row });
}

async function handleReceipt(id, url, env, sql) {
  const key = url.searchParams.get("key");
  if (!key) return json({ error: "key_required" }, 400);

  const [row] = await sql`select receipt_keys from submissions where id = ${id}`;
  if (!row) return json({ error: "not_found" }, 404);
  if (!(row.receipt_keys || []).includes(key)) {
    return json({ error: "key_not_on_submission" }, 403);
  }

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

// Cost-code picker data for the review UI: the submission's project's WBS/budget
// codes, plus which one is the category default so the dropdown can pre-select it.
async function handleCostCodes(id, env, sql) {
  const [sub] = await sql`select project_procore_id, category from submissions where id = ${id}`;
  if (!sub) return json({ error: "not_found" }, 404);
  if (!sub.project_procore_id) return json({ error: "no_project", detail: "Submission isn't linked to a Procore project." }, 422);

  const token = await getProcoreToken(env);
  let codes = [];
  try {
    codes = await listProjectWbsCodes(env, token, procoreFetch, sub.project_procore_id);
  } catch (e) {
    return json({ error: "procore_lookup_failed", detail: e.message }, 502);
  }

  const defaultFlat = CATEGORY_TO_WBS_CODE[sub.category] || null;
  const norm = (s) => String(s || "").replace(/\s/g, "").toLowerCase();
  const defaultMatch = defaultFlat
    ? codes.find((c) => norm(c.code) === norm(defaultFlat)) ||
      codes.find((c) => norm(c.code).startsWith(norm(defaultFlat).split(".")[0]))
    : null;

  return json({
    category: sub.category,
    default_cost_code: defaultFlat,          // null for "other"
    default_wbs_code_id: defaultMatch?.id || null,
    codes,
  });
}

async function handleApprove(id, url, request, env, sql, user) {
  let [sub] = await sql`select * from submissions where id = ${id}`;
  if (!sub) return json({ error: "not_found" }, 404);
  if (sub.status === "approved") return json({ error: "already_approved", procore_direct_cost_id: sub.procore_direct_cost_id }, 409);

  const dryRun = url.searchParams.get("dryRun") === "1";

  // A reviewer can correct the net amount (e.g. a tax_estimated / amount_mismatch
  // flag they've resolved by eye) before approving. Re-persisted immediately so
  // the corrected figure is what both the dry run and the real POST use.
  const overrideBody = await parseBody(request).catch(() => ({}));
  if (overrideBody && overrideBody.net_amount !== undefined) {
    const overridden = money(overrideBody.net_amount);
    if (overridden === null || overridden <= 0) {
      return json({ error: "invalid_net_amount" }, 400);
    }
    const history = [...(sub.history || []), historyEvent("net_amount_corrected", `${user.username} set net amount to ${overridden} (was ${sub.net_amount}).`)];
    [sub] = await sql`
      update submissions
      set net_amount = ${overridden}, history = ${JSON.stringify(history)}::jsonb, updated_at = now()
      where id = ${id}
      returning *`;
  }

  if (money(sub.net_amount) === null || money(sub.net_amount) <= 0) {
    return json({ error: "no_net_amount", detail: "This submission has no usable net amount — resolve the tax_estimated / amount flags first." }, 422);
  }
  if (!sub.project_procore_id) {
    return json({ error: "no_project", detail: "This submission isn't linked to a Procore project." }, 422);
  }

  const token = await getProcoreToken(env);

  // Resolve the employee's Procore user id from their email — same lookup the
  // payroll flow's "Pre-fetch_Procore_User" step does. Best-effort: if it doesn't
  // resolve (e.g. the From address was a PM, not the employee), the header just
  // omits employee_id.
  let employeeId = null;
  try {
    if (sub.employee_email) {
      const users = await procoreFetch(
        env, token,
        `/rest/v1.0/companies/${env.PROCORE_COMPANY_ID}/users?filters[search]=${encodeURIComponent(sub.employee_email)}`
      );
      employeeId = Array.isArray(users) && users[0] ? users[0].id : null;
    }
  } catch {
    /* leave employeeId null */
  }

  // Cost code: the reviewer picks one in the app (pre-filled with the category
  // default). `cost_code` may be a flat-code string or a raw wbs_code_id; either
  // works. Absent -> resolveWbsCodeId falls back to the category default, which
  // throws for "other" (no default) so the reviewer is forced to choose.
  const chosenCostCode = overrideBody?.cost_code || overrideBody?.wbs_code_id || null;
  const wbsCodeId = await resolveWbsCodeId(
    env, token, procoreFetch, sub.project_procore_id, sub.category, chosenCostCode
  );
  const header = buildDirectCostHeader(sub, { employeeId });
  const lineItem = buildDirectCostLineItem(sub, wbsCodeId);

  if (dryRun) {
    return json({ dryRun: true, direct_cost_verified: DIRECTCOST_VERIFIED, employeeId, wbsCodeId, chosenCostCode, header, lineItem });
  }
  if (!DIRECTCOST_VERIFIED) {
    return json({
      error: "directcost_not_reconciled",
      detail: "The Direct Cost write hasn't been smoke-tested against live Procore yet (DIRECTCOST_VERIFIED). Use ?dryRun=1 to inspect exactly what would be sent.",
      header, lineItem,
    }, 501);
  }

  // Idempotency: the payroll flow's [TC:<id>] trick — scan the project's existing
  // line items for our [INV:<invoice>] token before writing anything.
  const existingLineItems = await procoreFetch(
    env, token, `/rest/v1.0/projects/${sub.project_procore_id}/direct_costs/line_items`
  ).catch(() => []);
  if (alreadyPosted(existingLineItems, sub)) {
    return json({ error: "already_in_procore", detail: "A Direct Cost line item tagged with this invoice number already exists on the project." }, 409);
  }

  // Two-step create: header first (wrapper "item"), then the line item
  // (wrapper "line_item") against the returned dc id.
  const headerResult = await procoreFetch(env, token, header.path, { method: "POST", body: header.data });
  const directCostId = String(headerResult.id || headerResult.item?.id || "");
  if (!directCostId) throw new Error(`Direct Cost header POST returned no id: ${JSON.stringify(headerResult).slice(0, 300)}`);

  const lineItemPath = lineItem.pathTemplate.replace("{dc_id}", directCostId);
  const lineItemResult = await procoreFetch(env, token, lineItemPath, { method: "POST", body: lineItem.data });

  const history = [
    ...(sub.history || []),
    historyEvent("approved", `Approved by ${user.username}; Procore Direct Cost ${directCostId}, wbs_code ${wbsCodeId}${chosenCostCode ? ` (chosen: ${chosenCostCode})` : " (category default)"}.`),
  ];
  const [row] = await sql`
    update submissions
    set status = 'approved', procore_direct_cost_id = ${directCostId},
        cost_code = ${String(chosenCostCode || "")},
        reviewed_by = ${user.username}, reviewed_at = now(),
        history = ${JSON.stringify(history)}::jsonb, updated_at = now()
    where id = ${id}
    returning id, status, procore_direct_cost_id, cost_code`;
  return json({ approved: true, submission: row, procore: { header: headerResult, lineItem: lineItemResult } });
}

async function handleRequestRevision(id, request, sql, user) {
  const body = await parseBody(request).catch(() => ({}));
  const note = (body.note || "").trim();
  if (!note) return json({ error: "note_required" }, 400);

  const [sub] = await sql`select * from submissions where id = ${id}`;
  if (!sub) return json({ error: "not_found" }, 404);

  const replySubject = `RE: Expense ${sub.invoice_number} — revision requested`;
  const history = [...(sub.history || []), historyEvent("revision_requested", `${user.username}: ${note}`)];
  const [row] = await sql`
    update submissions
    set status = 'needs_revision', revision_note = ${note},
        reviewed_by = ${user.username}, reviewed_at = now(),
        history = ${JSON.stringify(history)}::jsonb, updated_at = now()
    where id = ${id}
    returning id, status, invoice_number`;

  // The worker does NOT send mail (PA is intake-only). The reviewer sends this
  // reply from Outlook; the invoice number in the subject is what routes the
  // employee's reply back onto this row.
  return json({
    submission: row,
    reply: {
      subject: replySubject,
      body: `Hi${sub.employee_name ? " " + sub.employee_name.split(" ")[0] : ""},\n\nWe need a revision on expense ${sub.invoice_number} before we can process it:\n\n${note}\n\nPlease reply to this email (keep the subject line as-is) with the corrected receipt or details.\n\nThanks.`,
    },
  });
}

async function handleReject(id, request, sql, user) {
  const body = await parseBody(request).catch(() => ({}));
  const reason = (body.reason || "").trim();
  if (!reason) return json({ error: "reason_required" }, 400);

  const [sub] = await sql`select * from submissions where id = ${id}`;
  if (!sub) return json({ error: "not_found" }, 404);

  const history = [...(sub.history || []), historyEvent("rejected", `${user.username}: ${reason}`)];
  const [row] = await sql`
    update submissions
    set status = 'rejected', revision_note = ${reason},
        reviewed_by = ${user.username}, reviewed_at = now(),
        history = ${JSON.stringify(history)}::jsonb, updated_at = now()
    where id = ${id}
    returning id, status`;
  return json({ rejected: true, submission: row });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const sql = sqlFor(env);

    try {
      // /intake — service key only
      if (url.pathname === "/intake" && request.method === "POST") {
        if (!isServiceCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handleIntake(request, env, sql);
      }

      // everything else needs an Einbau ID session
      const auth = await requireLogin(request, env);
      if (!auth.ok) return json({ error: "unauthorized", reason: auth.reason }, 401);
      const extra = auth.refreshedToken ? { "X-Refreshed-Token": auth.refreshedToken } : {};

      if (url.pathname === "/submissions" && request.method === "GET") {
        const res = await handleList(url, sql);
        for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
        return res;
      }

      if (url.pathname === "/projects" && request.method === "GET") {
        const rows = await sql`
          select procore_id, project_number, name, stage, active, region, province, refreshed_at
          from projects_cache
          where active = true and stage is distinct from 'On Hold' and stage is distinct from 'Completed and Invoiced'
          order by project_number desc`;
        return json({ projects: rows });
      }

      // Populate/refresh projects_cache on demand instead of waiting for the 6h
      // cron — handy right after deploy and for ops. Admin only.
      if (url.pathname === "/admin/refresh-projects" && request.method === "POST") {
        if (auth.user.role !== "admin") return json({ error: "forbidden", reason: "admin only" }, 403);
        const n = await refreshProjectsCache(env, sql);
        return json({ refreshed: n });
      }

      const m = url.pathname.match(/^\/submissions\/([0-9a-f-]{36})(\/[a-z-]+)?$/i);
      if (m) {
        const id = m[1];
        const sub = m[2] || "";
        if (!sub && request.method === "GET") return await handleDetail(id, sql);
        if (sub === "/receipt" && request.method === "GET") return await handleReceipt(id, url, env, sql);
        if (sub === "/cost-codes" && request.method === "GET") return await handleCostCodes(id, env, sql);
        if (sub === "/approve" && request.method === "POST") return await handleApprove(id, url, request, env, sql, auth.user);
        if (sub === "/request-revision" && request.method === "POST") return await handleRequestRevision(id, request, sql, auth.user);
        if (sub === "/reject" && request.method === "POST") return await handleReject(id, request, sql, auth.user);
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
  extractInvoiceNumber,
  normalizeCategory,
  salvageByFieldBoundaries,
  parseBody,
  computeFlags,
  sumTaxLines,
  money,
  normalizeAttachments,
  FALLBACK_TAX_RATES,
  NO_RECEIPT_CATEGORIES,
};
