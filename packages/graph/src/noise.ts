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
 *    substring match) equals `test`, `tests`, `__tests__`, `spec`, or `specs`.
 *    Segment-bounding is what keeps `src/latest.ts`, `src/contest/handler.ts`,
 *    `src/attestation.ts` and `src/testing-utils/x.ts` (directory "testing",
 *    not "test") out of this rule — a plain substring match would tag all four.
 *  - the filename ends in `.test.` or `.spec.` followed by `ts`, `tsx`, `js`,
 *    or `jsx`.
 *  - the filename follows Python's `test_*.py` / `*_test.py` convention.
 *  - the filename ends in `_test.go`.
 */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? "";

  const testSegment = /^(test|tests|__tests__|spec|specs)$/;
  if (segments.some((s) => testSegment.test(s))) return true;

  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filename)) return true;
  if (/^test_.+\.py$/.test(filename) || /_test\.py$/.test(filename)) return true;
  if (/_test\.go$/.test(filename)) return true;

  return false;
}
