import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { harvest } from "./harvest.js";
import { graphifyGraphPath } from "./graphify.js";
import { declaredSpine } from "./spine.js";
import { compare } from "./rollup.js";
import type { Config } from "./config.js";

export type CheckState = "ok" | "warn" | "missing";
export type Status = "ok" | "degraded" | "blocked";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  fix?: string;
  /** Required inputs can force `degraded`; optional ones never do. */
  required: boolean;
}

export interface Report {
  status: Status;
  checks: Check[];
}

/**
 * Grade every input `analyze`/`drift` depend on and say what each
 * degradation costs and how to fix it.
 *
 * Three states, not two: "required missing" (`blocked`) and "optional
 * missing" (a `warn` check that never touches `status`) don't cover git
 * history that is PRESENT but too thin to trust — that is `degraded`, a
 * distinct state so CI can gate on it without also gating on an unrelated
 * warning.
 *
 * Two invariants every return path holds, because `--json` publishes `checks`
 * as per-input grades and a consumer keys them by `name`:
 *
 *  1. **One check per input name.** A second entry under a name a caller has
 *     already read is not extra detail, it is a contradiction — and the
 *     `checks.find(c => c.name === …)` a consumer writes silently believes the
 *     first one. `test/doctor.test.ts` asserts uniqueness across all three
 *     statuses.
 *  2. **Every non-`ok` check names a `fix`.** "What it costs and how to fix
 *     it" is the whole product; a degradation reported without a remedy is a
 *     complaint.
 */
export function doctor(repoRoot: string, config: Config): Report {
  const checks: Check[] = [];

  if (!existsSync(join(repoRoot, ".git"))) {
    checks.push({
      name: "repository",
      state: "missing",
      detail: "not a git repository — history is the only required input",
      fix: "run inside a git repository",
      required: true,
    });
    return { status: "blocked", checks };
  }

  // Harvest BEFORE recording the repository as `ok`. Pushing the `ok` check
  // first and then pushing a second `missing` one from the catch below left a
  // blocked report carrying two `repository` checks whose states contradicted
  // each other, `ok` first — so `--json`'s per-input grades reported the
  // repository as healthy on precisely the runs where it is the thing that is
  // broken. Reachable on any `git init` with no commit yet: `.git` exists,
  // `git log` exits 128.
  let analysable: number;
  let files: string[];
  try {
    const commits = harvest(repoRoot, { maxCommitFiles: config.maxCommitFiles });
    analysable = commits.length;
    // Code units through the shared comparator, never `localeCompare`.
    files = [...new Set(commits.flatMap((c) => c.files))].sort(compare);
  } catch {
    checks.push({
      name: "repository",
      state: "missing",
      detail: "git log failed — no commits?",
      fix: "make at least one commit",
      required: true,
    });
    return { status: "blocked", checks };
  }
  checks.push({ name: "repository", state: "ok", detail: repoRoot, required: true });

  const thin = analysable < config.minCommits;
  checks.push({
    name: "history depth",
    state: thin ? "warn" : "ok",
    detail: thin
      ? `${analysable} analysable commits — co-change needs ~${config.minCommits} to be meaningful (shallow clone, or a squashed migration?)`
      : `${analysable} analysable commits`,
    fix: thin ? "unshallow the clone, or accept sparse output" : undefined,
    required: true,
  });

  // Grade Graphify on what the pipeline will ACTUALLY get out of it, not on
  // whether a file exists at that path. `readGraphify` returns null for a
  // graph.json that is truncated, empty, `null`, or shaped wrong — the states
  // its own comments say a failed run leaves behind — and `declaredSpine` only
  // reports `source: "graphify"` when the file yielded cross-module import
  // edges. `existsSync` alone therefore claimed "precise import edges
  // available" for every one of those runs, which is the opposite of the truth
  // and is exactly the diagnosis this command exists to deliver.
  //
  // `spine.source` is the single spelling of "which edge source won"; doctor
  // reads it rather than re-deriving a weaker predicate of its own.
  const spine = declaredSpine(repoRoot, files);
  // Named from the path this function actually stat'd, never re-typed: the
  // message a human acts on and the file the check read cannot then disagree.
  const graphPath = graphifyGraphPath(repoRoot);
  const graphRel = relative(repoRoot, graphPath);
  const graphifyPresent = existsSync(graphPath);
  const graphifyUsable = spine.source === "graphify";
  checks.push({
    name: "graphify",
    state: graphifyUsable ? "ok" : graphifyPresent ? "warn" : "missing",
    detail: graphifyUsable
      ? `${graphRel} read — ${spine.imports.length} declared import edges, precise boundaries available`
      : graphifyPresent
        ? `${graphRel} found but yielded no cross-module import edges (truncated or empty run?) — the spine falls back to ${spine.source}`
        : 'not installed — drift can say "different modules" but not "nothing imports across them"',
    fix: graphifyUsable
      ? undefined
      : graphifyPresent
        ? `re-run graphify, or delete ${graphRel} if it is stale`
        : "uv tool install graphifyy",
    required: false,
  });

  const hasBoard = existsSync(join(repoRoot, ".octobots"));
  checks.push({
    name: "board",
    state: hasBoard ? "ok" : "missing",
    detail: hasBoard ? ".octobots/ found" : "no board — own/conflicts unavailable",
    // Every non-ok check names a fix — see the invariant on `doctor` above.
    fix: hasBoard ? undefined : "plan work onto an .octobots/ board, or ignore this",
    required: false,
  });

  const degraded = checks.some((c) => c.required && c.state !== "ok");
  return { status: degraded ? "degraded" : "ok", checks };
}

/** `ok` -> 0; `degraded` and `blocked` -> non-zero, so CI can gate on it. */
export function exitCode(report: Report): number {
  return report.status === "ok" ? 0 : 1;
}
