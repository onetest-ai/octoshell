// M6 T6.3: the `Tests` node of the sidebar tree and the BoardHost test API behind it (mission AC3).
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BoardHost } from "../src/host/board-host.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { trackedBoardCopies } from "./fixtures/real-board.js";
import { aggregateStatus, emptyCounts, TEST_STATUS_ORDER, type TestStatusCounts } from "../src/protocol/index.js";
import type { TestCaseStatus } from "@octoshell/board";

vi.mock("vscode", () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
}));

const { CampaignsTree, testFileToOpen, OPEN_TEST_FILE_COMMAND } = await import("../src/host/campaigns-tree.js");
type Tree = InstanceType<typeof CampaignsTree>;
type Node = ReturnType<Tree["getChildren"]>[number];
interface Item { label: string; id?: string; description?: string; tooltip?: string; collapsibleState?: number; iconPath?: { id: string; color?: { id: string } }; command?: { command: string; arguments?: unknown[] } }
const item = (tree: Tree, n: Node): Item => tree.getTreeItem(n) as unknown as Item;
const kids = (tree: Tree, n?: Node): Node[] => tree.getChildren(n);

const tc = (id: string, o: { title?: string; status?: string; covers?: string; mission?: string } = {}): string =>
  [
    "---",
    `id: ${id}`,
    `title: ${o.title ?? `case ${id}`}`,
    ...(o.mission ? [`mission: ${o.mission}`] : []),
    ...(o.covers ? [`covers: [${o.covers}]`] : []),
    "kind: unit",
    ...(o.status ? [`status: ${o.status}`] : []),
    "---",
    "",
    `# ${id}: case`,
    "",
  ].join("\n");

/** A scratch board: one campaign with the named missions (`M2 - x`), each with n ACs. */
function seed(missions: Array<{ title: string; acs?: number; status?: string }>): { board: BoardHost; octo: string; campaignId: string; campaignDir: string; ids: string[] } {
  const repo = mkdtempClean("tests-node-");
  const octo = join(repo, ".octobots");
  const board = new BoardHost(octo);
  const c = board.createCampaign({ name: "Camp" });
  const ids = missions.map((m) => {
    const created = board.createMission({ title: m.title, campaignId: c.id });
    if (m.acs) board.updateBrief("mission", created.id, { acceptanceCriteria: Array.from({ length: m.acs }, (_, i) => `- [ ] criterion ${i + 1}`).join("\n") });
    if (m.status) board.setStatus("mission", created.id, m.status, { force: "test" });
    return created.id;
  });
  return { board, octo, campaignId: c.id, campaignDir: join(octo, c.folderPath), ids };
}
const put = (campaignDir: string, folder: string, name: string, text: string): void => {
  mkdirSync(join(campaignDir, "tests", folder), { recursive: true });
  writeFileSync(join(campaignDir, "tests", folder, name), text);
};
const many = (campaignDir: string, folder: string, mission: string, counts: Record<string, number>): void => {
  let n = 0;
  for (const [status, count] of Object.entries(counts))
    for (let i = 0; i < count; i++) {
      n++;
      const id = `TC-${String(n).padStart(3, "0")}`;
      put(campaignDir, folder, `${id}_x.md`, tc(id, { mission, status: status === "none" ? undefined : status }));
    }
};

describe("Tests node: structure and labels", () => {
  it("a campaign with no TCs has no Tests node", () => {
    const { board, campaignId } = seed([{ title: "M1 - a" }]);
    const tree = new CampaignsTree(board);
    const campaign = kids(tree).find((n) => n.type === "campaign")!;
    expect(kids(tree, campaign).map((n) => n.type as string)).not.toContain("tests");
    expect(board.testSummary(campaignId)?.total).toBe(0);
  });

  it("groups by mission and labels each group exactly like the AC: `m2 · 32 · 30✓ 1✗ 1 blocked`", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }, { title: "M2 - b" }]);
    many(campaignDir, "m2", "M2", { pass: 30, fail: 1, blocked: 1 });
    many(campaignDir, "m1", "M1", { pass: 2 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    const campaign = kids(tree).find((n) => n.type === "campaign")!;
    const testsNode = kids(tree, campaign).find((n) => (n.type as string) === "tests")!;
    expect(item(tree, testsNode).label).toBe("Tests");
    expect(item(tree, testsNode).description).toBe("34 · 32✓ 1✗ 1 blocked");
    expect(kids(tree, testsNode).map((g) => item(tree, g).label)).toEqual(["m1 · 2 · 2✓", "m2 · 32 · 30✓ 1✗ 1 blocked"]);
  });

  it("shows statuses in the fixed order pass, fail, blocked, ready, draft, unknown and omits zero counts", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }]);
    many(campaignDir, "m1", "M1", { unknown: 0, draft: 2, ready: 3, blocked: 4, fail: 5, pass: 6, none: 1 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    const testsNode = kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!;
    expect(kids(tree, testsNode).map((g) => item(tree, g).label)).toEqual(["m1 · 21 · 6✓ 5✗ 4 blocked 3 ready 2 draft 1 unknown"]);
  });

  it("leaves carry a ThemeIcon coloured by a theme token, never a hardcoded colour", () => {
    const { board, campaignDir, octo } = seed([{ title: "M1 - a" }]);
    const statuses = ["pass", "fail", "blocked", "ready", "draft"] as const;
    statuses.forEach((s, i) => put(campaignDir, "m1", `TC-00${i + 1}_x.md`, tc(`TC-00${i + 1}`, { mission: "M1", status: s })));
    put(campaignDir, "m1", "TC-006_x.md", tc("TC-006"));
    board.reconcile();
    const tree = new CampaignsTree(board);
    const testsNode = kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!;
    const leaves = kids(tree, kids(tree, testsNode)[0]);
    const icons = Object.fromEntries(leaves.map((l) => [item(tree, l).description, item(tree, l).iconPath]));
    expect(icons.pass).toMatchObject({ id: "pass", color: { id: "testing.iconPassed" } });
    expect(icons.fail).toMatchObject({ id: "error", color: { id: "testing.iconFailed" } });
    expect(icons.blocked).toMatchObject({ id: "circle-slash", color: { id: "list.warningForeground" } });
    expect(icons.ready).toMatchObject({ id: "circle-large-outline", color: { id: "testing.iconQueued" } });
    expect(icons.draft).toMatchObject({ id: "edit", color: { id: "testing.iconUnset" } });
    expect(icons.unknown).toMatchObject({ id: "question", color: { id: "testing.iconUnset" } });
    for (const l of leaves) {
      expect(item(tree, l).collapsibleState).toBe(0);
      expect(item(tree, l).label).toMatch(/^TC-00\d: /);
      // click opens the TC file through the editor's openFile path
      const cmd = item(tree, l).command!;
      expect(cmd.command).toBe("octoshell.openTestFile");
      const abs = cmd.arguments![0] as string;
      expect(abs.startsWith(octo)).toBe(true);
      expect(existsSync(abs)).toBe(true);
    }
  });

  it("rolls legacy `unknown` TCs up to a count and a tooltip: no per-file warning nodes, no warning icon", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }]);
    for (let i = 1; i <= 7; i++) put(campaignDir, "m1", `TC-0${i}${i}_legacy.md`, `# TC-0${i}${i}: legacy\n\nrequirements: M1-AC1\n`);
    board.reconcile();
    const tree = new CampaignsTree(board);
    const testsNode = kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!;
    const [group] = kids(tree, testsNode);
    expect(item(tree, group!).label).toBe("m1 · 7 · 7 unknown");
    expect(item(tree, group!).tooltip).toMatch(/7 unknown/);
    expect(item(tree, group!).tooltip).toMatch(/set-test-status\.js .*--migrate/);
    expect(kids(tree, group).length).toBe(7); // the TCs themselves, nothing extra
    const icons = [item(tree, group!), ...kids(tree, group).map((l) => item(tree, l))].map((i) => i.iconPath?.id);
    expect(icons.join()).not.toMatch(/warning|alert|bell/);
    expect(item(tree, testsNode).description).toBe("7 · 7 unknown");
  });

  it("gives every Tests node a stable id, so a refresh keeps it expanded", () => {
    const { board, campaignDir, campaignId } = seed([{ title: "M1 - a" }]);
    many(campaignDir, "m1", "M1", { pass: 1 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    const testsNode = kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!;
    const group = kids(tree, testsNode)[0]!;
    expect(item(tree, testsNode).id).toBe(`tests:${campaignId}`);
    expect(item(tree, group).id).toBe(`tests:${campaignId}:m1`);
    const before = item(tree, group).id;
    many(campaignDir, "m1", "M1", { fail: 2 }); // overwrite statuses: the label changes, the id must not
    board.reconcile();
    const group2 = kids(tree, kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!)[0]!;
    expect(item(tree, group2).label).not.toBe("m1 · 1 · 1✓");
    expect(item(tree, group2).id).toBe(before);
  });
});

describe("Tests node: missions without test cases (review fix)", () => {
  it("a mission with no TCs gets no empty group, though its ACs still count as uncovered", () => {
    const { board, campaignDir, campaignId } = seed([{ title: "M1 - a", acs: 1 }, { title: "M2 - b", acs: 2 }, { title: "M3 - c" }]);
    many(campaignDir, "m1", "M1", { pass: 1 });
    mkdirSync(join(campaignDir, "tests", "m3", "runs"), { recursive: true }); // a folder holding no TC is not a group either
    board.reconcile();
    const tree = new CampaignsTree(board);
    const testsNode = kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!;
    expect(kids(tree, testsNode).map((g) => item(tree, g).label)).toEqual(["m1 · 1 · 1✓"]);
    expect(board.testSummary(campaignId)!.missions.map((m) => [m.folder, m.total])).toEqual([["m1", 1], ["m2", 0], ["m3", 0]]);
  });
});

describe("octoshell.openTestFile only opens a TC file inside the board (review fix)", () => {
  function board1() {
    const s = seed([{ title: "M1 - a" }]);
    put(s.campaignDir, "m1", "TC-001_x.md", tc("TC-001", { mission: "M1", status: "pass" }));
    put(s.campaignDir, "m1", "README.md", "# map\n");
    s.board.reconcile();
    return s;
  }

  it("accepts the path every TC leaf passes", () => {
    const { board } = board1();
    const tree = new CampaignsTree(board);
    const testsNode = kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!;
    const leaf = item(tree, kids(tree, kids(tree, testsNode)[0])[0]!);
    expect(leaf.command!.command).toBe(OPEN_TEST_FILE_COMMAND);
    const arg = leaf.command!.arguments![0];
    expect(testFileToOpen(board.artifactsRoot, arg)).toBe(arg);
  });

  it("rejects a missing or non-string argument, a path that climbs out, a non-TC file and a symlink leaving the board", () => {
    const { board, octo, campaignDir } = board1();
    const outside = join(octo, "..", "secret.md");
    writeFileSync(outside, "secret");
    const climb = join(campaignDir, "tests", "m1", "..", "..", "..", "..", "..", "secret.md");
    expect(existsSync(climb)).toBe(true);
    symlinkSync(outside, join(campaignDir, "tests", "m1", "TC-099_link.md"));
    const notTests = join(campaignDir, "missions", "x", "TC-007_not-a-test.md"); // a TC name outside tests/
    mkdirSync(join(campaignDir, "missions", "x"), { recursive: true });
    writeFileSync(notTests, "# TC-007\n");
    for (const arg of [undefined, null, 7, "", {}, outside, climb, "/etc/hosts",
      join(campaignDir, "tests", "m1", "README.md"),
      join(campaignDir, "campaign.yaml"),
      join(campaignDir, "tests", "m1", "TC-404_missing.md"),
      join(campaignDir, "tests", "m1", "TC-099_link.md"), notTests])
      expect(testFileToOpen(board.artifactsRoot, arg), String(arg)).toBeNull();
  });

  it("extension.ts routes the command through the guard, never straight to openFile", () => {
    const src = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
    const reg = /registerCommand\(OPEN_TEST_FILE_COMMAND,[\s\S]*?\n    \}\),/.exec(src)?.[0] ?? "";
    expect(reg).toContain("testFileToOpen(board.artifactsRoot, arg)");
    expect(reg).toMatch(/if \(abs\) await dispatchCtx\.editor\.openFile\(abs\)/);
  });
});

describe("BoardHost test API: lists, coverage and the campaign summary", () => {
  it("testSummary: totals by status incl. unknown, the uncovered-AC count and one row per mission", () => {
    const { board, campaignDir, campaignId, ids } = seed([{ title: "M1 - a", acs: 3 }, { title: "M2 - b", acs: 2 }]);
    put(campaignDir, "m1", "TC-001_x.md", tc("TC-001", { mission: "M1", covers: "M1-AC1", status: "pass" }));
    put(campaignDir, "m1", "TC-002_x.md", tc("TC-002", { mission: "M1", covers: "M1-AC2", status: "fail" }));
    put(campaignDir, "m1", "TC-003_x.md", tc("TC-003", { mission: "M1" }));
    board.reconcile();
    const s = board.testSummary(campaignId)!;
    expect(s.total).toBe(3);
    expect(s.counts).toEqual({ pass: 1, fail: 1, blocked: 0, ready: 0, draft: 0, unknown: 1 });
    // M1: AC3 uncovered; M2 has no tests folder at all: both ACs uncovered
    expect(s.uncovered).toBe(3);
    expect(s.missions.map((m) => [m.mission, m.missionId, m.total, m.uncovered])).toEqual([
      ["M1", ids[0], 3, ["M1-AC3"]],
      ["M2", ids[1], 0, ["M2-AC1", "M2-AC2"]],
    ]);
  });

  it("uncovered rule: a cancelled mission is excluded entirely; a live one with no tests folder counts all its ACs", () => {
    const { board, campaignDir, campaignId } = seed([
      { title: "M1 - live, no tests", acs: 4 },
      { title: "M2 - cancelled, no tests", acs: 5, status: "cancelled" },
      { title: "M3 - cancelled, with tests", acs: 2, status: "cancelled" },
    ]);
    put(campaignDir, "m3", "TC-001_x.md", tc("TC-001", { mission: "M3", status: "pass" }));
    board.reconcile();
    const s = board.testSummary(campaignId)!;
    expect(s.uncovered).toBe(4);
    expect(s.missions.find((m) => m.mission === "M2")?.uncovered).toEqual([]);
    expect(s.missions.find((m) => m.mission === "M3")?.uncovered).toEqual([]);
    expect(s.total).toBe(1); // a cancelled mission's TCs still exist, so they still total
  });

  it("a tests/ folder with no mission is totalled, listed with a null missionId and never uncovered", () => {
    const { board, campaignDir, campaignId } = seed([{ title: "M1 - a", acs: 1 }]);
    put(campaignDir, "m9", "TC-001_x.md", tc("TC-001", { mission: "M9", status: "ready" }));
    board.reconcile();
    const s = board.testSummary(campaignId)!;
    const orphan = s.missions.find((m) => m.mission === "M9")!;
    expect(orphan).toMatchObject({ missionId: null, total: 1, uncovered: [] });
    expect(s.uncovered).toBe(1); // only M1-AC1
  });

  it("testSummary is null for an unknown campaign; listTests and testCoverage are empty", () => {
    const { board } = seed([{ title: "M1 - a" }]);
    expect(board.testSummary("nope")).toBeNull();
    expect(board.listTests("nope")).toEqual([]);
    expect(board.testCoverage("nope")).toMatchObject({ mission: null, acs: [], uncovered: [] });
  });

  it("listTests narrows to a mission", () => {
    const { board, campaignDir, campaignId } = seed([{ title: "M1 - a" }, { title: "M2 - b" }]);
    many(campaignDir, "m1", "M1", { pass: 2 });
    many(campaignDir, "m2", "M2", { fail: 1 });
    board.reconcile();
    expect(board.listTests(campaignId)).toHaveLength(3);
    expect(board.listTests(campaignId, "m2").map((t) => t.status)).toEqual(["fail"]);
    expect(board.listTests(campaignId, "M2")).toHaveLength(1);
  });
});

// ── real boards: this campaign's own tests (tracked files via `git archive`) and, when set, solo's ──
const STATUSES = ["draft", "ready", "pass", "fail", "blocked"];
/** Independent expectation: per campaign dir and folder, status counts read with a plain regex, never the board library. */
function expected(octo: string): Map<string, Map<string, Record<string, number>>> {
  const out = new Map<string, Map<string, Record<string, number>>>();
  const cdir = join(octo, "campaigns");
  if (!existsSync(cdir)) return out;
  for (const slug of readdirSync(cdir)) {
    const tdir = join(cdir, slug, "tests");
    if (!existsSync(tdir)) continue;
    for (const folder of readdirSync(tdir).filter((d) => /^m\d+[a-z]*$/.test(d))) {
      const counts: Record<string, number> = {};
      for (const f of readdirSync(join(tdir, folder)).filter((n) => /^TC-.*\.md$/.test(n))) {
        const text = readFileSync(join(tdir, folder, f), "utf8");
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
        const raw = /^status:\s*["']?(\w+)/m.exec(fm)?.[1] ?? "";
        const s = STATUSES.includes(raw) ? raw : "unknown";
        counts[s] = (counts[s] ?? 0) + 1;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      if (!out.has(slug)) out.set(slug, new Map());
      out.get(slug)!.set(folder, counts);
    }
  }
  return out;
}
const labelOf = (folder: string, c: Record<string, number>): string => {
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const parts = [
    c.pass ? `${c.pass}✓` : "", c.fail ? `${c.fail}✗` : "", c.blocked ? `${c.blocked} blocked` : "",
    c.ready ? `${c.ready} ready` : "", c.draft ? `${c.draft} draft` : "", c.unknown ? `${c.unknown} unknown` : "",
  ].filter(Boolean);
  return `${folder} · ${total} · ${parts.join(" ")}`;
};
const folderNum = (f: string): number => Number(/\d+/.exec(f)![0]);

describe("Tests node over real boards", () => {
  it("every campaign with TCs gets a Tests node whose group labels match the files on disk", () => {
    let boardsWithTests = 0;
    for (const octo of trackedBoardCopies()) {
      const want = expected(octo);
      const board = new BoardHost(octo);
      const tree = new CampaignsTree(board);
      const withTests: string[] = [];
      for (const campaign of kids(tree).filter((n) => n.type === "campaign")) {
        const folderSlug = (campaign as unknown as { campaign: { folderPath: string } }).campaign.folderPath.split("/").pop()!;
        const testsNode = kids(tree, campaign).find((n) => (n.type as string) === "tests");
        const folders = want.get(folderSlug);
        if (!folders) { expect(testsNode, folderSlug).toBeUndefined(); continue; }
        expect(testsNode, folderSlug).toBeDefined();
        withTests.push(folderSlug);
        const sorted = [...folders.entries()].sort((a, b) => folderNum(a[0]) - folderNum(b[0]));
        expect(kids(tree, testsNode).map((g) => item(tree, g).label), folderSlug).toEqual(sorted.map(([f, c]) => labelOf(f, c)));
        for (const g of kids(tree, testsNode)) {
          const leaves = kids(tree, g);
          const label = item(tree, g).label;
          expect(leaves.length).toBe(Number(/ · (\d+) · /.exec(label)![1]));
          for (const l of leaves) expect(existsSync((item(tree, l).command!.arguments![0] as string))).toBe(true);
        }
      }
      if (withTests.length > 0) boardsWithTests++;
    }
    expect(boardsWithTests).toBeGreaterThan(0); // this campaign's own tests/m1..m6 are tracked
  });

  it("this campaign's tests are on the tree, one labelled group per mission folder", () => {
    const octo = trackedBoardCopies()[0]!;
    const board = new BoardHost(octo);
    const tree = new CampaignsTree(board);
    const campaign = kids(tree).find((n) => n.type === "campaign" && item(tree, n).label.toLowerCase().includes("direct"))!;
    const testsNode = kids(tree, campaign).find((n) => (n.type as string) === "tests")!;
    const labels = kids(tree, testsNode).map((g) => item(tree, g).label);
    expect(labels.length).toBeGreaterThanOrEqual(6);
    expect(labels[0]).toMatch(/^m1 · \d+ · /);
    for (const l of labels) expect(l).toMatch(/^m\d+[a-z]* · \d+ · (\d+(✓|✗| blocked| ready| draft| unknown)\s?)+$/);
  });

  it("expanding the whole tree stays fast on a solo-sized board (23 campaigns, 116 TCs)", () => {
    const repo = mkdtempClean("tests-perf-");
    const board = new BoardHost(join(repo, ".octobots"));
    const dirs: string[] = [];
    for (let i = 0; i < 23; i++) {
      const c = board.createCampaign({ name: `Campaign ${i}` });
      for (let m = 1; m <= 3; m++) board.createMission({ title: `M${m} - mission ${m}`, campaignId: c.id });
      dirs.push(join(repo, ".octobots", c.folderPath));
    }
    many(dirs[0]!, "m1", "M1", { pass: 30, fail: 2, none: 20 });
    many(dirs[0]!, "m2", "M2", { pass: 30 });
    many(dirs[0]!, "m3", "M3", { blocked: 34 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    const t0 = performance.now();
    const walk = (n?: Node): number => kids(tree, n).reduce((acc, k) => { item(tree, k); return acc + 1 + walk(k); }, 0);
    const count = walk();
    const ms = performance.now() - t0;
    expect(count).toBeGreaterThan(116);
    expect(ms).toBeLessThan(1500);
  });
});

// M6 B1: the Tests node and each mission group carry the worst status inside them as a theme-coloured beaker.
describe("Tests node and group status icons (M6 B1)", () => {
  const counts = (o: Partial<Record<TestCaseStatus, number>>): TestStatusCounts => ({ ...emptyCounts(), ...o });
  const COLOUR = { fail: "testing.iconFailed", blocked: "list.warningForeground", pass: "testing.iconPassed" } as const;
  const expectColour = (icon: Item["iconPath"], agg: "fail" | "blocked" | "pass" | "neutral"): void => {
    expect(icon?.id).toBe("beaker");
    if (agg === "neutral") expect(icon?.color).toBeUndefined();
    else expect(icon?.color?.id).toBe(COLOUR[agg]);
  };
  const aggOf = (c: TestStatusCounts): "fail" | "blocked" | "pass" | "neutral" => (c.fail > 0 ? "fail" : c.blocked > 0 ? "blocked" : c.pass > 0 && c.pass === TEST_STATUS_ORDER.reduce((n, s) => n + c[s], 0) ? "pass" : "neutral");
  const nodes = (tree: Tree) => {
    const testsNode = kids(tree, kids(tree).find((n) => n.type === "campaign")!).find((n) => (n.type as string) === "tests")!;
    return { testsNode, groups: kids(tree, testsNode) };
  };

  it.each([
    ["fail wins over blocked and pass", { pass: 3, blocked: 2, fail: 1 }, "fail"],
    ["blocked wins over pass", { pass: 3, blocked: 1 }, "blocked"],
    ["all pass is green", { pass: 4 }, "pass"],
    ["pass with a draft is neutral", { pass: 2, draft: 1 }, "neutral"],
    ["draft/ready/unknown only is neutral", { draft: 1, ready: 2, unknown: 3 }, "neutral"],
    ["an empty set is neutral", {}, "neutral"],
  ] as const)("aggregateStatus: %s", (_n, c, want) => {
    expect(aggregateStatus(counts(c))).toBe(want);
  });

  it("groups and the Tests node get the aggregate colour; the Tests node uses the campaign-wide counts", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }, { title: "M2 - b" }, { title: "M3 - c" }, { title: "M4 - d" }]);
    many(campaignDir, "m1", "M1", { pass: 2 });
    many(campaignDir, "m2", "M2", { pass: 2, blocked: 1 });
    many(campaignDir, "m3", "M3", { draft: 2, ready: 1 });
    many(campaignDir, "m4", "M4", { pass: 1, blocked: 1, fail: 1 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    const { testsNode, groups } = nodes(tree);
    expect(groups.map((g) => item(tree, g).iconPath?.color?.id)).toEqual([COLOUR.pass, COLOUR.blocked, undefined, COLOUR.fail]);
    groups.forEach((g) => expect(item(tree, g).iconPath?.id).toBe("beaker"));
    expectColour(item(tree, testsNode).iconPath, "fail");
  });

  it("the Tests node is green only when every group is all-pass, blocked when blocked beats pass", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }, { title: "M2 - b" }]);
    many(campaignDir, "m1", "M1", { pass: 2 });
    many(campaignDir, "m2", "M2", { pass: 1 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    expectColour(item(tree, nodes(tree).testsNode).iconPath, "pass");
    put(campaignDir, "m2", "TC-900_x.md", tc("TC-900", { mission: "M2", status: "blocked" }));
    board.reconcile();
    expectColour(item(tree, nodes(tree).testsNode).iconPath, "blocked");
  });

  it("a blocked leaf and a blocked group use the same colour", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }]);
    many(campaignDir, "m1", "M1", { blocked: 1 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    const [group] = nodes(tree).groups;
    expect(item(tree, kids(tree, group)[0]!).iconPath?.color?.id).toBe(item(tree, group!).iconPath?.color?.id);
  });

  it("the icon follows the counts when a status changes (recomputed on refresh)", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }]);
    many(campaignDir, "m1", "M1", { pass: 2 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    expectColour(item(tree, nodes(tree).groups[0]!).iconPath, "pass");
    writeFileSync(join(campaignDir, "tests", "m1", "TC-001_x.md"), tc("TC-001", { mission: "M1", status: "fail" }));
    board.reconcile();
    tree.refresh();
    expectColour(item(tree, nodes(tree).groups[0]!).iconPath, "fail");
    expectColour(item(tree, nodes(tree).testsNode).iconPath, "fail");
  });

  it("theme guard: every beaker colour is a ThemeColor id, never a hex value", () => {
    const { board, campaignDir } = seed([{ title: "M1 - a" }, { title: "M2 - b" }, { title: "M3 - c" }]);
    many(campaignDir, "m1", "M1", { fail: 1 });
    many(campaignDir, "m2", "M2", { blocked: 1 });
    many(campaignDir, "m3", "M3", { pass: 1 });
    board.reconcile();
    const tree = new CampaignsTree(board);
    const { testsNode, groups } = nodes(tree);
    for (const n of [testsNode, ...groups, ...groups.flatMap((g) => kids(tree, g))]) {
      const c = item(tree, n).iconPath?.color;
      expect(typeof c?.id).toBe("string");
      expect(c!.id).toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)+$/);
      expect(c!.id).not.toMatch(/^#|rgb/i);
    }
  });

  it("real board: each group's colour matches its counts, and the Tests node matches the campaign totals", () => {
    let checked = 0;
    for (const octo of trackedBoardCopies()) {
      const board = new BoardHost(octo);
      const tree = new CampaignsTree(board);
      for (const campaign of kids(tree).filter((n) => n.type === "campaign")) {
        const testsNode = kids(tree, campaign).find((n) => (n.type as string) === "tests");
        if (!testsNode) continue;
        const summary = board.testSummary((campaign as unknown as { campaign: { id: string } }).campaign.id)!;
        expectColour(item(tree, testsNode).iconPath, aggOf(summary.counts));
        for (const g of kids(tree, testsNode)) {
          const row = summary.missions.find((m) => `tests:${summary.campaignId}:${m.folder}` === item(tree, g).id)!;
          expectColour(item(tree, g).iconPath, aggOf(row.counts));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
