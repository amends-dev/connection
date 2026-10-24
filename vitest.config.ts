import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Separate processes preserve Bun's native server APIs.
    pool: "forks",
    maxWorkers: 4,
    environment: "node",
    // Tests own their resources; reuse workers and their module cache.
    isolate: false,
    testTimeout: 20_000,
    include: ["packages/*/test/**/*.test.ts"]
  }
})
