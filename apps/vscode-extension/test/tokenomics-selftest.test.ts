import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PACK = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "octobots-pack");
const SELFTEST = join(PACK, "tokenomics", "selftest.mjs");

/**
 * Runs the pack's tokenomics selftest the way CI would. The environment is deliberately polluted:
 * HOME and CLAUDE_CONFIG_DIR point at decoy dirs holding a session, so a selftest that let the
 * developer's real transcript roots leak in would either fail or count the decoy.
 */
let cached: { status: number | null; stdout: string; stderr: string } | undefined;

/** Spawns the selftest once; the first test to call it owns the (auto-cleaned) decoy dirs. */
function selftest(): { status: number | null; stdout: string; stderr: string } {
  if (cached) return cached;
  const decoyHome = mkdtempClean("selftest-decoy-home-");
  const decoyCfg = mkdtempClean("selftest-decoy-cfg-");
  const proj = join(decoyCfg, "projects", "-decoy-slug");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "decoy.jsonl"), "{}\n");
  const r = spawnSync(process.execPath, [SELFTEST], {
    encoding: "utf8",
    env: { ...process.env, HOME: decoyHome, USERPROFILE: decoyHome, CLAUDE_CONFIG_DIR: decoyCfg },
    timeout: 120_000,
  });
  cached = { status: r.status, stdout: r.stdout, stderr: r.stderr };
  return cached;
}

/** The "ok" lines of the roots suite, i.e. everything printed after its header. */
function rootsOkLines(): string[] {
  const after = selftest().stdout.split("tokenomics selftest — transcript roots:")[1] ?? "";
  return after.split("\n").filter((l) => /^\s+ok\s/.test(l));
}

describe("tokenomics selftest.mjs", () => {
  it("exits 0 with no failed check", { timeout: 130_000 }, () => {
    expect(selftest().stdout).toContain("all checks passed");
    expect(selftest().stdout).not.toMatch(/^\s+FAIL\s/m);
    expect(selftest().status).toBe(0);
  });

  it("ran the transcript roots suite", () => {
    expect(selftest().stdout).toContain("tokenomics selftest — transcript roots:");
    expect(rootsOkLines().length).toBeGreaterThanOrEqual(8);
  });

  it.each([
    ["M1 AC1 slug filter: only the repo's own slug is read", /\[roots\]\[AC1\].*other projects' slugs are ignored/],
    ["M1 AC1 slug rule: _ and . become -", /\[roots\]\[AC1\].*slug rule/],
    ["M1 AC2 root precedence: CLAUDE_CONFIG_DIR replaces ~/.claude", /\[roots\]\[AC2\].*CLAUDE_CONFIG_DIR\/projects/],
    ["M1 AC2 root precedence: env override replaces both", /\[roots\]\[AC2\].*env override/],
    ["M1 AC2 root precedence: --projects-dir replaces both", /\[roots\]\[AC2\].*--projects-dir/],
    ["M1 AC3 dedupe: a session in two roots counts once", /\[roots\]\[AC3\].*not double-counted/],
    ["M1 AC3 dedupe: more turns wins regardless of root order", /\[roots\]\[AC3\].*more turns wins even when the richer copy is in the earlier root/],
    ["M1 AC3 dedupe: rerun is byte-identical", /\[roots\]\[AC3\].*byte-identical/],
    ["worktree path unwinds to the main checkout's slug", /\[roots\].*worktree/],
  ])("covers %s", (_name, pattern) => {
    expect(rootsOkLines().some((l) => pattern.test(l))).toBe(true);
  });

  it("proves the developer's real HOME and CLAUDE_CONFIG_DIR cannot leak in", () => {
    const lines = rootsOkLines();
    expect(lines.some((l) => /\[roots\]\[isolation\].*CLAUDE_CONFIG_DIR/.test(l))).toBe(true);
    expect(lines.some((l) => /\[roots\]\[isolation\].*HOME/.test(l))).toBe(true);
  });
});
