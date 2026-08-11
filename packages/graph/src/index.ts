// The package's public API. Cross-package consumers read `dist/index.js`
// (see package.json `exports`), never a deep path into `src/` — so anything a
// consumer needs has to be re-exported here or it does not exist outside this
// package. M2 added the whole analysis pipeline across four tasks and none of
// them reached this file: `analyze`, `renderMap`, `impact` and `loadConfig`
// were importable only from inside the package's own tests.
export { harvest, type HarvestOptions } from "./harvest.js";
export type { Commit } from "./types.js";

export { loadConfig, DEFAULTS, historyIsThin, type Config } from "./config.js";
export { analyze, type Analysis, type AnalyzeOptions, type ModuleSummary } from "./analyze.js";
export { workingSets, type WorkingSet } from "./working-sets.js";
export { renderMap, estimateTokens } from "./render.js";
export { impact, type ImpactRow } from "./impact.js";
export { declaredSpine, filesByModule, type Spine } from "./spine.js";
export { readGraphify } from "./graphify.js";
export { layerRanks } from "./layers.js";
export { rollUp, compare, type ModuleEdge } from "./rollup.js";
export { edgeWeight, weighEdges, type Edge, type WeightOptions } from "./weights.js";
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
export { conflicts, type ConflictPair } from "./conflicts.js";
export {
  hasBoard,
  readArtifact,
  resolveOut,
  writeArtifact,
  type StoredGraph,
} from "./artifact.js";
// The CLI is a library entry, not just a bin: `runCli` deliberately returns its
// exit code and output text rather than touching `process` (see cli.ts), which
// is precisely so an in-process caller — M6's VS Code commands — can run a
// command without spawning one. M3 built it across two task PRs and neither
// reached this file, the identical gap the comment at the top of this module
// records for M2's analysis pipeline; `test/conventions.test.ts` now names
// these symbols so the third recurrence fails the build instead of review.
export { runCli, parseArgs, type CliResult, type Command } from "./cli.js";
