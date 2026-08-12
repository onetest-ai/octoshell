import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const SCRIPT = join(
  __dirname,
  "..",
  "resources",
  "octobots-pack",
  "tokenomics",
  "backfill-worklog-sha.mjs",
);
const LOG = (repo: string) => join(repo, ".octobots", "tokenomics", "worklog.jsonl");

function repoWithWorklog(lines: string[], opts: { octograph?: boolean } = {}): string {
  const dir = mkdtempClean("octo-sha-backfill-");
  mkdirSync(join(dir, ".octobots", "tokenomics"), { recursive: true });
  writeFileSync(LOG(dir), lines.map((l) => `${l}\n`).join(""));
  if (opts.octograph) writeFileSync(join(dir, "octograph.yaml"), "minSupport: 2\n");
  return dir;
}

/**
 * A fake `gh` on PATH ahead of the real one. Writes `marker` the moment it is
 * invoked, so a test can tell "gh was never called" apart from "gh was
 * called and happened to answer with nothing" — the distinction the
 * octograph-detection skip path exists to prove.
 */
function fakeGh(
  behavior: "merged" | "empty" | "fail",
  marker: string,
  sha = "cafebabecafebabecafebabecafebabecafebabe",
): string {
  const binDir = mkdtempClean("octo-fakebin-");
  const body =
    behavior === "merged"
      ? [
          "#!/usr/bin/env node",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "called");`,
          `process.stdout.write(JSON.stringify([{ mergeCommit: { oid: ${JSON.stringify(sha)} } }]));`,
        ].join("\n")
      : behavior === "empty"
        ? [
            "#!/usr/bin/env node",
            `require("fs").writeFileSync(${JSON.stringify(marker)}, "called");`,
            `process.stdout.write("[]");`,
          ].join("\n")
        : [
            "#!/usr/bin/env node",
            `require("fs").writeFileSync(${JSON.stringify(marker)}, "called");`,
            `process.stderr.write("gh: not authenticated");`,
            `process.exit(1);`,
          ].join("\n");
  writeFileSync(join(binDir, "gh"), `${body}\n`, { mode: 0o755 });
  return binDir;
}

/** `spawnSync`, not `execFileSync` — informational lines go to stderr, and
 *  `execFileSync` discards stderr on a SUCCESSFUL (exit 0) run, which this
 *  script always is by design. `spawnSync` captures both regardless of exit
 *  code, matching `octobots-scripts.test.ts`'s own pattern for this pack. */
function run(repo: string, ghBinDir?: string): { out: string; stdout: string; code: number } {
  const env = ghBinDir ? { ...process.env, PATH: `${ghBinDir}:${process.env.PATH}` } : process.env;
  const result = spawnSync("node", [SCRIPT, "--project-dir", repo], { encoding: "utf8", env });
  return {
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
    code: result.status ?? 1,
  };
}

function entries(repo: string): Record<string, unknown>[] {
  return readFileSync(LOG(repo), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe("backfill-worklog-sha.mjs", () => {
  it("skips cleanly, with no gh call and a byte-unchanged log, when octograph is not detected", () => {
    const repo = repoWithWorklog(
      [line({ session_id: "s1", task: "T1.1", branch: "feat/x-t1", at: "2026-08-10T00:00:00.000Z" })],
      { octograph: false },
    );
    const before = readFileSync(LOG(repo), "utf8");
    const marker = join(repo, "gh-was-called");
    const bin = fakeGh("merged", marker);

    const { code, out } = run(repo, bin);

    expect(code).toBe(0);
    expect(out).toMatch(/octograph not detected/);
    expect(existsSync(marker)).toBe(false); // no gh call was spawned
    expect(readFileSync(LOG(repo), "utf8")).toBe(before); // byte-unchanged
  });

  it("backfills a branch's merge SHA, labelled by a fresh gh lookup, when octograph is available", () => {
    const repo = repoWithWorklog(
      [line({ session_id: "s1", task: "T1.1", branch: "feat/x-t1", at: "2026-08-10T00:00:00.000Z" })],
      { octograph: true },
    );
    const marker = join(repo, "gh-was-called");
    const sha = "1111111111111111111111111111111111111a";
    const bin = fakeGh("merged", marker, sha);

    const { code, out } = run(repo, bin);

    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true); // gh WAS spawned this time
    expect(entries(repo)[0]).toMatchObject({ task: "T1.1", branch: "feat/x-t1", merged_sha: sha });
    expect(out).toMatch(/filled 1 entry/);
  });

  it("is idempotent: an entry that already carries merged_sha is left byte-unchanged, and gh is never called for it", () => {
    const repo = repoWithWorklog(
      [
        line({
          session_id: "s1",
          task: "T1.1",
          branch: "feat/x-t1",
          merged_sha: "abc123",
          at: "2026-08-10T00:00:00.000Z",
        }),
      ],
      { octograph: true },
    );
    const before = readFileSync(LOG(repo), "utf8");
    const marker = join(repo, "gh-was-called");
    // A fake gh that WOULD answer with a different SHA if it were ever
    // invoked — proving the already-filled line is skipped, not merely
    // "happens to resolve to the same value".
    const bin = fakeGh("merged", marker, "decoydecoydecoydecoydecoydecoydecoydecoy");

    const { code, out } = run(repo, bin);

    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(LOG(repo), "utf8")).toBe(before);
    expect(out).toMatch(/filled 0 entries/);
  });

  it("leaves a branch with no merged PR alone rather than guessing", () => {
    const repo = repoWithWorklog(
      [line({ session_id: "s1", task: "T1.1", branch: "feat/x-t1", at: "2026-08-10T00:00:00.000Z" })],
      { octograph: true },
    );
    const bin = fakeGh("empty", join(repo, "gh-was-called"));

    const { code } = run(repo, bin);

    expect(code).toBe(0);
    expect(entries(repo)[0]?.merged_sha).toBeUndefined();
  });

  it("a gh failure exits 0 with a note instead of corrupting the log", () => {
    const repo = repoWithWorklog(
      [line({ session_id: "s1", task: "T1.1", branch: "feat/x-t1", at: "2026-08-10T00:00:00.000Z" })],
      { octograph: true },
    );
    const before = readFileSync(LOG(repo), "utf8");
    const bin = fakeGh("fail", join(repo, "gh-was-called"));

    const { code, out } = run(repo, bin);

    expect(code).toBe(0);
    expect(out).toMatch(/gh lookup failed/);
    expect(readFileSync(LOG(repo), "utf8")).toBe(before);
  });

  it("leaves a malformed line untouched and does not throw", () => {
    const repo = repoWithWorklog(
      [
        line({ session_id: "s1", task: "T1.1", branch: "feat/x-t1", at: "2026-08-10T00:00:00.000Z" }),
        `{"session_id":"s2","task":"T1.2","branch":"feat/x-t2","at":"2026-08-10T00:0`, // truncated tail
      ],
      { octograph: true },
    );
    const bin = fakeGh("empty", join(repo, "gh-was-called"));

    expect(() => run(repo, bin)).not.toThrow();
    const raw = readFileSync(LOG(repo), "utf8");
    expect(raw).toContain('{"session_id":"s2","task":"T1.2","branch":"feat/x-t2","at":"2026-08-10T00:0');
  });

  it("detects octograph via an existing .octobots/graph artifact, not just octograph.yaml", () => {
    const repo = repoWithWorklog(
      [line({ session_id: "s1", task: "T1.1", branch: "feat/x-t1", at: "2026-08-10T00:00:00.000Z" })],
      { octograph: false },
    );
    mkdirSync(join(repo, ".octobots", "graph"), { recursive: true });
    const marker = join(repo, "gh-was-called");
    const bin = fakeGh("merged", marker);

    run(repo, bin);

    expect(existsSync(marker)).toBe(true);
  });

  /**
   * The rewrite is a read-modify-WRITE over the one surviving record of work
   * whose transcripts are pruned outside the repo, so it goes through a tmp
   * file and an atomic `rename`, never a truncate-in-place. This pins both
   * halves: the untouched lines survive byte-for-byte alongside the filled
   * one, and no `.tmp` scratch file is left in `.octobots/tokenomics/` for
   * the gate to commit.
   */
  it("rewrites atomically — other lines survive verbatim and no tmp file is left behind", () => {
    const already = line({
      session_id: "s0",
      task: "T1.0",
      branch: "feat/x-t0",
      merged_sha: "abc123",
      at: "2026-08-09T00:00:00.000Z",
    });
    const noBranch = line({ session_id: "s2", mission: "M1", at: "2026-08-10T01:00:00.000Z" });
    const repo = repoWithWorklog(
      [
        already,
        line({ session_id: "s1", task: "T1.1", branch: "feat/x-t1", at: "2026-08-10T00:00:00.000Z" }),
        noBranch,
      ],
      { octograph: true },
    );
    const sha = "2222222222222222222222222222222222222222";
    const bin = fakeGh("merged", join(repo, "gh-was-called"), sha);

    const { code } = run(repo, bin);

    expect(code).toBe(0);
    const raw = readFileSync(LOG(repo), "utf8");
    expect(raw.split("\n")[0]).toBe(already); // untouched line, byte-for-byte
    expect(raw).toContain(noBranch); // no branch to resolve from — also untouched
    expect(raw.endsWith("\n")).toBe(true); // trailing newline preserved
    expect(entries(repo)[1]).toMatchObject({ task: "T1.1", merged_sha: sha });
    expect(existsSync(`${LOG(repo)}.backfill.tmp`)).toBe(false);
  });

  it("emits nothing on stdout — informational lines go to stderr, matching the pack's other scripts", () => {
    const repo = repoWithWorklog([], { octograph: false });
    expect(run(repo).stdout).toBe("");
  });
});
