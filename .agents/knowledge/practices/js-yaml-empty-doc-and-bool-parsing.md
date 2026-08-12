---
name: js-yaml 5.2.2's actual empty-document and boolean-parsing behavior
description: In this repo's pinned js-yaml (5.2.2), load() throws on an empty/whitespace/comment-only document instead of returning undefined, and only literal true/false parse as booleans — bare yes/no/on/off stay strings.
type: reference
applies_to: [js-dev, tech-lead]
verified: 2026-08-09
aliases: [js-yaml empty file, js-yaml load undefined, yaml boolean parsing, js-yaml quirks]
tags: [area/tooling, area/parsing]
---

## The fact

Verified 2026-08-09 by running `js-yaml@5.2.2` (the version pinned in `packages/graph/package.json`
and resolved from this repo's `node_modules`) directly:

```js
const { load } = require("js-yaml");
load("");            // throws YAMLException: "expected a document, but the input is empty"
load("   \n  \n");    // same throw — whitespace-only
load("# just a comment\n"); // same throw — comment-only
load("42");           // 42            (bare scalar top level, no throw)
load("hello");        // "hello"       (bare string scalar, no throw)
load("- a\n- b");     // ["a", "b"]    (bare sequence, no throw)
load("flag: yes");    // { flag: "yes" }  — "yes" stays a STRING
load("flag: true");   // { flag: true }   — only literal true/false parse as boolean
```

Two things worth knowing before writing code or tests against this dependency in this repo:

1. **An empty/whitespace/comment-only document throws, it does not return `undefined`.** This
   differs from how some older js-yaml versions (3.x/4.x) behaved and from what you might expect
   from "empty YAML = empty object". Code that wraps `load()` in a `try { } catch { fall back }`
   already handles this case for free — the throw is caught the same as any other syntax error, no
   special-case needed. But do NOT write `const doc = load(text); if (doc === undefined) …` as your
   *only* empty-file guard outside a try/catch — this version won't reach that branch, it'll throw
   first.
2. **`yes`/`no`/`on`/`off` are NOT booleans in this js-yaml's default schema** — they parse as
   plain strings. Only the literal tokens `true`/`false` parse as JS booleans. A test meant to
   exercise "a boolean value landed in a field that expects a number" must use `true`/`false`, not
   `yes`/`no` — the latter will silently test the string-typo case instead of the boolean case.

## Why it matters / what it costs to get wrong

- A defensive parser (see `packages/graph/src/config.ts`'s `loadConfig` and `packages/graph/src/
  spine.ts`'s `pnpmPackageGlobs`, both of which wrap `load()` in try/catch and then shape-guard the
  result with `doc === null || typeof doc !== "object" || Array.isArray(doc)`) is safe against both
  quirks by construction: the try/catch swallows the empty-document throw, and the shape-guard's
  `typeof doc !== "object"` clause also happens to cover a hypothetical future `undefined` return
  (`typeof undefined === "undefined"`), so the code doesn't need to special-case either behavior.
  The risk is only in *tests* written to assert "an empty file returns `{}`" or "yes/no gets
  rejected as a boolean" — both would encode a false belief about this dependency version.
- If `js-yaml` is ever upgraded, re-verify this note — schema/parsing behavior across major
  versions is exactly the kind of thing that changes silently in a `^` semver bump.

## How to re-verify

```bash
cd packages/graph && node -e "
const { load } = require('js-yaml');
try { load(''); } catch (e) { console.log('empty throws:', e.reason); }
console.log(JSON.stringify(load('flag: yes')), JSON.stringify(load('flag: true')));
"
```

Related: [[dist-before-typecheck]]
