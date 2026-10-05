import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFailureMessage, prepareInstall } from "../src/host/pack-install-guard.js";
import { store } from "./fixtures/pack-store.js";

describe("prepareInstall", () => {
  it("a missing or unreadable store is an error naming it, so the flow stops before any question", () => {
    expect(prepareInstall(null)).toEqual({ error: "Octobots: nothing was installed (shipped-skill store missing)." });
  });
  it("a readable store passes through", () => {
    expect(prepareInstall(store)).toEqual({ store });
  });
});

describe("installFailureMessage", () => {
  it("names the failure from an Error", () => {
    const err = Object.assign(new Error("EACCES: permission denied, mkdir '/ws/.claude'"), { code: "EACCES" });
    expect(installFailureMessage(err)).toBe("Octobots: the install failed: EACCES: permission denied, mkdir '/ws/.claude'");
  });
  it("names a thrown non-Error", () => {
    expect(installFailureMessage("boom")).toBe("Octobots: the install failed: boom");
  });
});

describe("installOctobotsPack in extension.ts", () => {
  const src = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fn = src.slice(src.indexOf("async function installOctobotsPack"), src.indexOf("export async function activate"));

  it("checks the store before any modal or question", () => {
    const check = fn.indexOf("prepareInstall(");
    expect(check).toBeGreaterThan(-1);
    for (const later of ["packStatus(", "decideLocalChanges(", "showWarningMessage(", "also install the session hooks", "install the tokenomics CLI", "installPack("]) {
      expect(check, later).toBeLessThan(fn.indexOf(later));
    }
    // The error is shown and the function returns before the first of them.
    const stop = fn.indexOf("showErrorMessage(", check);
    expect(stop).toBeGreaterThan(check);
    expect(stop).toBeLessThan(fn.indexOf("decideLocalChanges("));
  });

  it("the activation prompt checks the store before asking to install", () => {
    const act = src.slice(src.indexOf("export async function activate"));
    const status = act.indexOf("shouldPromptOnActivation(");
    const check = act.indexOf("prepareInstall(", status);
    const prompt = act.indexOf("Octobots workflow pack isn't", status);
    expect(status).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(status);
    expect(prompt).toBeGreaterThan(-1);
    expect(check).toBeLessThan(prompt);
    // The store error is shown and the prompt is not reached.
    const stop = act.indexOf("showErrorMessage(", check);
    expect(stop).toBeGreaterThan(check);
    expect(stop).toBeLessThan(prompt);
  });

  it("catches a throw and shows it as an error message", () => {
    expect(fn).toMatch(/try\s*{/);
    expect(fn).toMatch(/catch\s*\(\w+\)\s*{[^}]*showErrorMessage\(installFailureMessage\(/);
  });
});
