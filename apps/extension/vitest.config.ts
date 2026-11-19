import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests do not run the extension build plugin.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
