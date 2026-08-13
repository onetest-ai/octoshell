# Octograph Extension Bridge (M6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire octograph into the VS Code extension as a **thin launcher** — two commands that open a terminal on the bundled CLI, plus `primer.mjs` injecting `map.md` as session context — and get the bundle into the workspace in the first place.

**Architecture:** Three layers. A **pack payload** step that ships the built bundle and installs it — borrowing tokenomics' install/status *shape* but not its build wiring, which never faced this problem. A **pure host module** (`octograph.ts`) that builds command strings and resolves artifact paths, unit-tested with no VS Code import. A **thin glue module** (`octograph-command.ts`) that registers the commands, opens a terminal, and does nothing else.

**Tech Stack:** TypeScript (NodeNext ESM, `strict`, `noUncheckedIndexedAccess`), Vitest, the VS Code extension API. **No new dependency on `@octoshell/graph`.**

## Global Constraints

- Relative imports carry `.js`. The extension uses CSS-variable VS Code theme tokens — never hardcoded colours — but this mission adds no webview.
- **The extension gains no runtime dependency on `@octoshell/graph`** (mission criterion 4). It ships the *built bundle as a static asset* and spawns `node` on it. Shipping a built artifact and spawning `node` on it is not a runtime dependency: there is no import edge in the extension's TypeScript. Adding `@octoshell/graph` to `dependencies` fails this mission; a `devDependency` for build ordering does not, but must be stated in the PR rather than slipped in.
- **No output capture, no state tracking, no post-run verification.** The terminal is the interface and `doctor` is the only thing that knows how to judge the result.
- Bare `node` — no `npx`, no network, no install step at run time.

---

## The gap this mission has to close first

The spec (§ Extension commands) says *"Octobots: Install Graph"* runs:

```
node .claude/skills/graph/octograph.mjs setup
```

and that *"the bundle is the same artifact the pack installs into any workspace, so the extension and a CLI agent in an unrelated repo run identical code."*

**Nothing installs it.** Verified 2026-08-11: `resources/octobots-pack/` contains `hooks/`, `skill/` and `tokenomics/` and no octograph anywhere. `packages/graph/scripts/bundle.mjs` writes to `dist/octograph.mjs`, inside the package, which the extension never reads. So `Install Graph` as specified would spawn `node` on a path that does not exist, and the user would see a bare ENOENT in a terminal.

That is why Task 1 exists and why it comes first. Its three responsibilities — ship, install, report drift — match what `octobots-tokenomics.ts` does, and its install/status shape is worth copying. Its *build wiring* is not, for the reason below.

> **Correction, after tech-lead review 2026-08-11: `octobots-tokenomics.ts` is NOT a precedent for
> this, and calling Task 1 "a mirror" was wrong.** The tokenomics pack payload is a hand-written,
> independently-maintained copy that shares no code with `packages/tokenomics`' TypeScript source —
> `bundle.mjs`'s own doc comment names that duplication as the anti-pattern octograph exists to
> avoid. **No existing mechanism in this repo ships a sibling package's build output as pack
> payload and verifies it fresh.** Task 1 is novel engineering. Copy tokenomics' *install/status
> shape* by all means; do not assume its build wiring, because it never had this problem.

#### Task 1's build wiring, designed rather than assumed

The naive placement does not work, and the review verified why:

- `packages/graph`'s `bundle` is **not a turbo task** — `turbo.json` defines only `build`, `test`,
  `lint`, `typecheck`. It runs ad hoc, today only as a side effect inside `bundle.test.ts`.
- `.github/workflows/package-vsix.yml` — the only workflow running `scripts/package-vsix.mjs` — is
  **`workflow_dispatch` only**. A freshness check placed there lets a stale payload pass every PR
  and surface only when someone manually packages a VSIX, possibly long after the drift landed.
  That is the failure Task 1 exists to prevent, one layer up.
- `apps/vscode-extension/package.json` has **no dependency edge at all** on `@octoshell/graph`, so
  turbo's `^build` ordering does not know the bundle must be built first.

So Task 1 must make three decisions explicitly, and they are its real substance:

1. **Where the freshness check runs.** It must be in the `pnpm build` / CI-gated path that runs on
   every push, not only in the dispatch-only VSIX workflow.
2. **How ordering is guaranteed.** Either a `devDependency` edge on `@octoshell/graph` plus a
   `bundle` turbo task, or an explicit shell-out from the extension's build script. A
   **`devDependency` is not a runtime dependency** and satisfies criterion 4 on its literal wording
   — but it is a new `package.json` entry, so state it in the PR rather than slipping it in.
3. **Committed or generated.** The File Structure table said "Task 1 decides", which is a decision
   deferred into implementation. Decide it here: **committed**, because a generated payload absent
   from a fresh clone makes the extension's build depend on build order that a contributor cannot
   see, and because "stale" then has a concrete meaning — the committed bytes differ from what
   `bundle.mjs` produces now, which is exactly what the check compares.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs` | **New, COMMITTED.** The bundle, as pack payload. Freshness is checked in the CI-gated build path — see Task 1. |
| `apps/vscode-extension/src/host/octograph-install.ts` | **Create.** `installGraph` / `graphStatus`, mirroring `octobots-tokenomics.ts`: copy the payload into the workspace, report present/current/stale. |
| `apps/vscode-extension/src/host/octograph.ts` | **Create.** Pure: command-string construction, artifact-path resolution, **two validators**. No `vscode` import. |
| `apps/vscode-extension/src/host/octograph-command.ts` | **Create.** Thin glue: register the two commands, create a terminal, send, show. |
| `apps/vscode-extension/resources/octobots-pack/hooks/primer.mjs` | **Modify.** Inject `map.md` when present and under a size cap; a one-line pointer otherwise. |
| `apps/vscode-extension/src/extension.ts` | **Modify.** Register the commands. Note: `extension.ts` is at `src/`, NOT under `src/host/`. |
| `apps/vscode-extension/package.json` | **Modify.** Contribute the two commands. **Not** `dependencies`. |

---

### Task 1: Ship the bundle as pack payload, and make a stale one fail the build

**Files:** Create `src/host/octograph-install.ts` and its test; modify the pack build/packaging step; add the payload path.

**Interfaces produced:**

```ts
export interface GraphStatus { present: boolean; current: boolean }
export function graphStatus(repoRoot: string, packVersion: string): GraphStatus;
export function installGraph(repoRoot: string): void;
```

- [ ] **Step 1:** Read `octobots-tokenomics.ts` end to end and `octobots-skill.ts`'s `installPack` and its drift check. Follow that shape — do not invent a second mechanism. Note how `installPack` already refuses to leave a workspace half-upgraded and how the activation-time prompt decides a re-install is needed.
- [ ] **Step 2:** Failing test — `graphStatus` reports `present: false` for a workspace with no `.claude/skills/graph/octograph.mjs`, and `present: true, current: false` when the installed copy's version does not match the pack version.
- [ ] **Step 3:** Failing test — `installGraph` copies the payload and the installed file is byte-identical to the resource.
- [ ] **Step 4:** Wire `graphStatus` into the existing pack drift check, so an extension upgrade prompts to re-install exactly as it does for a stale skill or a stale tokenomics CLI. One mechanism, not two.
- [ ] **Step 5: Make a missing or stale payload fail a CI-GATED build.** Assert the committed payload matches what `bundle.mjs` produces now. It must run in the path CI executes on every push — **not** in `package-vsix.yml`, which is `workflow_dispatch` only and would let drift pass every PR. Make the ordering real: a `bundle` turbo task plus a `devDependency` edge, or an explicit shell-out from the extension's build. Say which you chose and why in the PR.
- [ ] **Step 6:** Emit the pack-version marker into the bundle **explicitly** — an esbuild `banner: { js: "// octobots-pack-version: N" }` — rather than relying on esbuild's default comment retention, which `graphStatus` would otherwise depend on implicitly. Test that the marker survives bundling.
- [ ] **Step 7:** Green, commit.

**Acceptance criteria (board):** `graphStatus` distinguishes absent, stale and current, and its stale verdict drives the same re-install prompt a stale skill does; `installGraph` produces a file byte-identical to the shipped resource; the extension build fails when the payload is missing or does not match the current `packages/graph` bundle; `apps/vscode-extension/package.json` gains no `@octoshell/graph` dependency.

---

### Task 2: `octograph.ts` — pure command construction, with two validators

**Files:** Create `src/host/octograph.ts`, `test/octograph.test.ts`.

**Interfaces produced:**

```ts
export function graphCommand(cmd: "setup" | "map"): string;
export function impactArgv(repoRoot: string, path: string): string[] | null;   // null = rejected
export function conflictsArgv(ids: string[]): string[] | null;
export function artifactPath(repoRoot: string): string;
```

The spec is explicit that **one validator is wrong here**, and this is the task's whole substance:

- **Task ids** (`conflicts <a> <b>`) — the safe-slug pattern `sdlc-bundles.ts` already uses.
- **Paths** (`impact <path>`) — a slug validator is wrong: real paths contain `/`, `.`, `-`, and sometimes spaces. **Loosening the slug pattern to accept them would quietly gut the injection guard it exists to provide.** Instead: resolve the path, assert it stays inside the workspace root, reject shell metacharacters, and pass it as a **separate argv element** rather than interpolating it into a command string.

> **The containment rule cannot be reused, and pretending otherwise is unactionable.** An earlier
> draft said "reuse the reasoning `insideRepo` already encodes" — but `packages/graph/src/paths.ts`
> is unimportable here: criterion 4 forbids the dependency. `insideRepo` is non-trivial
> (`resolveAsFarAsExists`, `tryRealpath`, explicit symlink-escape handling, and a comment on why
> naive `resolve` + `startsWith` is insufficient), so this is a **second spelling of a containment
> rule** and must be treated as one.
>
> Make the duplication **visible and pinned** rather than silent: hand-duplicate the logic with a
> cross-reference comment naming `paths.ts` as its twin, and drive **both** implementations from
> one shared list of escape vectors so they can never diverge on a case. If a future mission wants
> to remove the duplication, the honest home is a small shared module both packages already depend
> on — out of scope here, and worth stating as the known follow-up rather than doing under cover of
> this mission.

- [ ] **Step 1:** Failing test — a path outside the workspace root is rejected: `..` traversal, an absolute path elsewhere, and a symlink pointing out. Use the same escape-vector list `paths.ts` is tested against.
- [ ] **Step 2:** Failing test — a path containing a shell metacharacter is rejected rather than escaped.
- [ ] **Step 3:** Failing test — a legitimate path with spaces and dots (`src/my file.test.ts`) is **accepted**, and appears as its own argv element with no quoting applied by us.
- [ ] **Step 4:** Failing test — task ids go through the slug validator and a non-slug id is rejected.
- [ ] **Step 5:** Failing test — `graphCommand("setup")` and `("map")` produce the documented `node .claude/skills/graph/octograph.mjs <cmd>` form, with no `npx` and no network.
- [ ] **Step 6:** Implement. **No `vscode` import in this module** — add a test asserting that, so it stays unit-testable.
- [ ] **Step 7:** Unit-test `artifactPath`'s two-branch resolution directly (`.octobots/graph` when a board exists, `.octograph` otherwise) — cheap, and today it would only be exercised end to end.
- [ ] **Step 8:** Document on `impactArgv`/`conflictsArgv` that they have **no consumer in this mission** and name the intended one. Also record that `vscode.Terminal.sendText` takes a single string, not an argv array — only `TerminalShellIntegration.executeCommand` accepts argv, and it falls back to `sendText` when shell integration is not active. Whoever wires `impact`/`conflicts` to a command will hit this; leave them the note rather than the rediscovery.
- [ ] **Step 9:** Green, commit.

**Acceptance criteria (board):** a path outside the workspace root, a `..` traversal and a symlink escaping the root are each rejected; a path containing a shell metacharacter is rejected rather than escaped; a legitimate path containing spaces is accepted and passed as its own argv element; task ids are validated by the slug pattern and paths never are; `octograph.ts` imports `vscode` nowhere, enforced by a test.

---

### Task 3: The two commands

**Files:** Create `src/host/octograph-command.ts`; modify `extension.ts` and `package.json` contributions.

- **"Octobots: Install Graph"** → `setup` — first-run flow: health checks, prompted installs, initial build.
- **"Octobots: Rebuild Graph"** → `map` — the routine path.

Both create a terminal, send the command, show it. Nothing more.

- [ ] **Step 1:** Failing test — the command handler creates a terminal with the workspace as `cwd`, sends the string `octograph.ts` produced, and shows it; it does **not** read the terminal, register an exit handler, or write any state.
- [ ] **Step 2:** Failing test — with no workspace folder open, the command reports that clearly rather than throwing.
- [ ] **Step 3:** Failing test — when the bundle is not installed, **Rebuild Graph** says so and points at Install Graph, rather than spawning `node` on a missing path and leaving the user an ENOENT.
- [ ] **Step 4:** Implement, register in `extension.ts`, contribute both commands in `package.json`.
- [ ] **Step 5:** Green, commit.

**Acceptance criteria (board):** both commands open a terminal, send the command and show it, and neither captures output, registers an exit handler, nor writes any state; with no workspace open each reports it rather than throwing; with the bundle absent, Rebuild Graph names Install Graph instead of producing an ENOENT in the terminal.

---

### Task 4: `primer.mjs` injects `map.md`

**Files:** Modify `resources/octobots-pack/hooks/primer.mjs` and its tests.

The session hook already teaches a CLI agent how to read the board. `map.md` is the other thing an agent landing in an unfamiliar repo needs, and it is token-budgeted precisely so it can be loaded as context.

> **An earlier draft of this task contradicted the mission's own criterion**, and it is worth naming
> because it is this campaign's defect committed against the criteria themselves. AC 3 reads
> *"injects `map.md` when it exists **and** is under a size cap, **otherwise** a one-line pointer"* —
> and "otherwise" covers **both** branches: absent, and present-but-over-cap. The draft said absent
> → output byte-identical, no pointer at all, silently narrowing approved behaviour. Corrected
> below: the pointer is emitted in both non-injecting cases.

- [ ] **Step 1:** Failing test — with `map.md` present and under the size cap, the primer's output contains it.
- [ ] **Step 2:** Failing test — with `map.md` present but **over** the cap, the primer emits a **one-line pointer** naming the path, not a truncated map. A truncated architecture map is worse than none: it reads as complete.
- [ ] **Step 3:** Failing test — with **no** `map.md`, the primer emits the one-line pointer too, naming where the map would be and how to build it. This is the second half of AC 3's "otherwise", and it is the case a workspace that has not run octograph yet actually hits.
- [ ] **Step 4:** Failing test — everything the primer emitted before this mission is still present in all three cases. The map block is **additive**; this mission must not change what a workspace already relies on.
- [ ] **Step 5:** Pin the cap as a named constant with its rationale, in the same spirit as `budgetTokens`. State it in bytes and why. Note that `map.md`'s ~2k-token target is a *rendering* target and `--budget` is user-configurable, so a byte cap here is real defence and not a restatement.
- [ ] **Step 6: Bump `OCTOBOTS_PACK_VERSION` and the `// octobots-pack-version:` marker in `primer.mjs`.** `packStatus` keys staleness off exactly that marker. Skip it and every already-installed workspace silently never learns the primer changed — no upgrade prompt, ever, until some unrelated bump carries it. Task 1 wires its own payload into the same mechanism; this is the identical step.
- [ ] **Step 7:** Implement, green, commit.

**Acceptance criteria (board):** with `map.md` present and under the cap the primer output contains it; over the cap it contains a one-line pointer naming the path and not the map body; with no `map.md` it contains that same one-line pointer rather than nothing; everything the primer emitted before this mission is still present in all three cases; the cap is a named constant with a stated rationale; `OCTOBOTS_PACK_VERSION` and `primer.mjs`'s version marker are both bumped so an installed workspace is prompted to re-install.

---

### Task 5: End-to-end — a workspace with no graph, a stale one, and a launcher that stays thin

**Role:** `qa-engineer`

- [ ] **Step 1:** A workspace with the pack installed but no octograph gets a working **Install Graph** — the bundle lands at the documented path and runs under bare `node`.
- [ ] **Step 2:** After an extension upgrade with a stale installed bundle, the drift prompt fires and re-install produces a byte-identical copy of the new payload.
- [ ] **Step 3:** **Rebuild Graph** against a real workspace writes `map.md` and `clusters.json` at the resolved artifact path — assert against the exported `artifactPath()`, never by re-deriving the `.octobots/graph` vs `.octograph` fallback, which would be a third spelling of that rule.
- [ ] **Step 4:** Assert the launcher stays thin: grep the two host modules for output capture, exit handlers, and state writes, and assert none — this is the criterion most likely to erode later, so it needs a test and not a review comment.
- [ ] **Step 5:** Assert `apps/vscode-extension/package.json` has no `@octoshell/graph` dependency, and that the extension bundle does not contain the graph package's source.
- [ ] **Step 6:** Every fixture removed on completion.

---

## Self-Review

**Spec coverage.** Mission criterion 1 (terminal, no capture) → T3, T5S4. Criterion 2 (path validator, not slug) → T2. Criterion 3 (primer injects `map.md`) → T4. Criterion 4 (no runtime dependency) → T1S5, T5S5.

**Scope this plan adds beyond the mission's four criteria, and why.** Task 1 is not covered by any current criterion, because the mission was written assuming the bundle already reached the workspace. It does not. Without Task 1 the other three tasks build a launcher for a file that is never there. **Add a fifth mission criterion for it before execution** — this campaign's recurring failure is work whose correctness no criterion states.

**Re-estimate.** The mission is boarded at 1 day / S. With Task 1 it is closer to **2 days / M**. Update `tokenomics` on the mission rather than leaving a size that was set before the gap was known.

**Deliberately out of scope:** any webview, any graph visualisation, any status bar item, `own`/`conflicts`/`drift`/`impact` as VS Code commands. The spec's command table names exactly two commands, and a launcher that grows a UI stops being a launcher.
