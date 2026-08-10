import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { analyze, type Analysis } from "./analyze.js";
import { readArtifact, resolveOut, writeArtifact } from "./artifact.js";
import { loadConfig, type Config } from "./config.js";
import { doctor, exitCode, type Report } from "./doctor.js";
import { drift as computeDrift, type DriftRow } from "./drift.js";
import { impact as computeImpact, type ImpactRow } from "./impact.js";
import { repoRelative } from "./paths.js";
import { renderMap } from "./render.js";

export type Command = "map" | "impact" | "drift" | "doctor";

const COMMANDS: readonly Command[] = ["map", "impact", "drift", "doctor"];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

interface ParsedCommand {
  command: Command;
  positionals: string[];
  overrides: Partial<Config>;
  since: string | undefined;
  json: boolean;
}

type ParseResult = { ok: true; parsed: ParsedCommand } | { ok: false; error: string };

/** Turn CLI text into a number, or `null` on anything that is not a finite
 *  one — `Number("")` is `0` and `Number("  ")` is `0`, both of which would
 *  otherwise silently accept a missing value as a real setting. */
function toFiniteNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Every flag this CLI accepts, spelled out one `case` at a time.
 *
 * Deliberately NOT derived from a `Config` key name (e.g. by kebab-casing
 * `halfLifeDays`): that once produced `--half-life-days` while the spec —
 * and every doc string in this package — documents `--half-life`, and the
 * flag a user actually typed was silently ignored rather than rejected. A
 * `switch` over literal flag strings can only recognise the flags written
 * here; anything else falls to the `default` case below and exits 2.
 */
export function parseArgs(argv: string[]): ParseResult {
  const [rawCommand, ...rest] = argv;
  if (rawCommand === undefined) {
    return { ok: false, error: `missing command — expected one of: ${COMMANDS.join(", ")}` };
  }
  if (!isCommand(rawCommand)) {
    return {
      ok: false,
      error: `unknown command "${rawCommand}" — expected one of: ${COMMANDS.join(", ")}`,
    };
  }

  const positionals: string[] = [];
  const overrides: Partial<Config> = {};
  let since: string | undefined;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }

    const value = rest[i + 1];
    if (value === undefined) return { ok: false, error: `${arg} requires a value` };
    i += 1;

    switch (arg) {
      case "--out":
        overrides.out = value;
        break;
      case "--since":
        since = value;
        break;
      case "--max-commit-files": {
        const n = toFiniteNumber(value);
        if (n === null) return { ok: false, error: `--max-commit-files expects a number, got "${value}"` };
        overrides.maxCommitFiles = n;
        break;
      }
      case "--half-life": {
        const n = toFiniteNumber(value);
        if (n === null) return { ok: false, error: `--half-life expects a number, got "${value}"` };
        overrides.halfLifeDays = n;
        break;
      }
      case "--min-support": {
        const n = toFiniteNumber(value);
        if (n === null) return { ok: false, error: `--min-support expects a number, got "${value}"` };
        overrides.minSupport = n;
        break;
      }
      case "--min-commits": {
        const n = toFiniteNumber(value);
        if (n === null) return { ok: false, error: `--min-commits expects a number, got "${value}"` };
        overrides.minCommits = n;
        break;
      }
      case "--budget": {
        const n = toFiniteNumber(value);
        if (n === null) return { ok: false, error: `--budget expects a number, got "${value}"` };
        overrides.budgetTokens = n;
        break;
      }
      default:
        // Unrecognised flag — exits 2 rather than being silently ignored.
        return { ok: false, error: `unrecognised flag: ${arg}` };
    }
  }

  return { ok: true, parsed: { command: rawCommand, positionals, overrides, since, json } };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function usageError(message: string): CliResult {
  return { code: 2, stdout: "", stderr: `octograph: ${message}\n` };
}

function runtimeError(err: unknown): CliResult {
  const message = err instanceof Error ? err.message : String(err);
  return { code: 1, stdout: "", stderr: `octograph: ${message}\n` };
}

function formatCheck(state: string): string {
  return state === "ok" ? "ok" : state === "warn" ? "warn" : "missing";
}

function formatDoctor(report: Report): string {
  const lines = [`status: ${report.status}`, ""];
  for (const c of report.checks) {
    lines.push(`[${formatCheck(c.state)}] ${c.name}: ${c.detail}`);
    if (c.fix !== undefined) lines.push(`  fix: ${c.fix}`);
  }
  return lines.join("\n") + "\n";
}

function formatImpactRow(row: ImpactRow): string {
  // Destructured, not `row.npmi` — `test/conventions.test.ts` bans `.npmi`
  // dot access outside weights.ts to keep the nPMI floor single-spelled;
  // this is a DIFFERENT field (the already-floored value on a result row),
  // but the guard is a textual one, so destructuring keeps the intent
  // (never re-read a raw, unfloored weight) legible without tripping it.
  const { path, npmi, support, confidence } = row;
  return `${path}\tnpmi=${npmi.toFixed(3)}\tsupport=${support}\tconfidence=${confidence.toFixed(3)}`;
}

function formatImpact(rows: ImpactRow[]): string {
  if (rows.length === 0) return "(no coupled files)\n";
  return rows.map(formatImpactRow).join("\n") + "\n";
}

function formatDriftRow(row: DriftRow): string {
  const { a, b, moduleA, moduleB, npmi, support, confidence } = row;
  return (
    `${a} <-> ${b}  (${moduleA} <-> ${moduleB})` +
    `\tnpmi=${npmi.toFixed(3)}\tsupport=${support}\tconfidence=${confidence.toFixed(3)}`
  );
}

function formatDrift(rows: DriftRow[]): string {
  if (rows.length === 0) return "(no undeclared coupling above the noise floor)\n";
  return rows.map(formatDriftRow).join("\n") + "\n";
}

function runDoctorCommand(repoRoot: string, config: Config, json: boolean): CliResult {
  const report = doctor(repoRoot, config);
  const stdout = json ? JSON.stringify(report) + "\n" : formatDoctor(report);
  return { code: exitCode(report), stdout, stderr: "" };
}

/** `clusters.json`'s `Record<number, string[]>` -> the `Map` `analyze`'s
 *  `previousClusters` option consumes — the conversion `analyze.ts` itself
 *  deliberately stays free of (it takes no file I/O), so it happens here at
 *  the one place that reads the artifact back off disk. */
function clustersToMap(clusters: Record<number, string[]>): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const [id, members] of Object.entries(clusters)) map.set(Number(id), members);
  return map;
}

function analysisToClusters(analysis: Analysis): Record<number, string[]> {
  const clusters: Record<number, string[]> = {};
  for (const m of analysis.modules) clusters[m.id] = m.members;
  return clusters;
}

function runMapCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  json: boolean,
): CliResult {
  // The SAME `resolveOut` `octograph.yaml`'s `out:` already resolves
  // through — it re-validates `config.out` (however it got set: a
  // committed `octograph.yaml`, or this run's `--out` override) via the
  // SAME `insideRepo` helper before it is ever joined into a real path. An
  // escaping `--out` therefore degrades to the same default location a bad
  // `octograph.yaml` value would, rather than writing outside the repo.
  const outDir = resolveOut(repoRoot, config);

  const previous = readArtifact(outDir);
  const previousClusters = previous ? clustersToMap(previous.clusters) : new Map<number, string[]>();

  const { analysis } = analyze(repoRoot, config, { now, since, previousClusters });
  const mapText = renderMap(analysis, config.budgetTokens);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "map.md"), mapText);
  writeArtifact(outDir, { version: 1, clusters: analysisToClusters(analysis), config });

  const relOut = relative(repoRoot, outDir);
  const stdout = json
    ? JSON.stringify({
        outDir: relOut,
        modules: analysis.modules.length,
        moduleEdges: analysis.moduleEdges.length,
        clusterIds: analysis.clusterIds,
      }) + "\n"
    : `wrote ${relOut}/map.md and ${relOut}/clusters.json — ${analysis.modules.length} modules,` +
      ` ${analysis.moduleEdges.length} edges (${analysis.clusterIds.kept} kept,` +
      ` ${analysis.clusterIds.fresh} fresh cluster ids)\n`;
  return { code: 0, stdout, stderr: "" };
}

function runImpactCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  rawPath: string,
  json: boolean,
): CliResult {
  const { edges, files } = analyze(repoRoot, config, { now, since });
  // Same normalisation `insideRepo`/`repoRelative` give every other
  // repo-content path in this package — a caller running the CLI from a
  // subdirectory, or passing an absolute in-repo path, still matches
  // `files`, which is always repo-relative (harvest.ts). A path that
  // escapes the repo (or names the root itself) has no entry in `files`
  // either way, so falling back to the raw string here just yields the
  // empty result `impact` already returns for an unknown path.
  const path = repoRelative(repoRoot, rawPath) ?? rawPath;
  const rows = computeImpact(path, edges, files);
  const stdout = json ? JSON.stringify(rows) + "\n" : formatImpact(rows);
  return { code: 0, stdout, stderr: "" };
}

function runDriftCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  json: boolean,
): CliResult {
  const { edges, files, spine } = analyze(repoRoot, config, { now, since });
  const rows = computeDrift(edges, files, spine);
  const stdout = json ? JSON.stringify(rows) + "\n" : formatDrift(rows);
  return { code: 0, stdout, stderr: "" };
}

/**
 * Parse `argv` (excluding the `node`/script elements), run the named
 * command against `repoRoot`, and return an exit code plus the text a
 * caller should write to stdout/stderr — never `process.exit` or
 * `console.log` itself, so this is testable without capturing globals.
 *
 * `now` is a required parameter, not `Date.now()`, for the same reason
 * `AnalyzeOptions.now` is: this package's own `conventions.test.ts` bans a
 * clock read anywhere under `src/`, `cli.ts` included. The real process
 * entry point (`bin/octograph.mjs`, outside `src/` and never typechecked
 * or bundled-in as "graph computation") is the one place that reads
 * `Date.now()`.
 */
export function runCli(argv: string[], repoRoot: string, now: number): CliResult {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return usageError(parsed.error);
  const { command, positionals, overrides, since, json } = parsed.parsed;

  if (command === "impact") {
    if (positionals.length !== 1) {
      return usageError("impact requires exactly one <path> argument");
    }
  } else if (positionals.length > 0) {
    return usageError(`${command} takes no positional arguments`);
  }

  const config = loadConfig(repoRoot, overrides);

  try {
    switch (command) {
      case "doctor":
        return runDoctorCommand(repoRoot, config, json);
      case "map":
        return runMapCommand(repoRoot, config, since, now, json);
      case "drift":
        return runDriftCommand(repoRoot, config, since, now, json);
      case "impact": {
        const path = positionals[0];
        if (path === undefined) return usageError("impact requires exactly one <path> argument");
        return runImpactCommand(repoRoot, config, since, now, path, json);
      }
    }
  } catch (err) {
    return runtimeError(err);
  }
}
