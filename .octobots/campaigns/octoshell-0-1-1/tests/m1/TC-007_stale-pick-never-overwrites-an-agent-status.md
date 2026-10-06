---
id: TC-007
title: "A pick made on a panel that has not yet seen an agent's write is refused and the agent's status survives"
mission: M1
covers: [M1-AC4]
kind: ui
status: blocked
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: critical
size: M
---

# TC-007: A pick made on a panel that has not yet seen an agent's write is refused and the agent's status survives

**Mission:** M1 | **Priority:** critical | **Kind:** ui | **Covers:** M1-AC4

## Objective

Reproduce the race M3 B1/B2 taught: the panel shows ready, an agent records fail, the user picks pass before the panel refreshed. Nothing is written; the panel shows fail and says the pick was not saved.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.
- The manual half runs in an Extension Development Host (F5) and is recorded as manual, with screenshots under `tests/m1/evidence/`.

## Real data (pre-existing record)

The copy in $WORK/octo-ws of this repo's real direct-dispatch-process m6 TC-001_parse-own-campaign-tests.md (whatever its recorded status), set to ready with the shipped script in step 2, and RUN-2026-10-06-001.md as the agent's evidence. The watcher's git-quiescence gate (board-watcher.ts, git-quiescence.ts: index.lock defers the rebuild) holds the panel stale on purpose.

## Commands

```bash
# automated half
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/test-case-view.test.tsx test/tests-detail-rpc.test.ts --reporter=verbose
# manual half: F5 on $WORK/octo-ws, which must be a git repo for the quiescence gate
git -C $WORK/octo-ws init -q
F=$DDP/tests/m6/TC-001_parse-own-campaign-tests.md
node $SET $F ready                                  # step 2, then open its panel and wait until it shows ready
touch $WORK/octo-ws/.git/index.lock                 # step 3: the watcher now defers its rebuild
node $SET $F fail --evidence .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md
shasum $F                                          # A
# step 5: pick pass in the panel's dropdown, then:
shasum $F                                          # B
rm $WORK/octo-ws/.git/index.lock
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run test-case-view.test.tsx and tests-detail-rpc.test.ts | At least 1 test passed in each, 0 failed (the stale cases included) |
| 2 | Set the copy of TC-001 to ready; open its panel | Panel shows ready |
| 3 | Create index.lock, run the script with fail | The panel still shows ready (rebuild deferred) |
| 4 | Record shasum A | - |
| 5 | Pick pass in the dropdown | The dropdown is disabled while the call runs; the panel then shows fail with the agent's last run (today, RUN-2026-10-06-001.md) and an inline notice (role=status) that the status changed outside the panel and was not saved; no notification |
| 6 | Record shasum B; compare | A equals B; the file holds `status: fail` and the agent's last_run |
| 7 | Remove index.lock | The watcher refreshes: the tree shows fail; the not-saved notice is still shown (it stays until the next pick) |
| 8 | Pick blocked | The notice disappears; the file holds `status: blocked` and `last_run: {date: <today UTC>}` |

## Expected Final State

An agent's newer status is never overwritten by a pick made on a stale view; the user is told. Live half recorded as manual.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
