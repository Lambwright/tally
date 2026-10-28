// Live view of what the worker is doing while it reads a submission, so a slow parse looks
// different from a stalled one. The worker keeps the "parsing" flag's `updated_at` fresh with
// a heartbeat; if it goes quiet for STALL_MS the parse has died (e.g. the request was cut off)
// and the person can restart it.
import { useEffect, useState } from "react";
import Loader from "./Loader.jsx";

export const STALL_MS = 120000;

// Something to say while it works — a new word every few seconds.
const VERBS = [
  "Percolating", "Ruminating", "Pondering", "Pontificating", "Cogitating", "Deliberating", "Mulling it over",
  "Noodling", "Marinating", "Simmering", "Squinting at receipts", "Untangling", "Contemplating", "Musing",
  "Philosophizing", "Puzzling", "Deciphering", "Rummaging", "Tabulating", "Concocting", "Cross-referencing",
  "Peering at the fine print", "Consulting the oracle", "Wrangling line items", "Reticulating", "Brewing",
];
export function useVerb(active) { // (kept for anything that still wants a word; the shared loader has its own lines)
  const [i, setI] = useState(() => Math.floor(Math.random() * VERBS.length));
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setI((n) => (n + 1 + Math.floor(Math.random() * 5)) % VERBS.length), 3200);
    return () => clearInterval(t);
  }, [active]);
  return VERBS[i];
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Step({ state, children }) {
  const mark = state === "done" ? "✓" : state === "running" ? "●" : "○";
  const color = state === "done" ? "var(--green, #6fbf73)" : state === "running" ? "var(--yellow)" : "var(--muted, #8a8478)";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", color: state === "todo" ? "var(--muted, #8a8478)" : undefined }}>
      <span style={{ color, width: 14, textAlign: "center" }}>{mark}</span>
      <span>{children}</span>
    </div>
  );
}

export default function ParseProgress({ flag, now, onRestart, restarting, finished = false }) {
  if (finished) {
    return (
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Loader state="done" doneText="All done!" size={110} />
      </div>
    );
  }
  const started = Date.parse(flag.started_at || "") || null;
  const updated = Date.parse(flag.updated_at || "") || null;
  const queued = !flag.running;
  const quietFor = updated ? now - updated : 0;
  const stalled = !queued && quietFor > STALL_MS;
  const files = flag.files ?? null;
  const phase = flag.phase || "reading";

  return (
    <div className="card" style={{ borderColor: stalled ? "var(--red)" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <Loader state={stalled ? "stalled" : "working"} size={110} stalledText="This looks stalled" />
      <div style={{ flex: 1, minWidth: 220 }}>
      <div className="card-title" style={{ color: stalled ? "var(--red)" : "var(--yellow)" }}>
        {stalled ? "This looks stalled" : "Reading your files"}
        {started && !queued ? <span className="row-secondary" style={{ marginLeft: 10, fontWeight: 400 }}>{mmss(now - started)} elapsed</span> : null}
      </div>

      <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
        <Step state="done">Files saved{files ? ` (${files})` : ""}</Step>
        <Step state={queued ? "running" : phase === "saving" ? "done" : "running"}>
          {queued
            ? "Waiting to start…"
            : `Claude is reading the files${flag.total ? ` — ${flag.done || 0} of ${flag.total} batch${flag.total === 1 ? "" : "es"} done` : ""}`}
        </Step>
        <Step state={phase === "saving" && !queued ? "running" : "todo"}>Matching receipts to lines and saving</Step>
      </div>
      </div>
      </div>

      {stalled ? (
        <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="row-secondary">No progress for {mmss(quietFor)}. The files are saved; nothing is lost.</span>
          <button className="btn btn-ghost btn-sm" onClick={onRestart} disabled={restarting}>
            {restarting ? "Restarting…" : "↻ Restart reading"}
          </button>
        </div>
      ) : (
        <div className="row-secondary" style={{ marginTop: 8 }}>
          Big bundles can take a few minutes. This updates by itself; you can leave it open.
        </div>
      )}
    </div>
  );
}
