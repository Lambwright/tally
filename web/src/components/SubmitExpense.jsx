import { useCallback, useEffect, useRef, useState } from "react";
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

// The PM-facing version of UploadSubmission — no PDF form, no employee-name
// field (it's always the submitter's own name, set server-side), just
// receipts + a project. Lands in the same review page where line items get
// built by hand, same as any other form-parse-failure case already does.
export default function SubmitExpense({ onClose, onCreated }) {
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [projectNumber, setProjectNumber] = useState("");
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api.listProjects().then((d) => setProjects(d.projects || [])).catch(() => setProjects([]));
  }, []);

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

  async function handleSubmit() {
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
        <div className="card-title" style={{ marginBottom: 4 }}>Submit an expense</div>
        <p className="row-secondary" style={{ marginBottom: 12 }}>
          Drop your receipts below — no PDF form needed. You'll build the line items on the next page, then it goes to Leela for approval.
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
          <span>Drag receipts here, or click to browse</span>
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
          <label htmlFor="submit-expense-project">Project number</label>
          <input id="submit-expense-project" list="submit-expense-project-options" placeholder="Search active projects…"
            value={projectNumber} disabled={busy} onChange={(e) => setProjectNumber(e.target.value)} />
          <datalist id="submit-expense-project-options">
            {projects.map((p) => <option key={p.procore_id} value={p.project_number}>{p.name}</option>)}
          </datalist>
        </div>

        {error && <div className="login-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-orange" onClick={handleSubmit} disabled={busy || !files.length}>
            {busy ? "Uploading…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
