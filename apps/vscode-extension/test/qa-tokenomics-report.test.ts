import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const SCRIPT = fileURLToPath(new URL("../scripts/qa/tokenomics-report.mjs", import.meta.url));

function session(projectsRoot: string, slug: string, id: string, turns: number): void {
  const dir = join(projectsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: turns }, (_, i) =>
    JSON.stringify({
      type: "assistant",
      gitBranch: "feat/qa",
      requestId: `${id}-${i}`,
      message: { model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 5 }, content: [] },
    }));
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe("scripts/qa/tokenomics-report.mjs", () => {
  it("prints the JSON contract for a temp workspace with an injected home root, and writes nothing", () => {
    const base = realpathSync(mkdtempClean("qa-tok-"));
    const workspace = join(base, "ws_demo");
    const home = join(base, "home");
    mkdirSync(join(workspace, ".octobots", "campaigns"), { recursive: true });
    const slug = workspace.replace(/[^A-Za-z0-9]/g, "-");
    session(join(home, ".claude", "projects"), slug, "home-only-1", 2);
    session(join(home, ".claude", "projects"), slug, "home-only-2", 1);
    session(join(home, ".claude", "projects"), "-Users-someone-else", "foreign", 3);
    session(join(workspace, ".claude", "projects"), slug, "legacy-1", 1);
    session(join(workspace, ".claude", "projects"), "-private-tmp", "legacy-foreign", 1);
    const before = snapshot(base);

    const out = execFileSync(process.execPath, [SCRIPT, workspace], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
    });
    const report = JSON.parse(out) as Record<string, unknown>;

    expect(Object.keys(report).sort()).toEqual(["roots", "segments", "sessions", "slug", "slugs", "workspace"]);
    expect(report.workspace).toBe(workspace);
    expect(report.slug).toBe(slug);
    expect(report.roots).toEqual([join(home, ".claude", "projects"), join(workspace, ".claude", "projects")]);
    expect(report.segments).toBe(3);
    expect(report.sessions).toEqual(["home-only-1", "home-only-2", "legacy-1"]);
    expect(report.slugs).toEqual([
      join(home, ".claude", "projects", slug),
      join(workspace, ".claude", "projects", slug),
    ]);
    expect(snapshot(base)).toEqual(before);
  });

  it("exits 2 with a usage line when no workspace is given", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT], { stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
