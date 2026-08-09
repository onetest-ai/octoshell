# Shared knowledge — charter

This is the **committed, cross-role** counterpart to `.agents/memory/<role>/`. A fact one role
paid to establish is otherwise invisible to every other role, and to the same role on another
machine — this layer exists so it's actually reachable.

**Known repo gap (found 2026-08-09):** the repo's `.gitignore` line 14 is a bare `.agents/`,
which currently blanket-ignores this whole directory. Nothing in here is actually tracked by git
yet — `git add -f` per file until the `.gitignore` is scoped down. See `AGENTS.md` § Agent memory
for the full note. That does not make this layer optional in the meantime: write here, force-add,
and flag the gap again if you hit it.

## Admission tests

A note is admitted here **only if all four hold**. Do not pad this layer — three trustworthy
notes beat twenty uncertain ones, and an unverified claim here is *worse than silence*, because it
is committed and therefore trusted by every role that reads it.

1. **Cross-role** — useful to two or more roles, or architecture-level. A fact only `js-dev` will
   ever need belongs in `.agents/memory/js-dev/`, not here.
2. **Verified** — you confirmed it against the actual repo (code, a command's real output, a
   commit), and the note states the method and a date. "I read a comment that says X" is weaker
   than "I ran X and observed Y" — say which you did.
3. **Durable** — still true once the current mission ends. A fact tied to one in-flight PR or task
   belongs on the work board, not here.
4. **Costly to rediscover** — if it's obvious from a five-second read of the file in question, it
   belongs in a code comment, not a knowledge note. This layer is for facts that took real
   exploration, cross-referencing, or a git-history dig to establish.

Correct or delete a note the moment it stops being true — a stale shared note misleads every role
at once, which is a worse outcome than the fact never having been written down.

## Folders

| Folder | What belongs | What does not |
|---|---|---|
| `architecture/` | System shape, the board model's on-disk format, where mirrored/duplicated implementations live and why, service boundaries | Feature-level implementation notes, anything scoped to one file with no cross-cutting implication |
| `services/` | N/A for this project — no backend service exists. Kept as a named home in case that changes. | — |
| `frontend/` | Webview-side (React/Tailwind) state and lifecycle rules that aren't obvious from the code — enforced UI conventions, host↔webview protocol gotchas | Generic React knowledge available in any React doc |
| `integrations/` | External systems this project depends on (VS Code extension API surfaces, GitHub Actions) | Internal package-to-package coupling — that's `architecture/` |
| `environment/` | Local setup, the dev loop (F5 Extension Development Host, watch scripts), anything that trips up a fresh clone | One-off machine issues that aren't reproducible |
| `practices/` | How we verify work, build-order/migration hazards, review conventions specific to this repo | Generic engineering advice not specific to this repo |
| `testing/` | Suite structure and harness behavior beyond what `AGENTS.md` § Testing already states, flaky-test notes | Restating the test command list — that's `AGENTS.md` |
| `security/` | Credential, auth, and egress invariants | N/A currently — no secrets, no auth surface, no network egress in this repo. Kept as a named home. |

Empty folders are intentional and fine — see the table. A named home makes it likelier a hard-won
fact gets written down at all, even before the folder has its first note.

## Index

- [`architecture/disk-is-authoritative.md`](architecture/disk-is-authoritative.md) — reads rebuild
  the board model from disk; nothing cascade-mutates in memory.
- [`architecture/dual-schema-entity-io.md`](architecture/dual-schema-entity-io.md) — the board YAML
  schema is implemented twice with no import edge; both copies must change together.
- [`practices/dist-before-typecheck.md`](practices/dist-before-typecheck.md) — dependents read a
  package's built `dist/`, not its `src/`; rebuild before typecheck/test after a public-type change.

## Curation

Ongoing curation (promoting, correcting, retiring notes) is the `knowledge-curation` skill's job.
This charter and the three seed notes above were written during onboarding
(`seeding-a-project`, 2026-08-09).
