// Reproduces the calibration tables pinned in `src/lexical.ts`'s
// CONFIDENCE_FLOOR / RUNNER_UP_MARGIN comments.
//
// Those two constants are the only tunables in this package whose value comes
// from a MEASUREMENT rather than from an argued-for default, and this campaign's
// recurring defect is a claim that outran what was actually computed. A table
// typed into a doc comment by hand is such a claim: the first version of
// CONFIDENCE_FLOOR's table read the `margin: 0` row of the sweep while its own
// prose said the margin was held at RUNNER_UP_MARGIN, and the conclusion drawn
// from the mismatched cells ("0.20 buys precision over 0.05") did not survive
// re-running it. So the table is machine-produced and re-runnable:
//
//     pnpm --filter @octoshell/graph build
//     node packages/graph/scripts/calibrate-lexical.mjs
//
// NOT a test, and deliberately not run by vitest: it measures THIS repo's live
// git history and live `.octobots/` board, so its numbers legitimately move as
// the repo grows (the labelled dataset gets bigger — that is the point, see the
// "revisit once own/conflicts accumulate a larger sample" note on the constant).
// A vitest assertion on these numbers would fail on every merge, and would fail
// outright on CI, whose checkout is shallow (see
// `.agents/knowledge/testing/graph-ci-checkout-is-shallow-live-history-tests-return-empty.md`).
// When the numbers move, re-run this and update the comment — do not edit the
// comment alone.
//
// The labelled dataset is T4.2's work: every board task whose worklog entry
// carries a `merged_sha` that still resolves has a KNOWN true file set, straight
// from `git diff-tree` (`attribute()`'s `provenance` mode). Everything below is
// scored against that, never against a guess.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attribute,
  harvest,
  predictFiles,
  readBoard,
  readWorklog,
  CONFIDENCE_FLOOR,
  RUNNER_UP_MARGIN,
} from "../dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const board = readBoard(repoRoot);
if (board === null) {
  console.error(`No .octobots board under ${repoRoot} — nothing to calibrate against.`);
  process.exit(1);
}

const log = readWorklog(repoRoot);
const labelled = attribute(repoRoot, board, log).filter((a) => a.mode === "provenance");
const criteriaOf = new Map(board.tasks.map((t) => [t.id, t.criteria]));

// The candidate corpus: every path any commit in this repo's history touched,
// through `harvest()` — the same reader the graph itself is built from, never a
// second walk of the tree, so the corpus a prediction is scored against is the
// corpus `own`/`conflicts` will predict over. `compare`-independent here: the
// ranking sorts, this only needs the set.
const corpus = [...new Set(harvest(repoRoot).flatMap((c) => c.files))].sort();

const trueFileCount = labelled.reduce((n, a) => n + a.files.length, 0);

console.log(`repo             ${repoRoot}`);
console.log(`board tasks      ${board.tasks.length}`);
console.log(`worklog entries  ${log.length}`);
console.log(`labelled dataset ${labelled.length} tasks attributed by provenance`);
console.log(`true files       ${trueFileCount}`);
console.log(`candidate corpus ${corpus.length} paths`);
console.log();

/** One sweep row: how the predictor scores at (floor, margin) over the whole
 *  labelled dataset. Micro-averaged — total true positives over total
 *  predictions — so a task predicting 6 files does not count the same as one
 *  predicting 1. */
function measure(floor, margin) {
  let truePositives = 0;
  let predicted = 0;
  let answered = 0;
  for (const attribution of labelled) {
    const criteria = criteriaOf.get(attribution.task) ?? [];
    const matches = predictFiles(criteria, corpus, {
      confidenceFloor: floor,
      runnerUpMargin: margin,
    });
    if (matches.length > 0) answered += 1;
    predicted += matches.length;
    const truth = new Set(attribution.files);
    for (const m of matches) if (truth.has(m.file)) truePositives += 1;
  }
  return { truePositives, predicted, answered };
}

function sweep(margin) {
  console.log(`runnerUpMargin: ${margin}${margin === RUNNER_UP_MARGIN ? "  (RUNNER_UP_MARGIN)" : ""}`);
  console.log("| confidenceFloor | precision | recall | tasks answered | predictions | true positives |");
  console.log("|---|---|---|---|---|---|");
  for (const floor of [0.05, 0.2, 0.3]) {
    const { truePositives, predicted, answered } = measure(floor, margin);
    const precision = predicted === 0 ? "n/a" : (truePositives / predicted).toFixed(2);
    const recall = trueFileCount === 0 ? "n/a" : (truePositives / trueFileCount).toFixed(2);
    const pinned = floor === CONFIDENCE_FLOOR ? "  <- CONFIDENCE_FLOOR" : "";
    console.log(
      `| ${floor} | ${precision} | ${recall} | ${answered}/${labelled.length} | ${predicted} | ${truePositives} |${pinned}`,
    );
  }
  console.log();
}

sweep(RUNNER_UP_MARGIN);
sweep(0);
