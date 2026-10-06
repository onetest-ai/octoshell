import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  return { handlers, patterns };
});
vi.mock("vscode", () => ({
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
