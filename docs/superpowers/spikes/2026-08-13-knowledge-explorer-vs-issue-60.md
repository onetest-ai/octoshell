# knowledge-explorer measured against issue #60

**Date:** 2026-08-13
**Repository:** octoshell @ `feat/knowledge-explorer-skill`
**Instrument:** `apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs` (pack v50)

Issue [#60](https://github.com/onetest-ai/octoshell/issues/60) asks to drop the
one-workflow-per-mission restriction. Its author listed four files. The question this spike answers
is not "can the skill find those four" — the issue already names them — but **what the issue's own
careful, grep-armed author missed, and whether the skill finds it.**

## The true change set

Established by reading, after both runs:

| # | File | Named by the issue? |
|---|---|---|
| 1 | `…/octobots-pack/skill/mission-planner/scripts/add-workflow.js` — the guard at :59 and the comment at :6 | yes |
| 2 | `…/octobots-pack/skill/mission-planner/scripts/validate.js` — the check at :102 and the comment at :91 | yes |
| 3 | `…/octobots-pack/skill/workflow-designer/SKILL.md` — the doctrine line | yes |
| 4 | `…/octobots-pack/skill/mission-planner/SKILL.md` — the doctrine line | yes |
| 5 | **`packages/board/src/validate.ts:321`** — the same rule, in TypeScript | **no** |
| 6 | **`packages/board/test/validate.test.ts:210`** — the test pinning it | **no** |
| 7 | **The pack version-bump cohort** — `src/host/octobots-skill.ts`, the banners in `hooks/primer.mjs` / `tokenomics/run.mjs` / `tokenomics/backfill-worklog-sha.mjs`, the regenerated `graph/octograph.mjs`, and a new hash in `scripts/graph-payload-versions.json` | **no** |

Item 5 is the sharpest miss. The issue argues *"`BoardModel` already stores an array — only the
board-writing scripts enforce one"*, and that is not true: `packages/board/src/validate.ts` carries
the identical rule and the identical message. Acting on the issue as written ships a fix whose own
validator still rejects the thing it just permitted.

Item 7 is the one nobody would write down. Editing any pack `SKILL.md` obliges the whole-pack
version ritual — nine markers, a regenerated bundle and a recorded hash — or `packStatus` reports
every installed workspace as out of date. (Confirmed the hard way while shipping this very skill.)

## Baseline — grep only

```bash
grep -rn "at most one" --include=*.js --include=*.ts --include=*.md .
grep -rn "more than one workflow" .
```

Finds **items 1–6**. It finds item 5 only because `validate.ts` happens to reuse the exact doctrine
phrase `a mission may have at most one`, and item 6 because the test asserts on the message text.
Change either wording and the grep stops finding them.

Finds **nothing of item 7** — no file in that cohort contains the phrase, the word `workflow`, or
any other token connected to the change.

Cost: 2 tool calls.

## Skill run — tier 1, then tier 2

**Tier 1.** `grep -ril workflow .agents/knowledge/` returns four notes, none about workflow
cardinality. The vault has nothing to say here. Recorded and moved on — this is the expected common
case for a young vault, and the skill treats an empty tier 1 as an answer, not a failure.

**Tier 2.** `doctor` → `degraded`: 31 analysable commits, 34 of 44 look like squashed PRs. Every
zero below is read under that.

```
$ impact …/octobots-pack/skill/mission-planner/scripts/validate.js
packages/board/src/validate.ts                 npmi=0.857  support=2   ← item 5, rank 1
…/mission-planner/scripts/show.js              npmi=0.853  support=2
packages/board/src/write.ts                    npmi=0.704  support=3
packages/board/src/types.ts                    npmi=0.710  support=2
packages/board/test/scripts-smoke.test.ts      npmi=0.599  support=2
…all four pack SKILL.md files…

$ impact …/octobots-pack/skill/workflow-designer/SKILL.md
…/mission-completion-gate/SKILL.md             npmi=0.905  support=20
…/mission-execution/SKILL.md                   npmi=0.730  support=20
…/mission-planner/SKILL.md                     npmi=0.730  support=20
…/hooks/primer.mjs                             npmi=0.646  support=19  ← item 7
apps/vscode-extension/src/host/octobots-skill.ts  npmi=0.646 support=19 ← item 7
…/tokenomics/run.mjs                           npmi=0.460  support=11  ← item 7
…/graph/octograph.mjs                          npmi=0.359  support=8   ← item 7
…/tokenomics/backfill-worklog-sha.mjs          npmi=0.359  support=8   ← item 7
apps/vscode-extension/scripts/graph-payload-versions.json  npmi=0.359 support=8  ← item 7

$ impact …/octobots-pack/skill/mission-planner/scripts/add-workflow.js
(no coupled files)
```

`drift` independently ranks `…/scripts/validate.js ↔ packages/board/src/validate.ts` as a
cross-module pair (`npmi=0.860`, `support=2`), which is item 5 again from a different direction.

Cost: 5 tool calls (1 vault grep, 1 `doctor`, 3 queries).

## Pass condition 1 — did the footprint cover the change set?

**Partially, and not where I predicted.**

- Items 1–4: found by both.
- **Item 5: found by both**, and by the graph at rank 1 with the strongest score in the result.
  The graph did not need the phrase to match — but grep found it anyway, because the phrase happened
  to be copied verbatim into `validate.ts`. Two independent routes to the same file, which is the
  correct outcome and not a win for either.
- **Item 6: the graph missed it.** `impact` returned `packages/board/test/scripts-smoke.test.ts`,
  a neighbouring test, but never `packages/board/test/validate.test.ts`. Grep found it directly.
  The skill's own "verify by reading" step recovers it — opening `validate.ts:321` and searching its
  message reaches the test — but that is the procedure compensating, not the instrument working.
- **Item 7: only the graph found it**, at `support=19–20` — the strongest evidence anywhere in this
  spike, and completely invisible to text search. Nothing in `octobots-skill.ts` or
  `graph-payload-versions.json` shares a token with the change.

**The honest summary: grep wins on the textual rule sites, the graph wins on the process cohort.**
The graph's contribution here is not "find the other file that says the same thing" — a good grep
does that more cheaply. It is *"changing this kind of file obliges this ritual"*, a coupling that
exists only in commit history and cannot be expressed as a search term. Item 7 is precisely the
class of miss that ships a red CI run.

## Pass condition 2 — were zeros reported as invisibility, not absence?

**Yes, and it caught a cause I had not anticipated.**

`impact` on `add-workflow.js` returned `(no coupled files)`. Applying the skill's three-cause rule:

- excluded? No — `apps/…` is not in `excludePaths`.
- untracked? No — `git log --oneline -- <path> | wc -l` → **3 commits**.
- below `minSupport`? **Yes.** Three commits, none pairing repeatedly.

So the zero is *thin evidence*, reported as such. The design doc predicted the excluded-path cause
(#1) would be the one exercised; the real run hit the support-floor cause (#3). The rule
discriminated correctly, which is the thing being tested.

The excluded-path cause is still real and still silent — `impact .claude/skills/…/validate.js`
returns the same `(no coupled files)` as a genuinely uncoupled file — but see the correction below:
in this repository those paths are install output, not change targets.

## Correction to the design doc

`docs/superpowers/specs/2026-08-13-knowledge-explorer-design.md` states the #60 change set includes
`add-workflow.js` and `validate.js` "each in two copies (`resources/octobots-pack/…` and the
installed `.claude/…`)". **That is wrong for octoshell.** `.claude/` is gitignored here and its
contents are regenerated by `installPack`; the pack directory is the only source. The doubling is
real in a *consumer* repository that vendors the pack — which is where #60 was originally hit
(`onetest-ai/octoweb`) — but it is not part of this repository's change set. The spec has been
corrected.

## What the skill got wrong

1. **It found item 6 by procedure, not by instrument.** A reader who skipped the "verify by reading"
   step would have shipped without the test update. The step is not optional and the skill says so,
   but the graph offered no signal toward it.
2. **`impact` on a `SKILL.md` returns the version cohort, which is right, and also returns every
   sibling `SKILL.md` at `support=20`, which is noise for this question.** Four of the top rows are
   "pack files change together", true and unhelpful. The skill's budget rule limits the damage; it
   does not eliminate it.
3. **Two of three `impact` queries were needed to reach item 7, and I only ran the second one
   because the first came back empty.** Nothing in the skill told a reader to query a *doctrine*
   file as well as a *code* file — a real gap in the query ladder. **Closed:** the ladder now says
   to run `impact` on both, and cites this measurement as the reason. A sample of one, but the
   mechanism it exposes is not accidental — process obligations attach to a *kind* of file, and are
   therefore reachable only from that file, never from the change that triggers them.

The version-bump cohort has since been promoted to
[`.agents/knowledge/architecture/pack-version-is-one-unit.md`](../../../.agents/knowledge/architecture/pack-version-is-one-unit.md),
which closes the skill's own loop: the next reader gets item 7 from tier 1 without paying for a
graph query at all.

## Verdict

The skill passes condition 2 outright and condition 1 with a documented gap. Its measured value on
this issue is **item 7** — a seven-file obligation that no text search can reach and that the
issue's author, working carefully, did not see.
