// Einbau ID — fourth instance of the pattern already proven in PUNCH/SCOUT/INTAKE.
// Own login screen, calls auth-worker's /auth/login directly, stores the token in
// localStorage, attaches it as `Authorization: Bearer` on every call to our own
// worker. See ../../worker/README.md and auth-worker/README.md for the server side.

const TOKEN_KEY = "einbau_id_token";

// In dev, requests go through Vite's proxy (same-origin, avoids auth-worker's
// CORS lock to https://lambwright.github.io). In prod they go straight there.
const AUTH_BASE = import.meta.env.DEV
  ? ""
  : import.meta.env.VITE_AUTH_API || "https://auth.ben-a90.workers.dev";

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing / storage blocked — session just won't persist across reloads.
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

const LOGIN_ERROR_MESSAGES = {
  invalid_credentials: "Incorrect username or password.",
  rate_limited: "Too many attempts — try again in a few minutes.",
  invalid_request: "Enter a username and password.",
};

export async function login(username, password) {
  const res = await fetch(`${AUTH_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(LOGIN_ERROR_MESSAGES[data.error] || data.error || "Login failed.");
  }
  storeToken(data.token);
  return data.user;
}

// Returns { valid, user?, reason? } — never throws, so callers can just check .valid.
export async function verify(token) {
  try {
    const res = await fetch(`${AUTH_BASE}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    });
    const data = await res.json().catch(() => ({ valid: false }));
    if (data.valid && data.refreshedToken) storeToken(data.refreshedToken);
    return data;
  } catch (e) {
    return { valid: false, reason: `Couldn't reach the login service: ${e.message}` };
  }
}

export function logout() {
  clearToken();
}
