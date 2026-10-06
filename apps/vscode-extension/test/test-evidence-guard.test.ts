// T1.2: the evidence link opens only a regular file inside the workspace folder, and only the evidence the HOST
// reads from the TC on disk (the webview never supplies it). The guard module is VS Code free.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardHost } from "../src/host/board-host.js";
import { evidenceFileToOpen, spelledAsOnDisk, testFileToOpen, testFileArgFromWebview } from "../src/host/test-file-guard.js";
import { trackedBoardCopies } from "./fixtures/real-board.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

vi.mock("vscode", () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
}));

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "host");
const RUN = ".octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md";
const TC4 = "campaigns/direct-dispatch-process/tests/m6/TC-004_sidebar-tests-node-counts.md";

describe("evidenceFileToOpen", () => {
  it("returns the absolute path for the real RUN file on a board copy", () => {
    const repo = join(trackedBoardCopies()[0]!, "..");
    expect(evidenceFileToOpen(repo, RUN)).toBe(join(repo, RUN));
  });

  it("is null for a missing file, a directory, `..`, an absolute path, an empty or non-string value and a NUL byte", () => {
    const repo = mkdtempClean("evidence-guard-");
    mkdirSync(join(repo, "dir"));
    writeFileSync(join(repo, "ok.md"), "run");
    writeFileSync(join(dirname(repo), "outside-evidence.md"), "outside");
    expect(evidenceFileToOpen(repo, "ok.md")).toBe(join(repo, "ok.md"));
    for (const ev of ["missing.md", "dir", "../outside-evidence.md", "dir/../../outside-evidence.md", join(dirname(repo), "outside-evidence.md"), "ok.md\0x", "", "..", "."]) {
      expect(evidenceFileToOpen(repo, ev), JSON.stringify(ev)).toBeNull();
    }
    for (const ev of [undefined, null, 7, {}]) expect(evidenceFileToOpen(repo, ev as never)).toBeNull();
  });

  it("is null for a symlink resolving outside the workspace, and fine for one resolving inside", () => {
    const repo = mkdtempClean("evidence-guard-");
    const outside = join(dirname(repo), "secret-evidence.md");
    writeFileSync(outside, "secret");
    writeFileSync(join(repo, "real.md"), "run");
    symlinkSync(outside, join(repo, "escape.md"));
    symlinkSync(join(repo, "real.md"), join(repo, "inside.md"));
    expect(evidenceFileToOpen(repo, "escape.md")).toBeNull();
    expect(evidenceFileToOpen(repo, "inside.md")).toBe(join(repo, "inside.md"));
  });
});

describe("BoardHost.testEvidencePath reads the evidence from the TC on disk", () => {
  it("answers the RUN file, and follows the file when it changes", () => {
    const octo = trackedBoardCopies()[0]!;
    const repo = join(octo, "..");
    const host = new BoardHost(octo);
    expect(host.testEvidencePath(TC4)).toBe(join(repo, RUN));
    const file = join(octo, TC4);
    writeFileSync(file, readFileSync(file, "utf8").replace(/evidence: [^,}]+/, "evidence: .octobots/campaigns/direct-dispatch-process/tests/m6/README.md"));
    expect(host.testEvidencePath(TC4)).toBe(join(octo, "campaigns/direct-dispatch-process/tests/m6/README.md"));
    writeFileSync(file, readFileSync(file, "utf8").replace(/evidence: [^,}]+/, "evidence: .octobots/nowhere.md"));
    expect(host.testEvidencePath(TC4)).toBeNull();
  });

  it("is null for a TC with no evidence, a TC the guard rejects and a TC that is gone", () => {
    const octo = trackedBoardCopies()[0]!;
    const host = new BoardHost(octo);
    const file = join(octo, TC4);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^last_run:.*\n/m, ""));
    expect(host.testEvidencePath(TC4)).toBeNull();
    expect(host.testEvidencePath("../outside.md")).toBeNull();
    expect(host.testEvidencePath("campaigns/direct-dispatch-process/tests/m6/TC-777_gone.md")).toBeNull();
    expect(host.testEvidencePath("campaigns/direct-dispatch-process/tests/m6/README.md")).toBeNull();
  });

  it("an evidence path escaping the workspace through a symlink is not opened", () => {
    const octo = trackedBoardCopies()[0]!;
    const repo = join(octo, "..");
    const outside = join(dirname(repo), "outside-run.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(repo, "escape-run.md"));
    const file = join(octo, TC4);
    writeFileSync(file, readFileSync(file, "utf8").replace(/evidence: [^,}]+/, "evidence: escape-run.md"));
    expect(new BoardHost(octo).testEvidencePath(TC4)).toBeNull();
  });
});

describe("the guard module", () => {
  it("imports nothing from vscode, and neither does board-host.ts", () => {
    for (const f of ["test-file-guard.ts", "board-host.ts"]) {
      expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(/from\s+["']vscode["']|require\(["']vscode["']\)/);
    }
  });

  it("campaigns-tree.ts still exports testFileToOpen and testFileArgFromWebview, the very same functions", async () => {
    const tree = await import("../src/host/campaigns-tree.js");
    expect(tree.testFileToOpen).toBe(testFileToOpen);
    expect(tree.testFileArgFromWebview).toBe(testFileArgFromWebview);
  });
});

describe("spelledAsOnDisk (the test-case panel key, 0.1.1 T1.3 review)", () => {
  it("accepts the exact on-disk spelling and rejects any other letter case, a missing segment and an unreadable parent", () => {
    const octo = trackedBoardCopies()[0]!;
    expect(spelledAsOnDisk(octo, TC4)).toBe(true);
    for (const v of [TC4.replace("TC-004_sidebar", "TC-004_Sidebar"), TC4.replace("/m6/", "/M6/"), TC4.replace("campaigns/", "Campaigns/"), `${TC4}x`, ""])
      expect(spelledAsOnDisk(octo, v), v).toBe(false);
    expect(spelledAsOnDisk(join(octo, "nope"), TC4)).toBe(false);
  });
});
