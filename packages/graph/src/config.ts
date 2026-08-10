import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { insideRepo } from "./paths.js";

export interface Config {
  maxCommitFiles: number;
  halfLifeDays: number;
  minSupport: number;
  minCommits: number;
  hubZThreshold: number;
  budgetTokens: number;
  out: string | null;
}

export const DEFAULTS: Config = {
  maxCommitFiles: 50,
  halfLifeDays: 180,
  minSupport: 2,
  minCommits: 200,
  hubZThreshold: 3,
  budgetTokens: 2000,
  out: null,
};

const NUMERIC = [
  "maxCommitFiles", "halfLifeDays", "minSupport",
  "minCommits", "hubZThreshold", "budgetTokens",
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
 * check) and `analyze` suppresses `workingSets` on it — two surfaces that
 * MUST agree, because mission criterion 3 (M7) is written as "absent
 * whenever doctor says degraded". Two spellings of this would let map.md
 * publish invented community structure on a repo doctor is calling
 * untrustworthy in the same breath. `test/conventions.test.ts` enforces this
 * is the only place a commit count is compared against `minCommits`.
 */
export function historyIsThin(analysableCommits: number, config: Config): boolean {
  return analysableCommits < config.minCommits;
}
