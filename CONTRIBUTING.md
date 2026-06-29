# Contributing to Octoshell

Thanks for your interest in contributing! This guide covers the local setup and the
conventions we follow.

## Prerequisites

- **Node ≥ 22.5** (the extension host and tests rely on built‑in `node:` APIs). Use
  `nvm use` to pick up `.nvmrc`.
- **pnpm 9** (`packageManager` is pinned in the root `package.json`).

## Setup

```bash
pnpm install
pnpm build        # build every package (turborepo respects build order)
pnpm test         # vitest across all packages
pnpm lint
pnpm typecheck
```

Per‑package iteration is faster:

```bash
pnpm --filter @octoshell/board test
pnpm --filter @octoshell/vscode-extension typecheck
pnpm --filter @octoshell/vscode-extension build
```

To run the extension, press **F5** in VS Code (*Run Octoshell Extension*) to launch an
Extension Development Host.

> **Changing a package's public types?** Downstream packages consume the built `dist/`, not
> source. Run `pnpm --filter @octoshell/<pkg> build` (or `pnpm build`) before `typecheck`/`test`
> in dependents, or they'll see stale `.d.ts`.

## Conventions

- **ESM + NodeNext.** TypeScript is `module: "NodeNext"`, `strict`,
  `noUncheckedIndexedAccess`. Relative imports **must** carry the `.js` extension
  (`import { x } from "./foo.js"`) even though the source is `.ts`.
- Each package exposes its public API through `src/index.ts`.
- Cross‑package imports use the package name (`@octoshell/board`), never relative paths into
  another package's `src`.
- The webview is React + Tailwind on VS Code theme tokens — **never hardcode colors**; use
  tokens like `bg-list-active`, `text-fg-muted`.
- Tests use Vitest (renderer tests use happy‑dom + `@testing-library/react`). Add or update
  tests with your change and make sure `pnpm test`, `pnpm lint`, and `pnpm typecheck` pass.

See [CLAUDE.md](CLAUDE.md) for a deeper tour of the architecture.

## Branching & keeping `main` green

`main` is always releasable and always green. **Never push directly to `main`** — all changes
land through a pull request.

1. **Branch off `main`** for every change. Use a short, descriptive name with a type prefix:
   `feat/board-doc-links`, `fix/watcher-debounce`, `chore/bump-vite`, `docs/contributing`.
2. **Keep the branch focused** — one feature or fix per branch. Rebase on `main` to stay current.
3. **Open a pull request** into `main`. CI (the `CI` workflow) runs `pnpm lint`, `pnpm build`,
   `pnpm typecheck`, and `pnpm test` on every push and PR.
4. **Merge only when CI is green** and the PR is reviewed. If a change can't be made green, it
   doesn't merge — fix it on the branch first.
5. Run `pnpm lint && pnpm build && pnpm typecheck && pnpm test` locally before pushing so red CI is
   the exception, not the norm.

> **Maintainers:** protect `main` on GitHub — require a pull request, require the `CI` status check
> to pass before merging, and keep branches up to date with `main`. That is what enforces the
> always‑green rule; the convention above is how contributors meet it.

## Pull requests

- Keep PRs focused; describe the change and how you verified it.
- Make sure CI (`lint` + `build` + `typecheck` + `test`) is green before requesting a merge.
- By contributing, you agree your contributions are licensed under the
  [Apache‑2.0 License](LICENSE).
