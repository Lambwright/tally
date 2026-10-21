// A small creature sitting on the floor, hammering away at an old beige CRT while TALLY reads
// the files; hops up when it's done, sits still (with a question mark) if the read stalled.
// Pure SVG + CSS (see the .cc-* rules in theme.css), so it can be swapped for hand-drawn art
// later without touching anything else: keep the same three states, working / done / stalled.
export default function ClaudeTyping({ state = "working", size = 150 }) {
  return (
    <svg
      className={`cc-scene is-${state}`}
      width={size}
      height={size * 0.62}
      viewBox="0 0 200 124"
      role="img"
      aria-label={state === "done" ? "Done" : state === "stalled" ? "Stalled" : "Working on it"}
    >
      {/* floor */}
      <rect x="0" y="108" width="200" height="2" fill="#3A3733" />

      {/* CRT monitor on the floor */}
      <rect x="112" y="46" width="76" height="62" rx="5" fill="#CDBF9F" />
      <rect x="112" y="102" width="76" height="6" fill="#B3A583" />
      <rect x="119" y="53" width="62" height="43" rx="3" fill="#0E1A12" />
      <g className="cc-screen">
        <rect className="cc-line l1" x="124" y="60" width="50" height="3" fill="#6FB35C" />
        <rect className="cc-line l2" x="124" y="67" width="50" height="3" fill="#6FB35C" />
        <rect className="cc-line l3" x="124" y="74" width="50" height="3" fill="#6FB35C" />
        <rect className="cc-line l4" x="124" y="81" width="50" height="3" fill="#6FB35C" />
        <rect className="cc-cursor" x="124" y="88" width="6" height="4" fill="#6FB35C" />
      </g>
      <polyline className="cc-check" points="135,76 146,88 166,64" fill="none" stroke="#6FB35C" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />

      {/* keyboard on the floor */}
      <rect x="82" y="100" width="48" height="8" rx="1.5" fill="#CDBF9F" />
      <g fill="#8E8268">
        <rect x="86" y="102" width="5" height="2" /><rect x="94" y="102" width="5" height="2" />
        <rect x="102" y="102" width="5" height="2" /><rect x="110" y="102" width="5" height="2" />
        <rect x="118" y="102" width="5" height="2" />
      </g>

      {/* the creature */}
      <g className="cc-char">
        {/* legs folded out in front */}
        <rect x="42" y="100" width="30" height="8" rx="2" fill="#B85F3E" />
        {/* body */}
        <rect x="32" y="62" width="40" height="42" rx="6" fill="#D97757" />
        {/* eyes */}
        <rect className="cc-eye" x="41" y="72" width="6" height="10" rx="1.5" fill="#2A1A12" />
        <rect className="cc-eye" x="56" y="72" width="6" height="10" rx="1.5" fill="#2A1A12" />
        {/* arms reaching for the keys */}
        <rect className="cc-arm cc-arm-a" x="68" y="86" width="15" height="5" rx="2.5" fill="#D97757" />
        <circle className="cc-arm cc-arm-a" cx="84" cy="88.5" r="3" fill="#E89170" />
        <rect className="cc-arm cc-arm-b" x="68" y="93" width="19" height="5" rx="2.5" fill="#C4684A" />
        <circle className="cc-arm cc-arm-b" cx="88" cy="95.5" r="3" fill="#E89170" />
      </g>

      <text className="cc-question" x="62" y="52" fontSize="20" fontWeight="700" fill="#D1A93F">?</text>
    </svg>
  );
}
