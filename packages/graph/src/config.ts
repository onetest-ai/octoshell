import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { CONFIDENCE_FLOOR, RUNNER_UP_MARGIN } from "./lexical.js";
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
