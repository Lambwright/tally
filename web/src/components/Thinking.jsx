import ClaudeTyping from "./ClaudeTyping.jsx";
import { useVerb } from "./ParseProgress.jsx";

// "Working on it" for anything that makes a person wait: the creature at his old desktop and a changing word.
// `label` says what it is doing in plain words.
export default function Thinking({ label, size = 120 }) {
  const verb = useVerb(true);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 0" }}>
      <ClaudeTyping state="working" size={size} />
      <div>
        <div className="card-title" style={{ color: "var(--yellow)", marginBottom: 4 }}>{verb}…</div>
        <div className="row-secondary">{label}</div>
      </div>
    </div>
  );
}
