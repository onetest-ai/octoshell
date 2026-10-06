---
name: octobots-doctor
description: Use when the session context says "Octobots health: run the octobots-doctor skill", when .octobots/pack-updates/pending.json lists a pending pack reconcile (a pack skill this workspace changed locally, staged by a pack update), or when doctor.js or validate.js report a pack or board health finding (pack reconcile pending, leftover workflows/ folders, CLAUDE_CONFIG_DIR, tests-pairing warnings) in a repo with an .octobots/ directory. Not for planning or recording board work (that is mission-planner) and not for building a planned task (that is mission-execution).
version: 57
---

# octobots-doctor

Pack and board health for an Octobots workspace. Your main duty is the **pending pack reconcile**: a
pack update found a skill this workspace changed locally, left the live skill as it was, staged three
versions of it, and left the merge to you. Pending reconciles come first, then the other findings.

## 1. Find what to act on

Run these from the workspace root:

```bash
node .claude/skills/mission-planner/scripts/doctor.js --json
node .claude/skills/mission-planner/scripts/validate.js .octobots/campaigns/<any campaign>
node .claude/skills/octobots-doctor/scripts/pack-reconcile.mjs list
```

Act on their findings: `pack reconcile pending` (§2-§3), leftover `workflows/` folders (§4), the
`config-dir` finding (§5), validate.js's tests-pairing warnings (§7) and set-status.js's legacy plan-review warnings (§8). Skip a finding that
`.octobots/doctor-acks.json` already acknowledges (§6).

## 2. Pending pack reconciles

Act only on the staging folders that `pending.json` names (`pack-reconcile.mjs list` prints them).
An `- ESCALATED:` entry in a folder no pending entry names is history and is never asked again. A
question still open from an older pack version reaches you in the named folder's RECONCILE.md, under
`Carried over from v<old>:`; copy each one, verbatim, as an open `- ESCALATED:` entry under Conflicts
in this folder's DECISIONS.md (unless the user answers it in this conversation).

For each named folder `.octobots/pack-updates/v<N>/<skill>/`:

1. Read RECONCILE.md, then base.md, local.md and upstream.md. If a DECISIONS.md there has an open
   `- ESCALATED:` entry, go to §3.
2. If RECONCILE.md says the skill is retired, go to "A retired skill" below.
3. List every change that local.md and upstream.md each made against base.md, rule by rule (a bullet,
   a numbered step, an instruction, a section). Decide each one by this table:

   | Change | Decision |
   |---|---|
   | local only | keep (Kept local) |
   | upstream only | take (Taken from upstream) |
   | both, the same | take (Taken from upstream) |
   | both, different | conflict (Conflicts) |

   With no base.md (RECONCILE.md says the merge is two-way), every difference is a conflict.
4. Making an upstream generic rule concrete for this project (for example, upstream says "run the project's
   declared test lanes", local names this project's lane commands) is not a conflict. Take upstream's
   generic rule and keep local's concrete commands right after it as this project's instance; record
   it under Kept local.
5. A conflict is a **policy conflict** when the two sides prescribe different values for the same
   decision:
   - model or role;
   - review or fix round limits;
   - coverage threshold;
   - what blocks a merge (what counts as green: failed, xfail, skip, todo);
   - who may merge or approve, and into which branch;
   - actions that need the user's OK first (deleting, pushing, migrating or seeding a database, anything with an external effect);
   - a safety guard.

   When local restates a base value and upstream changes that value, the restatement is local's
   position: a conflict, not an upstream-only change. When unsure whether a difference is policy,
   escalate.
6. Resolve a non-policy conflict yourself and write your reasoning in its `- RESOLVED:` entry.
7. ESCALATE every policy conflict: write its `- ESCALATED:` entry with both sides and a question.
   You do not pick a side, not even provisionally.
8. Write merged.md: the whole skill, rebuilt rule by rule from your decisions, in local.md's
   structure. Never merge by lines: no `git merge-file`, diff3, patch or hunk splicing; a line merge
   silently produces contradictory paragraphs. In the place of each escalated rule, merged.md holds
   exactly this one line and neither side's text:
   `<!-- ESCALATED: <rule>: awaiting the user's answer, see DECISIONS.md -->`
   Here and in DECISIONS.md, `<rule>` is a short name for the rule (e.g. `what counts as green`),
   never its wording. merged.md keeps local.md's frontmatter until step 11.
9. Write DECISIONS.md (form below) and, if a kept local rule would serve every project,
   UPSTREAM-CANDIDATES.md.
10. If any `- ESCALATED:` entry is open, stop work on this skill: the whole live SKILL.md stays
    untouched (no line, no non-conflicting change, no marker) until every escalation of this skill
    is answered. Do not run done. Ask in your reply (§9).
11. Otherwise install. In merged.md's frontmatter replace the `version:` line with
    `version: <N>+local` and add the line `reconciled-from: <sha256>` below it, both values exactly
    as `pack-reconcile.mjs list` prints them for this skill under `marker:`. Then copy merged.md byte for byte to `.claude/skills/<skill>/SKILL.md` and run:

    ```bash
    node .claude/skills/octobots-doctor/scripts/pack-reconcile.mjs done <skill>
    ```

    Exit 3 prints what is unfinished (done also refuses a live file that still holds an
    `<!-- ESCALATED: ... -->` line); fix it and run done again. Never edit pending.json yourself.

The marker is exactly `<N>+local`. A plain `<N>` makes the fork look like the pack's own file, so a
later update would overwrite it; `<N>-local` reads as a fork nobody reconciled.

**No upstream change.** When upstream.md equals base.md apart from its version marker, DECISIONS.md
is the single line `No upstream change since the base apart from the version marker; local kept as is.`,
merged.md is local.md, and you install as in step 11.

### DECISIONS.md

One entry per change, and every change between base.md and upstream.md has an entry. All three
sections are always present:

```markdown
# <skill>: reconcile against pack v<N>

## Kept local

- RESOLVED: <rule>: <reason>

## Taken from upstream

- RESOLVED: <rule>: <reason>

## Conflicts

- RESOLVED: <rule>: <reason>
- ESCALATED: <rule>: local <...>; upstream <...>; question <...>
```

UPSTREAM-CANDIDATES.md is optional and lists only rules from Kept local, one line each:

```markdown
- <rule>: <why it generalises>
```

### A retired skill

RECONCILE.md says upstream deleted it, so there is nothing to merge. Always escalate a retired skill:
DECISIONS.md gets `- ESCALATED: <skill> is retired: local <what it does here>; upstream deleted it; question keep it as a project skill under a new directory name (which name?), or delete it?`
Once the user answers, record the answer (§3), then move `.claude/skills/<skill>` to
`.claude/skills/<new name>` or delete it, and run done. The new name is
`<skill>-local-<YYYY-MM-DD>` unless the user picks another, and it is never a name that is, or ever
was, a pack skill (a skill the pack ships, or one any RECONCILE.md calls retired): a retired name
stays retired, and the next install would treat that directory as the retired skill again. If the
user picks such a name, say so and ask for another.

### What you may write

Write nothing outside `.claude/skills/<skill>/`, its staging folder and `.octobots/doctor-acks.json`
(a retired skill's directory may also move to the new name the user chose, as above). Never CLAUDE.md, AGENTS.md,
another skill, `.octobots/campaigns/` or pending.json.

## 3. Open escalations and answers

- A session that finds an open `- ESCALATED:` entry and has no answer from the user in this
  conversation must ask its question again, verbatim, and change nothing: do not merge again, do not
  rewrite merged.md, do not touch the live SKILL.md.
- When the user answers, rewrite that entry in place as
  `- RESOLVED (user, <YYYY-MM-DD>): <rule>: <answer>`, replace the rule's
  `<!-- ESCALATED: ... -->` line in merged.md with the answer applied, and when no `- ESCALATED:`
  entry is left, finish with step 11 of §2 (a retired skill: as "A retired skill" says).

## 4. Leftover `workflows/` folders

Pack v57 no longer reads `.octobots/campaigns/<c>/workflows/` or
`.octobots/campaigns/<c>/missions/<m>/workflows/`. They are the user's files: the installer and the
scripts never change them. Report each `workflows/` folder (not each `workflows/<slug>` inside it)
and ask about each folder separately; delete a folder
only after the user says yes to that folder. A yes for one folder is not a yes for another, and no
answer is a no. If the user declines, record it (§6).

## 5. `CLAUDE_CONFIG_DIR`

Claude Code writes this project's transcripts to `~/.claude/projects/<slug>` by default, and that is
where the tokenomics collector reads them; the default is healthy. A `CLAUDE_CONFIG_DIR` set to the
project's own `.claude` is the legacy root: advise the user to unset it in their shell profile. You
cannot change their environment yourself; tell them. Never set or recommend
`CLAUDE_CONFIG_DIR=<repo>/.claude`. If the user declines, record it (§6).

## 6. Declined findings: `.octobots/doctor-acks.json`

When the user declines to act on a `workflows/` or config-dir finding, add an entry so the
SessionStart notice stops naming it (doctor.js and validate.js still list it). Create the file if it
is absent, append, and keep every other entry. A pending reconcile is never acknowledged.

```json
{
  "acknowledged": [
    { "finding": "workflows", "path": "campaigns/<c>/workflows", "date": "<YYYY-MM-DD>" },
    { "finding": "workflows", "path": "campaigns/<c>/missions/<m>/workflows", "date": "<YYYY-MM-DD>" },
    { "finding": "config-dir", "path": ".claude", "date": "<YYYY-MM-DD>" }
  ]
}
```

One `workflows` entry per declined folder. Its path is relative to `.octobots/`, `/`-separated, and
names the `workflows/` folder itself, never a `workflows/<slug>` path as doctor.js prints them: cut
doctor's path after `workflows`.

## 7. Tests pairing

`validate.js` also warns when a mission has no linked `tests/m<n>/README.md`, an AC that no TC
covers, or a TC that breaks the format. You act on that `validate.js` output; a tests-pairing
warning is not a primer finding, and the SessionStart notice never names it. Resolve it by running
`add-tests.js <mission-dir>` and authoring the missing TCs with the mission's owner (see the
mission-planner skill). Never resolve it by deleting an AC, a TC or a README row; that hides the gap
instead of closing it.

## 8. Legacy plan-review records

`set-status.js` accepts a legacy plan-review record when a move into `executing` finds a
`## Plan review (...)` heading that names both reviewers but has no `Reviewers:` or `Verdict:` line,
and prints `warning: legacy plan review "<heading>" ... has no Reviewers:/Verdict: lines; accepted`.
You act on that `set-status.js` output; a legacy record is not a primer finding, and the
SessionStart notice never names it. When you see the warning, say the record lacks its
Reviewers:/Verdict: lines and offer to add them: `Reviewers: ba (<name>), tech-lead (<name>)` with
the role tokens `ba` and `tech-lead`, plus a `Verdict:` line carrying the verdict the record states
(`approved` or `approved with nits`). Write them directly under that heading, and only with the
user's OK. Never invent a verdict the record does not state, and never edit the heading itself.

## 9. Your reply

End your reply with this block, filled in:

```
Reconciled: <skill>, <skill> (or: none)
Decision logs:
- .octobots/pack-updates/v<N>/<skill>/DECISIONS.md   (one line per skill you worked on)
Waiting for your answer:
- <skill>: <the question of every open ESCALATED entry, verbatim>
```

Leave out `Waiting for your answer:` only when no escalation is open.

## Red flags

| Thought | What to do instead |
|---|---|
| "I'll keep the stricter local rule in merged.md for now" | Write the `<!-- ESCALATED: ... -->` line; the answer is the user's. |
| "The non-conflicting changes are safe to install already" | The whole live SKILL.md waits until every escalation is answered. |
| "`version: <N>` is cleaner than `<N>+local`" | Exactly `<N>+local` plus `reconciled-from:`, or the next update overwrites the fork. |
| "`git merge-file` gave a clean result" | A clean line merge can still contradict itself. Merge rule by rule. |
| "The project's commands replace the generic rule" | Keep both: upstream's rule, then local's commands as this project's instance. |
| "I'll clear pending.json by hand" | Only `pack-reconcile.mjs done <skill>` clears an entry. |
