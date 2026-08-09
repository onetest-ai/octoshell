import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Defaults <- octograph.json <- explicit overrides. */
export function loadConfig(repoRoot: string, overrides: Partial<Config> = {}): Config {
  const cfg: Config = { ...DEFAULTS };
  const path = join(repoRoot, "octograph.json");

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const key of NUMERIC) {
        const v = parsed[key];
        if (typeof v === "number" && Number.isFinite(v)) cfg[key] = v;
      }
      if (typeof parsed.out === "string") cfg.out = parsed.out;
    } catch {
      /* malformed config: fall back to defaults rather than failing the run */
    }
  }

  return { ...cfg, ...overrides };
}
