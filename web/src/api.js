import { getStoredToken, storeToken, clearToken } from "./auth.js";

const API_BASE = import.meta.env.DEV
  ? "/api"
  : import.meta.env.VITE_TALLY_API || "";

class UnauthorizedError extends Error {
  constructor(reason) {
    super(reason || "unauthorized");
    this.unauthorized = true;
  }
}

async function request(path, { method = "GET", body, headers } = {}) {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const refreshed = res.headers.get("X-Refreshed-Token");
  if (refreshed) storeToken(refreshed);

  if (res.status === 401) {
    clearToken();
    const data = await res.json().catch(() => ({}));
    throw new UnauthorizedError(data.reason);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  listSubmissions: (status) => request(`/submissions${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  getSubmission: (id) => request(`/submissions/${id}`), // { submission, line_items, receipts }
  getCostCodes: (id) => request(`/submissions/${id}/cost-codes`), // { codes, defaults }

  addLine: (id, fields) => request(`/submissions/${id}/lines`, { method: "POST", body: fields }),
  patchLine: (id, lineId, fields) => request(`/submissions/${id}/lines/${lineId}`, { method: "PATCH", body: fields }),
  deleteLine: (id, lineId) => request(`/submissions/${id}/lines/${lineId}`, { method: "DELETE" }),
  matchLine: (id, lineId, receiptId) =>
    request(`/submissions/${id}/lines/${lineId}/match`, { method: "POST", body: { receipt_id: receiptId } }),
  unmatchLine: (id, lineId) => request(`/submissions/${id}/lines/${lineId}/unmatch`, { method: "POST", body: {} }),

  approve: (id, { dryRun = false } = {}) =>
    request(`/submissions/${id}/approve${dryRun ? "?dryRun=1" : ""}`, { method: "POST", body: {} }),
  requestRevision: (id, note) => request(`/submissions/${id}/request-revision`, { method: "POST", body: { note } }),
  reject: (id, reason) => request(`/submissions/${id}/reject`, { method: "POST", body: { reason } }),
  listProjects: () => request("/projects"),
  receiptUrl: (id, key) => `${API_BASE}/submissions/${id}/receipt?key=${encodeURIComponent(key)}`,
};

// Receipt images live in a private R2 bucket behind an authed route — fetch as a
// blob and hand the caller an object URL rather than ever exposing an R2 URL.
export async function fetchReceiptObjectUrl(id, key) {
  const token = getStoredToken();
  const res = await fetch(api.receiptUrl(id, key), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Couldn't load receipt image (HTTP ${res.status}).`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export { UnauthorizedError };
