import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { CONFIDENCE_FLOOR, RUNNER_UP_MARGIN, type LexicalOptions } from "./lexical.js";
import { insideRepo } from "./paths.js";

export interface Config {
  maxCommitFiles: number;
  halfLifeDays: number;
  minSupport: number;
  minCommits: number;
  hubZThreshold: number;
  budgetTokens: number;
  out: string | null;
  /** {@link CONFIDENCE_FLOOR} — settable per repo because a naming
   *  convention this floor was calibrated against (this repo's own commit
   *  history, 8 provenance-attributed samples) need not hold everywhere. */
  lexicalConfidenceFloor: number;
  /** {@link RUNNER_UP_MARGIN} — same caveat as the floor above. */
  lexicalRunnerUpMargin: number;
  /**
   * Repo-relative path prefixes {@link isExcludedPath} (noise.ts) matches
   * against, applied by `harvest` at the graph's input — so an excluded path
   * is absent from modules, clustering, hubs, working sets, `impact` and
   * `drift` alike. See `drift.ts`'s doc comment for the measurement that
   * moved this from one surface to all of them.
   */
  excludePaths: string[];
}

export const DEFAULTS: Config = {
  maxCommitFiles: 50,
  halfLifeDays: 180,
  minSupport: 2,
  minCommits: 200,
  hubZThreshold: 3,
  budgetTokens: 2000,
  out: null,
  // Values live in lexical.ts, next to the calibration comment that justifies
  // them — a single spelling of each pinned number, read here rather than
  // re-typed.
  lexicalConfidenceFloor: CONFIDENCE_FLOOR,
  lexicalRunnerUpMargin: RUNNER_UP_MARGIN,
  // This tool's own working state, never the codebase under analysis — see
  // `isExcludedPath`'s doc comment (noise.ts) for the octoweb measurement
  // that justifies the default and `drift.ts` for why only `drift()` reads it.
  excludePaths: [
    // MOST OF THIS LIST IS INSURANCE, NOT ROUTINE.
    //
    // `harvest` reads `git log`, so only TRACKED files can enter the graph at
    // all: an ordinary `node_modules`, `.venv` or `target/` is gitignored and
    // excluded by the nature of the input, not by anything here. Measured on
    // two real repos, none of them appeared even once.
    //
    // They are listed anyway because a project that COMMITS them — a vendored
    // dependency tree, a checked-in virtualenv, build output kept for a
    // deploy — would otherwise have its graph flooded by someone else's code,
    // and would have to discover that by reading confusing output and then
    // enumerating directories by hand. Onboarding should not cost that.
    //
    // Applied at the graph's INPUT (`harvest`), so modules, clustering, hubs,
    // working sets, `impact` and `drift` all see one graph with one meaning.
    // A wrong entry therefore removes a path from the analysis entirely — one
    // line of `octograph.yaml` to undo, but not a cosmetic mistake.
    //
    // This lived in `drift` alone until 2026-08-12, so `impact` could still
    // surface an agent's notes co-changing with the code they document.
    // Measurement retired that: on a repo where the board was 43% of files,
    // including it doubled the file edges, took hub quarantine from 5 files to
    // 39, and mis-ranked 4 of the top 5 real module edges.

    // This tool's own working state and the board it edits. Measured at 32% of
    // octoweb's graph, burying every real cross-module finding beneath it.
    ".agents/",
    ".claude/",
    ".octobots/",

    // CI, editor and tool configuration: co-changes with whatever it
    // configures, which is nearly everything, and is not architecture.
    ".github/",
    ".vscode/",
    ".idea/",

    // Dependencies a project chose to commit — someone else's architecture.
    "node_modules/",
    "vendor/",
    "third_party/",

    // Python environments and caches.
    ".venv/",
    "venv/",
    "__pycache__/",
    ".tox/",
    ".mypy_cache/",
    ".pytest_cache/",

    // JVM / Rust / general build output kept in tree.
    "target/",
    ".gradle/",
    "dist/",
    "build/",
    "out/",
    "coverage/",

    // Framework build caches.
    ".next/",
    ".nuxt/",
    ".cache/",
  ],
};

const NUMERIC = [
  "maxCommitFiles", "halfLifeDays", "minSupport",
  "minCommits", "hubZThreshold", "budgetTokens",
  "lexicalConfidenceFloor", "lexicalRunnerUpMargin",
] as const;

/** Defaults <- octograph.yaml <- explicit overrides. */
export function loadConfig(repoRoot: string, overrides: Partial<Config> = {}): Config {
  const cfg: Config = { ...DEFAULTS };
  const path = join(repoRoot, "octograph.yaml");

  if (existsSync(path)) {
    try {
      const doc: unknown = loadYaml(readFileSync(path, "utf8"));
      // Same shape-guard idiom as spine.ts's pnpmPackageGlobs: a bare scalar
      // or sequence top level, or an empty file (`load()` returns `undefined`
      // for one, not `{}`), is "no overrides" rather than a crash on
      // `parsed[key]` against a non-object.
      if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
        const parsed = doc as Record<string, unknown>;
        for (const key of NUMERIC) {
          const v = parsed[key];
          if (typeof v === "number" && Number.isFinite(v)) cfg[key] = v;
        }
        // `out` is repo content too — read out of octograph.yaml, same as
        // every other key here — and is not exempt from the containment rule
        // `readGraphify` already enforces on a declared node path (via
        // `insideRepo`/`repoRelative` in paths.ts). M2 never consumes
        // `Config.out`, but a future writer will, so `out: '../../..'` must
        // not be accepted verbatim now, before there is a write to guard.
        // Reuse the SAME `insideRepo` helper rather than open-coding a third
        // containment check — a second, independently-written one is exactly
        // how the edge-weight defect (see `edgeWeight` in weights.ts)
        // happened.  An escaping path degrades to the default, exactly like
        // every NUMERIC key above: skip the assignment rather than throw.
        if (typeof parsed.out === "string" && insideRepo(repoRoot, parsed.out) !== null) {
          cfg.out = parsed.out;
        }
        // `excludePaths` is the first LIST-valued key this file validates —
        // same spirit as every scalar key above, extended to an array: the
        // whole value is accepted only when every element is the right type,
        // and a wrong-shaped value (a bare string, a list with a number in
        // it, `null`) degrades to the default rather than throwing or letting
        // a malformed entry silently do nothing later at the point it's
        // matched. A caller that wants "no exclusions" writes `excludePaths:
        // []` explicitly — an empty array is a valid, meaningful value here,
        // not a falsy one to reject.
        if (
          Array.isArray(parsed.excludePaths)
          && parsed.excludePaths.every((v): v is string => typeof v === "string")
        ) {
          cfg.excludePaths = parsed.excludePaths;
        }
      }
    } catch {
      /* malformed config: fall back to defaults rather than failing the run */
    }
  }

  // Key by key rather than `{ ...cfg, ...overrides }`. A spread copies an
  // EXPLICIT `undefined` over a good default, and `Partial<Config>` is exactly
  // the shape a caller assembling flags builds — `{ budgetTokens: argv.budget }`
  // is `{ budgetTokens: undefined }` when the flag is absent, not `{}`. That
  // lands `undefined` in `Config.budgetTokens`, and `estimateTokens(out) >
  // undefined` is false for every map, so the token budget silently stops
  // applying. "Not provided" must mean the default, at this seam as everywhere
  // else in this function.
  // Iterated over the DEFAULTS key set, not over the override object's own
  // keys, so an unrecognised key cannot smuggle a field into `Config` — and so
  // a key added to `Config` later is covered here without a second edit.
  for (const key of Object.keys(DEFAULTS) as Array<keyof Config>) {
    const value = overrides[key];
    if (value !== undefined) Object.assign(cfg, { [key]: value });
  }
  return cfg;
}

/**
 * The `Config` half of this file's lexical settings, in the shape
 * `predictFiles` takes — the ONE place `lexicalConfidenceFloor` /
 * `lexicalRunnerUpMargin` are translated into `LexicalOptions`.
 *
 * It exists because both consumers of the lexical tier (`own` and
 * `conflicts`, via `cli.ts`) need the same translation, and the first version
 * of each did the same thing instead: nothing. `predictFiles` was called with
 * no options at all, so both keys were parsed, range-checked, documented in
 * `lexical.ts` as "settable per repo from `octograph.yaml`" — and had no
 * effect whatsoever on any answer the CLI produced. A setting a user writes
 * and the tool silently ignores is the defect `parseArgs` was rewritten to
 * make impossible for flags (`--half-life-days`, see cli.ts); this is the
 * same defect one layer down.
 *
 * Exported from `index.ts` for the same reason: any consumer calling
 * `own`/`conflicts` as a library needs this mapping, and the alternative to
 * handing it one is that it writes a second one.
 *
 * Not, as an earlier version of this comment said, because "M6's VS Code
 * commands" call them in-process — M6 spawns the binary and adds no runtime
 * dependency on this package. Corrected 2026-08-11; see `index.ts` above
 * `runCli`.
 */
export function lexicalOptions(config: Config): LexicalOptions {
  return {
    confidenceFloor: config.lexicalConfidenceFloor,
    runnerUpMargin: config.lexicalRunnerUpMargin,
  };
}

/**
 * The one rule for "this history is too thin for clustering to mean
 * anything". `doctor` grades a repo `degraded` on it (its "history depth"
 * check) and `analyze` suppresses `workingSets` on it. Two spellings of the
 * RULE would let map.md publish invented community structure on a repo doctor
 * is calling untrustworthy in the same breath, which is why it lives here and
 * nowhere else; `test/conventions.test.ts` enforces that.
 *
 * The two callers deliberately feed it DIFFERENT counts, and the asymmetry is
 * load-bearing rather than an oversight: `doctor` grades the *repository*, so
 * it passes the full harvest, while `analyze` guards a partition it computed
 * from the `--since` window alone, so it passes that window's commit count.
 * A window is a subset of full history, so the implication runs one way:
 *
 *     doctor(repo, cfg).status === "degraded"
 *        =>  analyze(repo, cfg, …).analysis.workingSets is []
 *
 * which is the direction M7's criterion 3 ("absent whenever doctor says
 * degraded") is written in. The CONVERSE does not hold and must not be
 * claimed: `octograph map --since <recent>` legitimately suppresses on a repo
 * `octograph doctor` grades `ok`, because the clustering being suppressed was
 * computed from exactly those windowed commits and from nothing else.
 * `test/analyze.test.ts` pins both the implication and its non-converse.
 */
export function historyIsThin(analysableCommits: number, config: Config): boolean {
  return analysableCommits < config.minCommits;
}
