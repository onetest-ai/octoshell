import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardHost } from "../src/host/board-host.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import {
  BOARD_DEBOUNCE_MS,
  createQuiescentDebouncer,
  isTestsRunOrEvidencePath,
  registerBoardWatcher,
} from "../src/host/board-watcher.js";

// `vscode` is provided by the extension host at runtime. The watcher only needs a FileSystemWatcher whose
// three events the test can fire, so stub exactly that and record the glob the watcher subscribes to.
const fake = vi.hoisted(() => {
  type Handler = (uri: { fsPath: string }) => void;
  const handlers: { change: Handler[]; create: Handler[]; delete: Handler[] } = { change: [], create: [], delete: [] };
  const patterns: string[] = [];
  // Webview panels EntityPanelManager opens: what each was posted, and its message handler (the webview's side).
  type FakePanel = { posted: Array<{ type: string; payload?: unknown; id?: number; ok?: boolean; value?: unknown }>; send: (m: unknown) => Promise<unknown>; panel: unknown };
  const panels: FakePanel[] = [];
  const newPanel = (): unknown => {
    let recv: ((m: unknown) => Promise<unknown>) | null = null;
    let onDispose: (() => void) | null = null;
    const p: FakePanel = { posted: [], send: (m) => recv!(m), panel: null };
    p.panel = {
      webview: {
        html: "", options: {}, cspSource: "",
        postMessage: (m: FakePanel["posted"][number]) => { p.posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (h: (m: unknown) => Promise<unknown>) => { recv = h; return { dispose: () => undefined }; },
        asWebviewUri: (u: unknown) => u,
      },
      onDidDispose: (cb: () => void) => { onDispose = cb; return { dispose: () => undefined }; },
      reveal: () => undefined,
      dispose: () => onDispose?.(),
    };
    panels.push(p);
    return p.panel;
  };
  return { handlers, patterns, panels, newPanel };
});
vi.mock("vscode", () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
  ViewColumn: { Active: -1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { createWebviewPanel: () => fake.newPanel() },
  RelativePattern: class {
    constructor(public base: unknown, public pattern: string) {}
  },
  workspace: {
    createFileSystemWatcher(p: { pattern: string }) {
      fake.patterns.push(p.pattern);
      return {
        onDidChange: (h: (uri: { fsPath: string }) => void) => fake.handlers.change.push(h),
        onDidCreate: (h: (uri: { fsPath: string }) => void) => fake.handlers.create.push(h),
        onDidDelete: (h: (uri: { fsPath: string }) => void) => fake.handlers.delete.push(h),
        dispose: () => undefined,
      };
    },
  },
}));
vi.mock("../src/host/git-quiescence.js", () => ({ isGitQuiescent: () => true }));
vi.mock("../src/host/webview-html.js", () => ({ buildWebviewHtml: () => "<html></html>" }));

describe("createQuiescentDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of triggers into ONE settle after the debounce window", () => {
    const onSettle = vi.fn();
    const gate = createQuiescentDebouncer({ debounceMs: 350, retryMs: 400, isQuiescent: () => true, onSettle });
    gate.trigger();
    gate.trigger();
    gate.trigger();
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1); // the whole burst → a single rebuild
  });

  it("defers the settle while git is non-quiescent, then runs exactly once after it settles", () => {
    let quiescent = false;
    const onSettle = vi.fn();
    const gate = createQuiescentDebouncer({ debounceMs: 350, retryMs: 400, isQuiescent: () => quiescent, onSettle });
    gate.trigger();
    vi.advanceTimersByTime(350);
    expect(onSettle).not.toHaveBeenCalled(); // git mid-operation → deferred, no rebuild
    vi.advanceTimersByTime(400);
    expect(onSettle).not.toHaveBeenCalled(); // still mid-operation → still deferred
    quiescent = true;
    vi.advanceTimersByTime(400);
    expect(onSettle).toHaveBeenCalledTimes(1); // git settled → exactly one rebuild
  });

  it("dispose cancels a pending settle", () => {
    const onSettle = vi.fn();
    const gate = createQuiescentDebouncer({ debounceMs: 350, retryMs: 400, isQuiescent: () => true, onSettle });
    gate.trigger();
    gate.dispose();
    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();
  });
});

const CAMPAIGN = "/ws/.octobots/campaigns/direct-dispatch-process";
const fire = (kind: "change" | "create" | "delete", fsPath: string): void => {
  for (const h of fake.handlers[kind]) h({ fsPath });
};

describe("isTestsRunOrEvidencePath", () => {
  it("is true for anything under tests/**/runs/ or tests/**/evidence/", () => {
    for (const p of [
      `${CAMPAIGN}/tests/m4/runs/RUN-2026-10-06-001.md`,
      `${CAMPAIGN}/tests/m4/evidence/screenshot.png`,
      `${CAMPAIGN}/tests/m3b/evidence/deep/er/shot.png`,
      `${CAMPAIGN}/tests/runs/RUN-1.md`,
      `${CAMPAIGN}/tests/m4/sub/evidence/x.md`,
      "C:\\ws\\.octobots\\campaigns\\c\\tests\\m4\\runs\\RUN-1.md",
    ]) expect(isTestsRunOrEvidencePath(p), p).toBe(true);
  });

  it("is false for a TC file, a README, an entity file and a runs/ or evidence/ folder outside tests/", () => {
    for (const p of [
      `${CAMPAIGN}/tests/m4/TC-001_add-tests.md`,
      `${CAMPAIGN}/tests/m4/README.md`,
      `${CAMPAIGN}/tests/m4/runs.md`,
      `${CAMPAIGN}/tests/m4/evidence-notes.md`,
      `${CAMPAIGN}/campaign.yaml`,
      `${CAMPAIGN}/missions/m4-x/tasks/t4-2-y/task.yaml`,
      `${CAMPAIGN}/missions/m4-x/runs/RUN-1.md`,
      `${CAMPAIGN}/missions/m4-x/evidence/a.md`,
      `${CAMPAIGN}/tests`,
    ]) expect(isTestsRunOrEvidencePath(p), p).toBe(false);
  });

  it("judges only the part below .octobots/campaigns/, never the workspace's own ancestors (M4 gate)", () => {
    // A workspace that itself lives under a `campaigns/<x>/tests/<y>/runs/` folder must still rebuild on
    // every entity write; an unanchored match would silence the whole board.
    const ws = "/home/u/campaigns/acme/tests/e2e/runs/repo/.octobots/campaigns/c";
    expect(isTestsRunOrEvidencePath(`${ws}/missions/m1-x/mission.yaml`)).toBe(false);
    expect(isTestsRunOrEvidencePath(`${ws}/tests/m1/TC-001_a.md`)).toBe(false);
    expect(isTestsRunOrEvidencePath(`${ws}/tests/m1/runs/RUN-1.md`)).toBe(true);
    const win = "C:\\campaigns\\a\\tests\\b\\evidence\\repo\\.octobots\\campaigns\\c";
    expect(isTestsRunOrEvidencePath(`${win}\\campaign.yaml`)).toBe(false);
    expect(isTestsRunOrEvidencePath(`${win}\\tests\\m1\\evidence\\a.png`)).toBe(true);
    expect(isTestsRunOrEvidencePath("/tmp/campaigns/c/tests/m1/runs/RUN-1.md")).toBe(false); // not a board path
  });
});

describe("registerBoardWatcher: tests/ writes", () => {
  const reconcile = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    reconcile.mockReset();
    fake.handlers.change.length = fake.handlers.create.length = fake.handlers.delete.length = 0;
    fake.patterns.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  const start = () =>
    registerBoardWatcher({ folder: {} as never, board: { reconcile } as never, repoRoot: "/ws" });
  const settle = (): void => { vi.advanceTimersByTime(BOARD_DEBOUNCE_MS * 4); };

  it("watches the whole campaigns tree, so TC and README writes reach the handler", () => {
    start();
    expect(fake.patterns).toEqual([".octobots/campaigns/**/*.{md,yaml}"]);
  });

  // Mission AC6: writes under tests/**/runs/** and tests/**/evidence/** trigger no rebuild.
  it("triggers no rebuild for a write under tests/**/runs/** or tests/**/evidence/**, on any event", () => {
    start();
    for (const kind of ["change", "create", "delete"] as const) {
      fire(kind, `${CAMPAIGN}/tests/m4/runs/RUN-2026-10-06-001.md`);
      fire(kind, `${CAMPAIGN}/tests/m4/evidence/TC-001.md`);
    }
    settle();
    expect(reconcile).not.toHaveBeenCalled();
  });

  // ...and a write to tests/m<n>/*.md triggers exactly one debounced rebuild.
  it("a write to a TC file triggers exactly one debounced rebuild, however many events it raises", () => {
    start();
    fire("create", `${CAMPAIGN}/tests/m4/TC-013_new.md`);
    fire("change", `${CAMPAIGN}/tests/m4/TC-013_new.md`);
    fire("change", `${CAMPAIGN}/tests/m4/TC-013_new.md`);
    expect(reconcile).not.toHaveBeenCalled(); // debounced, not immediate
    settle();
    expect(reconcile).toHaveBeenCalledTimes(1);
    settle();
    expect(reconcile).toHaveBeenCalledTimes(1); // no reconcile loop: nothing re-arms it
  });

  it("a README write triggers exactly one rebuild, and so does a TC delete", () => {
    start();
    fire("change", `${CAMPAIGN}/tests/m4/README.md`);
    settle();
    expect(reconcile).toHaveBeenCalledTimes(1);
    fire("delete", `${CAMPAIGN}/tests/m4/TC-013_new.md`);
    settle();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("a run report written in the same window as a TC write still costs exactly one rebuild", () => {
    start();
    fire("create", `${CAMPAIGN}/tests/m4/runs/RUN-2026-10-06-002.md`);
    fire("change", `${CAMPAIGN}/tests/m4/TC-001_add-tests.md`);
    fire("create", `${CAMPAIGN}/tests/m4/evidence/out.txt`);
    settle();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("entity files outside tests/ rebuild as before", () => {
    start();
    fire("change", `${CAMPAIGN}/missions/m4-x/mission.yaml`);
    settle();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

// ── M6 T6.3: a TC status written by set-test-status.js reaches the Tests node and the open panel, once ──

const SET_TEST_STATUS = join(
  dirname(fileURLToPath(import.meta.url)), "..", "resources", "octobots-pack", "skill", "mission-planner", "scripts", "set-test-status.js",
);

/** What VS Code's `.octobots/campaigns/**\/*.{md,yaml}` watcher reports: only paths that glob matches. */
const globMatches = (fsPath: string): boolean => /[\\/]\.octobots[\\/]campaigns[\\/].*\.(md|yaml)$/.test(fsPath);
const deliver = (kind: "change" | "create" | "delete", fsPath: string): void => { if (globMatches(fsPath)) fire(kind, fsPath); };

describe("a set-test-status.js write reaches the Tests node and open panels with one rebuild", () => {
  function fixture() {
    const repo = mkdtempClean("watch-tc-");
    const octo = join(repo, ".octobots");
    const board = new BoardHost(octo);
    const c = board.createCampaign({ name: "Camp" });
    const m = board.createMission({ title: "M4 - Gate", campaignId: c.id });
    board.updateBrief("mission", m.id, { acceptanceCriteria: "- [ ] one" });
    const dir = join(octo, c.folderPath, "tests", "m4");
    mkdirSync(join(dir, "runs"), { recursive: true });
    mkdirSync(join(dir, "evidence"), { recursive: true });
    const tcs = ["TC-001", "TC-002", "TC-003"].map((id) => {
      const file = join(dir, `${id}_case.md`);
      writeFileSync(file, `---\nid: ${id}\ntitle: case ${id}\nmission: M4\ncovers: [M4-AC1]\nkind: cli\nstatus: ready\n---\n\n# ${id}: case\n\nbody stays\n`);
      return file;
    });
    board.reconcile();
    return { board, octo, c, m, dir, tcs };
  }
  const setStatus = (file: string, status: string): void => {
    execFileSync("node", [SET_TEST_STATUS, file, status, "--date", "2026-10-06"], { stdio: "pipe" });
  };
  const tmpOf = (file: string): string => join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);

  beforeEach(() => {
    vi.useFakeTimers();
    fake.handlers.change.length = fake.handlers.create.length = fake.handlers.delete.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("updates the Tests node counts and notifies an open panel within one debounce, with exactly one rebuild", async () => {
    const { board, m, c, tcs } = fixture();
    const reconcile = vi.spyOn(board, "reconcile");
    let panelRefreshes = 0;
    board.on("entities:changed", () => { panelRefreshes++; });
    const dispose = registerBoardWatcher({ folder: {} as never, board, repoRoot: "/ws" });

    const { CampaignsTree } = await import("../src/host/campaigns-tree.js");
    const tree = new CampaignsTree(board);
    const groupLabel = (): string => {
      const camp = tree.getChildren().find((n) => n.type === "campaign")!;
      const tests = tree.getChildren(camp).find((n) => (n.type as string) === "tests")!;
      return (tree.getTreeItem(tests.type === "tests" ? tree.getChildren(tests)[0]! : tests) as unknown as { label: string }).label;
    };
    expect(groupLabel()).toBe("m4 · 3 · 3 ready");

    // the script's own sequence: write the temp file next to the TC, rename it over the TC
    setStatus(tcs[0]!, "pass");
    deliver("create", tmpOf(tcs[0]!)); // .TC-001_case.md.<pid>.tmp: the glob does not report it
    deliver("change", tcs[0]!);        // the rename lands as a change of the TC

    vi.advanceTimersByTime(BOARD_DEBOUNCE_MS - 1);
    expect(reconcile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(panelRefreshes).toBe(1);
    expect(groupLabel()).toBe("m4 · 3 · 1✓ 2 ready");
    expect(board.testCoverage(m.id).acs[0]).toMatchObject({ ac: "M4-AC1", covered: true });
    expect(board.testSummary(c.id)!.counts).toMatchObject({ pass: 1, ready: 2 });

    vi.advanceTimersByTime(BOARD_DEBOUNCE_MS * 10);
    expect(reconcile).toHaveBeenCalledTimes(1); // no reload loop
    expect(panelRefreshes).toBe(1);
    dispose.dispose();
  });

  it("an OPEN mission panel is refreshed once within one debounce and its reload over tests:* sees the new status", async () => {
    const { board, m, c, tcs } = fixture();
    const { EntityPanelManager } = await import("../src/host/entity-panel-manager.js");
    const reconcile = vi.spyOn(board, "reconcile");
    const manager = new EntityPanelManager({ extensionPath: "/ext" } as never, { board } as never);
    fake.panels.length = 0;
    manager.openMission(m.id);
    manager.openCampaign(c.id);
    const [missionPanel, campaignPanel] = fake.panels;
    const spine = (p: typeof missionPanel): unknown[] => p!.posted.filter((x) => x.type === "spine:event").map((x) => x.payload);
    const rpc = async (p: typeof missionPanel, id: number, method: string, args: unknown): Promise<unknown> => {
      await p!.send({ type: "rpc", id, method, args });
      const r = p!.posted.find((x) => x.type === "rpc:result" && x.id === id)!;
      expect(r.ok, method).toBe(true);
      return r.value;
    };
    const dispose = registerBoardWatcher({ folder: {} as never, board, repoRoot: "/ws" });

    setStatus(tcs[0]!, "pass");
    deliver("create", tmpOf(tcs[0]!));
    deliver("change", tcs[0]!);
    vi.advanceTimersByTime(BOARD_DEBOUNCE_MS - 1);
    expect(spine(missionPanel)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    // the event MissionView reloads on (mission-view.tsx: `e.missionId === id`), exactly once
    expect(spine(missionPanel)).toEqual([{ projectId: "workspace", missionId: m.id }]);
    expect(spine(campaignPanel)).toEqual([{ projectId: "workspace", campaignId: c.id }]);

    // the panel's reload: its tests:* calls already see the TC that set-test-status.js flipped
    const list = (await rpc(missionPanel, 1, "tests:list", { campaignId: c.id, mission: "m4" })) as Array<{ id: string; status: string }>;
    expect(list.map((t) => `${t.id}:${t.status}`)).toEqual(["TC-001:pass", "TC-002:ready", "TC-003:ready"]);
    const cov = (await rpc(missionPanel, 2, "tests:coverage", { missionId: m.id })) as { acs: Array<{ ac: string; tcs: string[] }> };
    expect(cov.acs[0]).toMatchObject({ ac: "M4-AC1", tcs: ["TC-001", "TC-002", "TC-003"] });
    const sum = (await rpc(campaignPanel, 3, "tests:summary", { campaignId: c.id })) as { counts: Record<string, number> };
    expect(sum.counts).toMatchObject({ pass: 1, ready: 2 });

    vi.advanceTimersByTime(BOARD_DEBOUNCE_MS * 10);
    expect(reconcile).toHaveBeenCalledTimes(1); // the panel's reads trigger no rebuild: no reload loop
    expect(spine(missionPanel)).toHaveLength(1);
    dispose.dispose();
  });

  it("the temp-file rename costs ONE rebuild, whether the watcher reports it as a change or as delete + create", () => {
    for (const events of [["change"], ["delete", "create"], ["create", "change"]] as const) {
      const { board, tcs } = fixture();
      const reconcile = vi.spyOn(board, "reconcile");
      const seen: string[] = [];
      board.on("entities:changed", () => { seen.push(readFileSync(tcs[1]!, "utf8").match(/^status: (\w+)/m)![1]!); });
      const dispose = registerBoardWatcher({ folder: {} as never, board, repoRoot: "/ws" });
      setStatus(tcs[1]!, "fail");
      deliver("create", tmpOf(tcs[1]!));
      for (const kind of events) deliver(kind, tcs[1]!);
      deliver("delete", tmpOf(tcs[1]!));
      vi.advanceTimersByTime(BOARD_DEBOUNCE_MS * 4);
      expect(reconcile, events.join("+")).toHaveBeenCalledTimes(1);
      expect(seen, events.join("+")).toEqual(["fail"]); // never a half state: the one rebuild sees the final file
      expect(board.listTests(board.listCampaigns()[0]!.id).map((t) => t.status).sort()).toEqual(["fail", "ready", "ready"]);
      dispose.dispose();
    }
  });

  it("the temp name itself is not a board path: a bare tmp create/delete rebuilds nothing", () => {
    const { board, tcs } = fixture();
    const reconcile = vi.spyOn(board, "reconcile");
    const dispose = registerBoardWatcher({ folder: {} as never, board, repoRoot: "/ws" });
    for (const kind of ["create", "change", "delete"] as const) deliver(kind, tmpOf(tcs[0]!));
    vi.advanceTimersByTime(BOARD_DEBOUNCE_MS * 4);
    expect(reconcile).not.toHaveBeenCalled();
    dispose.dispose();
  });

  it("a QA run writes RUN + evidence + the TC status in one window: exactly one rebuild, none for runs/ or evidence/ alone", () => {
    const { board, dir, tcs } = fixture();
    const reconcile = vi.spyOn(board, "reconcile");
    const dispose = registerBoardWatcher({ folder: {} as never, board, repoRoot: "/ws" });
    const run = join(dir, "runs", "RUN-2026-10-06-001.md");
    const shot = join(dir, "evidence", "TC-003.md");
    writeFileSync(run, "run");
    writeFileSync(shot, "shot");
    deliver("create", run); deliver("change", run); deliver("create", shot);
    vi.advanceTimersByTime(BOARD_DEBOUNCE_MS * 4);
    expect(reconcile).not.toHaveBeenCalled(); // M4-AC6: runs/ and evidence/ cost no rebuild
    setStatus(tcs[2]!, "blocked");
    deliver("change", run); deliver("change", tcs[2]!); deliver("change", shot);
    vi.advanceTimersByTime(BOARD_DEBOUNCE_MS * 4);
    expect(reconcile).toHaveBeenCalledTimes(1);
    dispose.dispose();
  });

  it("set-test-status.js leaves no temp file behind, so a late tmp event cannot arrive", () => {
    const { dir, tcs } = fixture();
    setStatus(tcs[0]!, "pass");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
  });
});
