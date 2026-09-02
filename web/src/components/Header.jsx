// Standalone on purpose — the kickoff wants this app easy to fold into a future
// shared multi-app shell (logo dropdown, cross-app nav). This component doesn't
// assume it owns the page, doesn't read routing state, and takes everything it
// needs as props.
export default function Header({ user, onLogout }) {
  return (
    <div className="header">
      <div className="header-badge">
        <span className="header-badge-name">TALLY</span>
        <span className="header-badge-sub">Einbau Expense Review</span>
        <span className="header-brand-tag">An Einbau Product</span>
      </div>
      {user && (
        <div className="header-user">
          <span className="header-username">{user.displayName || user.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
