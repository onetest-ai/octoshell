---
id: TC-011
title: "0.1.0 VSIX: workflow grep hits only the allow-list, new scripts present, markers 57, solo install up to date, no pairing warnings, 0 unsigned parked"
mission: M6
covers: [M6-AC8]
kind: cli
status: draft
priority: critical
size: M
---

# TC-011: 0.1.0 VSIX: workflow grep hits only the allow-list, new scripts present, markers 57, solo install up to date, no pairing warnings, 0 unsigned parked

**Mission:** M6 | **Priority:** critical | **Kind:** cli | **Covers:** M6-AC8

## Objective

0.1.0 VSIX: workflow grep hits only the allow-list, new scripts present, markers 57, solo install up to date, no pairing warnings, 0 unsigned parked. Verifies M6-AC8 (and campaign AC1, AC2, AC4, AC7) of M6 - Test cases are first-class on the board. Owned by T6.6; runs after T6.5.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK).
- $OCTO is on feat/direct-dispatch-process at the release commit; `pnpm install && pnpm build` done; `pnpm --filter @octoshell/vscode-extension package` has written apps/vscode-extension/octobots-0.1.0.vsix.
- Originals under $SOLO and $OCTO are untouched; the install runs on a copy.

## Real data (pre-existing record)

The VSIX built from the real release commit; a `cp -R` copy of solo's real `.claude` + `.octobots` (two `version: 57-local` forks, workflow-designer, create-team.js, 30+ non-pack skills); this campaign's own six missions; the octoshell repo itself for the parked-test scan.

## Commands

```bash
cd $OCTO
git log -1 --format=%s; git show --name-only --format= HEAD             # the release commit: subject, and only apps/vscode-extension/package.json
jq -r .version apps/vscode-extension/package.json
mkdir -p $WORK/vsix && unzip -q apps/vscode-extension/octobots-0.1.0.vsix -d $WORK/vsix; X=$WORK/vsix/extension; XP=$X/resources/octobots-pack
# (1) workflow grep: print every hit with 60 chars of context, then classify each against the allow-list
grep -rnoE '.{0,60}(Workflow\(|workflow\.js|add-workflow|sync-meta|add-run|mission-input|workflow-designer|octoshell\.newWorkflow).{0,60}' $X | cut -c1-260 > $WORK/vsix-hits.txt; wc -l < $WORK/vsix-hits.txt
# (2) new scripts and markers
for f in qa-env.mjs scan-parked.js add-tests.js set-test-status.js tc-io.mjs; do find $XP -name $f | grep -q . && echo "$f present" || echo "$f MISSING"; done
test ! -e $XP/skill/workflow-designer && echo "no workflow-designer"
grep -rh -E "^version:|octobots-pack-version" $XP | sort | uniq -c
# (3) install the VSIX's own pack into a copy of solo
mkdir -p $WORK/solo-rel && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo-rel/
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/solo-rel --pack-root $XP | jq '{before: .before.upToDate, after: .after}'
ls $WORK/solo-rel/.claude/skills; test -e $WORK/solo-rel/.claude/skills/mission-planner/scripts/create-team.js && echo "create-team KEPT"
for f in add-workflow.js sync-meta.js add-run.js mission-input.js extract-meta.mjs workflow-meta.mjs vendor/acorn.mjs; do test ! -e $WORK/solo-rel/.claude/skills/mission-planner/scripts/$f && echo "$f gone"; done
# (4) no tests-pairing warning on this campaign's missions
for m in .octobots/campaigns/direct-dispatch-process/missions/*/; do echo "$(basename $m): $(node $XP/skill/mission-planner/scripts/validate.js $m | grep -c '^warning:')"; done
# (5) parked tests and the repo gates
node $XP/skill/mission-execution/scripts/scan-parked.js; echo "scan exit=$?"
pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm coverage && echo GATES_GREEN
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Read the release commit and version | Subject `chore(ext): release 0.1.0 with workflow pack v57`; the only file is apps/vscode-extension/package.json; version 0.1.0 |
| 2 | Classify every line of vsix-hits.txt | Each hit is one of: the validate/doctor 'no longer read' text; the legacy-folder paragraph in a skill; tokenomics' wf_ transcript reader; the installer's RETIRED_SKILLS/RETIRED_FILES lists in dist/extension.js; the disposing octoshell.workflow serializer. Any other hit FAILs |
| 3 | Check the new scripts, workflow-designer and markers | qa-env.mjs, scan-parked.js, add-tests.js, set-test-status.js, tc-io.mjs present; no workflow-designer; every `version:` and `octobots-pack-version` reads 57 |
| 4 | Install the VSIX's pack into the solo copy | `.before` false (57-local), `.after.upToDate` true; workflow-designer and the 7 retired files gone; create-team.js and solo's non-pack skills kept |
| 5 | validate.js on each of this campaign's six missions | 0 `warning:` lines each (no tests-pairing warning) |
| 6 | scan-parked.js on octoshell; the repo gates | Scan exit 0 (0 unsigned); GATES_GREEN |

## Expected Final State

The 0.1.0 VSIX ships no workflow surface beyond the allow-list, carries the v57 scripts, upgrades solo cleanly, and the campaign's own board and repo are clean. Recorded with set-test-status.js by the qa-engineer dispatch under T6.6.

## Teardown

- `rm -rf $WORK/vsix $WORK/solo-rel`
