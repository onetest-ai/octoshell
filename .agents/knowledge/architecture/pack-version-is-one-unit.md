---
name: Editing any pack payload obliges a whole-pack version bump across nine markers, a regenerated bundle and a recorded hash
description: packStatus calls the pack out of date unless every marker equals OCTOBOTS_PACK_VERSION, so a one-line SKILL.md edit drags eight other files with it; the pieces are each documented, the obligation as a whole is not.
type: reference
applies_to: [js-dev, tech-lead, qa-engineer, project-manager]
verified: 2026-08-13
aliases: [pack version bump, OCTOBOTS_PACK_VERSION, pack markers, version cohort]
tags: [area/pack, area/extension]
---

## The fact

`packStatus` (`apps/vscode-extension/src/host/octobots-skill.ts`) reports a workspace's pack
up-to-date only when **every** marker equals `OCTOBOTS_PACK_VERSION`. There is no partial state and
no per-file versioning: the pack is one unit. So changing a single line of any pack payload obliges
all of this, in the same PR:

| # | File | How it moves |
|---|---|---|
| 1 | `src/host/octobots-skill.ts` — `OCTOBOTS_PACK_VERSION` | by hand |
| 2–6 | `resources/octobots-pack/skill/*/SKILL.md` — frontmatter `version:`, **all five** | by hand |
| 7 | `resources/octobots-pack/hooks/primer.mjs` — `// octobots-pack-version:` | by hand |
| 8 | `resources/octobots-pack/tokenomics/run.mjs` — same banner | by hand |
| 9 | `resources/octobots-pack/tokenomics/backfill-worklog-sha.mjs` — same banner | by hand |
| 10 | `resources/octobots-pack/graph/octograph.mjs` | **machine-stamped** — `node scripts/graph-payload.mjs --write` from `apps/vscode-extension/`; never hand-edit its banner |
| 11 | `apps/vscode-extension/scripts/graph-payload-versions.json` | a **new** entry `"<version>": "<sha256 of the regenerated payload>"`; leave prior entries untouched |

Two tests enforce it, and they fail for different reasons: `octobots-skill.test.ts` parameterises
its convention cases over `OCTOBOTS_SKILLS`, so a stale `SKILL.md` version fails by skill name;
`graph-payload.test.ts` fails if the payload's bytes are not recorded against the *current* version.

Adding a skill also means adding its directory name to `OCTOBOTS_SKILLS` — the roster is an explicit
list, and a skill absent from it is simply never installed and never tested, silently.

## Why it matters / what it costs to get wrong

The failure is silent on the shipping side and loud on the CI side, which is the wrong way round.

- Miss **one** hand-edited marker: `packStatus().upToDate` goes false, so every workspace that
  already installed the pack is told it is out of date — including workspaces that are, in fact,
  running the current payload.
- Miss the **payload regeneration or the hash**: the reverse. `graphStatus` compares only the
  banner integer, so every workspace keeps running a stale `octograph.mjs` indefinitely, is never
  prompted to upgrade, and nothing anywhere says so. `graph-payload-versions.json`'s own `_why` key
  documents this specific hole and exists to close it.
- **`js-dev`** editing a `SKILL.md` for a one-line doctrine fix ships an eleven-file diff. That is
  correct, not scope creep — a reviewer who asks for it to be narrowed is asking for a red CI run.
- **`tech-lead`** reviewing any diff that touches `resources/octobots-pack/` should check the
  cohort moved as a unit before approving.
- **`qa-engineer`**: the install path is only genuinely covered when all eleven are consistent;
  `packStatus(repo).upToDate === true` after `installPack` is the assertion that proves it.

The individual pieces *are* documented — in `graph-payload-versions.json`'s `_why`, in
`graph-payload.test.ts`'s regression comment, in `octobots-skill.ts`'s doc comments. **Nothing
states the obligation as one thing**, which is why it is rediscovered per-author rather than known.

## How this was verified

2026-08-13 — lived end to end while adding the `knowledge-explorer` skill (pack 49 → 50, PR #95).
Adding `"knowledge-explorer"` to `OCTOBOTS_SKILLS` turned 26 of 47 cases in
`octobots-skill.test.ts` red; bumping the nine hand-edited markers, regenerating the payload with
`node scripts/graph-payload.mjs --write` (banner confirmed at `// octobots-pack-version: 50`) and
recording `5d45b4fe…` in `graph-payload-versions.json` returned the extension suite to 401 passing.

Independently surfaced the same cohort from git history, before touching any of it:

```
$ octograph impact apps/…/octobots-pack/skill/workflow-designer/SKILL.md
…/hooks/primer.mjs                          npmi=0.646  support=19
src/host/octobots-skill.ts                  npmi=0.646  support=19
…/tokenomics/run.mjs                        npmi=0.460  support=11
…/graph/octograph.mjs                       npmi=0.359  support=8
…/tokenomics/backfill-worklog-sha.mjs       npmi=0.359  support=8
scripts/graph-payload-versions.json         npmi=0.359  support=8
```

Nineteen and twenty commits of support — these files have moved together nearly every time any of
them moved. No text search reaches this: the cohort shares no token with the change that triggers
it. Recorded in full at
`docs/superpowers/spikes/2026-08-13-knowledge-explorer-vs-issue-60.md`.

Related: [[dual-schema-entity-io]] — the other pack coupling that no import edge expresses. That one
is enforced by a comment; this one is enforced by two tests, which is why it fails loudly instead of
corrupting data.
