import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { harvest, squashShape, isIgnored } from "./harvest.js";
import { hasBoard, resolveOut } from "./artifact.js";
import { isExcludedPath } from "./noise.js";
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

  // Whether this repository squash-merges. It matters here for one specific
  // reason: it changes what advice is HONEST when history is thin.
  //
  // A squash merge collapses a whole branch into one commit, so the
  // fine-grained co-change this package mines — which files moved together
  // within a unit of work — is discarded at merge time and cannot be
  // recovered from the repository. Worse, the surviving commit is often large
  // enough that `maxCommitFiles` drops it as a mega-commit, so a squashed
  // feature branch can contribute NOTHING at all. Measured on this repo:
  // seven missions and 102 commits became one 147-file commit, dropped.
  //
  // What is NOT lost is the task-to-code link: the board records a task's
  // merge SHA, and that SHA resolves to the squashed commit perfectly, which
  // is what `own` reads. Squashing costs the discovered half of the graph,
  // not the declared half and not provenance. Do not "fix" this by
  // reconstructing branch history from the forge — that rebuilds, badly, a
  // grouping the board already records precisely, and the workflow discarded
  // those commits on purpose.
  const squash = squashShape(repoRoot, { maxCommitFiles: config.maxCommitFiles });
  const thin = historyIsThin(analysable, config);
  checks.push({
    name: "history depth",
    state: thin ? "warn" : "ok",
    detail: thin
      ? `${analysable} analysable commits — co-change needs ~${config.minCommits} to be meaningful`
      : `${analysable} analysable commits`,
    // The default advice is wrong on a squash-merged repository, and wrong in
    // the expensive direction: it sends someone to re-clone a repository whose
    // clone is already complete. Say what actually happened instead.
    fix: thin
      ? squash.dominated
        ? "nothing to unshallow — this repository squash-merges, so per-branch history was discarded at merge time; expect a sparse discovered graph and rely on the declared spine"
        : "unshallow the clone, or accept sparse output"
      : undefined,
    required: true,
  });

  if (squash.squashed > 0) {
    checks.push({
      name: "history shape",
      state: squash.dominated ? "warn" : "ok",
      detail:
        `${squash.squashed} of ${squash.total} commits look like squashed pull requests`
        + (squash.droppedSquash > 0
          ? `, and ${squash.droppedSquash} exceeded max-commit-files and were dropped entirely`
          : ""),
      // This module's contract is that every non-`ok` check names a fix,
      // because "a degradation reported without a remedy is a complaint" —
      // and `test/doctor.test.ts` enforces it. Nothing here RECOVERS the
      // discarded history, so the honest remedy is what to do given it,
      // not a repair. Saying "none available" would satisfy the letter of
      // the invariant and betray its point.
      fix: squash.dominated
        ? "read `map` as declared-structure-first: the spine and its dependency edges are unaffected, and `own` still resolves through each task's merge SHA — it is `drift` and working sets that will be sparse, so treat their absence as missing evidence rather than as evidence of absence"
        : undefined,
      // `required: false` on purpose: this is a property of how the project
      // merges, not a broken input, and grading a repository degraded forever
      // for its merge strategy is noise rather than honesty. `history depth`
      // already carries the grade.
      required: false,
    });
  }

  // Whether the artifact this run writes will survive a fresh clone.
  //
  // `clusters.json` is what cluster-id STABILITY reads: the Jaccard remap
  // compares this run's communities against the previous run's, and its whole
  // purpose is that an unchanged codebase reports unchanged ids. Read from a
  // file that is never committed, it silently degrades to "every cluster is
  // fresh" on every clone, every new machine and every CI run — a false churn
  // signal, which is exactly what the feature exists to prevent.
  //
  // This is a RECOMMENDATION and never a requirement. octograph runs inside
  // other people's repositories and does not get to dictate their .gitignore,
  // so `required: false`: it must degrade honestly and say what the choice
  // costs, not grade a project down for a policy that is theirs to set.
  //
  // Note the asymmetry worth reporting: `resolveOut` picks `.octobots/graph`
  // when a board exists so the artifact sits beside the board — but a project
  // that ignores `.octobots/` wholesale (as this one does) then ignores the
  // artifact too, while a repo with no board writes to `.octograph/` and is
  // usually fine. The feature works by default for non-board users and
  // silently does not for the users it was built for.
  const outDir = resolveOut(repoRoot, config);
  const outRel = relative(repoRoot, outDir) || outDir;
  // Probe the FILE, never the directory. A trailing-slash pattern like
  // `.octograph/` cannot match a path git has no reason to believe is a
  // directory, so asking about the directory answers "not ignored" on exactly
  // the run that matters most — the first one, before any artifact exists.
  // Asking about `<out>/clusters.json` matches in both cases, and it is also
  // the honest question: whether THAT file will be committed.
  if (isIgnored(repoRoot, join(outDir, "clusters.json"))) {
    checks.push({
      name: "artifact durability",
      state: "warn",
      detail: `${outRel} is gitignored, so clusters.json is never committed and cluster ids reset on every fresh clone and CI run`,
      fix: `commit ${outRel}/clusters.json if you want stable cluster ids across machines — or leave it ignored and read clusterIds as meaningless, but do not read "N fresh" as churn`,
      required: false,
    });
  }

  // What the graph is actually MADE OF, and a nudge toward excluding whatever
  // is not architecture.
  //
  // The onboarding problem this solves: a user should not have to discover,
  // by reading rendered output and being puzzled, that a third of their graph
  // is tooling state. Measured on octoweb before the defaults widened,
  // `.octobots/` alone was 815 of 2787 files — 29%, more than double the
  // largest real code directory.
  //
  // What this check deliberately does NOT do is decide which directories are
  // architecture. It cannot: `apps/` is 55% of this repo's own graph and that
  // is correct. So it flags only what convention makes defensible — a
  // DOT-directory carrying real weight, which is nearly always tooling or
  // configuration rather than source — and reports the rest as composition
  // for a human to judge. A check that guessed would train people to ignore
  // it, which is worse than saying nothing.
  // Count only what the configuration does NOT already handle. `harvest`
  // knows nothing about `excludePaths` — that filter lives at the reporting
  // surfaces — so counting its raw output would advise excluding a directory
  // the user has already excluded, which is the fastest way to teach someone
  // that this check is wrong and can be ignored.
  const counted = files.filter((f) => !isExcludedPath(f, config.excludePaths));
  const shares = new Map<string, number>();
  for (const f of counted) {
    const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : "(root files)";
    shares.set(top, (shares.get(top) ?? 0) + 1);
  }
  const ranked = [...shares.entries()]
    .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
    .map(([dir, n]) => ({ dir, n, pct: Math.round((100 * n) / Math.max(1, counted.length)) }));
  const composition = ranked
    .slice(0, 3)
    .map((r) => `${r.dir} ${r.pct}%`)
    .join(", ");
  // Already-excluded paths are absent from `files`, so anything a dot-entry
  // shows here is by definition NOT covered by the current configuration.
  const unexcludedTooling = ranked.filter((r) => r.dir.startsWith(".") && r.pct >= 5);
  checks.push({
    name: "graph composition",
    state: unexcludedTooling.length > 0 ? "warn" : "ok",
    detail:
      `${counted.length} files after exclusions; largest contributors ${composition}`
      + (unexcludedTooling.length > 0
        ? ` — ${unexcludedTooling.map((r) => `${r.dir} (${r.pct}%)`).join(", ")} look like tooling rather than architecture`
        : ""),
    fix:
      unexcludedTooling.length > 0
        ? `if those are not part of your architecture, add them to octograph.yaml:\n    excludePaths:\n`
          + unexcludedTooling.map((r) => `      - ${r.dir}/`).join("\n")
          + `\n  octograph does not decide this for you — a directory can legitimately dominate a graph.`
        : undefined,
    // Advisory. A repository's layout is not a broken input, and grading it
    // down for one would be the same overreach as excluding docs by default.
    required: false,
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
