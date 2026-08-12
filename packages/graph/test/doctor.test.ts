import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOut } from "../src/artifact.js";
import { DEFAULTS } from "../src/config.js";
import { doctor, exitCode, type Report } from "../src/doctor.js";
import { buildRepo } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/** A repo whose history clears any bar these tests set. */
function healthyRepo(): string {
  return buildRepo(Array.from({ length: 12 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })));
}

/** `git init` with no commit yet: `.git` exists, `git log` exits 128. */
function emptyRepo(): string {
  const root = mkdtempClean("octograph-empty-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "pipe" });
  return root;
}

function writeGraph(root: string, body: string): void {
  mkdirSync(join(root, "graphify-out"), { recursive: true });
  writeFileSync(join(root, "graphify-out", "graph.json"), body);
}

const check = (report: Report, name: string) => report.checks.find((c) => c.name === name);

describe("doctor", () => {
  it("reports blocked and exits non-zero outside a git repo", () => {
    const report = doctor(mkdtempClean("octograph-nogit-"), DEFAULTS);
    expect(report.status).toBe("blocked");
    expect(exitCode(report)).not.toBe(0);
  });

  it("reports degraded when history is below minCommits", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["c.ts", "d.ts"] }]);
    const report = doctor(repo, { ...DEFAULTS, minCommits: 200 });
    expect(report.status).toBe("degraded");
    expect(exitCode(report)).not.toBe(0);
  });

  it("names the cause and a fix for every non-ok check", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const report = doctor(repo, { ...DEFAULTS, minCommits: 200 });
    const history = check(report, "history depth");
    expect(history?.state).toBe("warn");
    expect(history?.detail).toContain("commits");

    // What this test's NAME claims, actually asserted. It used to check the
    // one field of the one check it names, while the `board` check shipped
    // `missing` with no `fix` at all — a degradation reported with no remedy,
    // in the command whose entire product is the remedy.
    for (const c of report.checks.filter((c) => c.state !== "ok")) {
      expect(c.detail.length, `${c.name} detail`).toBeGreaterThan(0);
      expect(c.fix ?? "", `${c.name} fix`).not.toBe("");
    }
  });

  it("reports ok and exits 0 when history clears the bar", () => {
    const report = doctor(healthyRepo(), { ...DEFAULTS, minCommits: 10 });
    expect(report.status).toBe("ok");
    expect(exitCode(report)).toBe(0);
  });

  it("treats a missing graphify as a warning, never as degraded", () => {
    const report = doctor(healthyRepo(), { ...DEFAULTS, minCommits: 10 });
    expect(check(report, "graphify")?.state).toBe("missing");
    expect(report.status).toBe("ok");
  });

  /**
   * Regression: a repo with `.git` but no commit at all produced TWO checks
   * named `repository` — the `ok` one pushed before `harvest`, then the
   * `missing` one pushed from the catch — and `ok` came first. Every consumer
   * of `--json`'s per-input grades keys by name and so read "repository: ok"
   * on the one status where the repository IS the blocker.
   */
  it("blames the repository exactly once when git log fails on an empty repo", () => {
    const report = doctor(emptyRepo(), DEFAULTS);
    expect(report.status).toBe("blocked");
    expect(exitCode(report)).not.toBe(0);

    const repoChecks = report.checks.filter((c) => c.name === "repository");
    expect(repoChecks).toHaveLength(1);
    expect(check(report, "repository")?.state).toBe("missing");
    expect(check(report, "repository")?.fix ?? "").not.toBe("");
  });

  /** AC4's contract: `--json` publishes per-INPUT grades, so a name is a key. */
  it("grades each input exactly once in every status", () => {
    const reports: Array<[string, Report]> = [
      ["blocked (no .git)", doctor(mkdtempClean("octograph-nogit-"), DEFAULTS)],
      ["blocked (no commits)", doctor(emptyRepo(), DEFAULTS)],
      ["degraded", doctor(buildRepo([{ files: ["a.ts", "b.ts"] }]), DEFAULTS)],
      ["ok", doctor(healthyRepo(), { ...DEFAULTS, minCommits: 10 })],
    ];
    for (const [label, report] of reports) {
      const names = report.checks.map((c) => c.name);
      expect(new Set(names).size, `${label}: duplicate check name in ${names.join(", ")}`).toBe(
        names.length,
      );
    }
  });

  it("survives a JSON round-trip with a status field and per-input grades", () => {
    const report = doctor(healthyRepo(), { ...DEFAULTS, minCommits: 10 });
    const parsed = JSON.parse(JSON.stringify(report)) as Report;
    expect(parsed.status).toBe("ok");
    expect(parsed.checks.length).toBeGreaterThan(0);
    for (const c of parsed.checks) {
      expect(typeof c.name).toBe("string");
      expect(["ok", "warn", "missing"]).toContain(c.state);
      expect(typeof c.required).toBe("boolean");
    }
  });

  /**
   * Regression: the graphify grade was `existsSync(graph.json)`, while the
   * pipeline's actual predicate is `spine.source === "graphify"` — which
   * `readGraphify` fails for a truncated, empty, bare-`null` or wrong-shaped
   * document, the exact states graphify.ts documents a failed run as leaving
   * behind. doctor therefore reported "precise import edges available" for
   * every broken Graphify run: a claim its own producer contradicts, in the
   * command whose job is to explain why the output is thin.
   */
  it.each([
    ["truncated", "{not json"],
    ["a bare null", "null"],
    ["an empty document", "{}"],
    ["nodes with no import edges", '{"nodes":[{"id":"1","file":"a/x.ts"}],"edges":[]}'],
  ])("does not claim precise import edges when graph.json is %s", (_label, body) => {
    const repo = healthyRepo();
    writeGraph(repo, body);
    const report = doctor(repo, { ...DEFAULTS, minCommits: 10 });
    const graphify = check(report, "graphify");
    expect(graphify?.state).toBe("warn");
    expect(graphify?.detail).not.toContain("precise");
    expect(graphify?.fix ?? "").not.toBe("");
    // Optional input: it warns, it never grades the run down.
    expect(report.status).toBe("ok");
    expect(exitCode(report)).toBe(0);
  });

  it("reports graphify ok, with an edge count it actually read, when the run is usable", () => {
    const repo = healthyRepo();
    writeGraph(
      repo,
      JSON.stringify({
        nodes: [
          { id: "1", file: "pkg/a/x.ts" },
          { id: "2", file: "pkg/b/y.ts" },
        ],
        edges: [{ source: "1", target: "2", type: "imports" }],
      }),
    );
    const report = doctor(repo, { ...DEFAULTS, minCommits: 10 });
    const graphify = check(report, "graphify");
    expect(graphify?.state).toBe("ok");
    expect(graphify?.detail).toContain("1 declared import edges");
    expect(graphify?.fix).toBeUndefined();
    expect(report.status).toBe("ok");
  });

  /**
   * doctor's "board" check and `resolveOut`'s choice of output directory are
   * the same question asked twice — and M3 shipped them as two independent
   * `existsSync(join(repoRoot, ".octobots"))` calls, written in two different
   * task PRs. Nothing behavioural could tell them apart while they agreed, and
   * the day they stopped agreeing doctor would report "board found" for a run
   * that writes into `.octograph/` (or the reverse) with no error anywhere.
   *
   * `test/conventions.test.ts` enforces the single spelling structurally; this
   * asserts the property that spelling exists to protect, in both directions,
   * so the pair cannot be re-split by a refactor that keeps one literal.
   */
  it.each([true, false])("agrees with resolveOut about whether a board exists (board: %s)", (withBoard) => {
    const repo = healthyRepo();
    if (withBoard) mkdirSync(join(repo, ".octobots"), { recursive: true });

    const config = { ...DEFAULTS, minCommits: 10 };
    const board = check(doctor(repo, config), "board");
    const out = resolveOut(repo, config);

    expect(board?.state).toBe(withBoard ? "ok" : "missing");
    expect(out).toBe(withBoard ? join(repo, ".octobots", "graph") : join(repo, ".octograph"));
    // Stated as one biconditional, not two independent expectations: the
    // defect is the two answers DIVERGING, whichever way.
    expect(board?.state === "ok").toBe(out === join(repo, ".octobots", "graph"));
  });
});

describe("doctor — squashed history", () => {
  /**
   * These exist because `doctor` gave ADVICE THAT WAS WRONG on a
   * squash-merged repository: it told the reader to unshallow a clone that
   * was already complete. The clone is not the problem — the history was
   * discarded at merge time and cannot be recovered from the repository.
   *
   * Measured on this repo when the defect was found: a seven-mission campaign
   * of 102 commits landed as one 147-file commit, which `maxCommitFiles` then
   * dropped, so the entire campaign contributed nothing to the co-change
   * graph while `doctor` blamed the clone depth.
   */
  it("reports the shape when most commits are squashed pull requests", () => {
    const repo = buildRepo([
      { files: ["a.ts", "b.ts"], message: "feat: one (#1)" },
      { files: ["c.ts", "d.ts"], message: "feat: two (#2)" },
      { files: ["e.ts", "f.ts"], message: "fix: three (#3)" },
      { files: ["g.ts", "h.ts"], message: "ordinary commit" },
    ]);
    const shape = check(doctor(repo, { ...DEFAULTS, minCommits: 200 }), "history shape");
    expect(shape?.state).toBe("warn");
    expect(shape?.detail).toContain("3 of 4");
    expect(shape?.fix ?? "").not.toBe("");
  });

  it("corrects the unshallow advice, which is wrong on a squashed repo", () => {
    const squashed = buildRepo([
      { files: ["a.ts", "b.ts"], message: "feat: one (#1)" },
      { files: ["c.ts", "d.ts"], message: "feat: two (#2)" },
      { files: ["e.ts", "f.ts"], message: "fix: three (#3)" },
    ]);
    const depth = check(doctor(squashed, { ...DEFAULTS, minCommits: 200 }), "history depth");
    expect(depth?.state).toBe("warn");
    expect(depth?.fix).not.toContain("unshallow the clone");
    expect(depth?.fix).toContain("squash");

    // And the generic advice survives where it IS right.
    const plain = buildRepo([
      { files: ["a.ts", "b.ts"] },
      { files: ["c.ts", "d.ts"] },
    ]);
    expect(check(doctor(plain, { ...DEFAULTS, minCommits: 200 }), "history depth")?.fix)
      .toContain("unshallow");
  });

  it("says nothing at all on a repository that does not squash", () => {
    const repo = buildRepo([
      { files: ["a.ts", "b.ts"] },
      { files: ["c.ts", "d.ts"] },
    ]);
    // Absent, not `ok` — a check that is always present and always green
    // trains a reader to skip it, and there is nothing to report here.
    expect(check(doctor(repo, { ...DEFAULTS, minCommits: 200 }), "history shape")).toBeUndefined();
  });

  it("counts a squashed PR the mega-commit filter dropped entirely", () => {
    // The compounding failure: squashing collapses the branch, and then the
    // surviving commit is too big to survive `maxCommitFiles`, so it
    // contributes NOTHING rather than merely contributing coarse signal.
    const wide = Array.from({ length: 12 }, (_, i) => `wide/f${i}.ts`);
    const repo = buildRepo([
      { files: wide, message: "feat: a whole campaign (#99)" },
      { files: ["a.ts", "b.ts"], message: "feat: small (#100)" },
    ]);
    const shape = check(doctor(repo, { ...DEFAULTS, minCommits: 200, maxCommitFiles: 5 }), "history shape");
    expect(shape?.detail).toContain("1 exceeded max-commit-files");
  });
});
