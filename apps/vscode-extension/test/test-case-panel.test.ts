// T1.3: the host side of the test-case panel: EntityPanelManager's `testCase` kind over a real BoardHost on a copy of
// the tracked board (campaign octoshell-0-1-1, rule 2), with a fake VS Code window. Expected values are read from
// the TC file.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const h = vi.hoisted(() => {
  interface FakePanel {
    viewType: string;
    title: string;
    reveal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    posted: Array<Record<string, unknown>>;
    receive: (msg: unknown) => Promise<void>;
    webview: Record<string, unknown>;
    onDidDispose: (cb: () => void) => { dispose(): void };
  }
  const panels: FakePanel[] = [];
  function fakePanel(viewType: string, title: string): FakePanel {
    const handlers: Array<(m: unknown) => unknown> = [];
    const disposers: Array<() => void> = [];
    const posted: Array<Record<string, unknown>> = [];
    const p: FakePanel = {
      viewType,
      title,
      posted,
      reveal: vi.fn(),
      dispose: vi.fn(() => { for (const d of disposers) d(); }),
      receive: async (msg) => { for (const fn of handlers) await fn(msg); },
      webview: {
        html: "",
        options: {},
        cspSource: "vscode-webview:",
        asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `vscode-webview://x${u.fsPath}` }),
        postMessage: vi.fn(async (m: Record<string, unknown>) => { posted.push(m); return true; }),
        onDidReceiveMessage: (fn: (m: unknown) => unknown) => { handlers.push(fn); return { dispose() {} }; },
      },
      onDidDispose: (cb) => { disposers.push(cb); return { dispose() {} }; },
    };
    return p;
  }
  return { panels, fakePanel, executeCommand: vi.fn(), showTextDocument: vi.fn(), openFile: vi.fn() };
});

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn((viewType: string, title: string) => { const p = h.fakePanel(viewType, title); h.panels.push(p); return p; }),
    showTextDocument: h.showTextDocument,
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: { executeCommand: h.executeCommand },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  ViewColumn: { Active: -1 },
  workspace: {},
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
}));

const { EntityPanelManager, TEST_CASE_VIEW_TYPE } = await import("../src/host/entity-panel-manager.js");
const { BoardHost } = await import("../src/host/board-host.js");
const { AppearanceStore } = await import("../src/host/appearance-store.js");
const { FakeMemento } = await import("./helpers.js");
const { trackedBoardCopies } = await import("./fixtures/real-board.js");
const { DDP, TC4, field, lastRunOf, unquote } = await import("./fixtures/tc-panel-fixtures.js");

function setup() {
  const octo = trackedBoardCopies()[0]!;
  const board = new BoardHost(octo);
  const ctx = {
    board,
    appearanceStore: new AppearanceStore(new FakeMemento()),
    workspaceFolderPath: dirname(octo),
    dialog: { openFiles: async () => [], confirm: async () => false },
    editor: { openReadonly: async () => {}, openFile: h.openFile },
  };
  const manager = new EntityPanelManager({ extensionPath: "/nonexistent-ext" } as never, ctx as never);
  return { octo, board, manager, ctx };
}

beforeEach(() => {
  h.panels.length = 0;
  vi.clearAllMocks();
});

describe("TEST_CASE_VIEW_TYPE", () => {
  it("is octoshell.testCase and is declared as an activation event and restored by a serializer", () => {
    expect(TEST_CASE_VIEW_TYPE).toBe("octoshell.testCase");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      activationEvents: string[]; contributes: { commands: Array<{ command: string }> };
    };
    expect(pkg.activationEvents).toContain("onWebviewPanel:octoshell.testCase");
    const ext = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
    expect(ext).toMatch(/registerWebviewPanelSerializer\(\s*TEST_CASE_VIEW_TYPE/);
    expect(ext).toMatch(/adopt\(panel, "testCase", id\)/);
  });
});

describe("openTestCase", () => {
  it("creates one panel of view type octoshell.testCase titled `TC-004: <title>`; a second call reveals it", () => {
    const { octo, manager } = setup();
    const title = unquote(field(readFileSync(join(octo, TC4), "utf8"), "title"))!;
    expect(manager.openTestCase(TC4)).toBe(true);
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0]!.viewType).toBe(TEST_CASE_VIEW_TYPE);
    expect(h.panels[0]!.title).toBe(`TC-004: ${title}`);
    expect(manager.openTestCase(TC4)).toBe(true);
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0]!.reveal).toHaveBeenCalledTimes(1);
  });

  it("one panel per TC however its path is spelled", () => {
    const { manager } = setup();
    manager.openTestCase(TC4);
    manager.openTestCase(TC4.replace("/tests/m6/", "/tests/m6/../m6/"));
    manager.openTestCase(`./${TC4}`);
    manager.openTestCase(TC4.replace("/m6/", "/m6//"));
    expect(h.panels).toHaveLength(1);
  });

  it("another letter case of the same TC never keys a second panel (a case-insensitive file system opens the same file)", () => {
    // Review finding (0.1.1 T1.3): on macOS `TC-004_SIDEBAR-...md` and `campaigns/Direct-dispatch-process/...` passed the
    // guard and opened a second panel on the same file (the second one with no mission: `mission M6 not found`).
    const { manager } = setup();
    expect(manager.openTestCase(TC4)).toBe(true);
    const variants = [
      TC4.replace("TC-004_sidebar", "TC-004_SIDEBAR"),
      TC4.replace("direct-dispatch-process", "Direct-dispatch-process"),
      TC4.replace("/m6/", "/M6/"),
      TC4.replace("campaigns/", "CAMPAIGNS/"),
    ];
    for (const v of variants) expect(manager.openTestCase(v), v).toBe(false);
    expect(h.panels).toHaveLength(1);
  });

  it("binds {kind: testCase, id: <path>} when the webview is ready", async () => {
    const { manager } = setup();
    manager.openTestCase(TC4);
    await h.panels[0]!.receive({ type: "webview-ready" });
    expect(h.panels[0]!.posted).toContainEqual({ type: "bind", kind: "testCase", id: TC4 });
  });

  it("posts a spine event to the panel on entities:changed, and stops after it is disposed", () => {
    const { board, manager } = setup();
    manager.openTestCase(TC4);
    const p = h.panels[0]!;
    board.reconcile();
    const events = p.posted.filter((m) => m.type === "spine:event");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ projectId: "workspace", testPath: TC4 });
    p.dispose();
    board.reconcile();
    expect(p.posted.filter((m) => m.type === "spine:event")).toHaveLength(1);
  });

  it("refreshes the panel title when the TC's title changes on disk", () => {
    const { octo, board, manager } = setup();
    manager.openTestCase(TC4);
    const abs = join(octo, TC4);
    writeFileSync(abs, readFileSync(abs, "utf8").replace(/^title:.*$/m, 'title: "Renamed on disk"'));
    board.reconcile();
    expect(h.panels[0]!.title).toBe("TC-004: Renamed on disk");
  });

  it("rejects `..` paths, absolute paths, a TC symlink resolving outside the board and non-TC files: no panel", () => {
    const { octo, manager } = setup();
    const repo = dirname(octo);
    writeFileSync(join(repo, "secret.md"), "secret");
    mkdirSync(join(repo, "elsewhere"), { recursive: true });
    writeFileSync(join(repo, "elsewhere", "TC-001_outside.md"), "# TC-001\n");
    symlinkSync(join(repo, "secret.md"), join(octo, DDP, "tests", "m6", "TC-099_link.md"));
    const crafted = [
      "../secret.md",
      "../elsewhere/TC-001_outside.md",
      `${DDP}/tests/m6/../../../../../elsewhere/TC-001_outside.md`,
      join(repo, "elsewhere", "TC-001_outside.md"),
      "/etc/hosts",
      `${DDP}/tests/m6/TC-099_link.md`,
      `${DDP}/campaign.yaml`,
      `${DDP}/tests/m6/README.md`,
      `${DDP}/tests/m6/TC-404_missing.md`,
      "", ".", "campaigns", 7, null, undefined,
    ];
    for (const p of crafted) expect(manager.openTestCase(p), String(p)).toBe(false);
    expect(h.panels).toHaveLength(0);
  });

  it("the openTestCase UI message (the sidebar-independent path: a mission panel's TC row) opens the panel", async () => {
    const { manager } = setup();
    manager.openMission("any");
    // a mission panel posts openTestCase with the row's TestCase.path
    await h.panels[0]!.receive({ type: "openTestCase", path: TC4 });
    expect(h.panels.map((p) => p.viewType)).toEqual(["octoshell.mission", TEST_CASE_VIEW_TYPE]);
    await h.panels[0]!.receive({ type: "openTestCase", path: "../secret.md" });
    expect(h.panels).toHaveLength(2);
    expect(h.executeCommand).not.toHaveBeenCalled(); // no raw-file open for a TC row
  });
});

describe("restored panel", () => {
  it("adopt binds a restored testCase panel to its path; a TC that is gone does not dispose it", async () => {
    const { manager } = setup();
    const restored = h.fakePanel(TEST_CASE_VIEW_TYPE, "TC-004: restored");
    manager.adopt(restored as never, "testCase", TC4);
    await restored.receive({ type: "webview-ready" });
    expect(restored.posted).toContainEqual({ type: "bind", kind: "testCase", id: TC4 });
    const gone = h.fakePanel(TEST_CASE_VIEW_TYPE, "TC-404");
    manager.adopt(gone as never, "testCase", `${DDP}/tests/m6/TC-404_gone.md`);
    await gone.receive({ type: "webview-ready" });
    expect(gone.dispose).not.toHaveBeenCalled();
    expect(gone.posted).toContainEqual({ type: "bind", kind: "testCase", id: `${DDP}/tests/m6/TC-404_gone.md` });
  });

  it("a restored panel answers tests:get with null for a gone TC (the webview shows the no-longer-exists state)", async () => {
    const { manager } = setup();
    const path = `${DDP}/tests/m6/TC-404_gone.md`;
    const gone = h.fakePanel(TEST_CASE_VIEW_TYPE, "TC-404");
    manager.adopt(gone as never, "testCase", path);
    await gone.receive({ type: "rpc", id: 1, method: "tests:get", args: { path } });
    expect(gone.posted).toContainEqual({ type: "rpc:result", id: 1, ok: true, value: null });
  });
});

describe("openTestEvidence and openTestFile", () => {
  it("opens the evidence file the host reads from the TC on disk, never one the webview names", async () => {
    const { octo, manager } = setup();
    manager.openTestCase(TC4);
    const run = lastRunOf(readFileSync(join(octo, TC4), "utf8"))!;
    await h.panels[0]!.receive({ type: "openTestEvidence", path: TC4 });
    expect(h.openFile).toHaveBeenCalledTimes(1);
    expect(h.openFile).toHaveBeenCalledWith(join(dirname(octo), run.evidence!));
  });

  it("opens nothing for a TC with no evidence, a missing evidence file, or a path the guard rejects", async () => {
    const { octo, manager } = setup();
    manager.openTestCase(TC4);
    const abs = join(octo, TC4);
    const text = readFileSync(abs, "utf8");
    writeFileSync(abs, text.replace(/evidence: [^,}]+/, "evidence: .octobots/nope/RUN-404.md"));
    await h.panels[0]!.receive({ type: "openTestEvidence", path: TC4 });
    writeFileSync(abs, text.replace(/^last_run:.*\n/m, ""));
    await h.panels[0]!.receive({ type: "openTestEvidence", path: TC4 });
    await h.panels[0]!.receive({ type: "openTestEvidence", path: "../../etc/hosts" });
    expect(h.openFile).not.toHaveBeenCalled();
  });

  it("the Open source file button (openTestFile) still goes through the guarded raw-file command", async () => {
    const { octo, manager } = setup();
    manager.openTestCase(TC4);
    await h.panels[0]!.receive({ type: "openTestFile", path: TC4 });
    expect(h.executeCommand).toHaveBeenCalledWith("octoshell.openTestFile", join(octo, TC4));
  });
});

describe("the octoshell.openTestCase command", () => {
  it("is registered in extension.ts through the panel manager's guard, and left out of the palette like openTestFile", () => {
    const ext = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
    expect(ext).toMatch(/registerCommand\(OPEN_TEST_CASE_COMMAND, \(arg: unknown\) => \{ entityPanels\.openTestCase\(arg\); \}\)/);
    const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    expect(pkg).not.toContain("octoshell.openTestCase");
    expect(pkg).not.toContain("octoshell.openTestFile");
  });
});
