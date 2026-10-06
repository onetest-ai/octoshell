---
id: TC-002
title: "Awkward frontmatter, refusals, symlinks and the atomic write match the script's rules"
mission: M1
covers: [M1-AC3]
kind: unit
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: high
size: M
---

# TC-002: Awkward frontmatter, refusals, symlinks and the atomic write match the script's rules

**Mission:** M1 | **Priority:** high | **Kind:** unit | **Covers:** M1-AC3

## Objective

The parity corpus of TC-001 has no CRLF file, no BOM and no TC without frontmatter, so the awkward inputs live in the shared case fixture packages/board/test/fixtures/tc-status-cases.json, derived from named real files and run over both the shipped script and the TS edit; and the writer's refusal, no-op and atomic-write rules hold.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.

## Real data (pre-existing record)

Derived (synthetic, says so) from real files: $DDP/tests/m6/TC-004_sidebar-tests-node-counts.md (new frontmatter) and $UWB/tests/m1/TC-003_set-ranging-mode-persists.md (legacy). No real TC is CRLF, has a BOM, lacks frontmatter or has unparseable frontmatter (solo's 119 and this repo's 86 all parse), so those inputs are made from these two files.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/board exec vitest run test/tc-status-parity.test.ts test/tc-status-write.test.ts --reporter=verbose
# derived refusals against the shipped script, on the copy
T=$UWB/tests/m1; awk 'c>=2{print} /^---$/{c++}' $T/TC-003_set-ranging-mode-persists.md > $T/TC-900_no-frontmatter.md
node $SET $T/TC-900_no-frontmatter.md pass; echo "script exit $?"
node --input-type=module -e 'const b = await import(process.argv[1]); console.log(JSON.stringify(b.writeTestCaseStatus(process.argv[2], process.argv[3], { status: "pass", date: "2026-10-06" })))' $OCTO/packages/board/dist/index.js $WORK/solo-ws/.octobots campaigns/uwb-ranging-ingest-vendor-v01/tests/m1/TC-900_no-frontmatter.md
shasum $T/TC-900_no-frontmatter.md   # before and after: equal
ls -a $T | grep '\.tmp$' || echo "no temp files"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run tc-status-parity.test.ts (case table) and tc-status-write.test.ts | At least 1 test passed in each file, 0 failed; the shared fixture covers the T6.2 review shapes (nested status, status in a block scalar, comment after status, quoted "status" key, anchor/alias, flow-mapping frontmatter), a duplicate key, empty and comment-only frontmatter, no trailing newline on the last frontmatter line, list-form last_run, trailing blank/comment lines after last_run, `status:` with no value, CRLF, BOM, a last_run with `note:`, block-form last_run, last_run before status, no status key, a quoted status, no frontmatter, unparseable frontmatter; the recorded refusal list matches |
| 2 | Run the script on the derived no-frontmatter TC-900 | Exit 2, message says the file has no frontmatter and names --migrate |
| 3 | Run the TS writer on the same file | Refused (ok false), the same reason; the file's shasum is unchanged |
| 4 | List the folder for temp files | `no temp files` |
| 5 | In tc-status-write.test.ts output, find the symlink, FIFO, oversize, read-only-folder, skipIfCurrent and final-re-read stale cases | Each passes: nothing written, no temp left, mode kept on success; a same-status pick with skipIfCurrent leaves bytes and mtime unchanged |

## Expected Final State

On every derived awkward input the TS writer and the shipped script agree byte for byte or both refuse; refusals and failures write nothing and leave no temp file.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
