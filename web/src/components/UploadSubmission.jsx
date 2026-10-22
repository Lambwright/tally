import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import Combobox from "./Combobox.jsx";

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
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    api.listCompanyUsers().then((d) => setUsers(d.users || [])).catch(() => setUsers([]));
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

  // The Procore user behind the typed name, when it is exactly one entry on the list (two people with the
  // same name can't be told apart here, so no id: Approve falls back to its name search and flags it).
  const matches = users.filter((x) => String(x.name || "").trim().toLowerCase() === employeeName.trim().toLowerCase());
  const pickedUserId = matches.length === 1 ? matches[0].id : null;

  async function handleParse() {
    if (!files.length || !employeeName.trim()) return;
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
        employee_procore_id: pickedUserId || undefined,
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
          Drop in whatever you have — the expense form, receipts, a photo of several receipts, a PDF of invoices. Claude works out what each file is, and TALLY fills in the Employee Expense Form for you when you submit.
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
          <label htmlFor="upload-employee">Employee this expense is for (required)</label>
          <Combobox id="upload-employee" placeholder="Search Einbau employees…" value={employeeName} disabled={busy}
            onChange={setEmployeeName} options={users.map((u) => ({ value: u.name, label: u.name }))} />
        </div>
        <div className="field">
          <label htmlFor="upload-project">Project number (optional — Claude reads it off the form)</label>
          <Combobox id="upload-project" placeholder="Search active projects…" value={projectNumber} disabled={busy}
            onChange={setProjectNumber} options={projects.map((p) => ({ value: p.project_number, label: p.project_number, sub: p.name }))} />
        </div>

        {error && <div className="login-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-orange" onClick={handleParse} disabled={busy || !files.length || !employeeName.trim()}>
            {busy ? "Uploading…" : "Parse with Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}
