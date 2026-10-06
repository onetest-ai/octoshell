/** readTestCaseDetail (packages/board/src/tc-detail.ts): the read behind the test-case panel's `tests:get`. */
import { describe, it, expect } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_TC_BYTES, readTestCaseDetail } from "../src/index.js";
import { scratchDir } from "./fixtures/real-board.js";

const BODY = "\n# TC-001: Example\n\n## Steps\n\n| # | A | E |\n|---|---|---|\n| 1 | a | b |\n";
const FULL = `---\nid: TC-001\ntitle: Example\nmission: M1\ncovers: [M1-AC1]\nkind: unit\nstatus: ready\n---\n${BODY}`;
const REL = "campaigns/c1/tests/m1/TC-001_example.md";

function board(text: string, rel = REL): string {
  const root = join(scratchDir("tc-detail-"), ".octobots");
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  return root;
}

describe("readTestCaseDetail", () => {
  it("a complete TC: the listed TestCase, the text after the block as markdown, not legacy, writable", () => {
    expect(readTestCaseDetail(board(FULL), REL)).toMatchObject({
      tc: { id: "TC-001", title: "Example", mission: "M1", covers: ["M1-AC1"], kind: "unit", status: "ready", path: REL },
      body: { kind: "markdown", text: BODY },
      legacy: false,
      writable: { ok: true },
    });
  });

  it("legacy when kind or mission is absent or empty; the status stays settable", () => {
    for (const text of [FULL.replace("kind: unit\n", ""), FULL.replace("mission: M1\n", ""), FULL.replace("kind: unit", "kind:")]) {
      expect(readTestCaseDetail(board(text), REL)).toMatchObject({ legacy: true, writable: { ok: true } });
    }
  });

  it("unparseable frontmatter keeps the text after the block as markdown; no block means the whole file as plain text", () => {
    const broken = FULL.replace("title: Example", 'title: "unterminated');
    expect(readTestCaseDetail(board(broken), REL)).toMatchObject({ body: { kind: "markdown", text: BODY }, legacy: false, writable: { ok: false, reason: "unparseable" } });
    const bare = "# TC-001: Bare\n\nno block\n";
    expect(readTestCaseDetail(board(bare), REL)).toMatchObject({ tc: { title: "TC-001: Bare" }, body: { kind: "plain", text: bare }, writable: { ok: false, reason: "no-frontmatter" } });
  });

  it("a file over MAX_TC_BYTES has no body and is not writable", () => {
    const d = readTestCaseDetail(board(`${FULL}${"x".repeat(MAX_TC_BYTES)}`), REL);
    expect(d).toMatchObject({ body: { kind: "too-large" }, legacy: false, writable: { ok: false, reason: "too-large" }, tc: { id: "TC-001", status: "unknown" } });
  });

  it("null for a path that is not a TC, is gone, or is a directory", () => {
    const root = board(FULL);
    mkdirSync(join(root, "campaigns/c1/tests/m1/TC-002_dir.md"));
    for (const rel of ["../x/TC-001_a.md", "campaigns/c1/tests/m1/../m1/TC-001_example.md", "campaigns/c1/campaign.yaml", "campaigns/c1/tests/m1/README.md", "campaigns/c1/tests/m1/TC-009_gone.md", "campaigns/c1/tests/m1/TC-002_dir.md", "/etc/passwd", ""]) {
      expect(readTestCaseDetail(root, rel), rel).toBeNull();
    }
  });

  it("a symlink to a TC inside the board reads but is never writable; one leaving the board or hitting a non-TC reads null", () => {
    const root = board(FULL);
    const dir = join(root, "campaigns/c1/tests/m1");
    const outside = join(dirname(root), "TC-001_outside.md");
    writeFileSync(outside, FULL);
    writeFileSync(join(root, "campaigns/c1/campaign.yaml"), "name: c\n");
    symlinkSync(join(dir, "TC-001_example.md"), join(dir, "TC-003_inside.md"));
    symlinkSync(outside, join(dir, "TC-004_outside.md"));
    symlinkSync(join(root, "campaigns/c1/campaign.yaml"), join(dir, "TC-005_nontc.md"));
    expect(readTestCaseDetail(root, "campaigns/c1/tests/m1/TC-003_inside.md")).toMatchObject({ body: { kind: "markdown" }, writable: { ok: false, reason: "symlink" } });
    expect(readTestCaseDetail(root, "campaigns/c1/tests/m1/TC-004_outside.md")).toBeNull();
    expect(readTestCaseDetail(root, "campaigns/c1/tests/m1/TC-005_nontc.md")).toBeNull();
  });

  it("a TC under a symlinked m<n> folder resolving inside the board reads but is not writable", () => {
    const root = board(FULL);
    symlinkSync(join(root, "campaigns/c1/tests/m1"), join(root, "campaigns/c1/tests/m2"));
    expect(readTestCaseDetail(root, "campaigns/c1/tests/m2/TC-001_example.md")).toMatchObject({ writable: { ok: false, reason: "symlink" } });
  });
});
