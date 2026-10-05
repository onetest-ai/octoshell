---
id: TC-010
title: "Repo gates green, coverage:pack passes, payload regenerated with a visible 57 hash line, parity holds"
mission: M6
covers: [M6-AC7]
kind: cli
status: draft
priority: high
size: S
---

# TC-010: Repo gates green, coverage:pack passes, payload regenerated with a visible 57 hash line, parity holds

**Mission:** M6 | **Priority:** high | **Kind:** cli | **Covers:** M6-AC7

## Objective

Repo gates green, coverage:pack passes, payload regenerated with a visible 57 hash line, parity holds. Verifies M6-AC7 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real octoshell repo on the mission branch

## Commands

```bash
cd $OCTO && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm coverage && pnpm coverage:pack
git diff origin/feat/direct-dispatch-process -- apps/vscode-extension/scripts/graph-payload-versions.json | grep '^[+-].*"57"'
jq '.dependencies' apps/vscode-extension/package.json | diff - <(git show origin/main:apps/vscode-extension/package.json | jq '.dependencies') && echo NO_NEW_RUNTIME_DEPS
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run every gate | All green; coverage:pack meets 90/90/90/70 |
| 2 | Diff the versions json against the campaign branch | One changed line: the 57 hash |
| 3 | Compare runtime dependencies | No new runtime dependency |
| 4 | Run the validate parity test | Green |

## Expected Final State

No regressions; payload pinned.
