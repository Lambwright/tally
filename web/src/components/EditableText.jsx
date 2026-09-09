import { useEffect, useRef, useState } from "react";

// Click-to-edit inline text — reads as plain text, only looks editable on
// hover/focus (PUNCH-bubble style). Commits on Enter/blur, cancels on Escape.
export default function EditableText({ value, onSave, placeholder = "—", disabled = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef(null);

  useEffect(() => { setDraft(value ?? ""); }, [value]);
  useEffect(() => {
    if (editing && ref.current) { ref.current.focus(); ref.current.select(); }
  }, [editing]);

  if (disabled) return <span>{value || placeholder}</span>;

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== String(value ?? "").trim()) onSave(v);
  };
  const cancel = () => { setEditing(false); setDraft(value ?? ""); };

  if (editing) {
    return (
      <input
        ref={ref}
        className="editable-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") cancel();
        }}
      />
    );
  }
  return (
    <span
      className="editable"
      tabIndex={0}
      role="button"
      title="Click to edit"
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); }
      }}
    >
      {value || <span className="editable-placeholder">{placeholder}</span>}
    </span>
  );
}
