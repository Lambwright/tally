import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Deploys as a GitHub Pages project site: https://lambwright.github.io/tally/
// `base` matches that path so built asset URLs resolve correctly.
//
// Dev proxy exists so the browser origin is http://localhost:5173 the whole
// time — auth-worker's CORS is locked to https://lambwright.github.io, so a
// direct cross-origin call from the dev server would be blocked. Proxying
// keeps every request same-origin from the browser's point of view.
export default defineConfig({
  base: "/tally/",
  plugins: [react()],
  server: {
    proxy: {
      "/auth": {
        target: "https://auth.ben-a90.workers.dev",
        changeOrigin: true,
      },
      "/api": {
        // Point at `wrangler dev`'s printed URL for tally-worker while iterating.
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
