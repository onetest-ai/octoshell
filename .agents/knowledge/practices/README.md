# practices/

How we verify work, build-order/migration hazards, review conventions specific to this repo.

**Not here:** generic engineering advice not specific to this repo (e.g. "write tests" — that
belongs nowhere, it's assumed).

## Index

- [`dist-before-typecheck.md`](dist-before-typecheck.md) — dependents read a package's built
  `dist/`, not its `src/`; rebuild before typecheck/test after a public-type change, especially
  when running a per-package command outside turbo's `^build` dependency graph.
- [`grep-goes-binary-on-nul-bytes.md`](grep-goes-binary-on-nul-bytes.md) — one NUL byte makes `grep` treat a text file as binary and print nothing at all (exit 1), which reads exactly like "no matches"; use `grep -a` to confirm, then remove the NUL.
