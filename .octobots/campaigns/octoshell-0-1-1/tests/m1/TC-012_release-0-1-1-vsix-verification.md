---
id: TC-012
title: "0.1.1 VSIX: version and activation event, fixed CHANGELOG and 0.1.1 entry, pack byte-identical to 0.1.0, clean assets, workflow grep on the allow-list"
mission: M1
covers: [M1-AC10]
kind: cli
status: blocked
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: critical
size: M
---

# TC-012: 0.1.1 VSIX: version and activation event, fixed CHANGELOG and 0.1.1 entry, pack byte-identical to 0.1.0, clean assets, workflow grep on the allow-list

**Mission:** M1 | **Priority:** critical | **Kind:** cli | **Covers:** M1-AC10

## Objective

Black-box verification of the release artifact against M1-AC10, comparing it with the shipped 0.1.0 VSIX. Owned by T1.4 (self-check) and executed by T1.5.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.

## Real data (pre-existing record)

apps/vscode-extension/octobots-0.1.0.vsix (761083 bytes on 2026-10-06; its extension/resources/octobots-pack equals the current tree's, diff -r empty as checked by the planner; rebuild from release commit ea432393 if the file is missing); octobots-0.1.1.vsix from T1.4's release commit; CHANGELOG.md line 13 (the muddled sentence) as the before-record; the direct-dispatch-process campaign AC2 allow-list (that campaign's campaign.yaml, AC2, plus M6-AC8's additions).

## Commands

```bash
cd $OCTO && R=$(git log --format=%H -1 --grep='^chore(ext): release 0.1.1$' feat/octoshell-0-1-1)
git show --stat --format=%s%n%b $R
git diff --exit-code $R HEAD -- apps packages && echo TREE-IS-RELEASE
V0=$WORK/v010; V1=$WORK/v011; mkdir -p $V0 $V1
unzip -q apps/vscode-extension/octobots-0.1.0.vsix -d $V0 && unzip -q apps/vscode-extension/octobots-0.1.1.vsix -d $V1
node -p "require('$V1/extension/package.json').version"
node -p "require('$V1/extension/package.json').activationEvents.join('\n')" | grep -x 'onWebviewPanel:octoshell.testCase'
grep -c 'If you still have such files, they were already migrated away' $V1/extension/changelog.md
grep -n '^## 0.1.1' $V1/extension/changelog.md; awk '/^## 0.1.1/{p=1} /^## 0.1.0/{p=0} p' $V1/extension/changelog.md
diff -r $V0/extension/resources/octobots-pack $V1/extension/resources/octobots-pack && echo PACK-IDENTICAL
cmp $V0/extension/resources/shipped-skills.json.br $V1/extension/resources/shipped-skills.json.br && echo STORE-IDENTICAL
ls $V1/extension/media/assets; grep -o 'assets/[^"]*' $V1/extension/media/index.html
/usr/bin/grep -rnE 'Workflow\(|workflow\.js|add-workflow|sync-meta|add-run|mission-input|workflow-designer|octoshell\.newWorkflow' $V1/extension
# manual: code --profile octobots-qa --install-extension apps/vscode-extension/octobots-0.1.1.vsix; open $WORK/octo-ws in that profile; single-click a TC leaf
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Show the release commit | Subject `chore(ext): release 0.1.1`; only apps/vscode-extension/package.json changed (version 0.1.0 -> 0.1.1); the body lists changes since 0.1.0 and per-package test counts |
| 2 | diff release commit vs HEAD over apps and packages | `TREE-IS-RELEASE` |
| 3 | Read the VSIX version and activation events | `0.1.1`; `onWebviewPanel:octoshell.testCase` present |
| 4 | Count the muddled sentence; print the 0.1.1 entry | Count 0; the 0.1.1 entry names the test-case panel, what its dropdown writes (status, last_run date, no evidence), the single-click change (sidebar and mission panel), the coloured Tests icons and the unchanged v57 pack; the 0.1.0 section says conditionally that if any release from a192780c through 0.0.51 ran in a workspace it deleted each workflow.md (git history holds the only copy), and that 0.1.0 no longer touches workflows/ |
| 5 | diff -r the two packs; cmp the two stores | `PACK-IDENTICAL`, `STORE-IDENTICAL` (every marker stays 57) |
| 6 | List media/assets against index.html and its CSS | Only referenced files (one JS, one CSS, the codicon font) |
| 7 | Classify every workflow grep hit | Each hit is on the direct-dispatch-process campaign AC2 / M6-AC8 allow-list; 0 unlisted |
| 8 | Manual: install into a separate profile, single-click a TC leaf | The TC panel opens (recorded as manual, screenshot) |

## Expected Final State

The 0.1.1 VSIX carries the panel, the fixed CHANGELOG and the 0.1.1 entry, with a pack byte-identical to 0.1.0's, so no workspace is prompted to reinstall.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
