import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const API_TARGET = process.env.LTM_API_TARGET ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Covers REST and the SSE stream at /api/v1/events. Proxied responses are piped,
      // so the event stream is not buffered.
      "/api": { target: API_TARGET, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // One self-hosted bundle on purpose: the protocol's zod schemas (shared with the server)
    // account for much of it, and validating responses against them is worth the bytes.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
  },
});
