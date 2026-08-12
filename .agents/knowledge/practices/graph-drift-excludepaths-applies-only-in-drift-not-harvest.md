---
name: graph excludePaths applies only inside drift(), never harvest/analyze/impact
description: octograph.yaml's excludePaths key filters only what drift() ranks — clustering, the module map, and impact() all still see the excluded paths, on purpose
type: reference
created: 2026-08-12
updated: 2026-08-12
aliases: [excludePaths, isExcludedPath, tooling-state noise in drift, .agents/ .claude/ .octobots/ exclusion]
tags: [area/graph, practices/design-decision]
---

## The fact

`Config.excludePaths` (`packages/graph/src/config.ts`, default `[".agents/", ".claude/",
".octobots/"]`) is a repo-relative path-prefix list, matched by `isExcludedPath` (`noise.ts`,
segment-bounded the same way `isTestPath` is — `.claude` does not swallow `.claudefoo/`). It is
threaded through as `drift()`'s 6th parameter (`drift.ts`) and read there **only**. `harvest`,
`analyze`, `impact`, clustering, and the rendered module map (`map.md`) are all unaffected — they
still see every excluded path.

**Verified 2026-08-12**, filing bugs against `octoweb`: 5 of `drift`'s top-10 rows named an
`.agents/` or `.claude/` path (agent working notes co-changing with the code they document, which
has nothing to do with architecture) — confirmed gone from even the top 20 after the fix, while
`octograph impact ".agents/memory/python-dev/daily/2026-06-12.md"` still lists its real co-change
partners afterward, proving the split held.

## Why it matters

The exclusion is deliberately scoped to the one command asking "what coupling does the declared
architecture fail to explain" (`drift`), not to the command asking "what else should I update when
I touch this file" (`impact`) — an agent's own notes co-changing with the code they document is
exactly the kind of answer `impact` exists to surface, and filtering it out at `harvest` (which
would strip it from *everything*, including `impact` and clustering) would have removed the one
place that signal is genuinely useful. Anyone extending `excludePaths` to a new consumer should
re-read `drift.ts`'s own doc comment on the parameter before doing so — the placement is a decision,
not an oversight, and moving it up to `harvest`/`analyze` silently removes it from `impact` too.

The default does **not** cover `CLAUDE.md` — documentation co-change is a real fact about a repo's
architecture, and the tool does not get to decide someone's docs aren't part of it. A repo whose
`CLAUDE.md` pairs dominate `drift` output the way octoweb's tooling-state paths did can add doc
paths to its own `excludePaths` list explicitly; `octograph.yaml` documents this with the octoweb
measurement inline, the same "reasoning behind every number" voice every other key in that file
already uses.

## Where

`packages/graph/src/drift.ts` (the `excludePaths` parameter and its doc comment),
`packages/graph/src/noise.ts` (`isExcludedPath`), `packages/graph/src/config.ts` (`Config.excludePaths`,
the first list-valued key — validated "wrong shape degrades to default, no partial application",
same spirit as every NUMERIC key). Root `octograph.yaml` documents the key and the octoweb
measurement. `packages/graph/test/drift.test.ts`'s `excludePaths` describe block and
`packages/graph/test/config.test.ts`'s `excludePaths` describe block pin the behaviour.
