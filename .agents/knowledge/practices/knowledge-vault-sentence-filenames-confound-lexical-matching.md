---
name: this repo's sentence-named knowledge files confound lexical/text matching
description: >-
  .agents/knowledge/**/*.md filenames are full English sentences
  (graph-fixture-map-output-must-be-gitignored-before-a-second-run.md), so any
  tf-idf/token-overlap matcher scored against English prose (acceptance
  criteria, issue text, commit messages) will rank them above real source
  files unless prose stopwords are filtered out of the query first.
type: practices
verified: 2026-08-11
aliases: [lexical matching confound, tf-idf stopwords, sentence-named markdown files]
tags: [area/graph, area/testing, practices/text-matching]
---

## The fact

`.agents/knowledge/`'s own filename convention names every note as a compressed English sentence
(`graph-fixture-two-module-boundary-needs-a-third-unrelated-component.md`,
`octograph-design-md-snippets-vs-conventions-test.md`). Tokenized the same way a source file's path
would be (split on `/`, `.`, `-`, `_`, camelCase), these filenames carry dozens of ordinary English
words — `must`, `before`, `a`, `second`, `run`. Any candidate corpus that includes this directory
(e.g. `harvest()`'s full list of every path ever touched by a commit) hands a text-similarity
matcher a set of "documents" that are, token-for-token, closer to natural-language prose than a
typical `src/*.ts` path is.

**Verified 2026-08-11**, building `packages/graph/src/lexical.ts` (T4.3, octograph M4): calibrating
a tf-idf token-overlap predictor (acceptance-criteria text -> candidate file path) against this
repo's own 8 provenance-attributed tasks, a first pass with no stopword filtering put a
`.agents/knowledge/**/*.md` file as the #1-ranked candidate for 5 of 8 tasks — every one where the
true file was actual source code the criteria never named directly. The knowledge note's ONLY
connection to the task was sharing ordinary English vocabulary with its acceptance-criteria prose
("given", "must", "not", "before"), not any topical relationship.

## The fix

A short, closed English-stopword list (articles, prepositions, conjunctions, auxiliary verbs, plus
the handful of verbs board criteria are conventionally written with — "given", "returns", "must")
applied to BOTH the query and the corpus before tf-idf scoring. `lexical.ts`'s `STOPWORDS` constant
and `tokenize()` are the reference implementation.

## Why it matters

Any future feature that lexically matches free text (issue bodies, PR descriptions, commit
messages, chat prompts) against this repo's own file corpus will hit the same confound if it
includes `.agents/knowledge/` (or anything else named as prose — should a future convention do the
same under `docs/` or elsewhere) in its candidate set without stopword filtering. The trap is
invisible on a small hand-built test fixture (which never contains a sentence-named file) and only
shows up against this repo's REAL corpus — exactly the "passes on a synthetic fixture, fails against
the real thing" shape several other `graph` package findings in this directory already document.

Related: [[octograph-design-md-snippets-vs-conventions-test]] — a different flavor of "a design
artifact/convention in this repo trips code that wasn't written with it in mind."
