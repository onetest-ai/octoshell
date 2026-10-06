import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Disables git background maintenance for every spawned git (M4 B1).
    setupFiles: ["test/setup-git-env.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text"],
    },
  },
});
