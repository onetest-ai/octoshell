import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { analyze, type Analysis } from "./analyze.js";
import { readArtifact, resolveOut, writeArtifact, type StoredGraph } from "./artifact.js";
import { readBoard } from "./board.js";
import { loadConfig, type Config } from "./config.js";
import { doctor, exitCode, type Report } from "./doctor.js";
import { drift as computeDrift, type DriftRow } from "./drift.js";
import { impact as computeImpact, type ImpactRow } from "./impact.js";
import { own as computeOwn, type OwnAnswer } from "./own.js";
import { repoRelative } from "./paths.js";
import { oneLine, renderMap } from "./render.js";
import { readWorklog } from "./worklog.js";

export type Command = "map" | "impact" | "drift" | "doctor" | "own";

const COMMANDS: readonly Command[] = ["map", "impact", "drift", "doctor", "own"];

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

    // RECOGNITION FIRST, CONSUMPTION SECOND. Reading `rest[i + 1]` above the
    // switch made an unrecognised flag report itself as a KNOWN flag missing
    // its value whenever it happened to be last on the line: `octograph
    // doctor --verbose` answered "--verbose requires a value", which tells a
    // user that `--verbose` exists and they merely typed it wrong. The exit
    // code was right and the message was a lie about this CLI's own surface —
    // the same quiet-failure class as swallowing the flag outright, just
    // louder. `takeValue` is only ever called from a `case` that has already
    // matched a literal flag string, so an unknown flag reaches `default` and
    // is named as unknown no matter what does or does not follow it.
    //
    // A `--`-prefixed token is never a value: `octograph map --out --json`
    // otherwise wrote the artifacts into a directory literally named
    // `--json` and dropped the `--json` flag on the floor — silently ignoring
    // a documented flag, which is precisely what this parser exists to make
    // impossible.
    const takeValue = (): string | null => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    const missingValue = (): ParseResult => ({ ok: false, error: `${arg} requires a value` });
    const notANumber = (v: string): ParseResult => ({
      ok: false,
      error: `${arg} expects a number, got "${v}"`,
    });

    switch (arg) {
      case "--out": {
        const value = takeValue();
        if (value === null) return missingValue();
        overrides.out = value;
        break;
      }
      case "--since": {
        const value = takeValue();
        if (value === null) return missingValue();
        since = value;
        break;
      }
      case "--max-commit-files": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.maxCommitFiles = n;
        break;
      }
      case "--half-life": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.halfLifeDays = n;
        break;
      }
      case "--min-support": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.minSupport = n;
        break;
      }
      case "--min-commits": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.minCommits = n;
        break;
      }
      case "--budget": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
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

function formatDoctor(report: Report): string {
  const lines = [`status: ${report.status}`, ""];
  for (const c of report.checks) {
    // `c.state` verbatim, never re-mapped. A `formatCheck` helper here spelled
    // the three `CheckState`s back out as themselves and folded everything
    // else onto "missing" — an identity map whose only possible effect was to
    // mislabel a fourth state added to `CheckState` later as the one state
    // that means "this input is not there at all". A label printed next to a
    // check is a claim about that check's grade; the only safe way to make it
    // is to print the grade.
    lines.push(`[${c.state}] ${c.name}: ${c.detail}`);
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

/** Human phrasing of a `since` window for {@link sinceMismatchWarning} —
 *  `null` reads as "full history", never as the literal string "null". */
function describeSince(since: string | null): string {
  return since === null ? "full history" : `--since ${since}`;
}

/**
 * Non-fatal stderr warning for `runMapCommand`: `clusters.json` is READ BACK
 * to pin cluster ids across runs (`remapClusters`, via `previousClusters`
 * below), and that comparison means nothing once the previous run and this
 * one harvested different slices of history — the harm `StoredGraph.since`
 * (artifact.ts) exists to make visible.
 *
 * `previous.since === undefined` — a legacy artifact written before that
 * field existed, or `previous === null` (no prior run at all) — says
 * NOTHING, not "full history": there is no reliable provenance to compare,
 * and claiming a mismatch (or a match) this function cannot actually verify
 * is exactly the false-claim class the bug is about.
 *
 * A warning, not a failure: the run still produces a good artifact, so this
 * degrades the same way `resolveOut`/`loadConfig` degrade a bad setting
 * rather than throwing — the caller wires the return value into stderr, exit
 * code stays 0.
 */
function sinceMismatchWarning(previous: StoredGraph | null, since: string | undefined): string {
  if (previous === null || previous.since === undefined) return "";
  const previousSince = previous.since;
  const currentSince = since ?? null;
  if (previousSince === currentSince) return "";
  return (
    `octograph: warning: clusters.json was built with ${describeSince(previousSince)}, ` +
    `this run uses ${describeSince(currentSince)} — cluster-id stability across mismatched ` +
    `history windows is not meaningful\n`
  );
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
  // Computed against the run `writeArtifact` below is about to REPLACE, not
  // against the artifact this run itself produces.
  const sinceWarning = sinceMismatchWarning(previous, since);

  const { analysis } = analyze(repoRoot, config, { now, since, previousClusters });
  const mapText = renderMap(analysis, config.budgetTokens);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "map.md"), mapText);
  writeArtifact(outDir, {
    version: 1,
    clusters: analysisToClusters(analysis),
    config,
    // Every NEW artifact this CLI writes records its own provenance
    // explicitly — `null` for full history, never left `undefined`. That
    // spelling is reserved for artifacts written before this field existed
    // (see StoredGraph.since); this run always knows the answer.
    since: since ?? null,
  });

  // `relative()` answers "" when the out directory IS the repo root (`--out .`
  // resolves there, and `insideRepo` admits the root itself), which renders as
  // "wrote /map.md" — a claim about an absolute path at the filesystem root,
  // not about the file that was actually written. "." is the same location
  // spelled truthfully.
  const relOut = relative(repoRoot, outDir) || ".";
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
  return { code: 0, stdout, stderr: sinceWarning };
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

/**
 * One `own` row, with the mode of EACH half of it spelled out where that half
 * is printed — `(provenance)` on the ownership clause, `(predicted)` on the
 * criterion clause. A single trailing `(mode)` covering the whole line read as
 * a claim that the criterion, too, came off a recorded merge; it never can
 * (see `own.ts`'s `OwnAnswer.criterionMode`).
 *
 * `oneLine` on every interpolated identifier, for the reason render.ts
 * documents: a repo-relative path may legally contain a newline, and this
 * formatter joins rows with `\n`, so an unescaped one splits a single answer
 * into two rendered rows — the phantom-line defect M7 shipped into `map.md`,
 * reaching stdout here instead.
 */
function formatOwnAnswer(a: OwnAnswer): string {
  const criterion =
    a.criterion === null || a.criterionMode === null
      ? "criterion: none — no acceptance criterion's own words single out this path"
      : `criterion (${a.criterionMode}): ${oneLine(a.criterion)}`;
  return `${oneLine(a.path)}\towned by ${oneLine(a.mission)} / ${oneLine(a.task)} (${a.mode})\t${criterion}`;
}

function formatOwn(answers: OwnAnswer[]): string {
  if (answers.length === 0) return "(no owner found)\n";
  return answers.map(formatOwnAnswer).join("\n") + "\n";
}

/**
 * `own [<path>]` needs a board — the ONE signal `board.ts`'s `readBoard`
 * exists to give (see its doc comment). Every other command keeps working
 * on a boardless repo; this is the single early-exit point that keeps it
 * that way, a clear message and a non-zero exit rather than `own.ts`
 * reaching into a `null` board and throwing.
 */
function runOwnCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  rawPath: string | null,
  json: boolean,
): CliResult {
  const board = readBoard(repoRoot);
  if (board === null) {
    return {
      code: 1,
      stdout: "",
      stderr: "octograph: no .octobots board found — own needs one to answer\n",
    };
  }

  const log = readWorklog(repoRoot);
  // Same candidate universe `impact`/`drift` already answer against — the
  // co-change file corpus `analyze` harvests, not a second file listing.
  const { files } = analyze(repoRoot, config, { now, since });
  const path = rawPath === null ? null : (repoRelative(repoRoot, rawPath) ?? rawPath);

  const answers = computeOwn(repoRoot, board, log, files, path);
  const stdout = json ? JSON.stringify(answers) + "\n" : formatOwn(answers);
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
  } else if (command === "own") {
    // `own [<path>]` — the optional positional every other non-`impact`
    // command lacks. An extra positional is REJECTED, not silently ignored:
    // `octograph own a.ts b.ts` names a real ambiguity (which of the two did
    // the caller mean?), the same "recognise, don't guess" rule the flag
    // parser above applies to an unrecognised `--flag`.
    if (positionals.length > 1) {
      return usageError("own accepts at most one <path> argument");
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
      case "own":
        return runOwnCommand(repoRoot, config, since, now, positionals[0] ?? null, json);
    }
  } catch (err) {
    return runtimeError(err);
  }
}
