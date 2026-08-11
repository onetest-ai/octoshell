import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { harvest } from "./harvest.js";
import { hasBoard } from "./artifact.js";
import { graphifyGraphPath } from "./graphify.js";
import { declaredSpine } from "./spine.js";
import { compare } from "./rollup.js";
import { historyIsThin, type Config } from "./config.js";

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

  const thin = historyIsThin(analysable, config);
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
        : // What this function ACTUALLY observed is the absence of a file, and
          // it used to report that as "not installed" — a claim about the
          // machine that nothing here checks. The two differ on the ordinary
          // case of a developer who has Graphify installed and has never run
          // it in this repo, and they contradicted each other out loud in
          // `runSetup`, which printed "`uv tool install graphifyy`
          // succeeded." and then, four lines down, "not installed — fix: uv
          // tool install graphifyy". Installing the tool cannot produce this
          // file; only running it can, which is why the fix below leads with
          // that.
          `${graphRel} not found — no Graphify output in this repo, so drift can say "different modules" but not "nothing imports across them"`,
    fix: graphifyUsable
      ? undefined
      : graphifyPresent
        ? `re-run graphify, or delete ${graphRel} if it is stale`
        : `run Graphify in this repo to produce ${graphRel} — install it with \`uv tool install graphifyy\` if you have not`,
    required: false,
  });

  // Through `hasBoard` (artifact.ts), never a second `existsSync` of the same
  // directory: `resolveOut` decides where the artifact is WRITTEN on exactly
  // this predicate, so a doctor that spells it independently is free to report
  // "board found" for a run that then writes into `.octograph/`. Same
  // one-producer-two-readers rule as `graphifyGraphPath` above, enforced by
  // `test/conventions.test.ts`.
  const board = hasBoard(repoRoot);
  checks.push({
    name: "board",
    state: board ? "ok" : "missing",
    detail: board ? ".octobots/ found" : "no board — own/conflicts unavailable",
    // Every non-ok check names a fix — see the invariant on `doctor` above.
    fix: board ? undefined : "plan work onto an .octobots/ board, or ignore this",
    required: false,
  });

  // Exactly two checks are `required: true` today — "repository" (always `ok`
  // on any branch that reaches this line; the two `blocked` returns above are
  // the only way it is not) and "history depth" (graded by `historyIsThin`,
  // config.ts). That is WHY `degraded <=> historyIsThin(analysable, config)`
  // holds — it is not a property this function states, it is a coincidence of
  // there being only one required check that can actually fail. Promoting
  // "graphify" or "board" to `required: true` breaks that equivalence: a repo
  // could then grade `degraded` for a reason `historyIsThin` has never heard
  // of, and M7's criterion 3 ("workingSets absent whenever doctor says
  // degraded") would start failing silently. Revisit `analyze()`'s
  // suppression call in the same change that adds a third required check.
  //
  // Note the equivalence is over THIS function's `analysable` — the full
  // harvest, since `doctor` grades the repository and takes no `--since`.
  // `analyze` applies the same rule to its own (possibly narrower) window, so
  // criterion 3's implication holds while its converse does not; that is
  // stated once, on `historyIsThin`.
  const degraded = checks.some((c) => c.required && c.state !== "ok");
  return { status: degraded ? "degraded" : "ok", checks };
}

/** `ok` -> 0; `degraded` and `blocked` -> non-zero, so CI can gate on it. */
export function exitCode(report: Report): number {
  return report.status === "ok" ? 0 : 1;
}
