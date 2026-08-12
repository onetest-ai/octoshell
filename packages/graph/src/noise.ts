/**
 * Whether a path is a test file, per spec A8.
 *
 * A single-spelling rule, in the same sense as `edgeWeight` (weights.ts) and
 * `compare` (rollup.ts): every place in this package that needs to know
 * "is this a test" reads it through here, never by hand-rolling a regex at
 * the call site. A duplicated rule is exactly what produced M1's negative
 * module edges (see weights.ts) — a second `/\.test\./` open-coded elsewhere
 * agrees with this one on every fixture until the day someone tweaks just
 * one of them, and the two implementations quietly start disagreeing about
 * which files are tests.
 *
 * Detection is path-based and deterministic: independently-compiled regexes
 * over directory names and file suffixes, no parsing, no I/O. Ported from
 * the policy in `wikis/cluster_constants.py:_TEST_PATH_PATTERNS`.
 *
 * A path counts as a test file if ANY of:
 *  - a path segment (bounded by `/` or the string's own start/end — never a
 *    substring match) equals `test`, `tests`, or `__tests__`. Segment-bounding
 *    is what keeps `src/latest.ts`, `src/contest/handler.ts`,
 *    `src/attestation.ts` and `src/testing-utils/x.ts` (directory "testing",
 *    not "test") out of this rule — a plain substring match would tag all
 *    four. `spec`/`specs` is deliberately NOT in this list, unlike
 *    `test`/`tests`/`__tests__`: a bare `spec`/`specs` directory is at least
 *    as often "specifications" (an API spec, a design doc) as it is RSpec's
 *    `spec/` convention, and this repo's own `docs/superpowers/specs/`
 *    proved it — it tripped the segment rule and mis-split a documentation
 *    module in map.md. See the filename-suffix rule below for the
 *    unambiguous form.
 *  - the filename ends in `.test.` or `.spec.` followed by `ts`, `tsx`, `js`,
 *    or `jsx`. Unlike the bare `spec` directory segment above, this form is
 *    unambiguous (Jasmine/Angular-style `foo.component.spec.ts`) — it names
 *    the FILE, not its directory, so it never collides with a
 *    "specifications" folder.
 *  - the filename follows Python's `test_*.py` / `*_test.py` convention.
 *  - the filename is exactly `conftest.py`. pytest's fixture file is test
 *    infrastructure wherever it sits, and it does NOT have to sit under a
 *    `tests/` segment — the convention puts one at the package root (and often
 *    at the repo root) so its fixtures apply to everything beneath it. Missing
 *    it is not cosmetic: a root `conftest.py` co-changes with every test in the
 *    tree, so left ungraded it survives the noise floor as a `candidate` and
 *    `drift` reports test scaffolding as an architectural finding — exactly the
 *    noise the floor exists to remove — while clustering builds a test-shaped
 *    community around it (the A8 harm). Anchored to the whole filename, so
 *    `src/myconftest.py` and `src/conftest_helpers.py` are unaffected.
 *  - the filename ends in `_test.go`.
 */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? "";

  const testSegment = /^(test|tests|__tests__)$/;
  if (segments.some((s) => testSegment.test(s))) return true;

  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filename)) return true;
  if (/^test_.+\.py$/.test(filename) || /_test\.py$/.test(filename)) return true;
  if (filename === "conftest.py") return true;
  if (/_test\.go$/.test(filename)) return true;

  return false;
}

/**
 * Whether `path` falls under one of `excludePaths` — a repo-relative prefix
 * list, sourced from `octograph.yaml`'s `excludePaths` key (see config.ts)
 * and defaulting to this tool's own tooling directories: `.agents/`,
 * `.claude/`, `.octobots/`.
 *
 * Those three are an agent's own working notes and board entities, not the
 * codebase under analysis — they co-change with real code for a reason that
 * has nothing to do with architecture (an agent edits its notes while it
 * edits code). Measured on `octoweb`: five of `drift`'s top ten rows named a
 * `.agents/` or `.claude/` path, burying every real cross-module finding
 * beneath tooling-state noise the repo's own architecture never produced.
 *
 * Segment-bounded, the same discipline `isTestPath` applies to `test`/
 * `tests`: an entry matches a path only at a `/` boundary (or the path's own
 * end), so `.claude` does not swallow `.claudefoo/`. A trailing slash on the
 * configured entry is optional and behaves identically either way, because
 * `octograph.yaml` is hand-edited and both spellings read as "this
 * directory" to whoever writes it. An empty entry (a stray blank line) never
 * matches anything, rather than matching every path.
 */
export function isExcludedPath(path: string, excludePaths: readonly string[]): boolean {
  for (const raw of excludePaths) {
    const prefix = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (prefix.length === 0) continue;
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Manifest -> lockfile pairs whose coupling is mechanical and already known. */
const LOCK_PAIRS: Array<[RegExp, RegExp]> = [
  [/(^|\/)package\.json$/, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/],
  [/(^|\/)Cargo\.toml$/, /(^|\/)Cargo\.lock$/],
  [/(^|\/)pyproject\.toml$/, /(^|\/)(uv\.lock|poetry\.lock)$/],
  [/(^|\/)go\.mod$/, /(^|\/)go\.sum$/],
  [/(^|\/)Gemfile$/, /(^|\/)Gemfile\.lock$/],
];

export type PairClass = "test-subject" | "mechanical" | "intra-module" | "candidate";

/** The directory part of a repo-relative path; `""` for a root-level file. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Whether a lockfile in `lockDir` is the one that GOVERNS a manifest in
 * `manifestDir` — i.e. whether it sits in that manifest's own directory or in
 * an ancestor of it.
 *
 * A lockfile's authority runs downwards and only downwards. pnpm, npm and
 * Cargo workspaces all put one lock at the workspace root and a manifest in
 * every package under it, so `packages/board/package.json` really is governed
 * by the root `pnpm-lock.yaml` — that pairing is the flagship mechanical
 * coupling in this very repo and must stay suppressed. Two SIBLING packages'
 * files are a different fact entirely: `services/a/pyproject.toml` moving with
 * `services/b/uv.lock` is not a manifest and its lockfile, it is one service's
 * dependency change forcing another's — a cross-boundary coupling the declared
 * structure does not explain, which is exactly what `drift` exists to surface.
 *
 * Compared with a trailing separator, never as a bare prefix: `packages/b` is
 * not an ancestor of `packages/board`, and a bare `startsWith` would say it is.
 */
function governs(lockDir: string, manifestDir: string): boolean {
  return lockDir === "" || lockDir === manifestDir || manifestDir.startsWith(`${lockDir}/`);
}

/**
 * Grade a pair against the noise floor.
 *
 * Order matters: mechanical is checked before test, so a lockfile inside a test
 * fixture directory is still reported as mechanical, not test-subject.
 *
 * "Mechanical" is a claim about a manifest and ITS lockfile, so the two are
 * matched by name AND by containment (see {@link governs}) — matching on
 * filename alone graded any manifest anywhere against any lockfile anywhere,
 * which suppressed a genuine cross-package finding as "already known".
 *
 * `"intra-module"` is not produced here — that grade depends on a `Spine`,
 * which this function does not take. `drift` (drift.ts) applies it as a
 * second filter, after this one, once it has resolved each path to a module.
 */
export function classifyPair(a: string, b: string): PairClass {
  const dirA = directoryOf(a);
  const dirB = directoryOf(b);
  for (const [manifest, lock] of LOCK_PAIRS) {
    if (manifest.test(a) && lock.test(b) && governs(dirB, dirA)) return "mechanical";
    if (manifest.test(b) && lock.test(a) && governs(dirA, dirB)) return "mechanical";
  }
  if (isTestPath(a) || isTestPath(b)) return "test-subject";
  return "candidate";
}
