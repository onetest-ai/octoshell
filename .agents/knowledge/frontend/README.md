# frontend/

Webview-side (React + Tailwind) state and lifecycle rules that aren't obvious from the code —
enforced UI conventions, host↔webview `postMessage` protocol gotchas, theming rules
(`CLAUDE.md` already states "never hardcode colors — use tokens like `bg-list-active`,
`text-fg-muted`" — a repeat of that belongs in `AGENTS.md`/`CLAUDE.md`, not a new note here).

**Not here:** generic React knowledge available in any React doc; anything already stated in
`CLAUDE.md`'s webview section.

## Index

_Empty — no notes yet. Candidate for a first note: the `chat-entry.tsx` naming ("a legacy name —
there is no chat") is already documented in `CLAUDE.md`; a genuinely new frontend note would need
something not already stated there, e.g. a verified webview re-render/perf gotcha._
