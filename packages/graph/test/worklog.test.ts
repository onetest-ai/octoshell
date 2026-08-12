import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWorklog } from "../src/worklog.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function repoWithWorklog(body: string): string {
  const root = mkdtempClean("octograph-worklog-");
  const dir = join(root, ".octobots", "tokenomics");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worklog.jsonl"), body);
  return root;
}

describe("readWorklog", () => {
  it("returns [] for a repo with no .octobots directory", () => {
    const root = mkdtempClean("octograph-worklog-noboard-");
    expect(readWorklog(root)).toEqual([]);
  });

  it("returns [] when .octobots exists but no worklog was ever written", () => {
    const root = mkdtempClean("octograph-worklog-nofile-");
    mkdirSync(join(root, ".octobots"), { recursive: true });
    expect(readWorklog(root)).toEqual([]);
  });

  it("parses a well-formed line into camelCase fields, defaulting absent keys to null", () => {
    const root = repoWithWorklog(
      `${JSON.stringify({
        session_id: "s1",
        task: "T1.1",
        branch: "feat/x-t1",
        at: "2026-08-09T11:51:45.163Z",
      })}\n`,
    );
    expect(readWorklog(root)).toEqual([
      {
        sessionId: "s1",
        task: "T1.1",
        mission: null,
        branch: "feat/x-t1",
        mergedSha: null,
        at: "2026-08-09T11:51:45.163Z",
      },
    ]);
  });

  it("carries a recorded merged_sha through as mergedSha", () => {
    const root = repoWithWorklog(
      `${JSON.stringify({
        session_id: "s1",
        task: "T1.1",
        branch: "feat/x-t1",
        merged_sha: "abc123",
        at: "2026-08-09T11:51:45.163Z",
      })}\n`,
    );
    expect(readWorklog(root)[0]?.mergedSha).toBe("abc123");
  });

  it("skips a truncated final line (writer died mid-append) and returns the well-formed entries", () => {
    const good = JSON.stringify({ session_id: "s1", mission: "M1", at: "2026-08-09T11:00:00.000Z" });
    // A JSONL writer that dies mid-`appendFileSync` leaves a syntactically
    // broken tail — never a fatal read for the well-formed lines before it.
    const truncated = `{"session_id":"s2","task":"T1.2","at":"2026-08-09T12:0`;
    const root = repoWithWorklog(`${good}\n${truncated}`);
    expect(readWorklog(root)).toEqual([
      { sessionId: "s1", task: null, mission: "M1", branch: null, mergedSha: null, at: "2026-08-09T11:00:00.000Z" },
    ]);
  });

  it("skips a line that is valid JSON but not an object, without throwing", () => {
    const good = JSON.stringify({ session_id: "s1", at: "2026-08-09T11:00:00.000Z" });
    const root = repoWithWorklog(`${good}\n42\n["not", "an", "object"]\n`);
    expect(readWorklog(root)).toEqual([
      { sessionId: "s1", task: null, mission: null, branch: null, mergedSha: null, at: "2026-08-09T11:00:00.000Z" },
    ]);
  });

  it("skips a line missing the required session_id or at fields", () => {
    const good = JSON.stringify({ session_id: "s1", at: "2026-08-09T11:00:00.000Z" });
    const missingSession = JSON.stringify({ task: "T1.1", at: "2026-08-09T11:00:00.000Z" });
    const missingAt = JSON.stringify({ session_id: "s2", task: "T1.2" });
    const root = repoWithWorklog(`${good}\n${missingSession}\n${missingAt}\n`);
    expect(readWorklog(root)).toEqual([
      { sessionId: "s1", task: null, mission: null, branch: null, mergedSha: null, at: "2026-08-09T11:00:00.000Z" },
    ]);
  });

  /**
   * The regression this pins: a truncated tail (an EXPECTED mid-write death)
   * and a well-formed-JSON-but-missing-a-field line (a real record this
   * reader still cannot use) both used to vanish the identical, silent way.
   * They must not any more — only the second is a record that survived
   * parsing and is still being dropped, and only it warns.
   */
  it("warns about a valid-JSON line missing a required field, but stays silent about a truncated tail", () => {
    const good = JSON.stringify({ session_id: "s1", at: "2026-08-09T11:00:00.000Z" });
    const missingAt = JSON.stringify({ session_id: "s2", task: "T1.2" });
    // A JSONL writer that died mid-`appendFileSync` — syntactically broken,
    // never a record that made it to disk.
    const truncated = `{"session_id":"s3","task":"T1.3","at":"2026-08-09T13:0`;
    const root = repoWithWorklog(`${good}\n${missingAt}\n${truncated}`);

    const warnings: string[] = [];
    const entries = readWorklog(root, (m) => warnings.push(m));

    expect(entries).toEqual([
      { sessionId: "s1", task: null, mission: null, branch: null, mergedSha: null, at: "2026-08-09T11:00:00.000Z" },
    ]);
    // Exactly one warning — for the missing-field record, never for the
    // truncated tail.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("at");
    expect(warnings[0]).toContain(missingAt);
  });

  it("ignores blank lines between entries", () => {
    const good = JSON.stringify({ session_id: "s1", at: "2026-08-09T11:00:00.000Z" });
    const root = repoWithWorklog(`\n${good}\n\n`);
    expect(readWorklog(root)).toHaveLength(1);
  });
});
