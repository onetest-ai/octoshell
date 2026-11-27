/**
 * The pack's gate scripts (`gate-record.mjs`, ...). Each runs as a child `node` process so
 * `pnpm coverage:pack` (c8 over child processes) counts it. Boards are built with the board writers
 * inside temp git repositories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCampaign, createMission } from "../src/index.js";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);
const entityIo = (await import(pathToFileURL(join(SCRIPTS, "entity-io.mjs")).href)) as {
  readEntity: (file: string, format: string) => { notes?: string };
};
const guard = (await import(pathToFileURL(join(SCRIPTS, "completion-guard.mjs")).href)) as {
  latestRecord: (notes: string, heading: string) => { fields: Record<string, string>; lines: string[] } | null;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
function run(script: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("node", [join(SCRIPTS, script), ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

let tmp: string;
beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), "gate-"))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

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
/** A mission with `n` criteria under `<base>/.octobots`; returns its folder. */
function makeMission(base: string, n: number): string {
  const boardRoot = join(base, ".octobots");
  mkdirSync(boardRoot, { recursive: true });
  const c = createCampaign(boardRoot, { name: "Q4" });
  const criteria = Array.from({ length: n }, (_, i) => `- [ ] criterion ${i + 1}`).join("\n");
  const m = createMission(boardRoot, c.id, { title: "M1 - Guard", acceptanceCriteria: criteria });
  return join(boardRoot, m.folderPath);
}
const notesOf = (missionDir: string): string => entityIo.readEntity(join(missionDir, "mission.yaml"), "yaml").notes ?? "";

describe("gate-record.mjs", () => {
  it("writes a green record for 3/3 and stillOpen 0, readable by latestRecord", () => {
    const repo = initRepo();
    const dir = makeMission(repo, 3);
    const head = commitAll(repo);
    const r = run("gate-record.mjs", [dir, "--verdict", "green", "--qa", "3/3", "--still-open", "0"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("## Completion gate (");
    const notes = notesOf(dir);
    expect(notes).toMatch(/## Completion gate \(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)\nVerdict: green\nCommit: [0-9a-f]{40}\nQA: 3\/3 criteria passed\nReview: stillOpen=0$/);
    const rec = guard.latestRecord(notes, "Completion gate");
    expect(rec?.fields.verdict).toBe("green");
    expect(rec?.fields.commit).toBe(head);
  });

  it("appends after existing notes with a blank line", () => {
    const repo = initRepo();
    const dir = makeMission(repo, 1);
    expect(run("gate-record.mjs", [dir, "--verdict", "red", "--qa", "0/1", "--still-open", "1"]).code).toBe(0);
    expect(run("gate-record.mjs", [dir, "--verdict", "green", "--qa", "1/1", "--still-open", "0"]).code).toBe(0);
    expect(notesOf(dir)).toMatch(/stillOpen=1\n\n## Completion gate \(/);
  });

  it("refuses green when the QA count is off, naming the number", () => {
    const repo = initRepo();
    const three = makeMission(repo, 3);
    const a = run("gate-record.mjs", [three, "--verdict", "green", "--qa", "2/3", "--still-open", "0"]);
    expect(a.code).toBe(3);
    expect(a.err).toContain("2/3");
    expect(notesOf(three)).not.toContain("Completion gate");
  });

  it("refuses green when the mission has 4 criteria and --qa says 3/3", () => {
    const repo = initRepo();
    const four = makeMission(repo, 4);
    const r = run("gate-record.mjs", [four, "--verdict", "green", "--qa", "3/3", "--still-open", "0"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("4");
  });

  it("refuses green with stillOpen above 0", () => {
    const repo = initRepo();
    const dir = makeMission(repo, 3);
    const r = run("gate-record.mjs", [dir, "--verdict", "green", "--qa", "3/3", "--still-open", "1"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("stillOpen");
  });

  it("records red and pending-human, with every --note", () => {
    const repo = initRepo();
    const dir = makeMission(repo, 3);
    expect(run("gate-record.mjs", [dir, "--verdict", "red", "--qa", "1/3", "--still-open", "2"]).code).toBe(0);
    const p = run("gate-record.mjs", [dir, "--verdict", "pending-human", "--qa", "3/3", "--still-open", "0", "--note", "first", "--note", "second"]);
    expect(p.code).toBe(0);
    const rec = guard.latestRecord(notesOf(dir), "Completion gate");
    expect(rec?.fields.verdict).toBe("pending-human");
    expect(rec?.lines.filter((l) => l.startsWith("Note:"))).toEqual(["Note: first", "Note: second"]);
  });

  it("exits 2 on a bad verdict, a missing --qa, a bad --qa, a bad --still-open or no path", () => {
    const repo = initRepo();
    const dir = makeMission(repo, 1);
    expect(run("gate-record.mjs", [dir, "--verdict", "blue", "--qa", "1/1", "--still-open", "0"]).code).toBe(2);
    expect(run("gate-record.mjs", [dir, "--verdict", "green", "--still-open", "0"]).code).toBe(2);
    expect(run("gate-record.mjs", [dir, "--verdict", "green", "--qa", "x", "--still-open", "0"]).code).toBe(2);
    expect(run("gate-record.mjs", [dir, "--verdict", "green", "--qa", "1/1", "--still-open", "-1"]).code).toBe(2);
    expect(run("gate-record.mjs", ["--verdict", "green", "--qa", "1/1", "--still-open", "0"]).code).toBe(2);
    expect(notesOf(dir)).not.toContain("Completion gate");
  });

  it("refuses on a dirty tracked file outside the board", () => {
    const repo = initRepo();
    const dir = makeMission(repo, 1);
    commitAll(repo);
    writeFileSync(join(repo, "src.txt"), "two\n");
    const r = run("gate-record.mjs", [dir, "--verdict", "green", "--qa", "1/1", "--still-open", "0"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("commit or stash");
  });

  it("refuses outside a git repository", () => {
    const dir = makeMission(join(tmp, "plain"), 1);
    const r = run("gate-record.mjs", [dir, "--verdict", "green", "--qa", "1/1", "--still-open", "0"]);
    expect(r.code).toBe(3);
  });
});

describe("gate-checks.mjs", () => {
  /** A repo with a committed AGENTS.md (the lanes text given) and a mission; HEAD is clean. */
  function setup(lanes: string | null): { repo: string; dir: string } {
    const repo = initRepo();
    if (lanes !== null) writeFileSync(join(repo, "AGENTS.md"), `# Agents\n\n## Test lanes\n\n- fast: \`true\`\n${lanes}\n`);
    const dir = makeMission(repo, 1);
    commitAll(repo);
    return { repo, dir };
  }
  const record = (dir: string) => guard.latestRecord(notesOf(dir), "Gate checks");

  it("writes a green record for a passing lane", () => {
    const { repo, dir } = setup('- coverage: `node -e "process.exit(0)"`');
    const head = git(repo, "rev-parse", "HEAD").trim();
    const r = run("gate-checks.mjs", [dir]);
    expect(r.code).toBe(0);
    const rec = record(dir);
    expect(rec?.fields.verdict).toBe("green");
    expect(rec?.fields.commit).toBe(head);
    expect(rec?.lines).toContain("Exit: 0");
    expect(rec?.lines).toContain("Parked: 0 unsigned");
    expect(rec?.lines).toContain('Lane: coverage `node -e "process.exit(0)"`');
  });

  it("accepts the mission.yaml path", () => {
    const { dir } = setup('- coverage: `true`');
    expect(run("gate-checks.mjs", [join(dir, "mission.yaml")]).code).toBe(0);
  });

  it("records red for a failing lane", () => {
    const { dir } = setup('- coverage: `node -e "process.exit(4)"`');
    expect(run("gate-checks.mjs", [dir]).code).toBe(1);
    const rec = record(dir);
    expect(rec?.fields.verdict).toBe("red");
    expect(rec?.lines).toContain("Exit: 4");
  });

  it.each([
    ["no coverage line", ""],
    ["a placeholder command", "- coverage: `pnpm --filter <pkg> coverage`"],
  ])("warns and skips the lane with %s", (_n, lane) => {
    const { dir } = setup(lane);
    const r = run("gate-checks.mjs", [dir]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning");
    const rec = record(dir);
    expect(rec?.fields.verdict).toBe("green");
    expect(rec?.lines).toContain("Lane: none, no coverage lane in AGENTS.md § Test lanes");
    expect(rec?.lines).toContain("Exit: skipped");
  });

  it("skips the lane when AGENTS.md is missing", () => {
    const { dir } = setup(null);
    const r = run("gate-checks.mjs", [dir]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning");
  });

  it("is red when a committed test is parked", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "x.test.ts"), 'it.skip("a", () => {});\n');
    const dir = makeMission(repo, 1);
    commitAll(repo);
    const r = run("gate-checks.mjs", [dir]);
    expect(r.code).toBe(1);
    const rec = record(dir);
    expect(rec?.fields.verdict).toBe("red");
    expect(rec?.lines).toContain("Parked: 1 unsigned");
  });

  it("is red with a Note when the lane commits new code", () => {
    const { dir } = setup(`- coverage: \`sh -c 'echo x > new.txt && git add new.txt && git -c core.hooksPath=/dev/null -c user.email=t@e.com -c user.name=T commit -q -m n'\``);
    const r = run("gate-checks.mjs", [dir]);
    expect(r.code).toBe(1);
    const rec = record(dir);
    expect(rec?.fields.verdict).toBe("red");
    expect(rec?.lines).toContain("Note: the code changed during the run");
  });

  it("refuses on a dirty tracked file and writes nothing", () => {
    const { repo, dir } = setup('- coverage: `true`');
    writeFileSync(join(repo, "src.txt"), "two\n");
    const r = run("gate-checks.mjs", [dir]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("commit or stash");
    expect(notesOf(dir)).not.toContain("Gate checks");
  });

  it("refuses outside a git repository", () => {
    const dir = makeMission(join(tmp, "plain"), 1);
    expect(run("gate-checks.mjs", [dir]).code).toBe(3);
  });

  it("exits 2 without a path or on a missing one", () => {
    expect(run("gate-checks.mjs", []).code).toBe(2);
    expect(run("gate-checks.mjs", [join(tmp, "nope")]).code).toBe(2);
  });
});
