import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveOut } from "../src/artifact.js";
import { DEFAULTS, type Config } from "../src/config.js";
import { runSetup, type SetupIO } from "../src/setup.js";
import { buildRepo } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const NOW = Date.UTC(2026, 0, 1);

/** A repo with enough history that `historyIsThin` never fires — the same
 *  override `test/doctor.test.ts` uses, so "healthy" means the same thing
 *  in both suites. */
function healthyRepo(): string {
  return buildRepo(Array.from({ length: 12 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })));
}

function healthyConfig(): Config {
  return { ...DEFAULTS, minCommits: 10 };
}

/** A usable graph.json — same shape `test/doctor.test.ts`'s "reports
 *  graphify ok" case writes — so the "graphify" check grades `ok` and
 *  `runSetup` has nothing to prompt about. */
function writeUsableGraph(root: string): void {
  mkdirSync(join(root, "graphify-out"), { recursive: true });
  writeFileSync(
    join(root, "graphify-out", "graph.json"),
    JSON.stringify({
      nodes: [
        { id: "1", file: "pkg/a/x.ts" },
        { id: "2", file: "pkg/b/y.ts" },
      ],
      edges: [{ source: "1", target: "2", type: "imports" }],
    }),
  );
}

interface FakePort {
  io: SetupIO;
  execCalls: Array<{ file: string; args: string[] }>;
  promptCalls: string[];
  logLines: string[];
}

/** A `SetupIO` over plain arrays — no TTY, no network, no process spawned.
 *  `consent` answers every `prompt()` call; `execCode` is the exit code the
 *  fake `exec()` reports back; `onExec` runs before that result resolves, so
 *  a test can make the fake install ACTUALLY change the machine — which is
 *  the only reason a real one is worth consenting to, and the only way to
 *  tell a postflight that re-observes from one that replays what `doctor`
 *  said before the mutation. `absent` names the executables `which` reports
 *  as not on `PATH` — one spelling for both lookups this flow makes (`uv`
 *  before the install, `graphify` after it), rather than a boolean per
 *  executable. */
function fakePort(
  opts: {
    consent?: boolean;
    execCode?: number;
    onExec?: () => void;
    absent?: readonly string[];
  } = {},
): FakePort {
  const execCalls: Array<{ file: string; args: string[] }> = [];
  const promptCalls: string[] = [];
  const logLines: string[] = [];
  const io: SetupIO = {
    prompt: async (question) => {
      promptCalls.push(question);
      return opts.consent ?? false;
    },
    log: (line) => {
      logLines.push(line);
    },
    exec: async (file, args) => {
      execCalls.push({ file, args });
      opts.onExec?.();
      return { code: opts.execCode ?? 0, stdout: "", stderr: "" };
    },
    which: async (file) => ((opts.absent ?? []).includes(file) ? null : `/usr/bin/${file}`),
  };
  return { io, execCalls, promptCalls, logLines };
}

describe("runSetup", () => {
  it("on a healthy repo, runs doctor, prompts for nothing, and returns 0", async () => {
    const repo = healthyRepo();
    writeUsableGraph(repo);
    const port = fakePort();

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.promptCalls).toEqual([]);
    expect(port.execCalls).toEqual([]);
    expect(code).toBe(0);
  });

  it("with Graphify missing and the port declining, makes zero install calls and names the degradation", async () => {
    const repo = healthyRepo(); // no graph.json written — graphify is "missing"
    const port = fakePort({ consent: false });

    await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.promptCalls.length).toBe(1);
    expect(port.execCalls).toEqual([]);
    const logged = port.logLines.join("\n");
    expect(logged).toContain("graphify");
    expect(logged).toContain("uv tool install graphifyy");
  });

  /**
   * `which("uv")` is the ONE gate `runSetup` checks before it ever asks for
   * consent: there is nothing to prompt about if the install command itself
   * cannot run. This is a DIFFERENT outcome than an explicit decline —
   * declining is a choice a healthy run can still exit 0 on; an absent `uv`
   * means the run could not do what it set out to do, so it is reported with
   * a non-zero exit even though `graphify` is only an optional check.
   */
  it("with uv absent, prints uv's install URL, makes zero exec calls, never prompts, and exits non-zero", async () => {
    const repo = healthyRepo(); // no graph.json written — graphify is "missing"
    const port = fakePort({ consent: true, absent: ["uv"] });

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.promptCalls).toEqual([]);
    expect(port.execCalls).toEqual([]);
    const logged = port.logLines.join("\n");
    expect(logged).toContain("https://docs.astral.sh/uv/getting-started/installation/");
    expect(code).not.toBe(0);
  });

  it("with Graphify missing and the port consenting, makes exactly one install call — the argv array", async () => {
    const repo = healthyRepo();
    const port = fakePort({ consent: true });

    await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.execCalls).toEqual([{ file: "uv", args: ["tool", "install", "graphifyy"] }]);
  });

  it("never installs on either of two consecutive declined runs — a build is never a trigger", async () => {
    const repo = healthyRepo();
    const port = fakePort({ consent: false });

    await runSetup(repo, healthyConfig(), NOW, port.io);
    await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.execCalls).toEqual([]);
  });

  it("builds through the same code map uses — map.md and clusters.json land under the resolved out dir", async () => {
    const repo = healthyRepo();
    writeUsableGraph(repo);
    const port = fakePort();

    await runSetup(repo, healthyConfig(), NOW, port.io);

    // No board here, so resolveOut(repo, config) is `.octograph` — asserted
    // indirectly, through the artifact this run must have produced, rather
    // than re-spelling `resolveOut`'s own rule a second time.
    const { resolveOut, readArtifact } = await import("../src/artifact.js");
    const outDir = resolveOut(repo, healthyConfig());
    const artifact = readArtifact(outDir);
    expect(artifact).not.toBeNull();
  });

  /**
   * The postflight reports what it OBSERVED after the install, not what
   * `doctor` said before it. Replaying the pre-install report printed
   * "Graphify installed." and then, three lines later, "graphify: not
   * installed — fix: uv tool install graphifyy" — telling a human to run the
   * exact command that had just succeeded, in the same run's output. That is
   * this campaign's one recurring defect (a claim that outran what the code
   * computed) in the one component that mutates the user's machine, where it
   * is least affordable.
   *
   * The fake install here genuinely changes the machine, so a postflight
   * built from the stale report and one built from a fresh observation
   * disagree — which is what makes this a test rather than a restatement.
   * It does NOT model a real `uv tool install graphifyy`, which writes no
   * `graphify-out/graph.json` at all; the test below covers that run.
   */
  it("reports the state observed AFTER the install, never the one doctor saw before it", async () => {
    const repo = healthyRepo(); // graphify missing at the point doctor first runs
    const port = fakePort({ consent: true, onExec: () => writeUsableGraph(repo) });

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.execCalls).toEqual([{ file: "uv", args: ["tool", "install", "graphifyy"] }]);
    const logged = port.logLines.join("\n");
    // Graded on the graph.json the install produced, not on its absence.
    expect(logged).toContain("[ok] graphify");
    // The manual fix for a check that is no longer broken must NOT be
    // printed. Matched on the check's fix LINE, not on the install command:
    // once `doctor`'s fix text stopped being that command verbatim, a
    // `not.toContain("fix: uv tool install graphifyy")` passed for a report
    // that still printed a graphify fix, which is the assertion going quiet
    // rather than the defect going away.
    expect(logged).not.toMatch(/^\s*fix:.*graphifyy/m);
    expect(code).toBe(0);
  });

  /**
   * The same run as above, against what `uv tool install graphifyy` REALLY
   * does: it installs an executable and writes nothing into this repo. The
   * postflight re-observes a `doctor` report that grades
   * `graphify-out/graph.json` — a file no install creates — so the run that
   * has just installed Graphify successfully is also the run whose report
   * still shows the `graphify` check unmet, and it must not resolve that by
   * calling the tool "not installed" or by handing back the command it just
   * ran.
   *
   * This is the shape the campaign's recurring defect takes in M5: every
   * line here is a claim about the machine, and the only one the run can
   * actually check is the `which` it now makes.
   */
  it("after a real install (which writes no graph.json), never calls Graphify uninstalled and never re-prescribes the command it just ran", async () => {
    const repo = healthyRepo();
    // No `onExec`: a real `uv tool install` leaves this repo untouched.
    const port = fakePort({ consent: true });

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    const logged = port.logLines.join("\n");
    // The success line is built from the `which` this run made, not from the
    // exit code alone.
    expect(logged).toContain("`graphify` is on PATH at /usr/bin/graphify");
    // …and nothing in the same output contradicts it.
    expect(logged).not.toContain("not installed");
    expect(logged).not.toMatch(/^\s*fix: uv tool install graphifyy\s*$/m);
    expect(code).toBe(0);
  });

  /**
   * A failed install is a failed `setup`. `graphify` is an optional check
   * that never moves `Report.status`, so `doctorExitCode` graded this repo
   * `ok` and `runSetup` returned 0 for a run that had just printed
   * "`uv tool install graphifyy` failed (exit 3)." — a green exit over a
   * machine that was not set up, in the one command whose entire job is to
   * set the machine up. T5.2 introduced exactly this rule for the
   * neighbouring case (`uv` absent -> non-zero) and left its sibling at 0.
   */
  it("exits non-zero when the install itself fails, on an otherwise healthy repo", async () => {
    const repo = healthyRepo();
    const port = fakePort({ consent: true, execCode: 3 });

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.execCalls.length).toBe(1);
    expect(port.logLines.join("\n")).toContain("failed (exit 3)");
    expect(code).not.toBe(0);
  });

  /**
   * An install that exits 0 and leaves nothing on `PATH` is a failed install
   * reported as a success — the "half-changed machine with no way to tell"
   * outcome, arrived at by trusting an exit code. The run verifies instead.
   */
  it("exits non-zero when the install exits 0 but leaves no graphify on PATH", async () => {
    const repo = healthyRepo();
    const port = fakePort({ consent: true, absent: ["graphify"] });

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    const logged = port.logLines.join("\n");
    expect(logged).toContain("exited 0 but left no `graphify` on PATH");
    expect(logged).not.toContain("succeeded");
    expect(code).not.toBe(0);
  });

  /**
   * Every check prints its OWN state, never a re-labelling. `doctor` grades
   * an optional gap (`board`) without touching `Report.status`, so a
   * postflight that stamped every non-`ok` check "degraded" announced a
   * report-level status the report does not hold — the same class of defect
   * `formatDoctor` (cli.ts) documents in its own comment: a label printed
   * next to a check is a claim about that check's grade, and the only safe
   * way to make it is to print the grade.
   */
  it("prints each check with its own state, never re-labelling an optional gap as the report status", async () => {
    const repo = healthyRepo();
    writeUsableGraph(repo);
    const port = fakePort();

    await runSetup(repo, healthyConfig(), NOW, port.io);

    const logged = port.logLines.join("\n");
    expect(logged).toContain("status: ok");
    expect(logged).toContain("[missing] board");
    expect(logged).not.toMatch(/degraded[^\n]*board/);
  });

  /**
   * A repo `doctor` grades `blocked` has no analysable history at all, so the
   * build cannot run — `harvest` throws out of `analyze`. `runSetup` returns
   * an exit code; it must not reject and hand the bin a raw `git log` stack
   * trace when `doctor` has already computed the precise diagnosis and its
   * fix. It must also not prompt or install on a repo it cannot build.
   */
  it("returns doctor's exit code and its fix on a blocked repo — never a rejected promise", async () => {
    const dir = mkdtempClean("octograph-nogit-");
    const port = fakePort({ consent: true });

    const code = await runSetup(dir, healthyConfig(), NOW, port.io);

    expect(code).toBe(1);
    expect(port.promptCalls).toEqual([]);
    expect(port.execCalls).toEqual([]);
    const logged = port.logLines.join("\n");
    expect(logged).toContain("not a git repository");
    expect(logged).toContain("fix: run inside a git repository");
    expect(existsSync(join(dir, ".octograph"))).toBe(false);
  });

  /**
   * A build that throws is reported, not propagated: `runSetup` promises an
   * exit code, and the caller that gets a rejection instead is the one that
   * has just changed the user's machine. A crash between the install and the
   * postflight is exactly the "half-changed machine with no way to tell"
   * outcome this component cannot have — the postflight is what tells.
   *
   * `.octograph` as a FILE makes `runMapCommand`'s `mkdirSync` throw without
   * touching git, so `doctor` still grades the repo healthy and the failure
   * lands squarely in the build step.
   */
  it("surfaces a build failure as a non-zero exit code and still prints the postflight", async () => {
    const repo = healthyRepo();
    writeUsableGraph(repo);
    writeFileSync(join(repo, ".octograph"), "not a directory\n");
    const port = fakePort();

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(code).not.toBe(0);
    const logged = port.logLines.join("\n");
    expect(logged).toContain("octograph:");
    // The postflight still ran — the run says what state it left behind.
    expect(logged).toContain("[ok] repository");
  });

  /**
   * `git status --porcelain --untracked-files=no` — TRACKED paths only. New
   * artifacts under the resolved out directory are new, untracked files (the
   * whole point of `setup`), so they never appear here; this is exactly "no
   * modified or added tracked file", checked without first computing where
   * the out directory landed. `git ls-files` alongside it is a second, coarser
   * check that the tracked SET itself didn't change (nothing `git add`ed,
   * nothing removed) — same fixture repos every other test in this file
   * builds, via `execFileSync("git", …)`, the same primitive `fixtures/
   * repo.ts` already uses for git plumbing outside `runSetup` itself.
   */
  function trackedFiles(root: string): string[] {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root })
      .toString()
      .split("\0")
      .filter((f) => f !== "");
  }

  function trackedStatus(root: string): string {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
    }).toString();
  }

  /** Every path `git` sees as new, one per entry (`-uall`, so a new directory
   *  is not collapsed to its name). The tracked checks above cannot see these
   *  at all, and they are the shape a stray write actually takes: a run that
   *  dropped `graphify-out/`, a log, or a lockfile at the repo root leaves
   *  every tracked file untouched and every tracked assertion green. */
  function untrackedFiles(root: string): string[] {
    return execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: root,
    })
      .toString()
      .split("\0")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3));
  }

  it("touches no tracked file outside the resolved out directory — none added, none modified", async () => {
    const repo = healthyRepo(); // no board — the resolved out dir is .octograph, untracked
    const port = fakePort({ consent: true });

    const filesBefore = trackedFiles(repo);
    const statusBefore = trackedStatus(repo);
    expect(statusBefore).toBe(""); // sanity: the fixture starts clean
    expect(untrackedFiles(repo)).toEqual([]);

    await runSetup(repo, healthyConfig(), NOW, port.io);

    // The consented (faked) install and the real build both ran — proof this
    // assertion isn't vacuously true because nothing happened.
    expect(port.execCalls.length).toBe(1);
    expect(existsSync(join(repo, ".octograph", "map.md"))).toBe(true);

    expect(trackedFiles(repo)).toEqual(filesBefore);
    expect(trackedStatus(repo)).toBe(statusBefore);

    // …and the NEW files are confined to the out directory. Without this the
    // criterion is only half-checked: the artifact `setup` is supposed to
    // write is untracked by construction, so "no tracked file changed" is
    // satisfied just as well by a run that scattered untracked files across
    // the repo — the half-changed machine this component must not leave.
    // `resolveOut` decides where the out directory is; asked here rather
    // than re-spelled, same as the build test above.
    const outRel = relative(repo, resolveOut(repo, healthyConfig()));
    const untracked = untrackedFiles(repo);
    // The artifact IS in this list — without that, "no stray untracked file"
    // would be satisfied by a list this helper failed to read at all.
    expect(untracked).toContain(`${outRel}/map.md`);
    expect(untracked.filter((f) => !f.startsWith(`${outRel}/`))).toEqual([]);
  });
});
