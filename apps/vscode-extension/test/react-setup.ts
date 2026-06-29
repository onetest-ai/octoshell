import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// Stub acquireVsCodeApi for webview entry-point tests (chat-entry.tsx, etc.).
// The real function is injected by VS Code's webview runtime; in tests we provide a no-op.
if (typeof (globalThis as Record<string, unknown>)["acquireVsCodeApi"] === "undefined") {
  (globalThis as Record<string, unknown>)["acquireVsCodeApi"] = () => ({
    postMessage: () => {},
    getState: () => undefined,
    setState: () => {},
  });
}

// Ensure document has a #root element so chat-entry.tsx's module-level createRoot() doesn't throw.
if (typeof document !== "undefined" && !document.getElementById("root")) {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
}
