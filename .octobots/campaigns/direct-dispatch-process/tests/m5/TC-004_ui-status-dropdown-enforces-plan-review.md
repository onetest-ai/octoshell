---
id: TC-004
title: "Status dropdown: modal confirm on solo M10; Cancel leaves the YAML byte-identical, Confirm flips and records; legacy uwb and strict records flip with no dialog and no message"
mission: M5
covers: [M5-AC2]
kind: ui
status: blocked
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m5/runs/RUN-2026-10-06-001.md}
priority: critical
size: L
---

# TC-004: Status dropdown: modal confirm on solo M10; Cancel leaves the YAML byte-identical, Confirm flips and records; legacy uwb and strict records flip with no dialog and no message

**Mission:** M5 | **Priority:** critical | **Kind:** ui | **Covers:** M5-AC2

## Objective

The extension enforces the same rule as the script: a modal confirm for a gated move with no review, and nothing at all for an allowed one (campaign decision 12: no extension message for the legacy warning). Verifies M5-AC2 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies. For the manual half make a workspace folder: `mkdir -p $WORK/solo-ws && cp -R $SOLO/.octobots $WORK/solo-ws/`. Answer "Not now" to the pack install prompt.

## Real data (pre-existing record)

A copy of solo's `.octobots`: epic-013 M10 (draft, no plan review anywhere) and uwb-ranging-ingest-vendor-v01 M5 'M5 - Emulator v01 gateway and end-to-end ranging match' (cancelled; its campaign notes hold the legacy heading-only record `## Plan review (Alex + Rio, 2026-10-02)`).

## Commands

```bash
# automated half: BoardHost and the rpc handler over the real copy, stubbed dialog.confirm
cd $OCTO && OCTOBOTS_BOARD_COPIES=$WORK/solo-octobots pnpm --filter @octoshell/vscode-extension exec vitest run test/board-host.test.ts test/rpc-dispatcher.test.ts --reporter=verbose
# manual half: F5 on $OCTO with $WORK/solo-ws as the workspace; screenshots to tests/m5/evidence/
M=$WORK/solo-ws/.octobots/campaigns/epic-013-ruleset-and-interval-retention/missions/m10-setup-flow-preset-and-exception-authorization
shasum -a 256 $M/mission.yaml > $WORK/m10-ui.sha     # before step 2; check with: shasum -a 256 -c $WORK/m10-ui.sha
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the two vitest files | At least 1 test passed in each file, none failed |
| 2 | Manual: on M10's panel choose Executing in the status dropdown | A modal names the missing plan review (no `## Plan review` section in the mission or campaign notes) with the confirm button and Cancel |
| 3 | Cancel | `shasum -c` OK (YAML byte-identical); the dropdown shows Draft again |
| 4 | Choose Executing again and Confirm | Status reads Executing; the notes gain `## Plan review overridden (<today UTC>)` with "confirmed in the extension's status dropdown" |
| 5 | On uwb M5 (cancelled) choose Executing | Flips with no dialog, and no notification, Problems-panel entry or output-channel line appears |
| 6 | On M10 choose Awaiting approval, then Done | No dialog (only moves into executing are gated) |

## Expected Final State

UI enforcement matches the script. The manual half is recorded as manual with screenshots (not Playwright-drivable).
