// Search + filters + sort for the review lists. All of it is applied by the worker (so it works on the whole
// history, not just what is on screen), and a typing pause of a third of a second sends it.
export const EMPTY_FILTERS = { q: "", project: "", employee: "", from: "", to: "", sort: "date:desc" };

const SORTS = [
  ["date:desc", "Newest first"],
  ["date:asc", "Oldest first"],
  ["employee:asc", "Employee A–Z"],
  ["employee:desc", "Employee Z–A"],
  ["project:asc", "Project number ↑"],
  ["project:desc", "Project number ↓"],
  ["amount:desc", "Amount, high to low"],
  ["amount:asc", "Amount, low to high"],
  ["expense:asc", "Expense ID"],
];

export function filtersActive(f) {
  return !!(f.q || f.project || f.employee || f.from || f.to || f.sort !== EMPTY_FILTERS.sort);
}

export default function FilterBar({ filters, onChange, dateLabel = "Date", count, netTotal, truncated }) {
  const set = (patch) => onChange({ ...filters, ...patch });
  return (
    <div className="card filter-bar">
      <div className="filter-row">
        <input className="filter-search" type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })}
          placeholder="Search: employee, project, vendor, line description, expense ID, Procore id…" aria-label="Search" />
        <select value={filters.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort by">
          {SORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>
      <div className="filter-row">
        <label>Project <input value={filters.project} onChange={(e) => set({ project: e.target.value })} placeholder="number or name" /></label>
        <label>Employee <input value={filters.employee} onChange={(e) => set({ employee: e.target.value })} placeholder="name" /></label>
        <label>{dateLabel} from <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>to <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
        {filtersActive(filters) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...EMPTY_FILTERS })}>Clear</button>
        )}
        <span className="row-secondary filter-count">
          {count} expense{count === 1 ? "" : "s"}
          {Number.isFinite(netTotal) ? ` · $${netTotal.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} net` : ""}
          {truncated ? " · showing the first 500, narrow the search to see the rest" : ""}
        </span>
      </div>
    </div>
  );
}
