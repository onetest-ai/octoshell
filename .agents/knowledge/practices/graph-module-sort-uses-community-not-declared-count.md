---
name: graph module sort key is community size, not declared member count
description: packages/graph's analyze() orders modules[] by Louvain-community size, not by the declared membership that ends up in .members — a fixture that grows only declared membership never reorders
type: reference
created: 2026-08-10
updated: 2026-08-10
aliases: [module sort order, ModuleSummary array position, merged vs declaredMembers]
tags: [area/graph, practices/testing]
---

## The fact

In `packages/graph/src/analyze.ts`, the final `modules` array is sorted with:

```ts
.sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]))
```

`b[1]`/`a[1]` here is `merged`'s value — the **Louvain-community accumulated id list**
(pre-reconciliation) — NOT `declaredMembers.get(name)`, which is what actually becomes each row's
`.members` (and its `.members.length`). The two counts usually track each other, but they are
computed independently and can diverge. `analyze.ts` documents this itself, right above the sort,
as an intentional (if "now cosmetic") inconsistency, not a bug to fix opportunistically.

**Verified 2026-08-10**, building T3.4 (cluster-id stability): a test fixture that grows a
module's *declared* membership (new files committed under its directory) without giving each new
file-pair 2+ commits (`config.minSupport`, default 2) never earns a co-change edge for those files.
With no edge, the growth never joins any Louvain community, so `merged`'s count for that module
does not change and the array position does not move — even though `.members.length` genuinely
grew. Confirmed by a throwaway debug script calling `analyze()` twice and logging
`{id, name, n: members.length}` per module before and after.

## Why it matters

Any test (or future CLI code) that assumes "the module with the most declared files sorts first"
is assuming something `analyze()` does not currently guarantee. To reorder the array in a test
fixture, the growth must produce real co-change **edges** (each new pair committed at least
`minSupport` times), not just new files under the directory — declared-membership growth alone is
invisible to the sort.

## Where

`packages/graph/src/analyze.ts`, the `preliminary`/`modules` build step (search for
`b[1].length - a[1].length`). See also `Analysis.clusterIds` (T3.4, PR #47) for a case that had to
work around this precisely to test id stability across a real reorder.
