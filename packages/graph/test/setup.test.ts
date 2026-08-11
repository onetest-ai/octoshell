import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 *  said before the mutation. */
function fakePort(
  opts: { consent?: boolean; execCode?: number; onExec?: () => void } = {},
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
    which: async (file) => `/usr/bin/${file}`,
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
   */
  it("reports the state observed AFTER the install, never the one doctor saw before it", async () => {
    const repo = healthyRepo(); // graphify missing at the point doctor first runs
    const port = fakePort({ consent: true, onExec: () => writeUsableGraph(repo) });

    const code = await runSetup(repo, healthyConfig(), NOW, port.io);

    expect(port.execCalls).toEqual([{ file: "uv", args: ["tool", "install", "graphifyy"] }]);
    const logged = port.logLines.join("\n");
    // Graded on the graph.json the install produced, not on its absence.
    expect(logged).toContain("[ok] graphify");
    // The manual fix for a check that is no longer broken must NOT be printed.
    expect(logged).not.toContain("fix: uv tool install graphifyy");
    expect(code).toBe(0);
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
});
