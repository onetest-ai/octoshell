# Octograph Interactive Setup Installer (M5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `octograph setup` — run `doctor`, prompt before installing anything, install Graphify via `uv` on consent, build, print the postflight.

**Architecture:** `setup` is **not** a `runCli` command. All its effects — prompting, spawning, writing — go through an injected **IO port**, so the whole flow is testable with no TTY, no network and no installs. The port is the design; everything else is a script over it.

**Tech Stack:** TypeScript (NodeNext ESM, `strict`, `noUncheckedIndexedAccess`), Vitest, `node:child_process` (`execFile`, never `exec`), `node:readline`. No new third-party dependencies.

## Global Constraints

- Relative imports carry `.js`. No new runtime dependency.
- **Never pipe a remote script to a shell.** No `curl … | sh`, ever, under any flag.
- **Never spawn through a shell.** `execFile` with an argv array — so there is no string for an interpolated value to escape out of.
- **Prompt before installing anything.** Never install as a side effect of a build.
- **Never install into the repo.** Graphify is a user-level tool. `setup` writes no tracked file — only artifacts under the resolved `out` directory.
- `uv tool install graphifyy` — **the double-`y` is correct.** The GitHub repo is `Graphify-Labs/graphify`; the published package is `graphifyy`. Do not "fix" it. A QA pass has already flagged it once as a typo.
- Fixtures use `mkdtempClean()`.

---

## The structural decision this mission turns on

`runCli(argv, repoRoot, now): CliResult` is **synchronous** and deliberately never touches `process`
— it returns its exit code and output text so an in-process caller can run a command without
spawning one. `index.ts` records that this is precisely for M6's VS Code commands.

Interactive prompting is asynchronous by nature. Making `setup` a `runCli` command therefore forces
one of two bad outcomes: `runCli` becomes `async` (a breaking change to the consumer M6 has not been
built for yet), or `setup` reads stdin directly (destroying the testability and purity that make
`runCli` worth having).

**So `setup` is a separate exported entry point, not a `Command`:**

```ts
export interface SetupIO {
  prompt: (question: string) => Promise<boolean>;   // y/N
  log: (line: string) => void;
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  which: (file: string) => Promise<string | null>;
}
export function runSetup(
  repoRoot: string,
  config: Config,
  now: number,          // NOT optional — see below
  io: SetupIO,
): Promise<number>;     // exit code
```

> **`now` is a parameter, not something `setup.ts` reads.** The build step calls `analyze()`, whose
> `AnalyzeOptions.now: number` is required with no default (`analyze.ts:83`). And
> `test/conventions.test.ts` scans **every** file under `src/` for a clock read, with no exemption
> list — so `Date.now()` inside `setup.ts` fails the build. The one sanctioned clock read in this
> package is in `bin/octograph.mjs`, outside `src/`, feeding `runCli`'s `now`. `runSetup` takes its
> clock the same way, from the same place.

> **The build step must call the same code `map` does.** `runMapCommand` is currently private to
> `cli.ts`. Reassembling `analyze → renderMap → writeArtifact` by hand in `setup.ts` would be a
> second implementation of the thing this whole tool exists to detect — the `entity-io.mjs` /
> `entity-schema.ts` shape. Export a shared `buildMap()` (or `runMapCommand` itself) and call it.

The `bin` wires a real TTY/`execFile` implementation; tests pass a fake and assert on the calls
made. This is consistent with the spec: `setup` does not appear in the § Output contract command
table — it lives under § Octobots bridge, which is a different surface.

**Consequence to state plainly:** `octograph setup` still works as a shell command, because the bin
constructs the port. Nothing about the user-facing behaviour changes; only the internal seam does.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/graph/src/setup.ts` | **Create.** `SetupIO`, `runSetup`: doctor → prompt → install → build → postflight. Pure over the port. |
| `packages/graph/src/setup-io.ts` | **Create.** The real port: `node:readline` prompting, `execFile` spawning, `which` lookup. The only module that touches the outside world. |
| `packages/graph/src/bin.ts` (or the existing bin entry) | **Modify.** Route `setup` to `runSetup` with the real port; every other command still goes to `runCli`. |
| `packages/graph/test/setup.test.ts` | **Create.** The whole flow against a fake port. |

---

### Task 1: The IO port and the setup flow, with nothing installed

**Files:** Create `src/setup.ts`, `src/setup-io.ts`, `test/setup.test.ts`; modify the bin and `src/index.ts`.

**Interfaces produced:** `SetupIO`, `runSetup` as above.

- [ ] **Step 1:** Failing test — `runSetup` with a fake port on a healthy repo runs `doctor`, prompts for nothing, and returns 0.
- [ ] **Step 2:** Failing test — with Graphify missing and the fake port answering **no**, `runSetup` performs **zero** `exec` calls that install anything, and still returns a useful postflight explaining what is degraded and how to fix it by hand.
- [ ] **Step 3:** Failing test — with the fake port answering **yes**, exactly one `exec` call is made, and it is `("uv", ["tool", "install", "graphifyy"])` — asserted as an **argv array**, so a future refactor into a shell string fails the test.
- [ ] **Step 4:** Failing test — a build is never a trigger for an install: running `runSetup` twice with the port answering no both times performs no install on either pass.
- [ ] **Step 5:** Implement `setup.ts` over the port; implement `setup-io.ts` with `readline` and `execFile`. **`setup-io.ts` is the only module allowed to import `node:child_process`** — add a conventions test asserting that, so a later task cannot quietly spawn from elsewhere.

- [ ] **Step 6: Unit-test `setup-io.ts` directly** — create `test/setup-io.test.ts`.

> The port implementation is the **safety-critical** module, and every other test in this plan
> replaces it with a fake. Task 4's E2E deliberately never performs a real install, so without this
> step the real `execFile`/`readline`/`which` wiring is never exercised against an actual process
> anywhere. Mission criterion 5 requires the rule be "enforced by tests, not by review"; a module
> that spawns processes and is never directly tested does not clear that bar.
>
> Spy on `node:child_process` to assert `exec()` reaches `execFile` and never `exec`/`spawn` with a
> shell, and run it once against a harmless real binary — **not** `uv` — to prove the promisified
> result shape actually works rather than only type-checking.

- [ ] **Step 7:** Green, export, commit.

**Acceptance criteria (board):** given a fake port that declines, `runSetup` makes no install call and still prints a postflight naming what is degraded and the manual fix; given a port that consents, exactly one install call is made and it is the argv array `["uv","tool","install","graphifyy"]`; given two consecutive runs that both decline, no install occurs on either; no module other than `setup-io.ts` imports `node:child_process`, enforced by a conventions test.

---

### Task 2: Missing `uv`, and the safety rules that have no override

**Files:** Modify `src/setup.ts`, `test/setup.test.ts`.

- [ ] **Step 1:** Failing test — when `which("uv")` returns null, `runSetup` prints uv's install URL, performs **no** exec, and returns a non-zero exit code.
- [ ] **Step 2:** Failing test — the source-text guard targets **`setup-io.ts`**, not `setup.ts`.

> **Scanning `setup.ts` for `|`, `curl` or `sh -c` would be theatre.** By this plan's own
> architecture `setup.ts` never touches `child_process` — it only calls `io.exec("uv", [...])` with
> a literal string and an array, so it *cannot* contain those substrings, and the assertion would
> pass forever no matter what the real spawning code does. The dangerous surface is the one module
> designated to touch the outside world. Guard the primitives that would actually violate the rule,
> in the file that can actually contain them: `child_process.exec(`, `spawn(` with `shell: true`,
> any `{ shell: true }` option, or a spawn whose arguments are not a literal array. Model it on
> `test/conventions.test.ts`, which already carries nine such guards and documents the defect each
> one caught.
- [ ] **Step 3:** Failing test — `setup` writes nothing outside the resolved `out` directory. Run against a fixture repo, snapshot the tracked-file list before and after, and assert equality.
- [ ] **Step 4:** Implement; green; commit.

**Acceptance criteria (board):** with `uv` absent, `runSetup` prints uv's documented install URL, makes zero exec calls, and exits non-zero; no exec call and no source line in `setup.ts` constructs a piped-remote-script invocation; after a `setup` run against a fixture repo, `git status` reports no modified or added tracked file outside the resolved out directory.

---

### Task 3: Artifact migration — CANCELLED 2026-08-11 (owner, YAGNI)

Nobody has adopted octograph yet, so there is no installed base holding `.octograph/` artifacts to
migrate. Building it would hardcode a transitional path into the shipped bundle **permanently**, to
serve a population that does not exist.

The residual case is a fresh user who runs octograph standalone and adopts Octobots afterwards. Its
entire cost is that cluster ids reset once and that run reports every cluster as fresh — cosmetic
churn in one report, not data loss. That does not justify permanent code in the artifact every user
downloads.

**Dropping it made the safety rule stronger**, which is the tell that it was right. Criterion 3 had
been amended hours earlier to carry a named exception letting `setup` delete the directory it
migrated from. With no migration there is nothing to except, and criterion 3 is absolute again:
*setup touches no tracked file at all except the artifacts under the resolved out directory.* A
component that mutates the user's machine is better with one rule and no carve-outs.

`migrate.ts` is not created. If an adopting base ever appears, this is a standalone one-shot script,
not bundle code.

---

### Task 4: End-to-end — consent, refusal, absent `uv`, and a tree that stays clean

**Role:** `qa-engineer`

- [ ] **Step 1:** Drive the real bin (not `runSetup` directly) against a fixture repo with a scripted stdin answering **no**; assert no install ran and the exit code and postflight are correct.
- [ ] **Step 2:** Same with `uv` absent from `PATH`; assert the install URL is printed and nothing was spawned.
- [ ] **Step 3:** Assert the fixture repo's tracked files are byte-identical before and after every scenario.
- [ ] **Step 4:** Assert the pack bundle still runs `setup` under bare `node` with no `node_modules`.
- [ ] **Step 5:** Confirm the published package name in the install command is `graphifyy` and that a test pins it, so the double-`y` cannot be "corrected" without a failing test explaining why.
- [ ] **Step 6: Verify the BUILD, not just the postflight.** Run `runSetup` to completion with full consent, then assert the resulting `map.md` and `clusters.json` are **equal to what `octograph map` alone produces** against the same repo at the same `now`. Every other step in this plan checks prompts, installs and exit codes; none of them checks that the artifact `setup` claims to have built is right. A postflight that reports a state it never verified is this campaign's defect, and it has shipped six times.
- [ ] **Step 7:** Every fixture removed on completion (`mkdtempClean`).

**Do not** perform a real `uv tool install` in any test. The suite must pass offline, on a machine with no `uv`, without mutating the developer's tools.

---

## Self-Review

**Spec coverage.** Mission criterion 1 (prompt before installing, never as a build side effect) → T1S2–4. Criterion 2 (missing `uv` prints URL, no piped script) → T2S1–2. Criterion 3 (touches no tracked file outside `out`, no exception) → T2S3, T4S3. Criterion 4 (only the IO port imports `node:child_process`; no piped-script construction) → T1S5, T2S2, T2S3.

**Deliberately not in scope:** installing anything other than Graphify; updating or uninstalling; any non-interactive `--yes` flag. A flag that skips the prompt is the exact affordance criterion 1 exists to forbid, and adding one "for CI" would make the safety rule optional in the environment where nobody is watching.

**Why there is no `--yes`, stated concretely rather than only from principle.** The two cases that
would seem to need it are already covered. M6's extension opens a **real terminal** for a human to
answer the prompt — the port is the escape valve, and it is deliberately left open. And a CI job or
Docker image that wants Graphify preinstalled runs `uv tool install graphifyy` directly in its
Dockerfile: a plain, auditable one-liner that does not require `octograph` to carry a
prompt-skipping surface at all, and is more reviewable than a flag would be. Graphify is optional
input (D4), so CI does not need it to run `octograph` in the first place. A flag that skips the
prompt is the exact affordance criterion 1 forbids, and adding one "for CI" would make the safety
rule optional precisely where nobody is watching.

**Open question for M6, not for this mission:** `runSetup` returns an exit code, so the extension
can open a terminal on the bin and read it. Whether M6 should instead call `runSetup` in-process
with a webview-backed prompt port is an M6 decision — the port makes both possible.

**Reviewed by tech-lead 2026-08-11.** Four blocking findings, all folded in: `runSetup`'s missing
`now` parameter (`analyze()` requires it and `conventions.test.ts` forbids a clock read anywhere
under `src/`); a source-text safety guard pointed at `setup.ts`, which by construction can never
contain the strings it scanned for, instead of at `setup-io.ts`, which can; no direct test for
`setup-io.ts`, the one safety-critical module every other test replaces with a fake; and the
migration-deletion conflict, resolved by the owner above. He verified the structural claim about
`runCli` independently and found no better seam, and confirmed the `graphifyy` guard is correctly
scoped. He also flagged that nothing in the plan verified the **build** phase at all — only prompts,
installs and exit codes — which is now Task 4 Step 6.
