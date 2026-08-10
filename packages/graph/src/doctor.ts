import { existsSync } from "node:fs";
import { join } from "node:path";
import { harvest } from "./harvest.js";
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
  checks.push({ name: "repository", state: "ok", detail: repoRoot, required: true });

  let analysable = 0;
  try {
    analysable = harvest(repoRoot, { maxCommitFiles: config.maxCommitFiles }).length;
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

  const hasGraphify = existsSync(join(repoRoot, "graphify-out", "graph.json"));
  checks.push({
    name: "graphify",
    state: hasGraphify ? "ok" : "missing",
    detail: hasGraphify
      ? "graph.json found — precise import edges available"
      : 'not installed — drift can say "different modules" but not "nothing imports across them"',
    fix: hasGraphify ? undefined : "uv tool install graphifyy",
    required: false,
  });

  const hasBoard = existsSync(join(repoRoot, ".octobots"));
  checks.push({
    name: "board",
    state: hasBoard ? "ok" : "missing",
    detail: hasBoard ? ".octobots/ found" : "no board — own/conflicts unavailable",
    required: false,
  });

  const degraded = checks.some((c) => c.required && c.state !== "ok");
  return { status: degraded ? "degraded" : "ok", checks };
}

/** `ok` -> 0; `degraded` and `blocked` -> non-zero, so CI can gate on it. */
export function exitCode(report: Report): number {
  return report.status === "ok" ? 0 : 1;
}
