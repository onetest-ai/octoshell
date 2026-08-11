import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, type Config } from "../src/config.js";
import { runSetup, type SetupIO } from "../src/setup.js";
import { buildRepo } from "./fixtures/repo.js";

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
 *  fake `exec()` reports back. */
function fakePort(opts: { consent?: boolean; execCode?: number } = {}): FakePort {
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
});
