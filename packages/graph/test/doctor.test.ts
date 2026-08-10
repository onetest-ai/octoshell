import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { doctor, exitCode } from "../src/doctor.js";
import { buildRepo } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

describe("doctor", () => {
  it("reports blocked and exits non-zero outside a git repo", () => {
    const report = doctor(mkdtempClean("octograph-nogit-"), DEFAULTS);
    expect(report.status).toBe("blocked");
    expect(exitCode(report)).not.toBe(0);
  });

  it("reports degraded when history is below minCommits", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["c.ts", "d.ts"] }]);
    const report = doctor(repo, { ...DEFAULTS, minCommits: 200 });
    expect(report.status).toBe("degraded");
    expect(exitCode(report)).not.toBe(0);
  });

  it("names the cause and a fix for every non-ok check", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const report = doctor(repo, { ...DEFAULTS, minCommits: 200 });
    const history = report.checks.find((c) => c.name === "history depth");
    expect(history?.state).toBe("warn");
    expect(history?.detail).toContain("commits");
  });

  it("reports ok and exits 0 when history clears the bar", () => {
    const repo = buildRepo(
      Array.from({ length: 12 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })),
    );
    const report = doctor(repo, { ...DEFAULTS, minCommits: 10 });
    expect(report.status).toBe("ok");
    expect(exitCode(report)).toBe(0);
  });

  it("treats a missing graphify as a warning, never as degraded", () => {
    const repo = buildRepo(
      Array.from({ length: 12 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })),
    );
    const report = doctor(repo, { ...DEFAULTS, minCommits: 10 });
    expect(report.checks.find((c) => c.name === "graphify")?.state).toBe("missing");
    expect(report.status).toBe("ok");
  });
});
