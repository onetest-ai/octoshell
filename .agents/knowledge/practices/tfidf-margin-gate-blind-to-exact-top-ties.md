---
name: a runner-up margin gate that only compares against a DIFFERENT score misses an exact tie for the top spot
description: a tf-idf confidence gate written as `scored.find(s => s.score !== top.score)` cannot see two-or-more-way ties at rank 1 — one candidate wins arbitrarily by sort tie-break instead of the match being rejected as ambiguous
type: reference
applies_to: [js-dev, tech-lead, qa-engineer]
verified: 2026-08-13
aliases: [runner-up margin blind spot, exact tie at rank 1, matchPredicted tie bug, confidence gate tie detection]
tags: [area/graph, practices/text-matching]
---

## The fact

A "runner-up margin" confidence gate — reject a match if the top score isn't comfortably ahead of
the next-best score — is only as good as how it finds "the next-best score". The natural
implementation,

```ts
const next = scored.find((s) => s.score !== top.score);
if (next !== undefined && top.score - next.score < margin) continue;
```

only ever looks for a candidate with a **different** score. If two or more candidates tie EXACTLY
for the top score, `next` resolves to the first candidate with a **lower** score (or `undefined` if
every candidate is tied), so the tie at rank 1 — the single most ambiguous case a margin gate exists
to catch — is invisible to it. One of the tied candidates wins by whatever the stable-sort
tie-break happens to be (alphabetical, insertion order, etc.), and that winner is presented as a
confident single answer.

**Verified 2026-08-13**, building `packages/graph/src/vault.ts`'s `matchPredicted` (T4.6 /
octograph M4, path→note direction): calibrating against this repo's own real
`.agents/knowledge/` vault (15 notes) surfaced this concretely. A generic path basename like
`README.md` tied EVERY note in the vault at the exact same score, because every note's own
filename ends in `.md` and that single shared token was enough to clear the default confidence
floor for all 15 — a 15-way tie the margin gate, as originally written, let straight through. A
narrower 2-way tie did the same for a real sample path
(`packages/board/src/write.ts`): it "matched" a `packages/graph`-specific note that has nothing to
do with `packages/board`, purely because that note happened to sort ahead of the note it was tied
with alphabetically. The result LOOKED plausible on manual inspection — which is exactly what made
it dangerous; only comparing it against the raw tied scores (not the single winning answer) showed
the win was arbitrary.

## The fix

Check for a tie AT THE TOP explicitly, before (or instead of) the distinct-score margin check:

```ts
const tiedAtTop = scored.filter((s) => s.score === top.score).length;
if (tiedAtTop > 1) continue; // no candidate wins over another — that IS the ambiguity
```

This is the correct generalization: a distinct near-tied runner-up is a coin flip, and an EXACT
tie at rank 1 is the same coin flip with worse odds (2+ equally-likely answers, not "one clear
answer with a close second"). Reject both.

## Why it matters

Any future confidence-gated ranking in this codebase (or a new one modeled on `lexical.ts`'s
pattern) that writes its margin check as "find a candidate with a different score" will have this
exact blind spot. It is invisible on a hand-built test fixture with only 2–3 candidates (unlikely
to tie by chance) and only shows up against a REAL, larger corpus where shared vocabulary — an
extension, a common word, a directory name — is common enough to produce genuine ties. Same shape
as [[knowledge-vault-sentence-filenames-confound-lexical-matching]]: a defect invisible on a
synthetic fixture, real against the actual vault.

## How this was verified

Disabled the tie-detection guard (`if (false && tiedAtTop > 1)`), confirmed a regression test
failed for the right reason (returned an arbitrary tied winner instead of `[]`), re-enabled the
guard, confirmed green. Full suite (592 tests), typecheck, and lint all pass with the fix in place.
See `packages/graph/test/vault.test.ts`'s `"returns nothing when two notes tie exactly for the top
score"` and the full calibration table in
`.superpowers/sdd/2026-08-13-octograph-diff-impact-and-vault-tier/task-3-report.md` (local, not
committed — that directory is gitignored repo-wide).

Related: [[knowledge-vault-sentence-filenames-confound-lexical-matching]] — the sibling confound in
the opposite matching direction (criteria→file vs. this note's path→note), both surfaced only by
calibrating against this repo's real vault rather than a synthetic fixture.
