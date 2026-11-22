# Tokenomics attribution

The library and installed pack use the resolver in `packages/tokenomics/src/attribution.ts`.
The extension build verifies the generated pack copy. After a resolver edit, run:

```sh
node apps/vscode-extension/scripts/attribution-payload.mjs --write
pnpm build
```

The pack board reader is importable without running a rollup or reading prices:

```js
import { loadBoard } from './.octobots/tokenomics/board.mjs';
import { makeAttributionContext, resolveAttribution } from './.octobots/tokenomics/attribution.mjs';
```

The TypeScript package exports `makeAttributionContext`, `resolveAttribution`,
`resolveSegmentAttribution`, `loadLedgerWindows`, `attributionLabels` and `segmentAttribution`.
The extension adapts its existing `BoardModel` into the same resolver input.
The pack board reader retains its existing YAML and legacy Markdown parsing.

Run the branch CLI from any directory:

```sh
node /path/to/project/.octobots/tokenomics/attribute.mjs \
  --branch feat/demo-m4-t2 --project-dir /path/to/project
```

It prints one JSON object:

```json
{"kind":"mission","campaign":"demo","mission":"M4","step":2}
```

`--project-dir` defaults to the current directory. `--session <id>` enables the
session-qualified worklog lookup. Missing campaign and mission values are `null`.
Letter missions keep their full label, such as `M6b`. The CLI does not need prices
or run a rollup.

The seven branch-resolution steps retain their existing order. A segment also
retains the existing Codex fallback, labelled step `0`. It applies only after
all seven branch steps fail. The segment midpoint must fall in exactly one
mission window from `.agents/telemetry/delivery/events-*.jsonl`. The branch CLI
cannot infer this time-based fallback without a segment. Use the segment output
for those exceptions.

`runs.json` adds `segment_attributions`. Each segment ID maps to an object:

```json
{"kind":"mission","ref":"demo/M4","step":2,"started_at":"2026-11-20T10:00:00Z"}
```

A campaign reference is its slug. An unattributed reference is `null`.
Mission references match the owning row's `work_item_ref`: an external tracker
reference when present, otherwise `campaign/mission`. The TypeScript report exposes
the same map as `segmentAttributions`.
Consumers can partition this map by `started_at` without changing prices.

The pack also preserves the existing Codex source fields and Claude-only
mission and task counters. Aggregate token counts and costs include all sources.

The `PreToolUse` hook records `Agent` and `Task` dispatches on `main` in
`.octobots/tokenomics/diagnostics.jsonl`. Each line names the session, branch,
tool, timestamp and `dispatch-on-main` kind. The hook finds the Git worktree root
from the session directory. It emits no decision and fails open on errors.
Doctor reports the missing hook by event and script path. The pack installer
preserves an earlier hook opt-in when it adds this event.

## Commit trailer hook and hook doctor (pack v59)

The pack ships `.octobots/hooks/prepare-commit-msg.mjs`. It asks the attribution CLI
(`.octobots/tokenomics/attribute.mjs`) which board item the current branch belongs to and adds one
`Octobots-Mission: <campaign>/<M>` or `Octobots-Campaign: <campaign>` trailer, never a duplicate. It
never blocks a commit. An unattributed branch, or a CLI that exits non-zero, gets exactly one warning
that names the branch and points to the mission-execution skill. `OCTOBOTS_CODEX_MODEL` adds a
`Co-Authored-By: Codex (<model>)` line. `OCTOBOTS_ATTRIBUTE_TIMEOUT_MS` raises the CLI time limit
(default 30000).

The pack writes nothing under the repo's hooks directory. Each repo commits two shims once, at
`<core.hooksPath>/prepare-commit-msg` and `<core.hooksPath>/commit-msg`, mode 100755:

```sh
#!/bin/sh
# Attribution is advisory: a missing runtime or pack script must not block Git.
command -v node >/dev/null || { echo "prepare-commit-msg: warning: node not found, no mission trailer added" >&2; exit 0; }
helper="$(git rev-parse --show-toplevel)/.octobots/hooks/prepare-commit-msg.mjs"
[ -f "$helper" ] || { echo "prepare-commit-msg: warning: $helper not found, no mission trailer added" >&2; exit 0; }
node "$helper" "$@"
exit 0
```

```sh
#!/bin/sh
# Adds the mission trailer that prepare-commit-msg deferred until the editor closed. Advisory: never blocks.
command -v node >/dev/null || exit 0
helper="$(git rev-parse --show-toplevel)/.octobots/hooks/prepare-commit-msg.mjs"
[ -f "$helper" ] || exit 0
node "$helper" --after-edit "$@"
exit 0
```

Both shims are guarded: a missing `node` or a missing pack script prints one warning line (from
`prepare-commit-msg` only) and exits 0, so a fresh worktree or a repo that commits the shims before the
pack arrives never sees a stack trace. `commit-msg` adds the trailer after the editor closes and only when content was written, so an empty
message still aborts the commit.

`node .octobots/hooks/hooks-doctor.mjs [--root <dir>]` checks both sides without writing anything:
the octoshell hook entries in `.claude/settings.json` (by script path and matcher), and the git wiring
(`core.hooksPath` set, both shims present, executable, running the pack script). It prints each gap with
its owner and the exact fix. The default list is `required-hooks.json`, derived from the installer's own
list (`OCTOBOTS_HOOK_SPECS`; regenerate with `apps/vscode-extension/scripts/required-hooks.mjs --write`).
A repo adds other installers' entries in `.agents/settings/required-hooks.json` (add-only, keyed by event,
script and arg).

`install-pack.mjs --hooks` registers the octoshell entries in a fresh copy that has no `settings.json`.
