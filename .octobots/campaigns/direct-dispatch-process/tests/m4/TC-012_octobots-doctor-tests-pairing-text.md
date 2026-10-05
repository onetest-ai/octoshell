---
id: TC-012
title: "octobots-doctor tells the agent to resolve a tests-pairing warning with add-tests.js, never by deleting"
mission: M4
covers: [M4-AC4]
kind: unit
status: draft
priority: medium
size: S
---

# TC-012: octobots-doctor tells the agent to resolve a tests-pairing warning with add-tests.js, never by deleting

**Mission:** M4 | **Priority:** medium | **Kind:** unit | **Covers:** M4-AC4

## Objective

The octobots-doctor skill (shipped by M7) carries M4's paragraph on acting on a tests-pairing warning. Verifies M4-AC4 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; mission branch built).
- M7 has landed (skill/octobots-doctor/SKILL.md exists in the pack).

## Real data (pre-existing record)

The real shipped `skill/octobots-doctor/SKILL.md`; solo uwb m1's real pairing gap (M1-AC11 uncovered, TC-003 of this suite) is the finding the paragraph is about.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/skill-conventions.test.ts --reporter=verbose
awk 'c>=2{print} /^---$/{c++}' $PACK/skill/octobots-doctor/SKILL.md | grep -n -i -E "add-tests\.js|pairing"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the conventions vitest | At least 1 test passed and none failed, including the octobots-doctor tests-pairing assertions |
| 2 | Read the paragraph the grep points at | It names add-tests.js, says the missing TCs are authored with the mission's owner, and forbids deleting an AC, a TC or a README row to silence the warning |

## Expected Final State

An agent running octobots-doctor on a pairing warning adds tests; it never removes requirements.
