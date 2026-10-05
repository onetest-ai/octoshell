---
id: TC-001
title: "Manifest has no workflow commands or menus; install command retitled"
mission: M3
covers: [M3-AC4, M3-AC7]
kind: unit
status: draft
priority: high
size: S
---

# TC-001: Manifest has no workflow commands or menus; install command retitled

**Mission:** M3 | **Priority:** high | **Kind:** unit | **Covers:** M3-AC4, M3-AC7

## Objective

Manifest has no workflow commands or menus; install command retitled. Verifies M3-AC4 and M3-AC7 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real apps/vscode-extension/package.json after M3

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/manifest-no-workflows.test.ts --reporter=verbose
jq '.contributes.commands[]|select(.command|test("orkflow"))' apps/vscode-extension/package.json
jq '.contributes.commands[]|select(.command=="octoshell.installOctobotsWorkflowSkill")|.title' apps/vscode-extension/package.json
jq '[.contributes.menus[]?[]?|select(.command|test("orkflow"))]|length' apps/vscode-extension/package.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run manifest-no-workflows.test.ts; search the manifest commands for newWorkflow/deleteWorkflow/openWorkflowById | At least 1 test passed; no match |
| 2 | Search every menu contribution for workflow commands | 0 |
| 3 | Read the install command | id `octoshell.installOctobotsWorkflowSkill` unchanged; title `Octobots: Install Octobots Pack` |

## Expected Final State

No workflow command or menu in the manifest; the install command is retitled with its id kept.
