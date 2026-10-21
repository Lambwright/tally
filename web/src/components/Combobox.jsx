import { useEffect, useMemo, useRef, useState } from "react";

// Typeahead dropdown in the same style as SCOUT's combobox: a text field with a themed list
// underneath (hover / keyboard highlight, selected row bold, "no matches" line), instead of the
// browser's native datalist. `options` is [{ value, label, sub? }] — `value` is what the field
// holds once picked, `label` is shown in the list (and searched), `sub` is a secondary line of
// text shown beside it (e.g. a project's name next to its number). With `allowFree` the field
// keeps whatever was typed even if it isn't on the list.
export default function Combobox({ id, value, onChange, options, placeholder, disabled, allowFree = true }) {
  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef(null);
  const listRef = useRef(null);

  // follow the value when it is changed from outside (a form reset)
  useEffect(() => { setText(value || ""); }, [value]);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const all = options || [];
    const shown = !q ? all : all.filter((o) => `${o.label} ${o.sub || ""}`.toLowerCase().includes(q));
    return shown.slice(0, 80);
  }, [text, options]);

  useEffect(() => { setHi(0); }, [text, open]);

  // keep the highlighted row in view while arrowing through a long list
  useEffect(() => {
    const el = listRef.current?.children?.[hi];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [hi]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function pick(o) {
    setText(o.value);
    onChange(o.value);
    setOpen(false);
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, Math.max(0, matches.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && matches[hi]) { e.preventDefault(); pick(matches[hi]); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  return (
    <div className="combobox-wrap" ref={wrapRef}>
      <input
        id={id}
        className="combobox-input"
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (allowFree) onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // leaving the field with text that isn't on the list: keep it if free entry is allowed, else clear it
          if (!allowFree && !(options || []).some((o) => o.value === text)) { setText(""); onChange(""); }
        }}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && !disabled && (
        <div className="combobox-dropdown open" ref={listRef} role="listbox">
          {matches.length === 0 ? (
            <div className="combobox-empty">No matches{allowFree && text.trim() ? " — it will be used as typed" : ""}</div>
          ) : matches.map((o, i) => (
            <div
              key={`${o.value}-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`combobox-option${i === hi ? " highlighted" : ""}${o.value === value ? " selected" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
            >
              <span>{o.label}</span>
              {o.sub ? <span className="combobox-sub">{o.sub}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
