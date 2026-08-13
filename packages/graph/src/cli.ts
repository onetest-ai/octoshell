import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { analyze, type Analysis } from "./analyze.js";
import { readArtifact, resolveOut, writeArtifact, type StoredGraph } from "./artifact.js";
import { insideRepo } from "./paths.js";
import { readBoard, type BoardTask, type BoardView } from "./board.js";
import { lexicalOptions, loadConfig, type Config } from "./config.js";
import { conflicts as computeConflicts, type ConflictPair, type ConflictReport } from "./conflicts.js";
import { changedPaths, diffImpact, type DiffImpactRow, type DiffScope } from "./diff-impact.js";
import { doctor, exitCode, type Report } from "./doctor.js";
import { drift as computeDrift, type DriftRow } from "./drift.js";
import { impact as computeImpact, type ImpactRow } from "./impact.js";
import { own as computeOwn, type OwnAnswer } from "./own.js";
import { repoRelative } from "./paths.js";
import { oneLine, renderMap } from "./render.js";
import { compare } from "./rollup.js";
import { matchCited, readVault, type VaultNote } from "./vault.js";
import { readWorklog } from "./worklog.js";

export type Command = "map" | "impact" | "drift" | "doctor" | "own" | "conflicts";

const COMMANDS: readonly Command[] = ["map", "impact", "drift", "doctor", "own", "conflicts"];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

interface ParsedCommand {
  command: Command;
  positionals: string[];
  overrides: Partial<Config>;
  since: string | undefined;
  json: boolean;
  /**
   * Non-null when `--diff` was given: which change set `impact --diff`
   * measures. Deliberately NOT `since` reinterpreted: `since` already has one
   * meaning across this whole CLI — the history window `map`/`drift` pass to
   * `git log` — and giving it a second, scope-shaped meaning only when
   * `--diff` is present is exactly the "same flag, surprise second behaviour"
   * class `parseArgs`'s flag-recognition discipline exists to rule out.
   * `DiffScope` has no "since" variant for the same reason (diff-impact.ts).
   */
  diff: DiffScope | null;
  /** `--base <ref>`; `undefined` means "use `Config.diffBase`". */
  base: string | undefined;
}

/** {@link ParsedCommand.diff}'s error when two scope flags are given at once
 *  — `--staged --worktree` names two different change sets, and picking one
 *  silently would be the same unresolved ambiguity `--out --json` was fixed
 *  to reject (see the `takeValue` doc comment below). */
const DUPLICATE_SCOPE = "only one of --staged, --worktree may be given";

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
  let sawDiff = false;
  let scopeFlag: string | null = null;
  let base: string | undefined;

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
      case "--diff":
        sawDiff = true;
        break;
      case "--staged":
      case "--worktree":
        if (scopeFlag !== null) return { ok: false, error: DUPLICATE_SCOPE };
        scopeFlag = arg;
        break;
      case "--base": {
        const value = takeValue();
        if (value === null) return missingValue();
        base = value;
        break;
      }
      default:
        // Unrecognised flag — exits 2 rather than being silently ignored.
        return { ok: false, error: `unrecognised flag: ${arg}` };
    }
  }

  // `--diff` names the QUESTION ("what does everything I changed touch?");
  // the scope flags narrow WHICH change set answers it. A scope flag given
  // alone is rejected rather than silently implying `--diff`, for the same
  // reason an unrecognised flag is rejected rather than ignored: a caller who
  // typed `impact --staged` and got a whole-repo `impact <path>` error (or,
  // worse, a quietly different answer) would have no way to notice the flag
  // did nothing.
  if (!sawDiff && scopeFlag !== null) {
    return { ok: false, error: `${scopeFlag} requires --diff` };
  }
  // Same guard, same reason, for `--base`: it selects what a branch is
  // measured AGAINST, which means nothing without `--diff` naming a change
  // set to measure in the first place. Missed in the original pass —
  // `--staged`/`--worktree` got this check and `--base` did not, so `impact
  // --base main <path>` parsed clean and ran ordinary `impact <path>` with
  // `--base` silently doing nothing. Exactly the "recognised flag the parser
  // then discards" defect this whole file's flag-recognition discipline
  // exists to rule out (see the `--out`/`--half-life-days` history above).
  if (!sawDiff && base !== undefined) {
    return { ok: false, error: "--base requires --diff" };
  }
  let diff: DiffScope | null = null;
  if (sawDiff) {
    if (scopeFlag === "--staged") diff = { kind: "staged" };
    else if (scopeFlag === "--worktree") diff = { kind: "worktree" };
    else diff = { kind: "branch" };
  }

  return {
    ok: true,
    parsed: { command: rawCommand, positionals, overrides, since, json, diff, base },
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function usageError(message: string): CliResult {
  return { code: 2, stdout: "", stderr: `octograph: ${message}\n` };
}

/**
 * The ONE spelling of "a command threw — say so and exit non-zero". Exported
 * for `setup.ts`, which runs `runMapCommand` from OUTSIDE `runCli`'s
 * try/catch below and so has to catch for itself: a `runSetup` that let the
 * exception escape would reject the `Promise<number>` it promises, and — on
 * the consent path — do it after having already changed the user's machine.
 * Formatting that message a second way there would be a second spelling of
 * what a failed command reads like.
 */
export function runtimeError(err: unknown): CliResult {
  const message = err instanceof Error ? err.message : String(err);
  return { code: 1, stdout: "", stderr: `octograph: ${message}\n` };
}

/**
 * How a `Report` reads, for `octograph doctor` AND for `setup`'s postflight
 * — one spelling, so the two can never disagree about what a check's grade
 * is called. `setup.ts` printed its own rendering first and had already
 * drifted: it stamped every non-`ok` check with the word "degraded", which
 * is a `Report.status` value the report itself may not hold (`board` is
 * optional and never moves the status), announcing a report-level grade
 * `doctor` had not given. That is the defect the comment inside this
 * function's loop describes, made from the outside instead.
 */
export function formatDoctor(report: Report): string {
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

/**
 * Non-fatal stderr warning for `own`/`conflicts`: a hazard `sinceMismatchWarning`
 * above already names for `map`, on a command that keeps no prior run to
 * compare against, so there is no "mismatch" to detect — only "in use", which
 * is worth saying every time.
 *
 * `--since` narrows the co-change candidate corpus (`analyze`'s `files`)
 * every PREDICTED answer is scored against — `own`'s lexical fallback, and
 * the WHOLE of `conflicts` (see conflicts.ts's own doc comment: it runs in
 * `predicted` mode permanently). The identical query can therefore answer
 * differently under a different window, and nothing on the page said why:
 * verified 2026-08-12, `octograph own packages/graph/src/render.ts --since
 * 2026-08-10` prints nothing to stderr either way. The PROVENANCE half is
 * unaffected — `attribution.ts`'s `filesChangedBy` resolves a merge SHA
 * against real git history regardless of `--since` — so this warns about
 * exactly the half a reader is least able to sanity-check for themselves.
 *
 * Fires on every run either command is given `--since`, never only on a
 * mismatch: unlike `map`'s `clusters.json`, `own`/`conflicts` persist
 * nothing between runs for this function to compare against.
 */
function sincePredictedWarning(since: string | undefined): string {
  if (since === undefined) return "";
  return (
    `octograph: --since ${since} narrows the co-change corpus predicted answers are scored ` +
    `against — the same query can answer differently under a different window; provenance ` +
    `answers are unaffected\n`
  );
}

/**
 * Module name → a one-line "what this is for".
 *
 * Two sources, each carrying its own label into the string, because `render`
 * escapes and budgets what it is handed but does not decide what counts as
 * evidence. A module's owner is the mission of the MOST-attributed task among
 * its files — one line per module is the budget, so a module owned by three
 * tasks names the one with the most files rather than listing all three.
 */
function purposeByModule(
  answers: readonly OwnAnswer[],
  notes: readonly VaultNote[],
  files: readonly string[],
  moduleOf: (p: string) => string,
): Map<string, string> {
  const tally = new Map<string, Map<string, { label: string; n: number }>>();
  for (const a of answers) {
    const mod = moduleOf(a.path);
    const byMission = tally.get(mod) ?? new Map<string, { label: string; n: number }>();
    const key = a.mission;
    const seen = byMission.get(key);
    const label = `${a.missionName} (${a.mode})`;
    if (seen === undefined) byMission.set(key, { label, n: 1 });
    else seen.n += 1;
    tally.set(mod, byMission);
  }

  const citedByModule = new Map<string, string>();
  for (const m of matchCited(notes, files)) {
    const mod = moduleOf(m.path);
    // First wins: `matchCited` is sorted by path then note, so this is stable
    // across runs — `map.md` is committed and must not churn between two
    // identical runs.
    if (!citedByModule.has(mod)) citedByModule.set(mod, m.note);
  }

  const out = new Map<string, string>();
  for (const mod of new Set([...tally.keys(), ...citedByModule.keys()])) {
    const missions = [...(tally.get(mod)?.values() ?? [])].sort(
      (x, y) => y.n - x.n || compare(x.label, y.label),
    );
    const parts: string[] = [];
    const top = missions[0];
    if (top !== undefined) parts.push(top.label);
    const note = citedByModule.get(mod);
    if (note !== undefined) parts.push(`see ${note}`);
    if (parts.length > 0) out.set(mod, parts.join(" — "));
  }
  return out;
}

/**
 * `map`'s whole pipeline — `analyze` -> `renderMap` -> `writeArtifact` — as
 * ONE function, exported so a second caller never reassembles that sequence
 * by hand. `setup.ts`'s build step calls this directly rather than
 * re-deriving `resolveOut`/`analyze`/`renderMap`/`writeArtifact` itself,
 * which would be a second implementation of the exact shape this package
 * exists to catch (the `entity-io.mjs` vs `entity-schema.ts` drift, one repo
 * over). `test/conventions.test.ts` guards that `setup.ts` never open-codes
 * `analyze(`/`renderMap(`/`writeArtifact(` itself.
 */
export function runMapCommand(
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

  const { analysis, files, spine } = analyze(repoRoot, config, { now, since, previousClusters });

  // Purpose lines are OPTIONAL evidence, same posture as the vault itself
  // (vault.ts's own doc comment): a repo with no board still gets vault-only
  // purpose lines, a repo with neither gets an unchanged map.md. `own` needs
  // a `BoardView` to answer at all (see `runOwnCommand`'s early exit), so
  // this is the one call site in `map` that is conditional on the board
  // existing — everything else `map` computes works on a boardless repo.
  const board = readBoard(repoRoot);
  const answers =
    board === null
      ? []
      : computeOwn(repoRoot, board, readWorklog(repoRoot), files, null, lexicalOptions(config));
  const notes = readVault(repoRoot, config.vaultPath);
  const purpose = purposeByModule(answers, notes, files, spine.moduleOf);

  const mapText = renderMap(analysis, config.budgetTokens, purpose);

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
  // `undefined` for `limit` keeps `impact`'s own default (20) — only
  // `minSupport` is overridden here, from the SAME `config.minSupport`
  // `weighEdges` already admitted these edges against (analyze.ts), so the
  // ranking's shrinkage constant never disagrees with the admission floor
  // that produced the edges it is ranking.
  const rows = computeImpact(path, edges, files, undefined, config.minSupport);
  const stdout = json ? JSON.stringify(rows) + "\n" : formatImpact(rows);
  return { code: 0, stdout, stderr: "" };
}

/** One `impact --diff` row: the changed files it did NOT come from, the
 *  evidence, and any `cited` vault notes — all through `oneLine`, same
 *  reason as `formatOwnAnswer`/`formatConflictPair`: a repo-relative path or
 *  a vault description is free-form text that may legally carry a newline,
 *  and this formatter joins rows with `\n`. */
function formatDiffImpactRow(row: DiffImpactRow): string {
  const { path, npmi, support, predictedBy, notes } = row;
  const lines = [
    `  ${oneLine(path)}  npmi=${npmi.toFixed(3)}  support=${support}`
      + `  via ${predictedBy.map(oneLine).join(", ")}`,
  ];
  for (const n of notes) lines.push(`      known: ${oneLine(n.note)} — ${oneLine(n.description)}`);
  return lines.join("\n");
}

function formatDiffImpactSection(title: string, rows: DiffImpactRow[]): string[] {
  if (rows.length === 0) return [title, "  (none)"];
  return [title, ...rows.map(formatDiffImpactRow)];
}

/**
 * `changed.length === 0`'s message, scoped to what was actually asked. Fix
 * round 1, minor 2: `--staged` and `--worktree` compare the index / the
 * worktree to HEAD — no `base` ref is ever consulted for either (see
 * `changedPaths`'s own `switch` in diff-impact.ts) — so a message claiming
 * "against the base" under those scopes describes a comparison that did not
 * happen. Only `branch` scope (the default) actually measures against
 * `base`.
 */
function emptyChangedMessage(scope: DiffScope): string {
  switch (scope.kind) {
    case "staged":
      return "nothing staged — no impact to report";
    case "worktree":
      return "worktree is clean — no impact to report";
    case "branch":
      return "nothing changed against the base — no impact to report";
  }
}

/**
 * `impact --diff` — what else moves, given everything this branch (or the
 * index, or the worktree) has changed.
 *
 * `changedPaths` and `analyze` are two INDEPENDENT reads of this repository,
 * not a two-step pipeline — `changedPaths` never consults `since` (it walks
 * `merge-base(base, HEAD)..HEAD` plus uncommitted work, see diff-impact.ts),
 * and `analyze` never consults `scope`/`base`. `since` keeps its one meaning
 * (the history window feeding the co-change graph) exactly as it does for
 * `impact <path>` — see the doc comment on `ParsedCommand.diff` for why a
 * second, diff-scoped meaning is deliberately not on offer here.
 *
 * An empty `source`/`tests` is rendered WITH `doctor`'s verdict when history
 * is thin or this repository squash-merges: the fine-grained co-change this
 * reads is exactly what a squash merge discards at merge time (doctor.ts,
 * "history shape"), so "no rows" there means "we cannot see", never "nothing
 * else moves" — the same honesty `docs/octograph.md`'s "Honest limits"
 * section states for `drift` and the working sets, applied here to the one
 * other surface built on the same discovered co-change edges. A genuinely
 * healthy history that simply found nothing prints no caveat: `doctor`'s
 * `status` is the single spelling of "is this evidence trustworthy", so this
 * reads it rather than re-deriving a second opinion from the same inputs.
 */
function runDiffImpactCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  scope: DiffScope,
  base: string,
  json: boolean,
): CliResult {
  const changed = changedPaths(repoRoot, scope, base, config.excludePaths);
  const { edges, files } = analyze(repoRoot, config, { now, since });
  const notes = readVault(repoRoot, config.vaultPath);
  // `undefined` for `limit` keeps `diffImpact`'s own default (20 per
  // section) — only `minSupport` is overridden, from the SAME
  // `config.minSupport` the edges were already admitted against, exactly as
  // `runImpactCommand` does above.
  const answer = diffImpact(changed, edges, files, notes, undefined, config.minSupport);

  if (json) return { code: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: "" };

  const lines: string[] = [`changed: ${changed.length} file(s)`];
  if (changed.length === 0) {
    lines.push("", emptyChangedMessage(scope));
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }

  lines.push("", ...formatDiffImpactSection("you may also need to change:", answer.source));
  lines.push("", ...formatDiffImpactSection("tests that historically move with this:", answer.tests));

  if (answer.source.length === 0 && answer.tests.length === 0) {
    const report = doctor(repoRoot, config);
    if (report.status !== "ok") {
      lines.push(
        "",
        `history is ${report.status} — this is missing evidence, not evidence of absence.`,
        "run `octograph doctor` for what is degraded and how to fix it.",
      );
    }
  }
  return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

/**
 * One `own` row, with the mode of EACH half of it spelled out where that half
 * is printed — `(provenance)` on the ownership clause, `(predicted)` on the
 * criterion clause. A single trailing `(mode)` covering the whole line read as
 * a claim that the criterion, too, came off a recorded merge; it never can
 * (see `own.ts`'s `OwnAnswer.criterionMode`).
 *
 * Names the mission and task by {@link OwnAnswer.missionName}/`.taskName` —
 * the words a person gave them — never by their folder-derived
 * `.mission`/`.task` ids (`folder:campaigns/.../missions/<slug>`). `own`'s
 * stated reader is a person asking why code exists; printing the id twice,
 * in full, answered a different question. The id stays reachable for a
 * machine consumer through `own --json`, which serialises the whole
 * {@link OwnAnswer} — id and name both — since a name is not a join key (two
 * missions can share a title, an id never repeats).
 *
 * `oneLine` on every interpolated identifier — the mission/task NAME included,
 * not only the path and criterion: both come off free-form board text
 * (`mission.yaml`'s `name`, `task.yaml`'s `name`) exactly like a criterion
 * does, and are exactly as able to carry a TAB or a newline. For the reason
 * render.ts documents: a repo-relative path (or a board-authored name) may
 * legally contain a newline, and this formatter joins rows with `\n`, so an
 * unescaped one splits a single answer into two rendered rows — the
 * phantom-line defect M7 shipped into `map.md`, reaching stdout here instead.
 */
function formatOwnAnswer(a: OwnAnswer): string {
  const criterion =
    a.criterion === null || a.criterionMode === null
      ? "criterion: none — no acceptance criterion's own words single out this path"
      : `criterion (${a.criterionMode}): ${oneLine(a.criterion)}`;
  return `${oneLine(a.path)}\towned by ${oneLine(a.missionName)} / ${oneLine(a.taskName)} (${a.mode})\t${criterion}`;
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

  const answers = computeOwn(repoRoot, board, log, files, path, lexicalOptions(config));
  const stdout = json ? JSON.stringify(answers) + "\n" : formatOwn(answers);
  return { code: 0, stdout, stderr: sincePredictedWarning(since) };
}

function runDriftCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  json: boolean,
): CliResult {
  const { edges, files, spine } = analyze(repoRoot, config, { now, since });
  // `undefined` keeps `drift`'s own default `limit` (20). `excludePaths` is
  // no longer threaded here: it applies at `harvest`, so the edges this
  // receives are already filtered — see drift.ts's doc comment.
  const rows = computeDrift(edges, files, spine, undefined, config.minSupport);
  const stdout = json ? JSON.stringify(rows) + "\n" : formatDrift(rows);
  return { code: 0, stdout, stderr: "" };
}

function formatModuleList(modules: string[]): string {
  return modules.length === 0 ? "(none)" : modules.map(oneLine).join(", ");
}

/**
 * One `conflicts` row, carrying the mode that produced it — `(predicted)`,
 * always, for the reason {@link ConflictPair.mode} states.
 *
 * Printed rather than left implicit: `own` labels every row it emits, and an
 * unlabelled row from a sibling command in the same CLI reads as the stronger
 * claim. Both halves of this row rest on a lexical guess about which files
 * each task will touch, so the label sits on the pair, covering the whole
 * line — there is no second, differently-evidenced half here of the kind that
 * forced `own` to label its two clauses separately.
 *
 * `oneLine` on every interpolated identifier, same reason as
 * {@link formatOwnAnswer}: a path or a board id may legally contain a control
 * character, and this formatter joins rows with `\n` and fields with `\t`.
 */
function formatConflictPair(p: ConflictPair): string {
  const shared = p.shared.length === 0 ? "(none)" : p.shared.map(oneLine).join(", ");
  return (
    `${oneLine(p.a)} <-> ${oneLine(p.b)} (${p.mode})` +
    `\tshared=${shared}\tcoupled=${p.coupled.toFixed(3)}\tmodules=${formatModuleList(p.modules)}`
  );
}

/**
 * What this answer actually rests on — printed on EVERY run, empty result or
 * not, because `pairs.length === 0` alone means two incompatible things.
 *
 * `predictFiles` answers for a minority of real tasks (`lexical.ts`'s
 * calibration measured 3 of 8 on this repo; `conflicts` on this repo's own M4
 * mission predicted a surface for 1 task of 6), and a task with no surface
 * takes part in no pair. So `(no conflicts found)` printed alone reads as
 * "this decomposition is clean" when the truth is "nothing was predicted for
 * five of these six tasks" — a verdict outrunning what was computed, in the
 * command whose whole product is that verdict.
 *
 * Uncovered tasks are NAMED, not just counted: a bare count is the "21 files"
 * row again — a number a reader cannot act on or check. `(predicted)` sits on
 * this line too, for the same reason it sits on every pair row.
 */
function formatCoverage(report: ConflictReport): string {
  const total = report.covered.length + report.uncovered.length;
  const head = `coverage (predicted): ${report.covered.length} of ${total} tasks produced a predicted surface`;
  if (report.uncovered.length === 0) return head;
  return (
    `${head} — this answer says nothing about the other ${report.uncovered.length}: ` +
    report.uncovered.map(oneLine).join(", ")
  );
}

function formatConflicts(report: ConflictReport): string {
  const rows = report.pairs.length === 0 ? ["(no conflicts found)"] : report.pairs.map(formatConflictPair);
  return [...rows, formatCoverage(report)].join("\n") + "\n";
}

/**
 * `conflicts <mission|campaign|...tasks>` resolves its positional(s) against
 * the board it already read, trying exactly three shapes in order: a single
 * id naming a CAMPAIGN (every task under it, from every mission it spans —
 * `BoardTask.campaign` is a real field per task, not a second board read),
 * a single id naming a MISSION (every task under it), or two-or-more ids
 * naming TASKS directly (exactly those tasks, nothing inferred).
 *
 * `BoardTask.campaign`/`.mission`/`.id` are three disjoint folder-path
 * namespaces (see attribution.ts's `SHORT_ID` doc comment for the sibling
 * argument about why a board id is never ambiguous with another kind), so at
 * most one of the three branches below can ever match a given single id.
 */
function resolveConflictTasks(
  board: BoardView,
  positionals: string[],
): { ok: true; tasks: BoardTask[] } | { ok: false; error: string } {
  if (positionals.length === 1) {
    const id = positionals[0];
    if (id === undefined) return { ok: false, error: "conflicts requires an id" };
    const byCampaign = board.tasks.filter((t) => t.campaign === id);
    if (byCampaign.length > 0) return { ok: true, tasks: byCampaign };
    const byMission = board.tasks.filter((t) => t.mission === id);
    if (byMission.length > 0) return { ok: true, tasks: byMission };
    const byTask = board.tasks.filter((t) => t.id === id);
    if (byTask.length > 0) return { ok: true, tasks: byTask };
    return { ok: false, error: `no campaign, mission, or task matches "${id}"` };
  }

  // Two or more positionals: an EXPLICIT task list, every id required to
  // resolve — a typo in one of several ids must be reported, not silently
  // dropped from the set it names.
  const wanted = new Set(positionals);
  const tasks = board.tasks.filter((t) => wanted.has(t.id));
  const found = new Set(tasks.map((t) => t.id));
  const missing = positionals.filter((id) => !found.has(id));
  if (missing.length > 0) return { ok: false, error: `no task matches: ${missing.join(", ")}` };
  return { ok: true, tasks };
}

/**
 * `conflicts` needs a board for the same reason `own` does (see
 * `runOwnCommand`) — resolving the positional into a task set reads
 * `board.tasks`. Deliberately never calls `readWorklog`: this command runs
 * in `predicted` mode permanently (see conflicts.ts's doc comment), so there
 * is nothing a worklog entry could add to its answer.
 */
function runConflictsCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  positionals: string[],
  json: boolean,
): CliResult {
  const board = readBoard(repoRoot);
  if (board === null) {
    return {
      code: 1,
      stdout: "",
      stderr: "octograph: no .octobots board found — conflicts needs one to answer\n",
    };
  }

  const resolved = resolveConflictTasks(board, positionals);
  if (!resolved.ok) return usageError(resolved.error);

  // Same co-change graph `impact`/`drift`/`own` already answer against.
  const { analysis, edges, files } = analyze(repoRoot, config, { now, since });
  const report = computeConflicts(analysis, edges, files, resolved.tasks, lexicalOptions(config));
  const stdout = json ? JSON.stringify(report) + "\n" : formatConflicts(report);
  return { code: 0, stdout, stderr: sincePredictedWarning(since) };
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
  const { command, positionals, overrides, since, json, diff, base } = parsed.parsed;

  // `--out` is REJECTED here rather than quietly dropped later.
  //
  // `resolveOut` only honours `config.out` when `insideRepo` accepts it, and
  // an escaping path falls through to the default. For `octograph.yaml`'s
  // `out:` that degradation is deliberate and documented — a config file
  // should not fail a build over one bad key. For a FLAG it is the defect
  // `--half-life-days` was rewritten to make impossible: a value the user
  // typed for this run, accepted by the parser, and then silently ignored.
  //
  // The harm is not hypothetical. Running octograph against another
  // repository with `--out` pointed at a scratch directory wrote `map.md` and
  // `clusters.json` into THAT repository instead, where `.octobots/` was
  // tracked rather than ignored — no warning, exit 0.
  //
  // Containment itself is not relaxed: writing outside the repository is a
  // genuine path-escape hazard and the check exists for that. Only the
  // silence is fixed.
  // `null` is the "no explicit out" value the config type uses, not a path.
  const outFlag = typeof overrides.out === "string" ? overrides.out : null;
  if (outFlag !== null && insideRepo(repoRoot, outFlag) === null) {
    return usageError(
      `--out must name a path inside the repository, and "${outFlag}" resolves outside it`,
    );
  }

  if (command === "impact") {
    // `--diff` and a positional `<path>` ask two different questions — "what
    // does everything I changed touch" vs. "what touches this one file" — so
    // picking one silently would answer a question the caller did not ask,
    // the same reasoning `--diff` alone-without-a-scope-flag rejection above
    // (parseArgs) already applies one level up.
    if (diff !== null && positionals.length > 0) {
      return usageError("--diff and a <path> are mutually exclusive");
    }
    if (diff === null && positionals.length !== 1) {
      return usageError("impact requires exactly one <path> argument, or --diff");
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
  } else if (command === "conflicts") {
    // `conflicts <mission|campaign|...tasks>` — needs at least ONE id.
    // Unlike `own`'s optional path, there is no "answer about everything"
    // shape here: a mission-scale co-change graph makes an all-tasks
    // O(tasks^2) sweep expensive enough that it should be opted into
    // explicitly (a campaign id), never implied by omitting the argument.
    if (positionals.length === 0) {
      return usageError("conflicts requires a <mission>, <campaign>, or one or more <task> ids");
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
        if (diff !== null) {
          return runDiffImpactCommand(repoRoot, config, since, now, diff, base ?? config.diffBase, json);
        }
        const path = positionals[0];
        if (path === undefined) return usageError("impact requires exactly one <path> argument");
        return runImpactCommand(repoRoot, config, since, now, path, json);
      }
      case "own":
        return runOwnCommand(repoRoot, config, since, now, positionals[0] ?? null, json);
      case "conflicts":
        return runConflictsCommand(repoRoot, config, since, now, positionals, json);
    }
  } catch (err) {
    return runtimeError(err);
  }
}
