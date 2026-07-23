# SDLC Team Bundle Install/Update Commands — Design

**Date:** 2026-07-23
**Status:** Approved (design)
**Component:** `apps/vscode-extension` (host only)

## Problem

Octobots (the board) and [sdlc-skills](https://github.com/arozumenko/sdlc-skills) (the teams)
are used together: Octobots owns the *what/when* (campaigns → missions → tasks, and the
`workflow.js` a mission runs), while sdlc-skills owns the *who/how* — named **team bundles** of
role agents/skills that "float in" to do a task's work. Today those two have separate install
stories. Octobots installs its own workflow pack via the *Octobots: Install Workflow Pack*
command; sdlc-skills bundles are installed only by hand from a terminal
(`npx github:arozumenko/sdlc-skills init --bundle <id>`).

We want Octobots to **offer installation (and update) of sdlc-skills bundles** from inside the
extension, so setting up a dev/QA/automation team is a discoverable command rather than tribal
knowledge.

## Principle: Octobots is a thin launcher; sdlc-skills owns the truth

The sdlc-skills installer is a **guided, interactive CLI** — the user makes selections and types
answers mid-flow (e.g. `feature-development` has an interactive dev-role picker for Python/JS/iOS,
plus external-dependency resolution and overwrite confirmations). It also already handles
cross-IDE layout and dependency resolution.

Therefore Octobots **delegates** to that installer and does not re-implement it. Octobots' job is
**discovery + one click + launch an interactive terminal**. It never captures output, pipes
answers, parses the stream, or verifies the result. This avoids the format/dependency drift that
re-implementing the install would guarantee, and keeps sdlc-skills the single source of truth for
what a bundle contains.

This same principle sets the boundaries below: no installed-state detection (pure launcher), and
dynamic discovery so new bundles appear without an Octobots release.

## Scope

**In scope**
- Two new VS Code commands (host side only):
  - `octoshell.installSdlcBundle` — **"Octobots: Install SDLC Team Bundle"**
  - `octoshell.updateSdlcBundle` — **"Octobots: Update SDLC Team Bundle"**
- One new host module `src/host/sdlc-bundles.ts` holding the catalog + command-string logic.
- Unit tests for the pure functions in that module.

**Out of scope (explicit non-goals)**
- No changes to `@octoshell/board`, the Octobots workflow pack, or the webview.
- No installed-vs-not **status detection** (pure launcher — see Q4 decision).
- No output capture, prompt automation, or post-install verification.
- No board-driven / contextual "you need team X" nudge (that was considered and deferred; this
  feature is the extension-command surface only).
- Octobots does not pre-flight `node`/`npx` presence — failures surface in the terminal like any
  CLI.

## Decisions (from brainstorming)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Where does the offer live? | **Extension UI** — command(s), not agent/board-driven. |
| Q2 | How is the install performed? | **Delegate** to the sdlc-skills `npx` installer. |
| Q3 | How are bundles discovered? | **Hybrid** — dynamic catalog fetch with a baked-in fallback. |
| Q4 | Track installed state? | **No** — pure stateless launcher. |
| Q5 | Install vs update surface? | **Two commands**, sharing the bundle QuickPick under the hood. |
| — | Discovery source | **GitHub contents API** for the `bundles/` directory. |

## Architecture

One new command handler per action (thin VS Code glue) backed by one mostly-pure module.

```
package.json  contributes.commands  ─┐
extension.ts  registerCommand(...)   ─┼─► command handler (thin glue)
                                      │        │
src/host/sdlc-bundles.ts  ◄───────────┘        │ 1. require workspace folder
   FALLBACK_BUNDLES                            │ 2. await fetchBundleCatalog()
   fetchBundleCatalog(fetchImpl?)              │ 3. showQuickPick(bundles)
   bundleInstallCommand(id, {update})          │ 4. createTerminal + sendText + show
   Bundle { id, label, description }           │
```

### `src/host/sdlc-bundles.ts`

```ts
export interface Bundle { id: string; label: string; description: string }

/** Known bundles, used both as rich metadata and as the offline fallback list. */
export const FALLBACK_BUNDLES: Bundle[] = [
  { id: "feature-development", label: "Feature Development",
    description: "Cross-platform delivery team (scout, BA, PM, tech-lead, QA + dev roles)." },
  { id: "manual-qa", label: "Manual QA",
    description: "Six manual-QA specialists for live browser testing." },
  { id: "test-automation", label: "Test Automation",
    description: "Automation pipeline: analyst → implementer → reviewer." },
];

const BUNDLES_CONTENTS_URL =
  "https://api.github.com/repos/arozumenko/sdlc-skills/contents/bundles";

/**
 * Discover bundle ids from the sdlc-skills `bundles/` directory (one GitHub contents API call)
 * and merge with FALLBACK_BUNDLES metadata:
 *   - a discovered id present in FALLBACK_BUNDLES → use the rich fallback entry
 *   - a discovered id NOT in FALLBACK_BUNDLES → synthesize { id, label: id, description: generic }
 * On any failure (offline, non-200, malformed, empty) → return FALLBACK_BUNDLES unchanged.
 * `fetchImpl` is injectable for tests; defaults to global fetch (Node 22).
 */
export async function fetchBundleCatalog(fetchImpl = fetch): Promise<Bundle[]> { /* ... */ }

/** Pure builder. update:true appends " --update" (overwrite existing installs). */
export function bundleInstallCommand(id: string, opts: { update?: boolean } = {}): string {
  const base = `npx github:arozumenko/sdlc-skills init --bundle ${id}`;
  return opts.update ? `${base} --update` : base;
}
```

The GitHub contents API returns a JSON array of entries; keep only `type === "dir"` entries and
use their `name` as the bundle id. No per-bundle `bundle.json` fetch (avoids N+1); rich
label/description come from `FALLBACK_BUNDLES`, so new/unknown bundles still appear (with id as
label) but without hand-written copy.

### Command handler (shared, in `extension.ts` or a small host file)

Both commands call one shared function parameterized by `update: boolean`:

1. Resolve the workspace root from `vscode.workspace.workspaceFolders[0]`. If none →
   `window.showErrorMessage("Open a workspace folder first.")` and return.
2. `const bundles = await fetchBundleCatalog();`
3. `const pick = await window.showQuickPick(bundles.map(b => ({ label: b.label, description: b.id, detail: b.description, id: b.id })), { placeHolder: update ? "Update which SDLC team bundle?" : "Install which SDLC team bundle?" });`
   Cancelled (`undefined`) → return silently.
4. `const term = window.createTerminal({ cwd: workspaceRoot, name: "SDLC Bundle Install" });`
   `term.sendText(bundleInstallCommand(pick.id, { update }));`
   `term.show();`

The user then drives the guided prompts in that terminal. Octobots is done.

## Data flow

```
User → Command Palette → "Octobots: Install/Update SDLC Team Bundle"
  → handler: workspace check
  → fetchBundleCatalog() ──(GitHub contents API)──► [dir names]
        └─ on error ─────────────────────────────► FALLBACK_BUNDLES
  → QuickPick(bundles) → user picks bundle
  → integrated terminal: npx … init --bundle <id> [--update]
  → user answers guided CLI prompts directly (Octobots not involved)
```

## Error handling

| Condition | Behavior |
|-----------|----------|
| No workspace folder open | Error message; abort before any terminal. |
| Catalog fetch fails / non-200 / malformed / empty | Silent fallback to `FALLBACK_BUNDLES`; command still works offline. |
| QuickPick cancelled | Return silently, no terminal. |
| `npx`/node missing, network down during install, install error | Surfaces in the terminal to the user; Octobots does not pre-flight or intercept. |

## Testing

Vitest on the pure module (`sdlc-bundles.test.ts`), matching the board package's pure-function
style:

- `bundleInstallCommand("manual-qa")` → `npx github:arozumenko/sdlc-skills init --bundle manual-qa`.
- `bundleInstallCommand("manual-qa", { update: true })` → same string + ` --update`.
- `fetchBundleCatalog` with an injected fetch returning a valid dir array → merges: known ids get
  fallback metadata, an unknown id appears with `label === id`.
- `fetchBundleCatalog` with an injected fetch that rejects / returns non-200 / returns garbage /
  returns `[]` → returns `FALLBACK_BUNDLES`.

The command handler / terminal creation is thin VS Code API glue and stays untested, consistent
with existing host patterns.

## Files touched

- `apps/vscode-extension/src/host/sdlc-bundles.ts` — new (catalog + command builder).
- `apps/vscode-extension/src/host/sdlc-bundles.test.ts` — new (pure-function tests).
- `apps/vscode-extension/src/host/extension.ts` — register the two commands (shared handler).
- `apps/vscode-extension/package.json` — two `contributes.commands` entries.
