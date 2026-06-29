import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/webview"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "media"),
    // NOT emptyOutDir: media/octoshell.svg is a committed activity-bar icon that lives
    // alongside the build output; wiping the dir would delete it. Hashed asset filenames
    // mean stale chunks are harmless (and gitignored under media/assets/).
    emptyOutDir: false,
    rollupOptions: { input: resolve(__dirname, "src/webview/index.html") },
  },
});
