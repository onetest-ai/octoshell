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
 *  - the filename ends in `_test.go`.
 */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? "";

  const testSegment = /^(test|tests|__tests__)$/;
  if (segments.some((s) => testSegment.test(s))) return true;

  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filename)) return true;
  if (/^test_.+\.py$/.test(filename) || /_test\.py$/.test(filename)) return true;
  if (/_test\.go$/.test(filename)) return true;

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

/**
 * Grade a pair against the noise floor.
 *
 * Order matters: mechanical is checked before test, so a lockfile inside a test
 * fixture directory is still reported as mechanical, not test-subject.
 *
 * `"intra-module"` is not produced here — that grade depends on a `Spine`,
 * which this function does not take. `drift` (drift.ts) applies it as a
 * second filter, after this one, once it has resolved each path to a module.
 */
export function classifyPair(a: string, b: string): PairClass {
  for (const [left, right] of LOCK_PAIRS) {
    if ((left.test(a) && right.test(b)) || (left.test(b) && right.test(a))) {
      return "mechanical";
    }
  }
  if (isTestPath(a) || isTestPath(b)) return "test-subject";
  return "candidate";
}
