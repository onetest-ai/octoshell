// The package's public API. Cross-package consumers read `dist/index.js`
// (see package.json `exports`), never a deep path into `src/` — so anything a
// consumer needs has to be re-exported here or it does not exist outside this
// package. M2 added the whole analysis pipeline across four tasks and none of
// them reached this file: `analyze`, `renderMap`, `impact` and `loadConfig`
// were importable only from inside the package's own tests.
export { harvest, type HarvestOptions } from "./harvest.js";
export type { Commit } from "./types.js";

export { loadConfig, DEFAULTS, type Config } from "./config.js";
export { analyze, type Analysis, type AnalyzeOptions, type ModuleSummary } from "./analyze.js";
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
