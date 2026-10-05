// Unit tests for the pack's legacy-workflows.mjs, the one place validate.js and doctor.js get the
// leftover-`workflows/` warning text from. The CLI scenarios cover it over real boards; this pins the
// board-root fallback a board-shaped path never reaches. It runs the module in a child `node`, as the
// CLI tests do, so `pnpm coverage:pack` (c8 over child processes) counts it.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts");
const LW = pathToFileURL(join(SCRIPTS, "legacy-workflows.mjs")).href;

/** `{ root, warnings }` for `dir`, computed by legacy-workflows.mjs in a child node process. */
function report(dir: string): { root: string; warnings: string[]; phrase: string } {
  const src =
    `import * as lw from ${JSON.stringify(LW)}; const d = process.argv[1]; const root = lw.boardRootOf(d);` +
    "console.log(JSON.stringify({ root, warnings: lw.findLegacyWorkflowFolders(d, root).map(lw.legacyWorkflowsWarning), phrase: lw.NO_LONGER_READ }));";
  return JSON.parse(execFileSync("node", ["--input-type=module", "-e", src, dir], { encoding: "utf8" })) as {
    root: string; warnings: string[]; phrase: string;
  };
}

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("legacy-workflows.mjs", () => {
  it("boardRootOf falls back to the folder itself when no .octobots or campaigns ancestor exists", () => {
    root = mkdtempSync(join(tmpdir(), "octo-lw-"));
    const dir = join(root, "loose", "mission");
    mkdirSync(join(dir, "workflows", "w1"), { recursive: true });
    const r = report(dir);
    expect(r.root).toBe(resolve(dir));
    expect(r.warnings).toEqual([`warning: workflows/w1: ${r.phrase}`]);
  });
});
