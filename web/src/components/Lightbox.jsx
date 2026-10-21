import { useEffect, useState } from "react";
import { PDFDocument } from "pdf-lib";

// Full-screen viewer for an attachment. `items` is [{ url, type, name, label }].
export default function Lightbox({ items, index, onIndex, onClose }) {
  const item = items[index];
  const isPdf = (item?.type || "").includes("pdf") || /\.pdf$/i.test(item?.name || "");

  // A receipt that is only some pages of a longer PDF (a 16-page bundle of invoices) opens as
  // just those pages, sliced out in the browser, with a switch to see the whole file.
  const [slice, setSlice] = useState(null); // null = working on it; { url, from, to, total } | { whole, total } | { failed }
  const [showAll, setShowAll] = useState(false);
  const pagesKey = item?.pages ? item.pages.join("-") : "";
  useEffect(() => {
    setSlice(null);
    setShowAll(false);
    if (!isPdf || !item?.pages) return undefined;
    let cancelled = false;
    let made = null;
    (async () => {
      try {
        const bytes = await (await fetch(item.url)).arrayBuffer();
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const total = src.getPageCount();
        const from = Math.max(1, Math.min(item.pages[0], total));
        const to = Math.max(from, Math.min(item.pages[1], total));
        if (from === 1 && to === total) { if (!cancelled) setSlice({ whole: true, total }); return; }
        const out = await PDFDocument.create();
        const idx = [];
        for (let i = from - 1; i < to; i++) idx.push(i);
        (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
        made = URL.createObjectURL(new Blob([await out.save()], { type: "application/pdf" }));
        if (!cancelled) setSlice({ url: made, from, to, total });
      } catch {
        if (!cancelled) setSlice({ failed: true });
      }
    })();
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [item?.url, pagesKey, isPdf]);

  const sliced = isPdf && item?.pages && !showAll && slice?.url ? slice : null;
  const preparing = isPdf && item?.pages && !showAll && slice === null;
  const shownUrl = sliced ? sliced.url
    : isPdf && item?.pages && !showAll && slice?.failed ? `${item.url}#page=${item.pages[0]}`
    : item?.url;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (items.length > 1 && e.key === "ArrowRight") onIndex((index + 1) % items.length);
      else if (items.length > 1 && e.key === "ArrowLeft") onIndex((index - 1 + items.length) % items.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex, onClose]);

  function saveBlob(bytes, filename, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadPdf() {
    const base = (item.name || "attachment").replace(/\.[^.]+$/, "");
    const bytes = new Uint8Array(await (await fetch(shownUrl.split("#")[0])).arrayBuffer());
    if (isPdf) {
      saveBlob(bytes, `${base}.pdf`, "application/pdf");
      return;
    }
    const doc = await PDFDocument.create();
    const isPng = (item.type || "").includes("png") || /\.png$/i.test(item.name || "");
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    saveBlob(await doc.save(), `${base}.pdf`, "application/pdf");
  }

  if (!item) return null;

  return (
    <div className="lightbox-backdrop" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-title">{item.label || item.name}</span>
        <div className="lightbox-bar-actions">
          {slice && item?.pages && !slice.failed && !slice.whole && (
            <span className="row-secondary">
              {showAll ? `All ${slice.total} pages` : slice.from === slice.to ? `Page ${slice.from} of ${slice.total}` : `Pages ${slice.from}–${slice.to} of ${slice.total}`}
              {" · "}
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show just this receipt" : "Show all pages"}</button>
            </span>
          )}
          {items.length > 1 && <span className="row-secondary">{index + 1} / {items.length}</span>}
          <button className="btn btn-ghost btn-sm" onClick={downloadPdf}>Download PDF</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close ✕</button>
        </div>
      </div>

      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        {isPdf ? (
          preparing ? (
            <div className="row-secondary" style={{ padding: 24 }}>Opening the right page…</div>
          ) : (
            <iframe key={shownUrl} title={item.label || "attachment"} src={shownUrl} className="lightbox-pdf" />
          )
        ) : (
          <img src={item.url} alt={item.label || "attachment"} />
        )}
      </div>

      {items.length > 1 && (
        <>
          <button className="lightbox-nav prev" onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + items.length) % items.length); }}>‹</button>
          <button className="lightbox-nav next" onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % items.length); }}>›</button>
        </>
      )}
    </div>
  );
}
