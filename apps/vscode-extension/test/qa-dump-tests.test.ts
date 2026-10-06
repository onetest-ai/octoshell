import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedBoardCopies } from "./fixtures/real-board.js";

const SCRIPT = fileURLToPath(new URL("../scripts/qa/dump-tests.mjs", import.meta.url));
const BOARD_DIST = fileURLToPath(new URL("../../../packages/board/dist/index.js", import.meta.url));
const SLUG = "direct-dispatch-process";

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

/** Independent count: the TC-*.md files of `tests/m<n>/` folders, found by walking the archive. */
function tcFiles(board: string, slug: string): string[] {
  const tests = join(board, "campaigns", slug, "tests");
  if (!existsSync(tests)) return [];
  const out: string[] = [];
  for (const d of readdirSync(tests)) {
    if (!/^m\d+[a-z]*$/.test(d) || !statSync(join(tests, d)).isDirectory()) continue;
    for (const f of readdirSync(join(tests, d))) if (/^TC-.*\.md$/.test(f) && statSync(join(tests, d, f)).isFile()) out.push(`campaigns/${slug}/tests/${d}/${f}`);
  }
  return out.sort();
}

describe("scripts/qa/dump-tests.mjs", () => {
  it("prints the JSON array listTestCases returns: one entry per TC-*.md of this campaign's own tests", () => {
    const [board] = trackedBoardCopies();
    const expected = tcFiles(board!, SLUG);
    expect(expected.length).toBeGreaterThan(0);
    const r = run([board!, SLUG]);
    expect(r.status).toBe(0);
    const cases = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(cases.map((t) => t.path).sort()).toEqual(expected);
    for (const t of cases) {
      expect(Object.keys(t)).toEqual(expect.arrayContaining(["id", "title", "mission", "covers", "kind", "status", "path"]));
      expect(t.id).toMatch(/^TC-\d{3,}$/);
      expect(t.mission).toMatch(/^M\d+[a-z]*$/);
      expect(Array.isArray(t.covers)).toBe(true);
      expect(["draft", "ready", "pass", "fail", "blocked", "unknown"]).toContain(t.status);
    }
  });

  it("--board-dist reads through the given library build (same output as the default here)", () => {
    const [board] = trackedBoardCopies();
    const viaDefault = run([board!, SLUG]);
    expect(run([board!, SLUG, "--board-dist", BOARD_DIST]).stdout).toBe(viaDefault.stdout);
    expect(run(["--board-dist=" + BOARD_DIST, board!, SLUG]).stdout).toBe(viaDefault.stdout);
  });

  it("prints [] for a campaign without tests, and exits 2 on bad usage, an unknown campaign or a missing dist", () => {
    const [board] = trackedBoardCopies();
    expect(run([board!]).status).toBe(2);
    expect(run([]).status).toBe(2);
    expect(run([board!, SLUG, "--nope"]).status).toBe(2);
    expect(run([board!, SLUG, "--board-dist"]).status).toBe(2);
    expect(run([join(board!, "nope"), SLUG]).status).toBe(2);
    const unknown = run([board!, "no-such-campaign"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/campaign/);
    expect(run([board!, SLUG, "--board-dist", join(board!, "missing.js")]).status).toBe(2);
  });
});
