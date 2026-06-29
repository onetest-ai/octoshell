import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  // The `vscode` module is only provided by the extension host at runtime. Alias it to a
  // minimal stub so host modules that statically import it can be loaded under vitest.
  resolve: { alias: { vscode: resolve(__dirname, "test/vscode-stub.ts") } },
  test: {
    environment: "node",
    passWithNoTests: true,
    environmentMatchGlobs: [["test/**/*.test.tsx", "happy-dom"]],
    setupFiles: ["./test/react-setup.ts"],
  },
});
