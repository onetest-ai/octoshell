// Unit tests for the pack's skill-marker.mjs, the one rule doctor.js, validate.js and
// pack-reconcile.mjs read a skill's version marker with. The host twin is pinned to it by the
// extension's test/skill-marker-parity.test.ts; this file runs the module in a child `node`, as the
// CLI tests do, so `pnpm coverage:pack` (c8 over child processes) counts it.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts");
const MARKER = pathToFileURL(join(SCRIPTS, "skill-marker.mjs")).href;

function parse(texts: string[]): Array<Record<string, unknown>> {
  const src =
    `import { parseSkillMarker } from ${JSON.stringify(MARKER)};` +
    "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(parseSkillMarker)));";
  return JSON.parse(execFileSync("node", ["--input-type=module", "-e", src, JSON.stringify(texts)], { encoding: "utf8" })) as Array<
    Record<string, unknown>
  >;
}

describe("skill-marker.mjs", () => {
  it("classifies every version form from the frontmatter only", () => {
    const H = "b".repeat(64);
    const out = parse([
      "---\nversion: 57\n---\n",
      "---\nversion: 57-local\n---\n",
      `---\nversion: 57+local\nreconciled-from: ${H}\n---\n`,
      "---\nversion: draft\n---\n",
      "---\nname: x\n---\nversion: 57\n",
      "---\r\nversion: 57  \r\n---\r\n",
    ]);
    expect(out.map(({ sha256: _s, ...rest }) => rest)).toEqual([
      { label: "57", n: 57, kind: "integer", reconciledFrom: null },
      { label: "57-local", n: 57, kind: "label", reconciledFrom: null },
      { label: "57+local", n: 57, kind: "plus-local", reconciledFrom: H },
      { label: "draft", n: null, kind: "label", reconciledFrom: null },
      { label: null, n: null, kind: "none", reconciledFrom: null },
      { label: "57", n: 57, kind: "integer", reconciledFrom: null },
    ]);
  });

  it("hashes CRLF and LF spellings of one file alike", () => {
    const [lf, crlf] = parse(["---\nversion: 57\n---\nbody\n", "---\r\nversion: 57\r\n---\r\nbody\r\n"]);
    expect(crlf!.sha256).toBe(lf!.sha256);
    expect(lf!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
