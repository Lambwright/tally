import { defineConfig } from "vitest/config";

// Plain node-environment unit tests over the pure helpers exported from src/index.js
// (invoice-number parsing, PA-body salvage, validation-flag logic, tax math).
// Route/integration tests that need R2 + the auth service binding are run against
// `wrangler dev` by hand — see worker/README.md.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.js"],
  },
});
