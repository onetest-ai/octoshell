---
id: TC-006
title: "The shipped-skill store indexes every shipped SKILL.md since v18 and holds the v50+ bodies"
mission: M7
covers: [M7-AC1]
kind: unit
status: draft
priority: high
size: S
---

# TC-006: The shipped-skill store indexes every shipped SKILL.md since v18 and holds the v50+ bodies

**Mission:** M7 | **Priority:** high | **Kind:** unit | **Covers:** M7-AC1

## Objective

Detection and base recovery have complete, current reference data. Verifies M7-AC1 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

The real git history of apps/vscode-extension/resources/octobots-pack/skill/*/SKILL.md (versions 18-57) and the current pack files.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/shipped-skills.test.ts --reporter=verbose
X=$OCTO/apps/vscode-extension/resources/shipped-skills.json.br; ls -l $X
node -e 'process.stdout.write(require("zlib").brotliDecompressSync(require("fs").readFileSync(process.argv[1])))' $X > $WORK/store.json
jq -r '.versions | keys | map(tonumber) | sort | "\(first)..\(last) (\(length))"' $WORK/store.json; jq '.bodies | length' $WORK/store.json
jq -r '.versions["56"]["mission-execution"][], .versions["56"]["mission-completion-gate"][], (.versions["56"]["workflow-designer"] | length), (.versions["18"]["octobots"] | length)' $WORK/store.json
for h in 9af2c928b8310dddbff78f015f00264251592ca727ae1d07741f363bd4a9c523 008de10a952f5afeb5e85fb02cf1814179cd516d537bf57016b3e071105dd4cc; do jq -e --arg h $h '.bodies[$h] != null' $WORK/store.json > /dev/null && echo "$h body stored"; done
for f in $PACK/skill/*/SKILL.md; do s=$(basename $(dirname $f)); h=$(tr -d '\r' < $f | shasum -a 256 | cut -d' ' -f1); jq -e --arg s $s --arg h $h '(.versions["57"][$s] | index($h) != null) and (.bodies[$h] != null)' $WORK/store.json > /dev/null && echo "$s current indexed"; done
GIT_DIR=$WORK/nogit node $OCTO/apps/vscode-extension/scripts/shipped-skills.mjs --verify; echo "verify exit=$?"
grep -n "shipped-skills" $OCTO/.gitattributes $OCTO/apps/vscode-extension/package.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run shipped-skills.test.ts | At least 1 test passed, none failed |
| 2 | Size and shape | One file of at most 100 KB; versions 18..57; at least 124 bodies |
| 3 | Read the v56 and retired entries | The v56 lists hold 9af2c928b831... and 008de10a952f...; workflow-designer has at least 1 entry at 56 and octobots at least 1 at 18; both v56 bodies stored |
| 4 | Check every current pack SKILL.md | Each of the 5 skills is indexed under 57 with its body stored (one line per skill) |
| 5 | --verify with no usable git | verify exit=0 |
| 6 | Where it is enforced | .gitattributes marks the store `-text`; the extension's build script runs `shipped-skills.mjs --verify` |

## Expected Final State

The store is complete and in sync with the pack.
