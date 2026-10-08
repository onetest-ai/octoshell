# Octoshell board — a Claude Code mod (proof of concept)

Browse the `.octobots/` board **inside Claude Code**, Midnight-Commander style, without opening
VS Code. This is a *mod*: a Claude Code plugin of function hooks that draws a live pane in the
terminal. It is early-access API and a proof of concept, built for fun; it is not part of any
release and nothing in the pnpm workspace builds, lints or tests it.

```
 Octoshell  board › Bookmark polish - four ruled defects                   read 21:39:57
┌──────────────────────────────────┐┌──────────────────────────────────────────────────┐
│↰ ..                              ││M1 - Four ruled bookmark defects, fixed and …     │
│✓ M1 - Four ruled bookmark d… 6/6 ›││✓ done  ·  mission                                │
│                                  ││folder bookmark-polish…/missions/m1-…             │
│                                  ││── acceptance criteria 5/5                        │
│                                  ││[x] Tapping a bookmark keeps that bookmark's tag… │
└──────────────────────────────────┘└──────────────────────────────────────────────────┘
 6 open campaigns · 1 executing · 1 failed · 16 draft
 h: Help  u: Up  s: Status  c: Cancel  v: Validate  r: Refresh  q: Close
```

## What it does

- **`[ Board ]` above the prompt** with a one-line summary (open campaigns, executing, awaiting
  approval, failed, draft). Click it, or press ctrl+x tab then `b`.
- **`/octoshell`** opens the board from the prompt and writes nothing to the conversation, so it
  costs no model context.
- **Two panels.** The left lists where you stand (campaigns → missions → tasks and bugs, active
  work first). The right previews the row under the cursor: status, role/severity/target,
  description, acceptance criteria, children and notes.
- **Keyboard first.** Every row is a Button, so the pane's own focus ring is the cursor and the
  board takes the keyboard the moment `/octoshell` opens it: ↑ ↓ move, PgUp/PgDn and Home/End
  jump (the wheel moves the cursor too), ⏎ opens, `u` goes up.
- **`p` switches panels**, as MC's Tab does: the cursor moves onto the right panel's children
  (⏎ opens one in its parent) or, with none, its acceptance criteria.
- **› marks what opens.** A row with missions, tasks or bugs inside ends `done/all ›`; ⏎ on any
  other row (a task, a bug, an empty mission) stays put and says why. On the `..` row the right
  panel previews the folder you are in.
- **Writes go through the board's own scripts.** `s` then 1–6 sets a status and `c` cancels, each
  after a y/n, by running `set-status.js`; ⏎ on a criterion ticks or unticks it through
  `set-criterion.js`; `v` runs `validate.js`. The mod never writes YAML itself.
- **Live.** It re-reads the board after any tool call that touches `.octobots/` or the planner
  scripts, and every 15 s while the pane is open.

## Installing it

It needs the Octobots pack installed in the repository (it calls
`.claude/skills/mission-planner/scripts/`) and Node on the PATH. In a Claude Code terminal session,
type:

```
/plugin install octoboard --marketplace onetest-ai/octoshell
```

Answer `y` to add the `onetest-ai/octoshell` marketplace, then pick a scope: **user** loads it in
every repository, **project** records it in the repository's shared `.claude/settings.json`,
**local** only for you in this repository. It is active straight away, with no restart.

Then type `/octoshell` in any repository that has a board. A fullscreen terminal that reports
clicks (iTerm2, Ghostty, kitty, WezTerm; not tmux) also gets the mouse.

`claude plugin update octoboard@octoshell` picks up a new version.

## Developing it

Run it from a checkout for one session, from the repository holding the board:

```bash
claude --plugin-dir /path/to/octoshell/mods/octoboard
```

or install it from the checkout itself, so an edit reaches a session on `/reload-plugins`:

```bash
claude plugin marketplace add /path/to/octoshell --scope local
claude plugin install octoboard@octoshell --scope local
```

The marketplace file is the repository's `.claude-plugin/marketplace.json`. Bump `version` in
`.claude-plugin/plugin.json` with every change people should get: an install from GitHub runs the
copy made when it was installed.

## How it is built

| File | What it holds |
|---|---|
| `hooks/register.tsx` | The hooks: the band, the pane, `/octoshell`, the focus ring as cursor, the script runs |
| `hooks/board.ts` | Loader and view model: folder-derived children, status mapping, rollups, previews |
| `hooks/layout.ts` | Pure text layout: glyphs, row labels, wrapping, the help screen |
| `hooks/js-yaml.mjs` | js-yaml 5.2.2 (MIT), vendored from the pack: a mod imports only its own files |
| `types/index.d.ts` | The mod's state contract |

The loader is a small re-implementation of `packages/board`'s read path. `packages/board` reads
with synchronous `node:fs`, and a mod has only the engine's async `$.fs`. A real version would
bundle `packages/board` behind a pre-read, in-memory fs adapter rather than duplicate it.

## Checks

```bash
claude plugin validate .                # the marketplace file at the repository root
claude plugin validate mods/octoboard   # manifest + hooks module, as the engine reads them
claude plugin test mods/octoboard       # 13 tests: loader, view model, pane, /octoshell
```

Built and checked against Claude Code 2.1.290–2.1.291. The function-hooks API is early access
and changes between releases, so expect to re-validate after an update.

## Known gaps against the VS Code extension

- Long text is clipped (description 900 characters, notes 1,400), the right panel shows only the
  children and criteria that fit, and it does not scroll.
- Bug fields (steps, expected, actual, environment, RCA), attached documents and estimates are not
  shown.
- No create/delete or field editing; no tokenomics view; no test-case nodes.
- Opening from the `[ Board ]` button may leave the keyboard on the button row: one click inside
  the board hands it over. `/octoshell` does not have this problem.
