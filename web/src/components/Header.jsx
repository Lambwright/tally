import { useEffect, useRef, useState } from "react";

// Same suite switcher the other apps carry — click the wordmark to jump between
// apps. Ported from scout-intake's app-switcher (URLs + owner-gated PUNCH link).
const PUNCH_OWNER_USERNAME = "ben";
function appLinks(user) {
  const isOwner = user && String(user.username).toLowerCase() === PUNCH_OWNER_USERNAME;
  return [
    { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/", comingSoon: !isOwner },
    { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html" },
    { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/" },
    { name: "TALLY", url: "https://lambwright.github.io/tally/", current: true },
  ];
}

// Standalone on purpose — this component doesn't assume it owns the page, so it
// drops cleanly into a future shared shell.
export default function Header({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="header">
      <div className="header-badge app-switcher" ref={ref}>
        <span
          className="header-badge-name"
          style={{ cursor: "pointer" }}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          TALLY<span className="app-switcher-caret">▾</span>
        </span>
        <span className="header-badge-sub">Einbau Expense Review</span>
        <span className="header-brand-tag">An Einbau Product</span>
        {open && (
          <div className="app-switcher-menu">
            {appLinks(user).map((app) =>
              app.comingSoon ? (
                <div className="app-switcher-item disabled" key={app.name}>
                  {app.name}<span className="app-switcher-soon">COMING SOON</span>
                </div>
              ) : (
                <a className={`app-switcher-item${app.current ? " current" : ""}`} href={app.url} key={app.name}>
                  {app.name}
                </a>
              )
            )}
          </div>
        )}
      </div>
      {user && (
        <div className="header-user">
          <span className="header-username">{user.displayName || user.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
        </div>
      )}
    </div>
  );
}
