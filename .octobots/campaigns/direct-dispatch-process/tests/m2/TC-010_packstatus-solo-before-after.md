---
id: TC-010
title: "packStatus on the solo copy: not up to date before install (57-local unparseable), up to date after"
mission: M2
covers: [M2-AC2]
kind: unit
status: draft
priority: medium
size: S
---

# TC-010: packStatus on the solo copy: not up to date before install (57-local unparseable), up to date after

**Mission:** M2 | **Priority:** medium | **Kind:** unit | **Covers:** M2-AC2

## Objective

packStatus on the solo copy: not up to date before install (57-local unparseable), up to date after. Verifies M2-AC2 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copy of solo's real `.claude/skills` with the two `version: 57-local` forks

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension test -- octobots-skill
# the case points packStatus at a copy of solo's real skills dir (read from the real tree at test time), before and after installPack
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | packStatus on the unmodified solo copy | installed: false / upToDate: false (57-local parses to null) |
| 2 | installPack, then packStatus | upToDate: true; every skill version is 57 |

## Expected Final State

The activation prompt is correct for solo before and after the upgrade.
