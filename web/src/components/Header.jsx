import { useEffect, useRef, useState } from "react";

// Same suite switcher every other app carries — keep the list and the
// visibility rule below identical across apps.
const APP_LINKS = [
  { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/" },
  { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html" },
  { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/" },
  { name: "TALLY", url: "https://lambwright.github.io/tally/" },
  { name: "HANDOFF", url: "https://lambwright.github.io/handoff/" },
  { name: "LEDGER", url: "https://lambwright.github.io/ledger/" },
  { name: "CRM", url: "https://lambwright.github.io/crm/" },
];
const HELM_LINK = { name: "HELM", url: "https://lambwright.github.io/helm/" };
const CURRENT_APP = "TALLY";

// Only apps this user can open, then HELM always last (it's where settings
// live). `user.apps` absent = unrestricted, except LEDGER, which fails closed
// and needs an explicit grant (see auth-worker/README.md).
function appLinks(user) {
  const apps = Array.isArray(user?.apps) ? user.apps.map((a) => String(a).toUpperCase()) : null;
  const allowed = (name) => (apps ? apps.includes(name) : name !== "LEDGER");
  return [...APP_LINKS.filter((a) => a.name === CURRENT_APP || allowed(a.name)), HELM_LINK].map((a) => ({
    ...a,
    current: a.name === CURRENT_APP,
  }));
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
