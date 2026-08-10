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

  it("classifies a test and any other file as test-subject", () => {
    expect(classifyPair("src/a.ts", "src/a.test.ts")).toBe("test-subject");
  });

  it("classifies everything else as a candidate", () => {
    expect(classifyPair("a/one.ts", "b/two.ts")).toBe("candidate");
  });
});
