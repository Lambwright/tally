import { useCallback, useRef, useState } from "react";
import { api } from "../api.js";

const MAX_FILES = 12;

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// Same pipeline as emailing expenses@einbau.ca — drop the form + receipts here
// instead, then "Parse with Claude" hands off to the exact same background
// parse /intake uses, and drops the reviewer straight onto the new form's
// review page while it's still reading.
export default function UploadSubmission({ onClose, onCreated }) {
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [employeeName, setEmployeeName] = useState("");
  const [projectNumber, setProjectNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const addFiles = useCallback((list) => {
    const incoming = Array.from(list || []);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      const next = [...prev];
      for (const f of incoming) {
        const key = `${f.name}:${f.size}`;
        if (!seen.has(key) && next.length < MAX_FILES) {
          next.push(f);
          seen.add(key);
        }
      }
      return next;
    });
  }, []);

  function removeFile(idx) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }

  async function handleParse() {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          contentType: f.type || "application/octet-stream",
          data: await readFileAsBase64(f),
        }))
      );
      const result = await api.uploadSubmission({
        employee_name: employeeName.trim() || undefined,
        project_number: projectNumber.trim() || undefined,
        attachments,
      });
      onCreated(result.submission.id);
    } catch (e) {
      setError(e.data?.detail || e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title" style={{ marginBottom: 4 }}>New expense submission</div>
        <p className="row-secondary" style={{ marginBottom: 12 }}>
          Drop the expense form (PDF) and receipt photos below — Claude reads them the same way it does from email.
        </p>

        <div
          className={`dropzone ${dragOver ? "is-dragover" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="application/pdf,image/*"
            style={{ display: "none" }}
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
          <span>Drag files here, or click to browse</span>
        </div>

        {files.length > 0 && (
          <ul className="upload-file-list">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <span>{f.name}</span>
                <button type="button" className="chip-x" title="Remove" disabled={busy} onClick={() => removeFile(i)}>×</button>
              </li>
            ))}
          </ul>
        )}

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="upload-employee">Employee name (optional — Claude reads it off the form)</label>
          <input id="upload-employee" value={employeeName} disabled={busy} onChange={(e) => setEmployeeName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="upload-project">Project number (optional — Claude reads it off the form)</label>
          <input id="upload-project" value={projectNumber} disabled={busy} onChange={(e) => setProjectNumber(e.target.value)} />
        </div>

        {error && <div className="login-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-orange" onClick={handleParse} disabled={busy || !files.length}>
            {busy ? "Uploading…" : "Parse with Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}
