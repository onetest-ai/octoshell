# practices/

How we verify work, build-order/migration hazards, review conventions specific to this repo.

**Not here:** generic engineering advice not specific to this repo (e.g. "write tests" — that
belongs nowhere, it's assumed).

## Index

- [`dist-before-typecheck.md`](dist-before-typecheck.md) — dependents read a package's built
  `dist/`, not its `src/`; rebuild before typecheck/test after a public-type change, especially
  when running a per-package command outside turbo's `^build` dependency graph.
- [`grep-goes-binary-on-nul-bytes.md`](grep-goes-binary-on-nul-bytes.md) — one NUL byte makes `grep` treat a text file as binary and print nothing at all (exit 1), which reads exactly like "no matches"; use `grep -a` to confirm, then remove the NUL.
- [`octograph-design-md-snippets-vs-conventions-test.md`](octograph-design-md-snippets-vs-conventions-test.md) — `packages/graph/test/conventions.test.ts` bans `.npmi` reads outside `weights.ts` and `localeCompare` anywhere in `src/`; some M2 `design.md` task snippets predate that guard and fail lint if copied verbatim.
- [`js-yaml-empty-doc-and-bool-parsing.md`](js-yaml-empty-doc-and-bool-parsing.md) — this repo's pinned js-yaml 5.2.2 throws on an empty/whitespace/comment-only document instead of returning `undefined`, and only literal `true`/`false` parse as booleans (`yes`/`no`/`on`/`off` stay strings).
- [`write-tool-u0000-escape-becomes-raw-nul.md`](write-tool-u0000-escape-becomes-raw-nul.md) — typing the JS NUL escape into a `Write`/`Edit` tool call's `content` parameter gets JSON-decoded into a real 0x00 byte in the written file — self-inflicted, not copied from an existing broken doc; use a plain ASCII separator instead.
- [`knowledge-vault-sentence-filenames-confound-lexical-matching.md`](knowledge-vault-sentence-filenames-confound-lexical-matching.md) — `.agents/knowledge/**/*.md` filenames are full English sentences, so an unfiltered tf-idf/token-overlap matcher scored against prose (acceptance criteria, issue text) ranks them above real source files; filter stopwords out of both query and corpus first.
