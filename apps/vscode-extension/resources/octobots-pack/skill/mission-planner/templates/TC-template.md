---
id: TC-001
title: "<one line: what this case proves>"
mission: M1
covers: [M1-AC1]
kind: cli
status: draft
---

# TC-001: <one line: what this case proves>

<!--
Copy this file to .octobots/campaigns/<campaign>/tests/m<n>/TC-NNN_<slug>.md (the id must equal the
filename prefix before the first "_"; mission must be the folder token upper-cased, m3b -> M3b).
Delete this comment. Frontmatter contract:
  id       ^TC-\d{3,}$
  mission  M<n>, the mission whose folder holds this file
  covers   non-empty list of <mission>-AC<k> ids of THIS mission
  kind     api | ui | cli | unit
  status   draft | ready | pass | fail | blocked | unknown
  last_run optional { date: YYYY-MM-DD, evidence: <repo-relative RUN file> }
Other keys (priority, size, tags) are allowed. Keep `## Steps` and `## Expected Final State`.
-->

## Objective

What behaviour this case verifies, and which acceptance criterion it covers.

## Preconditions

- What must be true before the first step (build, services, accounts).

## Real data (pre-existing record)

The record that already exists and backs this case. Say UNREACHABLE rather than fabricate one.

## Commands

```bash
# the exact commands, runnable as written
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | | |

## Expected Final State

What is true when the case has passed.

## Teardown

What to remove or restore afterwards (the case works on copies; originals stay untouched).
