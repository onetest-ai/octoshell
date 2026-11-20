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
