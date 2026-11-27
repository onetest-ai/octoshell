/**
 * The pack's `completion-guard.mjs`: the record parser (`latestRecord`), the commit currency rule
 * (`isCurrent`, with the board path excluded), the six mission-done checks (`doneProblems`) and the
 * at-rest warning. Boards are built with the board writers inside temp git repositories. Every guard
 * call runs the module in a child `node`, as the CLI tests do, so `pnpm coverage:pack` (c8 over child
 * processes) counts it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCampaign, createMission, createTask, setStatus, setCriterion, updateBrief } from "../src/index.js";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);

interface GuardRecord { at: string; fields: Record<string, string>; lines: string[] }
interface Problem { check: string; message: string; next?: string }
interface Guard {
  HEADINGS: { gate: string; completion: string; override: string };
  latestRecord: (notes: string, heading: string) => GuardRecord | null;
  hasOverride: (notes: string) => boolean;
  repoRootOf: (dir: string) => string | null;
  boardRelPath: (repoRoot: string, missionDir: string) => string;
  trackedChanges: (repoRoot: string, missionDir: string) => string[];
  isCurrent: (repoRoot: string, commit: string, missionDir: string) => boolean;
  headCommit: (repoRoot: string) => string;
  scriptsDir: (repoRoot: string | null) => string;
  doneProblems: (a: { missionDir: string; fields: Record<string, unknown> }) => Problem[];
  atRestWarning: (fields: Record<string, unknown>) => string | null;
}
const GUARD = pathToFileURL(join(SCRIPTS, "completion-guard.mjs")).href;
/** Call export `name` of completion-guard.mjs in a child node; a throw there is rethrown here. */
function call(name: string, args: unknown[]): unknown {
  const src =
    `import * as g from ${JSON.stringify(GUARD)};` +
    "const [n, a] = JSON.parse(process.argv[1]);" +
    "let r; try { r = { ok: true, v: typeof g[n] === 'function' ? g[n](...a) : g[n] }; } catch (e) { r = { ok: false, e: String(e?.message ?? e) }; }" +
    "process.stdout.write(JSON.stringify(r));";
  const out = JSON.parse(execFileSync("node", ["--input-type=module", "-e", src, JSON.stringify([name, args])], { encoding: "utf8" })) as {
    ok: boolean; v?: unknown; e?: string;
  };
  if (!out.ok) throw new Error(out.e);
  return out.v;
}
const guard = new Proxy({} as Guard, {
  get: (_t, name: string) => (name === "HEADINGS" ? call(name, []) : (...a: unknown[]) => call(name, a)),
});
const entityIo = (await import(pathToFileURL(join(SCRIPTS, "entity-io.mjs")).href)) as {
  readEntity: (file: string, format: string) => Record<string, unknown>;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let tmp: string;
beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), "guard-"))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** A git repository at `<tmp>/repo` with one committed file `src.txt`. */
function initRepo(): string {
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "src.txt"), "one\n");
  commitAll(repo);
  return repo;
}
function commitAll(repo: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c", "--allow-empty");
  return git(repo, "rev-parse", "HEAD").trim();
}

interface Board { boardRoot: string; campaignDir: string; missionDir: string; missionId: string; taskId: string }
/** A campaign with mission "M1 - Guard" (one criterion) and one task, under `<base>/.octobots`. */
function makeBoard(base: string): Board {
  const boardRoot = join(base, ".octobots");
  mkdirSync(boardRoot, { recursive: true });
  const c = createCampaign(boardRoot, { name: "Q4" });
  const m = createMission(boardRoot, c.id, { title: "M1 - Guard", acceptanceCriteria: "- [ ] it works" });
  const t = createTask(boardRoot, m.id, { name: "T1.1 - Build", acceptanceCriteria: "- [ ] built" });
  return {
    boardRoot,
    campaignDir: join(boardRoot, c.folderPath),
    missionDir: join(boardRoot, m.folderPath),
    missionId: m.id,
    taskId: `folder:${t.folderPath}`,
  };
}
function writeTc(b: Board, status: string): void {
  const dir = join(b.campaignDir, "tests", "m1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TC-001_works.md"), `---\nid: TC-001\nstatus: ${status}\n---\n## Steps\n`);
}
const fieldsOf = (b: Board): Record<string, unknown> => entityIo.readEntity(join(b.missionDir, "mission.yaml"), "yaml");
const setNotes = (b: Board, notes: string): void => { updateBrief(b.boardRoot, "mission", b.missionId, { notes }); };
const gateRecord = (at: string, commit: string, verdict = "green"): string =>
  [`## Gate checks (${at})`, `Verdict: ${verdict}`, `Commit: ${commit}`, "Lane: coverage `pnpm coverage`", "Exit: 0", "Parked: 0 unsigned"].join("\n");
const completionRecord = (at: string, commit: string, opts: { verdict?: string; qa?: string; review?: string } = {}): string =>
  [
    `## Completion gate (${at})`,
    `Verdict: ${opts.verdict ?? "green"}`,
    `Commit: ${commit}`,
    `QA: ${opts.qa ?? "1/1 criteria passed"}`,
    `Review: ${opts.review ?? "stillOpen=0"}`,
    "Note: first",
    "Note: second",
  ].join("\n");
const checks = (ps: Problem[]): string[] => ps.map((p) => p.check);
/** Finish the board: task done, criterion ticked, TC passed. */
function finish(b: Board): void {
  setStatus(b.boardRoot, "task", b.taskId, "done");
  setCriterion(b.boardRoot, "mission", b.missionId, 1, true);
  writeTc(b, "pass");
}

describe("HEADINGS", () => {
  it("names the three record headings", () => {
    expect(guard.HEADINGS).toEqual({ gate: "Gate checks", completion: "Completion gate", override: "Completion gate overridden" });
  });
});

describe("latestRecord", () => {
  it("returns the record with the latest timestamp, even when it is written above an earlier one", () => {
    const notes = [
      "intro",
      completionRecord("2026-11-27T12:00:00Z", "b".repeat(40), { verdict: "red" }),
      "",
      completionRecord("2026-11-27T10:00:00Z", "a".repeat(40)),
    ].join("\n");
    const r = guard.latestRecord(notes, "Completion gate");
    expect(r?.at).toBe("2026-11-27T12:00:00Z");
    expect(r?.fields.verdict).toBe("red");
    expect(r?.fields.commit).toBe("b".repeat(40));
  });

  it("on a timestamp tie, the record lower in the notes wins", () => {
    const notes = [gateRecord("2026-11-27T10:00:00Z", "a".repeat(40), "red"), gateRecord("2026-11-27T10:00:00Z", "b".repeat(40))].join("\n");
    expect(guard.latestRecord(notes, "Gate checks")?.fields.verdict).toBe("green");
  });

  it("never matches an override record or a legacy `: GREEN` heading as a Completion gate", () => {
    const notes = [
      "## Completion gate overridden (2026-11-27T11:00:00Z)",
      "shipping anyway",
      "Failed: tests",
      "## Completion gate (2026-10-05): GREEN",
      "Verdict: green",
    ].join("\n");
    expect(guard.latestRecord(notes, "Completion gate")).toBeNull();
    expect(guard.latestRecord(notes, "Completion gate overridden")?.lines).toContain("Failed: tests");
  });

  it("parses lowercased field keys, keeps repeated Note lines, and stops at the next heading", () => {
    const notes = `${completionRecord("2026-11-27T10:30:00Z", "c".repeat(40))}\n## Other\nVerdict: red\n`;
    const r = guard.latestRecord(notes, "Completion gate");
    expect(r?.fields.verdict).toBe("green");
    expect(r?.fields.qa).toBe("1/1 criteria passed");
    expect(r?.fields.review).toBe("stillOpen=0");
    expect(r?.lines.filter((l) => l.startsWith("Note:"))).toEqual(["Note: first", "Note: second"]);
    expect(r?.lines).not.toContain("Verdict: red");
  });

  it("returns null for empty or missing notes", () => {
    expect(guard.latestRecord("", "Gate checks")).toBeNull();
    expect(guard.latestRecord(undefined as unknown as string, "Gate checks")).toBeNull();
  });
});

describe("hasOverride", () => {
  it("is true only for a timestamped override heading", () => {
    expect(guard.hasOverride("## Completion gate overridden (2026-11-27T11:00:00Z)\nwhy")).toBe(true);
    expect(guard.hasOverride("## Completion gate (2026-11-27T11:00:00Z)\nVerdict: green")).toBe(false);
    expect(guard.hasOverride("")).toBe(false);
  });
});

describe("git helpers", () => {
  it("repoRootOf gives the toplevel, or null outside a repository", () => {
    const repo = initRepo();
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    expect(guard.repoRootOf(join(repo, "a", "b"))).toBe(repo);
    expect(guard.repoRootOf(join(tmp))).toBeNull();
    expect(guard.repoRootOf(join(tmp, "missing"))).toBeNull();
  });

  it("isCurrent: true after the commit, false after a tracked change outside the board, true after board-only changes", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    const head = commitAll(repo);
    expect(guard.headCommit(repo)).toBe(head);
    expect(guard.isCurrent(repo, head, b.missionDir)).toBe(true);

    setNotes(b, "edited board");
    writeFileSync(join(b.boardRoot, "new.md"), "x");
    expect(guard.isCurrent(repo, head, b.missionDir)).toBe(true);
    expect(guard.trackedChanges(repo, b.missionDir)).toEqual([]);

    writeFileSync(join(repo, "src.txt"), "two\n");
    expect(guard.isCurrent(repo, head, b.missionDir)).toBe(false);
    expect(guard.trackedChanges(repo, b.missionDir)).toEqual([" M src.txt"]);
  });

  it("isCurrent is false for an unknown commit, a malformed commit, and a non-repository", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    commitAll(repo);
    expect(guard.isCurrent(repo, "0000000000000000000000000000000000000000", b.missionDir)).toBe(false);
    expect(guard.isCurrent(repo, "--output=x", b.missionDir)).toBe(false);
    expect(guard.isCurrent(repo, "", b.missionDir)).toBe(false);
    expect(guard.isCurrent(join(tmp, "nope"), "a".repeat(40), b.missionDir)).toBe(false);
  });

  it("trackedChanges throws on a git error", () => {
    expect(() => guard.trackedChanges(join(tmp, "nope"), join(tmp, "nope"))).toThrow();
  });

  it("a subfolder board: isCurrent stays true and trackedChanges is empty after a mission.yaml edit", () => {
    const repo = initRepo();
    const b = makeBoard(join(repo, "apps", "x"));
    const head = commitAll(repo);
    expect(guard.boardRelPath(repo, b.missionDir)).toBe("apps/x/.octobots");
    setNotes(b, "changed");
    expect(git(repo, "status", "--porcelain")).toContain("mission.yaml");
    expect(guard.isCurrent(repo, head, b.missionDir)).toBe(true);
    expect(guard.trackedChanges(repo, b.missionDir)).toEqual([]);
  });

  it("scriptsDir prefers the workspace's installed scripts when they hold gate-checks.mjs", () => {
    const repo = initRepo();
    expect(guard.scriptsDir(repo)).toBe(SCRIPTS);
    expect(guard.scriptsDir(null)).toBe(SCRIPTS);
    const installed = join(repo, ".claude", "skills", "mission-planner", "scripts");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "gate-checks.mjs"), "");
    expect(guard.scriptsDir(repo)).toBe(installed);
  });
});

describe("doneProblems", () => {
  it("reports tasks, criteria, tests, gate-checks and completion-gate for an unfinished mission with no records", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    writeTc(b, "fail");
    commitAll(repo);
    const ps = guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) });
    expect(checks(ps)).toEqual(["tasks", "criteria", "tests", "gate-checks", "completion-gate"]);
    expect(ps[0]?.message).toContain("T1.1 - Build");
    expect(ps[0]?.message).toContain("draft");
    expect(ps[1]?.message).toContain("1");
    expect(ps[2]?.message).toContain("TC-001_works.md");
    expect(ps[3]?.next).toBe(`node ${SCRIPTS}/gate-checks.mjs ${b.missionDir}`);
    expect(ps[4]?.next).toContain("mission-completion-gate");
    expect(ps[4]?.next).toContain(`${SCRIPTS}/gate-record.mjs ${b.missionDir}`);
  });

  it("returns [] when everything is finished and both records are green and current", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    finish(b);
    const head = commitAll(repo);
    setNotes(b, [gateRecord("2026-11-27T10:00:00Z", head), completionRecord("2026-11-27T10:30:00Z", head)].join("\n\n"));
    expect(guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) })).toEqual([]);
  });

  it("a cancelled task is no problem", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    finish(b);
    setStatus(b.boardRoot, "task", b.taskId, "cancelled");
    const head = commitAll(repo);
    setNotes(b, [gateRecord("2026-11-27T10:00:00Z", head), completionRecord("2026-11-27T10:30:00Z", head)].join("\n\n"));
    expect(guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) })).toEqual([]);
  });

  it("Verdict: pending-human asks for awaiting approval", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    finish(b);
    const head = commitAll(repo);
    setNotes(b, [gateRecord("2026-11-27T10:00:00Z", head), completionRecord("2026-11-27T10:30:00Z", head, { verdict: "pending-human" })].join("\n\n"));
    const ps = guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) });
    expect(checks(ps)).toEqual(["completion-gate"]);
    expect(ps[0]?.message).toContain("awaiting approval");
  });

  it("a QA count that does not match the criteria, an open review finding or a red verdict is a completion-gate problem", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    finish(b);
    const head = commitAll(repo);
    const gate = gateRecord("2026-11-27T10:00:00Z", head);
    for (const opts of [{ qa: "2/3" }, { qa: "0/1 criteria passed" }, { qa: "2/2 criteria passed" }, { qa: "none" }, { review: "stillOpen=2" }, { review: "" }, { verdict: "red" }]) {
      setNotes(b, [gate, completionRecord("2026-11-27T10:30:00Z", head, opts)].join("\n\n"));
      const ps = guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) });
      expect(checks(ps), JSON.stringify(opts)).toEqual(["completion-gate"]);
    }
  });

  it("a red or stale Gate checks record is a gate-checks problem; a stale Completion gate is a completion-gate problem", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    finish(b);
    const head = commitAll(repo);
    setNotes(b, [gateRecord("2026-11-27T10:00:00Z", head, "red"), completionRecord("2026-11-27T10:30:00Z", head)].join("\n\n"));
    expect(checks(guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) }))).toEqual(["gate-checks"]);

    setNotes(b, [gateRecord("2026-11-27T10:00:00Z", head), completionRecord("2026-11-27T10:30:00Z", head)].join("\n\n"));
    writeFileSync(join(repo, "src.txt"), "changed\n");
    const ps = guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) });
    expect(checks(ps)).toEqual(["gate-checks", "completion-gate"]);
    expect(ps[0]?.message).toContain("not current");
  });

  it("a mission with no M<n> token or no TC folder passes the tests check; an unreadable task is unfinished", () => {
    const repo = initRepo();
    const b = makeBoard(repo);
    finish(b);
    rmSync(join(b.campaignDir, "tests"), { recursive: true });
    const head = commitAll(repo);
    setNotes(b, [gateRecord("2026-11-27T10:00:00Z", head), completionRecord("2026-11-27T10:30:00Z", head)].join("\n\n"));
    expect(guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) })).toEqual([]);
    writeTc(b, "fail");
    expect(guard.doneProblems({ missionDir: b.missionDir, fields: { ...fieldsOf(b), name: "Guard" } })).toEqual([]);

    mkdirSync(join(b.missionDir, "tasks", "broken"));
    writeFileSync(join(b.missionDir, "tasks", "broken", "task.yaml"), "name: [unclosed\n");
    mkdirSync(join(b.missionDir, "tasks", "legacy"));
    writeFileSync(join(b.missionDir, "tasks", "legacy", "task.md"), "# Legacy\n");
    const ps = guard.doneProblems({ missionDir: b.missionDir, fields: { ...fieldsOf(b), name: "Guard" } });
    expect(checks(ps)).toEqual(["tasks"]);
    expect(ps[0]?.message).toContain("broken");
    expect(ps[0]?.message).not.toContain("Legacy");
  });

  it("outside git, reports the problems found plus git, and skips the record checks", () => {
    const b = makeBoard(join(tmp, "plain"));
    writeTc(b, "fail");
    const ps = guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) });
    expect(checks(ps)).toEqual(["tasks", "criteria", "tests", "git"]);
    expect(ps[3]?.message).toContain("--force=<reason>");

    finish(b);
    expect(checks(guard.doneProblems({ missionDir: b.missionDir, fields: fieldsOf(b) }))).toEqual(["git"]);
  });
});

describe("atRestWarning", () => {
  const done = (notes?: string): Record<string, unknown> => ({ name: "M1 - Guard", status: "done", notes });

  it("warns about a done mission with no completion record", () => {
    expect(guard.atRestWarning(done())).toContain("M1 - Guard");
    expect(guard.atRestWarning(done(completionRecord("2026-11-27T10:30:00Z", "a".repeat(40), { verdict: "red" })))).toEqual(expect.any(String));
  });

  it("is null with a legacy GREEN heading, an override, or a green record of any age", () => {
    expect(guard.atRestWarning(done("## Completion gate (2026-10-05): GREEN — all good"))).toBeNull();
    expect(guard.atRestWarning(done("## Completion gate overridden (2026-11-27T11:00:00Z)\nwhy"))).toBeNull();
    expect(guard.atRestWarning(done(completionRecord("2020-01-01T00:00:00Z", "0".repeat(40))))).toBeNull();
    const greenThenRed = [
      completionRecord("2026-11-27T10:00:00Z", "a".repeat(40)),
      completionRecord("2026-11-27T12:00:00Z", "a".repeat(40), { verdict: "red" }),
    ].join("\n");
    expect(guard.atRestWarning(done(greenThenRed))).toBeNull();
  });

  it("is null for a mission that is not done", () => {
    expect(guard.atRestWarning({ name: "M1", status: "executing" })).toBeNull();
    expect(guard.atRestWarning({ name: "M1" })).toBeNull();
  });
});

