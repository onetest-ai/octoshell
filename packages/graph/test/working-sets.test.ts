import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingSets } from "../src/working-sets.js";
import { analyze } from "../src/analyze.js";
import { loadConfig } from "../src/config.js";

const moduleOf = (p: string): string => (p.startsWith("a/") ? "a" : p.startsWith("b/") ? "b" : "root");

// packages/graph/test -> packages/graph -> packages -> repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("workingSets", () => {
  it("drops a community whose files all fall inside one declared module", () => {
    const files = ["a/one.ts", "a/two.ts", "a/three.ts"];
    const byCommunity = new Map([[7, [0, 1, 2]]]);
    expect(workingSets(byCommunity, [], files, moduleOf)).toEqual([]);
  });

  it("keeps a community spanning two declared modules and names the span", () => {
    const files = ["a/one.ts", "b/two.ts"];
    const byCommunity = new Map([[7, [0, 1]]]);
    const [set] = workingSets(byCommunity, [], files, moduleOf);
    expect(set?.modules).toEqual(["a", "b"]);
    expect(set?.files).toEqual(["a/one.ts", "b/two.ts"]);
  });

  it("drops a two-file set that is entirely a manifest/lockfile pair", () => {
    const files = ["packages/graph/package.json", "pnpm-lock.yaml"];
    const mod = (p: string): string => (p.includes("/") ? "packages/graph" : "(repo root)");
    expect(workingSets(new Map([[24, [0, 1]]]), [], files, mod)).toEqual([]);
  });

  it("keeps a larger set that merely contains a lockfile", () => {
    const files = ["a/x.ts", "b/y.ts", "pnpm-lock.yaml"];
    const mod = (p: string): string => (p.startsWith("a/") ? "a" : p.startsWith("b/") ? "b" : "root");
    expect(workingSets(new Map([[9, [0, 1, 2]]]), [], files, mod)).toHaveLength(1);
  });

  // Live-history assertion, deliberately: it re-checks the mission's own
  // headline claim against this repo's real commit history rather than a
  // synthetic fixture. It will drift as the repo grows — that is expected;
  // this campaign has twice shipped a claim nothing re-checked, and the fix
  // for a broken instance of this test is to re-measure and decide, not to
  // delete it.
  it("finds the dual-schema working set on this repo's own history", () => {
    const { analysis } = analyze(REPO_ROOT, loadConfig(REPO_ROOT, {}), { now: Date.now() });
    const set = analysis.workingSets.find((w) =>
      w.files.includes("packages/board/src/entity-schema.ts"));
    expect(set?.files.some((f) => f.endsWith("entity-io.mjs"))).toBe(true);
    expect(set?.modules).toEqual(["apps/vscode-extension", "packages/board"]);
  });
});
