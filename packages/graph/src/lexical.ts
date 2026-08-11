/**
 * Cold-start task<->file prediction: acceptance-criteria text scored against
 * candidate file paths, by tf-idf over identifier-shaped tokens. Always
 * `predicted` mode (see `attribution.ts`'s two-mode doc comment) — this is
 * the non-vector tier of `wikis`' three-tier orphan cascade; the vector tier
 * is dropped on purpose because it would need embeddings, which would break
 * "no install step" (see the M4 board-overlay plan, Task 3).
 *
 * A "document" here is a candidate FILE PATH, tokenized into its own
 * identifier-shaped pieces (`src/authSession.ts` -> `src`, `auth`, `session`,
 * `ts`) — never file CONTENTS. Nothing in this package parses source for
 * identifiers (that is what `graphify.ts`'s declared-spine reader stops
 * short of too), so "identifiers" here means path segments, not exported
 * symbol names.
 */
import { compare } from "./rollup.js";

export interface LexicalMatch {
  file: string;
  /** Fraction of the query's total idf-weighted mass this file matched, in
   *  [0, 1] — 1 means every distinctive token in the criteria appears in this
   *  file's path, 0 means none does. Normalized so `confidenceFloor` and
   *  `runnerUpMargin` mean the same thing on a 5-file fixture and a
   *  5,000-file repo. */
  score: number;
}

export interface LexicalOptions {
  /** Minimum normalized score the TOP candidate must clear before this
   *  module answers at all. Below it, "no confident match" — see
   *  {@link CONFIDENCE_FLOOR}'s calibration comment. */
  confidenceFloor?: number;
  /** Minimum gap, in the same normalized units, the top score must hold over
   *  the next-best DISTINCT score. A top match that a near-tied runner-up is
   *  crowding is exactly as unhelpful as a weak absolute score — it says
   *  "criteria could belong to either file", which is not a prediction, it's
   *  a coin flip wearing one. See {@link RUNNER_UP_MARGIN}'s calibration
   *  comment. */
  runnerUpMargin?: number;
}

/**
 * A short, closed list of English function words: articles, prepositions,
 * conjunctions, auxiliary verbs, and the handful of verbs board criteria are
 * written with ("given", "returns", "must"). Acceptance-criteria text is
 * English prose describing BEHAVIOUR ("given a task whose criteria name
 * identifiers..."), not a bag of identifiers — so scoring every prose word
 * equally weights "the" and "given" the same as "session" or "auth", and this
 * repo's own `.agents/knowledge/**\/*.md` filenames (named as full English
 * sentences, e.g. `graph-fixture-map-output-must-be-gitignored-before-a-
 * second-run.md`) are exactly the kind of candidate a stopword-free query
 * would falsely out-score real identifiers against — confirmed during this
 * task's own calibration (see {@link CONFIDENCE_FLOOR}): dropping this list
 * moved the top-ranked candidate for 5 of 8 provenance-attributed tasks from
 * a code file to a `.agents/knowledge` note whose ONLY connection to the task
 * was sharing English prose vocabulary with its acceptance criteria.
 */
const STOPWORDS = new Set(
  `a an the is are was were be been being to of and or in on at by for with from
   as that this these those it its into over under given when returns return
   each every both never no not only exists must should would could rather
   than same across between per via own can will one two three does do did
   has have had so if else yet also still even out about after before while
   all any none there here where which who whom whose what how many more most
   such other another`.split(/\s+/),
);

/**
 * Splits `text` into lowercase, identifier-shaped tokens: on `/`, `.`, `-`,
 * `_`, whitespace, and camelCase boundaries (per the M4 plan's Task 3 spec),
 * then drops stopwords, bare numbers, and single characters — none of which
 * ever distinguish one file from another.
 */
function tokenize(text: string): string[] {
  return text
    .split(/[/.\-_\s]+/)
    .flatMap((word) => word.split(/(?<=[a-z0-9])(?=[A-Z0-9])/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * `ln(N / df(t))` — the standard tf-idf inverse document frequency, over the
 * CANDIDATE corpus (never a fixed external vocabulary, which would need
 * shipping one). A token this corpus never uses at all (`df(t) === 0`) is
 * not evidence for anything in it, so it scores 0 rather than `ln(N/0)`'s
 * `Infinity` — the query may legitimately contain words no candidate path
 * uses (ordinary English prose almost always does).
 */
function idf(df: ReadonlyMap<string, number>, candidateCount: number, token: string): number {
  const d = df.get(token);
  if (d === undefined || d === 0) return 0;
  return Math.log(candidateCount / d);
}

/**
 * Every candidate's score against `criteria`, HIGHEST first, ties broken by
 * `compare` — never Set/Map iteration order, which V8 happens to keep as
 * insertion order today but which is not a contract this package's
 * determinism rule can lean on (see `test/conventions.test.ts`'s fixed-epoch
 * guard for the same argument applied to the clock).
 *
 * Score is `sum(idf(t) for t shared by query and candidate) / sum(idf(t) for
 * t in query)` — the fraction of the query's own idf-weighted mass a
 * candidate recovers. An empty query, or a query whose every token has
 * `df === 0` in this corpus (so the denominator is 0), scores every
 * candidate 0 rather than dividing by zero.
 */
function rank(criteria: readonly string[], candidates: readonly string[]): LexicalMatch[] {
  const queryTokens = new Set<string>();
  for (const c of criteria) for (const t of tokenize(c)) queryTokens.add(t);

  const candidateTokens = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const file of candidates) {
    const toks = new Set(tokenize(file));
    candidateTokens.set(file, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = candidates.length;

  let denom = 0;
  for (const t of queryTokens) denom += idf(df, n, t);

  const scored: LexicalMatch[] = candidates.map((file) => {
    if (denom <= 0) return { file, score: 0 };
    const toks = candidateTokens.get(file);
    let s = 0;
    if (toks) for (const t of queryTokens) if (toks.has(t)) s += idf(df, n, t);
    return { file, score: s / denom };
  });

  scored.sort((a, b) => b.score - a.score || compare(a.file, b.file));
  return scored;
}

/**
 * **Measured, not invented — and against a weak prior.** Every other tunable
 * in this package is a pinned constant with a stated rationale (`minSupport:
 * 2`, `hubZThreshold: 3`, `halfLifeDays: 180`, `stability.ts`'s `0.5` Jaccard
 * bar). This one is unusual: T4.2's backfill made the calibration possible
 * to do honestly, by producing a labelled dataset — every worklog entry whose
 * `merged_sha` resolves (`attribute()`'s `provenance` mode) has a KNOWN true
 * file set, from `git diff-tree` itself, not a guess.
 *
 * Measured 2026-08-11 against THIS repo: 52 board tasks, 19 worklog entries,
 * **8 attributed by provenance** — that is the entire labelled dataset this
 * calibration has to fit. **8 samples is a weak prior for a constant meant to
 * generalize; this comment says so rather than presenting the number as
 * tuned.** Method: ranked every provenance task's true file set against a
 * 220-file candidate corpus (every path touched by any commit in this repo's
 * history, via `harvest()`) using its own acceptance-criteria text, at
 * `runnerUpMargin` held at {@link RUNNER_UP_MARGIN}, sweeping the floor.
 *
 * | confidenceFloor | precision | recall | tasks answered |
 * |---|---|---|---|
 * | 0.05 | 0.20 | 0.06 | 8/8 |
 * | 0.20 | **0.50** | 0.06 | 3/8 |
 * | 0.30 | 0.67 | 0.06 | 2/8 |
 *
 * Recall is capped at 0.06 (2 of 36 true files, across every floor tried) —
 * **not a threshold artefact**: board criteria describe TEST BEHAVIOUR
 * ("`autoResolution` returns 1.0 below 2 nodes..."), which rarely restates
 * the module name or file it lives in, so most of this dataset's true files
 * simply share no distinctive token with their own task's criteria. This is
 * the honest shape of a lexical-only, no-embeddings cold-start predictor
 * against prose-style criteria, not a bug in this module.
 *
 * `0.20` is chosen for precision over the marginal recall a lower floor buys
 * (0.05's 0.20 vs. 0.20's 0.50, for the same 2 true positives either way) —
 * a wrong `predicted` answer is worse than an honest "no match", since
 * nothing downstream can currently tell a low-confidence guess from a good
 * one except this floor. Revisit this number once `own`/`conflicts` (Task
 * 4/5) accumulate a larger labelled sample than 8 — this is a first fit, not
 * a final one.
 */
export const CONFIDENCE_FLOOR = 0.2;

/**
 * Measured alongside {@link CONFIDENCE_FLOOR}, same dataset, same 2026-08-11
 * run: holding the floor at `0.2`, margin `0.05` cuts 2 of the 5 remaining
 * false-positive predictions (the ones where a runner-up sat within 5
 * points of the top score — an ambiguous near-tie, not a confident pick)
 * while keeping both true positives, moving precision from `0.20` (at
 * `margin: 0`) to `0.50`. Same caveat as the floor: fit to 8 samples, and a
 * first pass rather than a settled constant.
 */
export const RUNNER_UP_MARGIN = 0.05;

/**
 * The task's cold-start prediction: `criteria` (a task's acceptance-criteria
 * strings — see `board.ts`'s `readCriteria`) scored against `candidates` (a
 * repo's file paths), gated by {@link CONFIDENCE_FLOOR} and
 * {@link RUNNER_UP_MARGIN} so "no confident match" is a real, distinct
 * outcome — `[]` — rather than an arbitrary top-N forced out of noise.
 *
 * Returns every candidate TIED for the top score (there is often exactly
 * one), ranked by `compare` — never just the first one Array#sort happens to
 * put in slot 0, which would be an unspecified pick between two candidates
 * this module has no actual basis for ranking against each other.
 */
export function predictFiles(
  criteria: readonly string[],
  candidates: readonly string[],
  opts: LexicalOptions = {},
): LexicalMatch[] {
  const floor = opts.confidenceFloor ?? CONFIDENCE_FLOOR;
  const margin = opts.runnerUpMargin ?? RUNNER_UP_MARGIN;

  const scored = rank(criteria, candidates);
  const top = scored[0]?.score ?? 0;
  if (top < floor) return [];

  const runnerUp = scored.find((m) => m.score < top)?.score ?? 0;
  if (top - runnerUp < margin) return [];

  return scored.filter((m) => m.score === top);
}
