---
id: TC-003
title: Set ranging mode with layout id and 0 mm tag height and read it back after reload and restart
priority: critical
type: functional
module: venue-ingest-mode
size: M
requirements: [M1-AC2, M1-AC5]
tags: [uwb-ranging-m1, api, persistence, api-tbd]
---

# TC-003: Set ranging Mode and Persist

**Module:** Venue ingest mode | **Priority:** Critical | **Type:** Functional

## Preconditions
- App is accessible at `{{base_url}}`; QA database `edgeserver_qa_m5` is in use
- Shell prelude from `README.md` is sourced in the shell (defines `$ADMIN_KEY`, `req`, `setvid`, `m1_restore`) and `export BASE={{base_url}}` has been run
- Pre-existing records: venue anchors `A1`, `A2`, `A3`, `A4` (deck, z=1.5 m); venue is in `tdoa` mode with no vendor ids set (verified in step 1)
- No match session is LIVE or SUSPENDED (`GET {{base_url}}/api/ops/session` state is not LIVE/SUSPENDED)
- Mode endpoint is assumed to be `PUT /api/ops/venue/mode` with fields `ingest_mode`, `layout_id`, `tag_reference_height_mm` (confirm names against the built OpenAPI at `{{base_url}}/docs`)

## Test Data

| Field | Value |
|-------|-------|
| ingest_mode | ranging |
| layout_id | pool-layout-20260930-r3 |
| tag_reference_height_mm | 0 |
| vendor_anchor_id for A1..A4 | 0, 1, 2, 3 |

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run `setvid A1 0; setvid A2 1; setvid A3 2; setvid A4 3` | each call prints `HTTP 200` |
| 2 | Run `req -X PUT {{base_url}}/api/ops/venue/mode -d '{"ingest_mode":"ranging","layout_id":"pool-layout-20260930-r3","tag_reference_height_mm":0}'` | `HTTP 200`; body has `"ingest_mode":"ranging"`, `"layout_id":"pool-layout-20260930-r3"`, `"tag_reference_height_mm":0` (0 is returned as 0, not null/omitted) |
| 3 | Run `req {{base_url}}/api/ops/venue` (fresh request, new connection) | `HTTP 200`; same three values as step 2 |
| 4 | Restart the edge process (operator action) and wait for `{{base_url}}/health` to return 200, then rerun step 3 | `HTTP 200`; same three values; `vendor_anchor_id` still 0..3 on A1..A4 |

## Expected Final State
Venue is in ranging mode with layout_id `pool-layout-20260930-r3` and tag reference height 0 mm, identical before and after the restart.

## Teardown
- Run `m1_restore`
