import { useEffect } from "react";
import { PDFDocument } from "pdf-lib";

// Full-screen viewer for an attachment. `items` is [{ url, type, name, label }].
export default function Lightbox({ items, index, onIndex, onClose }) {
  const item = items[index];
  const isPdf = (item?.type || "").includes("pdf") || /\.pdf$/i.test(item?.name || "");

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
    const bytes = new Uint8Array(await (await fetch(item.url)).arrayBuffer());
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
          {items.length > 1 && <span className="row-secondary">{index + 1} / {items.length}</span>}
          <button className="btn btn-ghost btn-sm" onClick={downloadPdf}>Download PDF</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close ✕</button>
        </div>
      </div>

      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        {isPdf ? (
          <iframe title={item.label || "attachment"} src={item.url} className="lightbox-pdf" />
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
