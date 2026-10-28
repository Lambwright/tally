import { useEffect, useRef } from "react";
import ClaudeTyping from "./ClaudeTyping.jsx";

// THE loading animation for anything that loads: the suite's shared one (Claude typing at his CRT, in costume for
// the season, with matching loading lines) from einbau-festive.js, which every Einbau app loads from HELM. If that
// script didn't load, our own creature stands in. state: "working" | "done" | "stalled". Pass `text` only when the
// person needs specific information ("Pushing to Procore…"); otherwise it rotates its own lines.
export default function Loader({ state = "working", size = 110, text, doneText, stalledText, align = "center" }) {
  const ref = useRef(null);
  const loaderRef = useRef(null);
  const F = typeof window !== "undefined" ? window.EinbauFestive : null;
  const ok = !!(F && F.loader);

  useEffect(() => {
    if (!ok || !ref.current) return undefined;
    const l = F.loader(ref.current, { size, text });
    loaderRef.current = l;
    return () => { l.remove(); loaderRef.current = null; };
  }, [ok, size, text]); // eslint-disable-line react-hooks/exhaustive-deps

  // declared after the effect above, so on (re)creation the new loader gets its state straight away
  useEffect(() => {
    const l = loaderRef.current;
    if (!l) return;
    if (state === "done") l.done(doneText);
    else if (state === "stalled") l.stalled(stalledText);
  }, [ok, size, text, state, doneText, stalledText]);

  if (!ok) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: align === "center" ? "center" : "flex-start", gap: 12, padding: 12 }}>
        <ClaudeTyping state={state} size={size} />
        <span className="row-secondary">{state === "done" ? doneText : state === "stalled" ? stalledText : text || "Working on it…"}</span>
      </div>
    );
  }
  return <div ref={ref} />;
}

// A seasonal line for places where only text fits (a button that says "Working…").
export function workingText(fallback = "Working…") {
  try {
    return window.EinbauFestive?.phrase?.() || fallback;
  } catch {
    return fallback;
  }
}
