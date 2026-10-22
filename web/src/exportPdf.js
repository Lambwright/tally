import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Builds the expense package an approver can file or send: page 1+ is a summary with a clean table
// of the lines as TALLY has them, followed by the original expense form (if there was one) and
// every receipt, each in full (an image gets its own page; a receipt that is some pages of a bigger
// PDF brings just those pages). Everything is built in the browser from what the review page already
// has, so nothing new is stored or sent anywhere.

const PAGE_W = 792; // US Letter, landscape for the summary
const PAGE_H = 612;
const M = 36;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);
const ORANGE = rgb(0.886, 0.529, 0.102);
const RULE = rgb(0.82, 0.82, 0.82);
const HEAD_BG = rgb(0.95, 0.93, 0.89);

// Standard PDF fonts only cover Latin-1, so swap the few fancy characters TALLY uses.
const safe = (s) =>
  String(s ?? "")
    .replace(/[–—]/g, "-")
    .replace(/→/g, "->")
    .replace(/≠/g, "!=")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

const fmt = (n) => (n === null || n === undefined || n === "" || Number.isNaN(Number(n)) ? "-" : `$${Number(n).toFixed(2)}`);
const dateText = (d) => (d ? String(d).slice(0, 10) : "-");

function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of safe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) { line = trial; continue; }
      if (line) out.push(line);
      // a single word wider than the column: break it by characters
      let chunk = "";
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) { out.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

// webp / heic / anything pdf-lib can't embed: redraw through a canvas as PNG.
async function toPng(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || "image/jpeg" }));
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image didn't load"));
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

// data: { sub, lines, receipts, labels: { costCode(line), taxCode(line) }, getFile(r2_key) -> { bytes, type } | null }
export async function buildExpensePdf({ sub, lines, receipts, labels, getFile }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const generated = new Date().toISOString().slice(0, 10);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;
  const text = (t, x, yy, { size = 9, f = font, color = INK } = {}) => page.drawText(safe(t), { x, y: yy, size, font: f, color });

  // ---- header
  page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: ORANGE });
  text("Expense report", M, y - 14, { size: 18, f: bold });
  text(`TALLY  -  generated ${generated}`, PAGE_W - M - 150, y - 12, { size: 8, color: MUTED });
  y -= 36;

  const reviewedAt = sub.reviewed_at ? dateText(sub.reviewed_at) : null;
  const facts = [
    ["Expense ID", sub.expense_id],
    ["Employee", sub.employee_name || "-"],
    ["Project", [sub.project_number, sub.project_name].filter(Boolean).join("  -  ") || "-"],
    ["Province", sub.province || "-"],
    ["Submitted by", sub.created_by || "(email)"],
    ["Approved by", sub.status === "approved" ? `${sub.reviewed_by || sub.approver || "-"}${reviewedAt ? `  on ${reviewedAt}` : ""}` : `${sub.status.replace("_", " ")}${sub.approver ? `  (assigned to ${sub.approver})` : ""}`],
    ["Procore Direct Cost", sub.procore_direct_cost_id || "-"],
    ["Date authorized", dateText(sub.date_authorized)],
  ];
  const colW = (PAGE_W - 2 * M) / 2;
  facts.forEach(([k, v], i) => {
    const cx = M + (i % 2) * colW;
    const cy = y - Math.floor(i / 2) * 15;
    text(k, cx, cy, { size: 8, color: MUTED });
    text(wrap(v, font, 9, colW - 110)[0], cx + 100, cy, { size: 9 });
  });
  y -= Math.ceil(facts.length / 2) * 15 + 14;

  // ---- table
  const cols = [
    { h: "Date", w: 56 },
    { h: "Description", w: 168 },
    { h: "Category", w: 52 },
    { h: "Gross", w: 50, right: true },
    { h: "Tax", w: 44, right: true },
    { h: "Net", w: 52, right: true },
    { h: "Cost code", w: 88 },
    { h: "Tax code", w: 56 },
    { h: "Receipt", w: 142 },
  ];
  const tableW = cols.reduce((a, c) => a + c.w, 0);
  const x0 = M + (PAGE_W - 2 * M - tableW) / 2;
  const drawHead = () => {
    page.drawRectangle({ x: x0, y: y - 15, width: tableW, height: 17, color: HEAD_BG });
    let cx = x0;
    for (const c of cols) {
      const tx = c.right ? cx + c.w - 4 - bold.widthOfTextAtSize(c.h, 8) : cx + 4;
      text(c.h, tx, y - 10, { size: 8, f: bold });
      cx += c.w;
    }
    y -= 19;
  };
  drawHead();

  let tg = 0, tt = 0, tn = 0;
  lines.forEach((l, i) => {
    const receipt = receipts.find((r) => r.id === l.receipt_id);
    const receiptText = l.receipt_override_by
      ? "Receipt waived"
      : l.is_flat_claim ? "Flat claim (no receipt)"
      : receipt ? `${receipt.vendor || "Receipt"}${receipt.page_start ? ` (p.${receipt.page_start}${receipt.page_end > receipt.page_start ? `-${receipt.page_end}` : ""})` : ""}${receipt.gross != null ? `  ${fmt(receipt.gross)}` : ""}`
      : "No receipt";
    const cells = [
      dateText(l.line_date), l.description || "", (l.category || "").replace("_", " "),
      fmt(l.gross_amount), fmt(l.tax_amount), fmt(l.net_amount),
      labels.costCode(l) || "", labels.taxCode(l) || "", receiptText,
    ];
    const wrapped = cells.map((c, ci) => wrap(c, font, 8, cols[ci].w - 8));
    const rowH = Math.max(...wrapped.map((w) => w.length)) * 10 + 6;
    if (y - rowH < M + 40) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - M;
      drawHead();
    }
    if (i % 2 === 1) page.drawRectangle({ x: x0, y: y - rowH + 3, width: tableW, height: rowH, color: rgb(0.985, 0.98, 0.97) });
    let cx = x0;
    wrapped.forEach((w, ci) => {
      w.forEach((ln, li) => {
        const tx = cols[ci].right ? cx + cols[ci].w - 4 - font.widthOfTextAtSize(ln, 8) : cx + 4;
        text(ln, tx, y - 7 - li * 10, { size: 8 });
      });
      cx += cols[ci].w;
    });
    page.drawLine({ start: { x: x0, y: y - rowH + 3 }, end: { x: x0 + tableW, y: y - rowH + 3 }, thickness: 0.4, color: RULE });
    y -= rowH;
    tg += Number(l.gross_amount) || 0; tt += Number(l.tax_amount) || 0; tn += Number(l.net_amount) || 0;
  });

  // totals
  if (y - 24 < M) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - M; }
  y -= 4;
  page.drawRectangle({ x: x0, y: y - 15, width: tableW, height: 17, color: HEAD_BG });
  text(`Total  (${lines.length} line${lines.length === 1 ? "" : "s"})`, x0 + 4, y - 10, { size: 8, f: bold });
  const right = (t, colIndex) => {
    const cx = x0 + cols.slice(0, colIndex).reduce((a, c) => a + c.w, 0);
    text(t, cx + cols[colIndex].w - 4 - bold.widthOfTextAtSize(t, 8), y - 10, { size: 8, f: bold });
  };
  right(fmt(tg), 3); right(fmt(tt), 4); right(fmt(tn), 5);
  y -= 24;
  text("Net is the pre-tax amount posted to Procore.", x0, y, { size: 7.5, color: MUTED });

  // ---- the form, then the receipts in the order the lines use them
  const used = new Set();
  const attachments = [];
  const form = receipts.find((r) => r.kind === "form");
  if (form) attachments.push({ r: form, caption: "Expense form" });
  const lineOrder = [];
  for (const l of lines) if (l.receipt_id && !lineOrder.includes(l.receipt_id)) lineOrder.push(l.receipt_id);
  const ordered = [
    ...lineOrder.map((id) => receipts.find((r) => r.id === id)).filter(Boolean),
    ...receipts.filter((r) => r.kind === "receipt" && !lineOrder.includes(r.id)),
  ];
  for (const r of ordered) {
    const rows = lines.filter((l) => l.receipt_id === r.id).map((l) => l.row_index);
    attachments.push({ r, caption: `${r.vendor || "Receipt"}${r.note ? ` (${r.note})` : ""}${r.gross != null ? `  ${fmt(r.gross)}` : ""}${rows.length ? `  -  line ${rows.join(", ")}` : ""}` });
  }

  const pdfCache = new Map();
  for (const { r, caption } of attachments) {
    const file = await getFile(r.r2_key).catch(() => null);
    if (!file) continue;
    const isPdf = (file.type || "").includes("pdf") || /\.pdf$/i.test(r.r2_key);
    if (isPdf) {
      let src = pdfCache.get(r.r2_key);
      if (!src) { src = await PDFDocument.load(file.bytes, { ignoreEncryption: true }); pdfCache.set(r.r2_key, src); }
      const total = src.getPageCount();
      const from = Math.max(1, Math.min(r.page_start || 1, total));
      const to = Math.max(from, Math.min(r.page_end || total, total));
      const idx = [];
      for (let i = from - 1; i < to; i++) idx.push(i);
      const copied = await doc.copyPages(src, idx);
      copied.forEach((p, i) => {
        doc.addPage(p);
        const { width } = p.getSize();
        const label = safe(`${caption}${copied.length > 1 ? `  (page ${i + 1} of ${copied.length})` : ""}`);
        p.drawText(label, { x: Math.max(12, (width - font.widthOfTextAtSize(label, 7)) / 2), y: 8, size: 7, font, color: MUTED });
      });
    } else {
      if (used.has(r.r2_key)) continue; // a photo of several receipts is added once
      used.add(r.r2_key);
      const sameFile = receipts.filter((x) => x.r2_key === r.r2_key);
      const cap = sameFile.length > 1 ? sameFile.map((x) => x.vendor || "Receipt").join(", ") : caption;
      let img;
      try {
        const isPng = (file.type || "").includes("png");
        const isJpg = /jpe?g/.test(file.type || "");
        img = isPng ? await doc.embedPng(file.bytes) : isJpg ? await doc.embedJpg(file.bytes) : await doc.embedPng(await toPng(file.bytes, file.type));
      } catch {
        try { img = await doc.embedPng(await toPng(file.bytes, file.type)); } catch { continue; }
      }
      const p = doc.addPage([612, 792]);
      const maxW = 612 - 2 * M, maxH = 792 - 2 * M - 24;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1.6);
      const w = img.width * scale, h = img.height * scale;
      p.drawText(safe(cap).slice(0, 110), { x: M, y: 792 - M - 8, size: 9, font: bold, color: INK });
      p.drawImage(img, { x: (612 - w) / 2, y: 792 - M - 24 - h, width: w, height: h });
    }
  }

  return doc.save();
}
