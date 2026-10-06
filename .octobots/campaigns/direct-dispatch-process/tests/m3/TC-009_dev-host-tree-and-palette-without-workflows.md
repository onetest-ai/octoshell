---
id: TC-009
title: "Dev host on the octoshell repo: tree shows octograph M6 without a workflow child; no 'New Workflow'; M6 panel opens"
mission: M3
covers: [M3-AC4, M3-AC2]
kind: ui
status: blocked
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m3/runs/RUN-2026-10-05-001.md}
priority: high
size: M
---

# TC-009: Dev host on the octoshell repo: tree shows octograph M6 without a workflow child; no 'New Workflow'; M6 panel opens

**Mission:** M3 | **Priority:** high | **Kind:** ui | **Covers:** M3-AC4, M3-AC2

## Objective

Dev host on the octoshell repo: tree shows octograph M6 without a workflow child; no 'New Workflow'; M6 panel opens. Verifies M3-AC4 and M3-AC2 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

octoshell's real octograph campaign, mission m6-extension-bridge (has workflows/build-and-gate on disk)

## Commands

```bash
# manual: from $OCTO press F5; in the Dev Host open $OCTO. Screenshots to tests/m3/evidence/.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Open the Octoshell sidebar; expand Octograph > M6 | Tasks and bugs listed; no workflow child although workflows/build-and-gate exists on disk |
| 2 | Open the command palette and type 'Workflow' | No 'New Workflow'/'Delete Workflow'; 'Octobots: Install Octobots Pack' is present |
| 3 | Open the M6 mission panel | Opens without error; documents, criteria and notes render |

## Expected Final State

No workflow surface remains, and the leftover folder on disk does not surface in the tree or palette. Recorded as MANUAL. (The validate warning for the folder is M3-AC3, checked by TC-006; the extension does not show it.)
