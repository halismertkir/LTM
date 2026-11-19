import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each file boots its own embedded Postgres (WASM); give start-up room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
