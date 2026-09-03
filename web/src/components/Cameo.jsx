import { useEffect } from "react";

// Brief walk-on across the bottom of the screen. Mounted by App on certain logins.
// The image lives at web/public/cameo.png (served at <base>/cameo.png); if it's
// missing the run is just an invisible empty div — nothing breaks.
export default function Cameo({ onEnd }) {
  useEffect(() => {
    const t = setTimeout(onEnd, 3600);
    return () => clearTimeout(t);
  }, [onEnd]);

  return (
    <div className="cameo-run" aria-hidden="true">
      <img
        src={`${import.meta.env.BASE_URL}cameo.png`}
        alt=""
        onError={(e) => { e.currentTarget.style.display = "none"; }}
      />
    </div>
  );
}
