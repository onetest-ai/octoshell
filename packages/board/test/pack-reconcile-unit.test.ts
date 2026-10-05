// Runs the pack's octobots-doctor/scripts/pack-reconcile.mjs from the pack source (with --root), in a
// child `node`, so `pnpm coverage:pack` (c8 over child processes) counts it. The behaviour an agent
// relies on is pinned by the extension's test/pack-reconcile-script.test.ts against an installed
// copy; this file walks every branch of the source file itself.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/octobots-doctor/scripts/pack-reconcile.mjs");
const UPSTREAM = "---\nname: s\nversion: 57\n---\n\nUp.\n";
const SHA = createHash("sha256").update(UPSTREAM).digest("hex");

const mk = (p: string, c: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
const pendingFile = (ws: string) => join(ws, ".octobots", "pack-updates", "pending.json");

function entry(skill: string, retired: boolean, base: boolean) {
  return {
    skill, action: "reconcile", localVersion: "57-local", localSha256: "a".repeat(64),
    base: base ? { version: 56, sha256: "b".repeat(64), source: "declared" } : null,
    upstreamSha256: retired ? null : SHA, retired, dir: `.octobots/pack-updates/v57/${skill}`,
  };
}

function ws(): string {
  const root = mkdtempSync(join(tmpdir(), "pack-reconcile-unit-"));
  mk(join(root, ".octobots", "pack-updates", "v57", "alpha", "upstream.md"), UPSTREAM);
  mk(join(root, ".claude", "skills", "alpha", "SKILL.md"), "---\nname: alpha\nversion: 57-local\n---\n");
  mk(join(root, ".claude", "skills", "gone", "SKILL.md"), "---\nname: gone\nversion: 56\n---\n");
  mk(pendingFile(root), JSON.stringify({ packVersion: 57, skills: [entry("alpha", false, true), entry("gone", true, false), entry("beta", false, false)], kept: [] }));
  return root;
}

function run(args: string[]) {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const done = (root: string, skill: string) => run(["done", skill, "--root", root]);
const decisions = (root: string, skill: string, text: string) => mk(join(root, ".octobots", "pack-updates", "v57", skill, "DECISIONS.md"), text);
const left = (root: string) => (JSON.parse(readFileSync(pendingFile(root), "utf8")) as { skills: Array<{ skill: string }> }).skills.map((s) => s.skill);

describe("pack-reconcile.mjs (pack source)", () => {
  it("list: every entry, its base, its folder and the marker to write; a missing upstream.md is said", () => {
    const root = ws();
    const r = run(["list", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/alpha: local 57-local, base v56 \(declared\), upstream v57/);
    expect(r.out).toContain(`marker: version: 57+local; reconciled-from: ${SHA}`);
    expect(r.out).toMatch(/gone: local 57-local, no base \(two-way\), retired: upstream deleted it/);
    expect(r.out).toMatch(/beta:[\s\S]*upstream\.md is missing/);
    rmSync(root, { recursive: true, force: true });
  });

  it("list with no pending.json, and with an empty one", () => {
    const root = ws();
    rmSync(pendingFile(root));
    expect(run(["list", "--root", root]).out).toMatch(/no pending reconcile/);
    rmSync(root, { recursive: true, force: true });
  });

  it("done walks every refusal, then clears the entry", () => {
    const root = ws();
    expect(done(root, "alpha").err).toMatch(/DECISIONS\.md does not exist/);
    decisions(root, "alpha", "## Conflicts\n\n- ESCALATED: r: local a; upstream b; question c\n");
    expect(done(root, "alpha")).toMatchObject({ code: 3 });
    decisions(root, "alpha", "## Conflicts\n\n- RESOLVED (user, 2026-10-05): r: a\n");
    expect(done(root, "alpha").err).toMatch(/version: 57-local; it must read version: 57\+local/);
    writeFileSync(join(root, ".claude", "skills", "alpha", "SKILL.md"), "---\nname: alpha\nversion: 57+local\n---\n");
    expect(done(root, "alpha").err).toMatch(/reconciled-from: \(none\)/);
    rmSync(join(root, ".claude", "skills", "alpha", "SKILL.md"));
    expect(done(root, "alpha").err).toMatch(/SKILL\.md does not exist/);
    writeFileSync(join(root, ".claude", "skills", "alpha", "SKILL.md"), `---\nname: alpha\nversion: 57+local\nreconciled-from: ${SHA}\n---\n`);
    const ok = done(root, "alpha");
    expect(ok.code, ok.err).toBe(0);
    expect(left(root)).toEqual(["gone", "beta"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("done refuses a pack skill whose upstream.md is missing", () => {
    const root = ws();
    decisions(root, "beta", "## Conflicts\n");
    mk(join(root, ".claude", "skills", "beta", "SKILL.md"), "---\nname: beta\nversion: 57+local\n---\n");
    expect(done(root, "beta").err).toMatch(/upstream\.md is missing/);
    rmSync(root, { recursive: true, force: true });
  });

  it("done on a retired skill needs its directory gone", () => {
    const root = ws();
    decisions(root, "gone", "## Conflicts\n\n- RESOLVED (user, 2026-10-05): retired: delete it\n");
    expect(done(root, "gone").err).toMatch(/\.claude\/skills\/gone still exists/);
    rmSync(join(root, ".claude", "skills", "gone"), { recursive: true });
    expect(done(root, "gone").code).toBe(0);
    expect(left(root)).toEqual(["alpha", "beta"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("done on a skill with no entry changes nothing; a malformed record is refused", () => {
    const root = ws();
    const before = readFileSync(pendingFile(root));
    expect(done(root, "nope").out.trim()).toBe("no pending reconcile for nope");
    expect(readFileSync(pendingFile(root)).equals(before)).toBe(true);
    writeFileSync(pendingFile(root), "[]");
    expect(done(root, "alpha")).toMatchObject({ code: 3 });
    expect(run(["list", "--root", root]).err).toMatch(/malformed/);
    rmSync(root, { recursive: true, force: true });
  });

  it("usage errors exit 2, and the pack source copy needs --root (it is not installed in a workspace)", () => {
    expect(run([]).code).toBe(2);
    expect(run(["bogus"]).code).toBe(2);
    expect(run(["done"]).code).toBe(2);
    expect(run(["list", "extra"]).code).toBe(2);
    expect(run(["list", "--root"]).code).toBe(2);
    const r = run(["list"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not installed under <workspace>\/\.claude\/skills/);
  });
});
