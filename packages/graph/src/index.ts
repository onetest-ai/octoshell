// The package's public API. Cross-package consumers read `dist/index.js`
// (see package.json `exports`), never a deep path into `src/` — so anything a
// consumer needs has to be re-exported here or it does not exist outside this
// package. M2 added the whole analysis pipeline across four tasks and none of
// them reached this file: `analyze`, `renderMap`, `impact` and `loadConfig`
// were importable only from inside the package's own tests.
export { harvest, squashShape, type HarvestOptions, type SquashShape } from "./harvest.js";
export type { Commit } from "./types.js";

export { loadConfig, lexicalOptions, DEFAULTS, historyIsThin, type Config } from "./config.js";
export { analyze, type Analysis, type AnalyzeOptions, type ModuleSummary } from "./analyze.js";
export { workingSets, type WorkingSet } from "./working-sets.js";
export { renderMap, estimateTokens } from "./render.js";
export { impact, type ImpactRow } from "./impact.js";
export { declaredSpine, filesByModule, type Spine } from "./spine.js";
export { readGraphify } from "./graphify.js";
export { layerRanks } from "./layers.js";
export { rollUp, compare, type ModuleEdge } from "./rollup.js";
export { edgeWeight, weighEdges, type Edge, type WeightOptions } from "./weights.js";
export { rankScore } from "./rank.js";
export { countPairs, type PairTable, type PairStat, type DecayOptions } from "./cochange.js";
export { isTestPath, classifyPair, type PairClass } from "./noise.js";
export { drift, type DriftRow } from "./drift.js";
export { doctor, exitCode, type Check, type CheckState, type Report, type Status } from "./doctor.js";
export { readBoard, type BoardTask, type BoardView } from "./board.js";
export { readWorklog, type WorklogEntry } from "./worklog.js";
export { attribute, type Attribution, type AttributionMode } from "./attribution.js";
export {
  predictFiles,
  CONFIDENCE_FLOOR,
  RUNNER_UP_MARGIN,
  type LexicalMatch,
  type LexicalOptions,
} from "./lexical.js";
// T4.4's own surface: the `own` query itself, over `board.ts`/`attribution.ts`/
// `lexical.ts`. Added in the same commit, same reason as every entry above.
export { own, type OwnAnswer } from "./own.js";
// T4.5's own surface: the `conflicts` query — whether a set of tasks
// decomposes cleanly, reported as `shared`/`coupled` on two separate fields
// (see conflicts.ts's doc comment for why they are never summed into one
// score). Added in the same commit, same reason as every entry above.
export { conflicts, type ConflictPair, type ConflictReport } from "./conflicts.js";
export {
  hasBoard,
  readArtifact,
  resolveOut,
  writeArtifact,
  type StoredGraph,
} from "./artifact.js";
// The CLI is a library entry, not just a bin: `runCli` deliberately returns its
// exit code and output text rather than touching `process` (see cli.ts), which
// makes every command testable without capturing globals — that is the reason,
// and the test suite is the consumer that proves it.
//
// It is NOT because the VS Code extension calls this in-process. An earlier
// version of this comment said "precisely so an in-process caller — M6's VS
// Code commands — can run a command without spawning one", and that was never
// true: M6 is a THIN LAUNCHER that opens a terminal on the binary and captures
// no output, and its acceptance criteria require that "the extension gains no
// runtime dependency on @octoshell/graph". A module cannot both be depended on
// in-process and not be depended on at all. Corrected 2026-08-11 — a stale
// claim in the file that documents this package's contract is the same defect
// class this tool exists to find, and it had already misled a reader once.
//
// M3 built the CLI across two task PRs and neither reached this file, the
// identical gap the comment at the top of this module records for M2's
// analysis pipeline; `test/conventions.test.ts` now names these symbols so the
// third recurrence fails the build instead of review.
export { runCli, parseArgs, type CliResult, type Command } from "./cli.js";
// M5/T5.1's own surface: `setup` is deliberately NOT a `runCli` command (see
// setup.ts's doc comment) — it is a second, async entry point over an
// injected `SetupIO` port, because prompting before an install cannot be
// synchronous the way `runCli` is on purpose.
//
// The port earns its place on testability alone: it is what lets the whole
// consent-and-install flow be driven with no TTY, no network and no installs.
// It is NOT here because M6 calls it in-process — see the correction above
// `runCli`; M6 spawns the binary and depends on this package not at all.
// Exported for the same reason everything else here is: a consumer outside
// this package must never reach a deep path into `src/`.
export { runSetup, type SetupIO } from "./setup.js";
