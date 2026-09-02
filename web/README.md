# web — TALLY review queue

React + Vite frontend, Einbau-ID gated. See the top-level
[`../README.md`](../README.md) for architecture and deploy order.

## Local dev

```bash
npm install
npm run dev
```

Requires `tally-worker` running locally (`cd ../worker && npm run dev`) — Vite's
dev proxy (see `vite.config.js`) routes `/api/*` to it and `/auth/*` to the real
`auth-worker`, so the browser origin stays `http://localhost:5173` the whole
time (auth-worker's CORS is locked to `https://lambwright.github.io`).

## Build

```bash
npm run build   # → dist/, base path /tally/
```

Deployed automatically to GitHub Pages by `.github/workflows/pages.yml` on push
to `main`. Set the `VITE_TALLY_API` and `VITE_AUTH_API` repository variables
(Settings → Secrets and variables → Actions → Variables) to the deployed
Worker URLs before the first real deploy — without them the build falls back to
empty strings and every API call will 404.
