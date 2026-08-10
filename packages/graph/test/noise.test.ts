import { describe, expect, it } from "vitest";
import { classifyPair, isTestPath } from "../src/noise.js";

describe("isTestPath", () => {
  it("matches a path segment equal to test/tests/__tests__", () => {
    expect(isTestPath("src/test/foo.ts")).toBe(true);
    expect(isTestPath("src/tests/foo.ts")).toBe(true);
    expect(isTestPath("src/__tests__/foo.ts")).toBe(true);
    // Segment at the very start or end of the path, not just in the middle.
    expect(isTestPath("test/foo.ts")).toBe(true);
    expect(isTestPath("foo/test")).toBe(true);
  });

  it("matches a .test./.spec. filename suffix across common extensions", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.test.tsx")).toBe(true);
    expect(isTestPath("src/foo.test.js")).toBe(true);
    expect(isTestPath("src/foo.test.jsx")).toBe(true);
    expect(isTestPath("src/foo.spec.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("src/foo.spec.js")).toBe(true);
    expect(isTestPath("src/foo.spec.jsx")).toBe(true);
  });

  it("matches Python's test_*.py and *_test.py convention", () => {
    expect(isTestPath("pkg/test_foo.py")).toBe(true);
    expect(isTestPath("pkg/foo_test.py")).toBe(true);
  });

  it("matches Go's _test.go suffix", () => {
    expect(isTestPath("pkg/foo_test.go")).toBe(true);
  });

  /**
   * The regression this test exists for: `conftest.py` was not graded at all.
   * pytest's fixture file is test infrastructure wherever it sits, and the
   * convention deliberately puts one OUTSIDE any `tests/` segment — at the
   * package root, often the repo root — so the segment rule above never
   * reaches it, and neither does `test_*.py` / `*_test.py` (no underscore).
   *
   * It is the single worst file to miss. A root `conftest.py` co-changes with
   * every test in the tree, so ungraded it sails through the noise floor as a
   * `candidate` and `drift` reports test scaffolding against ordinary source
   * as an architectural finding — the exact class of already-known coupling
   * the floor exists to bury — while `analyze` clusters it into a test-shaped
   * community, which is what A8's exclusion is for.
   */
  it("matches pytest's conftest.py, including outside any tests/ directory", () => {
    expect(isTestPath("conftest.py")).toBe(true);
    expect(isTestPath("backend/conftest.py")).toBe(true);
    expect(isTestPath("services/api/conftest.py")).toBe(true);
    // Already covered by the segment rule, but asserted so a future narrowing
    // of either rule cannot silently drop the other's coverage.
    expect(isTestPath("tests/conftest.py")).toBe(true);
  });

  it("matches conftest.py as a whole filename, not as a substring of one", () => {
    expect(isTestPath("src/myconftest.py")).toBe(false);
    expect(isTestPath("src/conftest_helpers.py")).toBe(false);
    expect(isTestPath("src/conftest.ts")).toBe(false);
  });

  /**
   * The noise floor's whole job on a Python repo: `conftest.py` paired with
   * ordinary source must grade `test-subject`, not `candidate`. This is the
   * behavioural half of the regression above — `isTestPath` returning false
   * is only a defect because `classifyPair` reads it.
   */
  it("grades conftest.py against ordinary source as test-subject, not candidate", () => {
    expect(classifyPair("backend/conftest.py", "backend/api/search.py")).toBe("test-subject");
  });

  it("real shape in this repo: packages/graph/test/analyze.test.ts is a test file", () => {
    expect(isTestPath("packages/graph/test/analyze.test.ts")).toBe(true);
  });

  it("does not match on a substring inside a longer segment or filename", () => {
    // "latest" contains "test" as a substring, not a segment.
    expect(isTestPath("src/latest.ts")).toBe(false);
    // "contest" contains "test" as a substring.
    expect(isTestPath("src/contest/handler.ts")).toBe(false);
    // "attestation" contains "test" as a substring.
    expect(isTestPath("src/attestation.ts")).toBe(false);
    // "testing-utils" is a directory named "testing", not "test".
    expect(isTestPath("src/testing-utils/x.ts")).toBe(false);
  });

  it("does not match ordinary source files", () => {
    expect(isTestPath("packages/graph/src/analyze.ts")).toBe(false);
    expect(isTestPath("src/index.ts")).toBe(false);
    expect(isTestPath("src/protest/vote.ts")).toBe(false);
  });

  /**
   * A bare `spec`/`specs` directory segment is NOT a test-path signal: it is
   * far more commonly "specifications" (an API spec, a design doc) than
   * RSpec's `spec/` convention, and this repo just proved it — its own
   * architecture spec directory, `docs/superpowers/specs/`, tripped the old
   * segment rule and rendered as a mis-split module in map.md. The
   * unambiguous `.spec.ts`/`.spec.tsx`/`.spec.js`/`.spec.jsx` FILENAME suffix
   * (Jasmine/Angular-style) is unaffected — it never collides with a
   * "specifications" folder, since it names the file, not its directory.
   */
  it("does not match a bare spec/specs directory segment — 'specifications', not RSpec", () => {
    expect(isTestPath("src/spec/foo.ts")).toBe(false);
    expect(isTestPath("src/specs/foo.ts")).toBe(false);
    // The regression this test exists for: this repo's own architecture spec.
    expect(isTestPath("docs/superpowers/specs/2026-08-09-octograph-design.md")).toBe(false);
    // The filename-suffix form is unambiguous and still matches.
    expect(isTestPath("src/foo.spec.ts")).toBe(true);
  });
});

describe("classifyPair", () => {
  it("classifies a manifest and its lockfile as mechanical", () => {
    expect(classifyPair("package.json", "pnpm-lock.yaml")).toBe("mechanical");
    expect(classifyPair("Cargo.toml", "Cargo.lock")).toBe("mechanical");
  });

  it("classifies a manifest/lockfile pair as mechanical even inside a fixtures directory", () => {
    expect(classifyPair("test/fixtures/repo/package.json", "test/fixtures/repo/pnpm-lock.yaml")).toBe(
      "mechanical",
    );
  });

  it("checks mechanical before test, so a lockfile under a test dir is still mechanical, not test-subject", () => {
    // Both members are under test/, which would otherwise satisfy isTestPath — mechanical
    // must be graded first so this doesn't fall through to test-subject.
    expect(classifyPair("test/fixtures/package.json", "test/fixtures/pnpm-lock.yaml")).toBe(
      "mechanical",
    );
  });

  /**
   * The regression this test exists for: "mechanical" was decided on FILENAMES
   * alone, so any manifest anywhere graded mechanical against any lockfile
   * anywhere. `services/a/pyproject.toml` moving with `services/b/uv.lock` is
   * not a manifest and its lockfile — it is one service's dependency change
   * forcing another service's, i.e. precisely the cross-boundary coupling the
   * declared structure does not explain. The floor exists to stop already-known
   * couplings from burying the real finding; graded this way it buried the real
   * finding itself, which is the same defect inverted and far harder to notice,
   * because a suppressed row leaves no trace in the output.
   *
   * The containment half must survive intact: a lockfile GOVERNS everything
   * beneath it, and one root lock over many package manifests is how pnpm, npm
   * and Cargo workspaces are actually laid out — including this repo.
   */
  it("pairs a manifest only with a lockfile that governs it", () => {
    // Governing: same directory, or any ancestor of it (the workspace shape).
    expect(classifyPair("packages/board/package.json", "pnpm-lock.yaml")).toBe("mechanical");
    expect(classifyPair("crates/parser/Cargo.toml", "Cargo.lock")).toBe("mechanical");
    expect(classifyPair("services/a/pyproject.toml", "services/a/uv.lock")).toBe("mechanical");
    // Siblings: neither directory contains the other, so this is a finding.
    expect(classifyPair("services/a/pyproject.toml", "services/b/uv.lock")).toBe("candidate");
    expect(classifyPair("apps/web/package.json", "apps/api/package-lock.json")).toBe("candidate");
    // Compared segment-wise, not as a bare string prefix: `packages/b` is not
    // an ancestor of `packages/board`.
    expect(classifyPair("packages/board/package.json", "packages/b/pnpm-lock.yaml")).toBe(
      "candidate",
    );
    // Order-independent — a pair is undirected, and `drift` may hand either
    // endpoint first depending on the canonical path ordering.
    expect(classifyPair("pnpm-lock.yaml", "packages/board/package.json")).toBe("mechanical");
    expect(classifyPair("services/b/uv.lock", "services/a/pyproject.toml")).toBe("candidate");
  });

  it("classifies a test and any other file as test-subject", () => {
    expect(classifyPair("src/a.ts", "src/a.test.ts")).toBe("test-subject");
  });

  it("classifies everything else as a candidate", () => {
    expect(classifyPair("a/one.ts", "b/two.ts")).toBe("candidate");
  });
});
