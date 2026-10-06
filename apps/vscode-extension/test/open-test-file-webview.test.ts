// M6 T6.4 review: the webview's `openTestFile` message carries a board-relative path. A compromised webview (or a
// crafted path) must not open anything outside the board's tests folders: the host joins it under the board and
// the open command's T6.3 guard (testFileToOpen) still decides. PoC over a scratch board.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BoardHost } from "../src/host/board-host.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

vi.mock("vscode", () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
}));

const { testFileToOpen, testFileArgFromWebview } = await import("../src/host/campaigns-tree.js");
const { uiMessage } = await import("../src/protocol/index.js");

function board() {
  const repo = mkdtempClean("open-tc-webview-");
  const octo = join(repo, ".octobots");
  const host = new BoardHost(octo);
  const c = host.createCampaign({ name: "Camp" });
  host.createMission({ title: "M1 - a", campaignId: c.id });
  const campaignDir = join(octo, host.listCampaigns()[0]!.folderPath);
  const tests = join(campaignDir, "tests", "m1");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "TC-001_x.md"), "---\nid: TC-001\ntitle: x\nmission: M1\ncovers: [M1-AC1]\nkind: unit\nstatus: pass\n---\n\n# TC-001\n");
  host.reconcile();
  writeFileSync(join(repo, "secret.md"), "secret");
  mkdirSync(join(repo, "elsewhere"), { recursive: true });
  writeFileSync(join(repo, "elsewhere", "TC-001_outside.md"), "# TC-001 outside the board\n");
  symlinkSync(join(repo, "secret.md"), join(tests, "TC-099_link.md"));
  return { host, octo, repo, campaignDir, rel: relative(octo, campaignDir) };
}

describe("openTestFile from a webview: crafted paths never leave the board", () => {
  it("opens the TC a real TestCase.path names", () => {
    const { host, octo } = board();
    const tc = host.listTests(host.listCampaigns()[0]!.id)[0]!;
    const arg = testFileArgFromWebview(octo, tc.path);
    expect(testFileToOpen(octo, arg)).toBe(join(octo, tc.path));
  });

  it("rejects climbs, absolute paths, TC-named files outside the board, non-TC files and symlinks out", () => {
    const { octo, rel, repo } = board();
    const crafted = [
      "../secret.md",
      "../elsewhere/TC-001_outside.md",
      `${rel}/tests/m1/../../../../secret.md`,
      `${rel}/tests/m1/../../../../../elsewhere/TC-001_outside.md`,
      `${rel}/tests/../../../../elsewhere/TC-001_outside.md`,
      join(repo, "elsewhere", "TC-001_outside.md"), // absolute: joined under the board, so it names nothing
      "/etc/hosts",
      `${rel}/tests/m1/TC-099_link.md`, // a TC name that is a symlink out of the board
      `${rel}/campaign.yaml`,
      `${rel}/tests/m1/TC-404_missing.md`,
      "",
      ".",
      "campaigns",
    ];
    for (const p of crafted) expect(testFileToOpen(octo, testFileArgFromWebview(octo, p)), p).toBeNull();
  });

  it("the ui-messages schema only accepts a string path, and the panel handler goes through the guarded command", () => {
    expect(uiMessage.safeParse({ type: "openTestFile", path: 7 }).success).toBe(false);
    expect(uiMessage.safeParse({ type: "openTestFile" }).success).toBe(false);
    const src = readFileSync(new URL("../src/host/entity-panel-manager.ts", import.meta.url), "utf8");
    const handler = /openTestFile: \(m\) =>[^\n]*/.exec(src)?.[0] ?? "";
    expect(handler).toContain("executeCommand(OPEN_TEST_FILE_COMMAND, testFileArgFromWebview(this.ctx.board.artifactsRoot, m.path))");
    expect(handler).not.toMatch(/showTextDocument|openFile\(/);
  });
});
