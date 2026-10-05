---
id: TC-005
title: "A restored octoshell.workflow panel from a pre-upgrade session closes silently"
mission: M3
covers: [M3-AC5]
kind: ui
status: draft
priority: medium
size: M
---

# TC-005: A restored octoshell.workflow panel from a pre-upgrade session closes silently

**Mission:** M3 | **Priority:** medium | **Kind:** ui | **Covers:** M3-AC5

## Objective

A restored octoshell.workflow panel from a pre-upgrade session closes silently. Verifies M3-AC5 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

a real workflow panel opened on octoshell's octograph m6 workflow with extension 0.0.51 before upgrading

## Commands

```bash
# manual (Extension Development Host): 1) install 0.0.51, open $OCTO, open the build-and-gate workflow panel; 2) leave it open, upgrade to the M3 build; 3) reload the window.
# automated half:
cd $OCTO && pnpm --filter @octoshell/vscode-extension test -- panel-serializer
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | On 0.0.51 open a workflow panel on octoshell's octograph campaign and leave it open | Panel visible |
| 2 | Upgrade to the M3 build and reload the window | Panel is restored then disposed |
| 3 | Look for notifications and the Developer console | No error notification; no unhandled error in the console |
| 4 | Run the serializer unit test | Green: deserialize disposes the panel |

## Expected Final State

Silent disposal. Recorded as MANUAL with screenshots in evidence/ (not Playwright-drivable).
