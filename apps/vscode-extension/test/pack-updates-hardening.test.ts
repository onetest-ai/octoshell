// M7 completion-gate review: the user-editable files under .octobots/pack-updates/ (pending.json,
// staging folders and files) and a live SKILL.md are read by the installer, the primer, doctor.js,
// validate.js and pack-reconcile.mjs. Each case is a PoC the gate reproduced before the fix:
//  - a symlink planted in a staging folder made installPack write the workspace's own SKILL.md
//    text (attacker-controlled in a cloned repo) to any path, e.g. a shell rc file;
//  - a FIFO (or a symlink to a device) at pending.json hung doctor.js and pack-reconcile.mjs, and
//    the extension host's activation check read it the same way.
// Plus the cross-reader agreement: a symlinked pending.json is "no record" for all three readers.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, rmSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { forks, PACK_SRC, store } from "./fixtures/pack-store.js";
import { installPack, packStatus, OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { readPending, readRegularBytes, writePending } from "../src/host/pack-updates.js";
import { renderBrief } from "../src/host/pack-staging.js";

const PACK = OCTOBOTS_PACK_VERSION;
const posix = process.platform !== "win32"; // FIFOs and unprivileged symlinks
const mk = (p: string, content: string | Buffer) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
const skillMd = (ws: string, skill: string) => join(ws, ".claude", "skills", skill, "SKILL.md");
const stagingDir = (ws: string, skill: string) => join(ws, ".octobots", "pack-updates", `v${PACK}`, skill);
const pendingPath = (ws: string) => join(ws, ".octobots", "pack-updates", "pending.json");
const mkfifo = (p: string) => { mkdirSync(dirname(p), { recursive: true }); execFileSync("mkfifo", [p]); };

/** A workspace at the pack with solo's 57-local mission-execution fork. */
function forked(): { ws: string; local: Buffer } {
  const ws = mkdtempClean("pack-harden-");
  installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
  const local = forks()["mission-execution"];
  writeFileSync(skillMd(ws, "mission-execution"), local);
  return { ws, local };
}

describe.runIf(posix)("installPack never writes or deletes through a symlink under .octobots/pack-updates", () => {
  it("a symlinked staging FILE is replaced, and its target keeps its bytes", () => {
    const { ws, local } = forked();
    const outside = join(mkdtempClean("pack-harden-out-"), "zshrc");
    writeFileSync(outside, "original rc\n");
    mkdirSync(stagingDir(ws, "mission-execution"), { recursive: true });
    symlinkSync(outside, join(stagingDir(ws, "mission-execution"), "local.md"));

    const res = installPack(PACK_SRC, ws, { store });

    expect(res.pending).toEqual(["mission-execution"]);
    expect(readFileSync(outside, "utf8")).toBe("original rc\n");
    const staged = join(stagingDir(ws, "mission-execution"), "local.md");
    expect(lstatSync(staged).isFile()).toBe(true);
    expect(readFileSync(staged).equals(local)).toBe(true);
  });

  it("a symlinked staging FOLDER makes the install refuse before its first write", () => {
    const { ws, local } = forked();
    const outside = mkdtempClean("pack-harden-out-");
    mkdirSync(join(ws, ".octobots", "pack-updates", `v${PACK}`), { recursive: true });
    symlinkSync(outside, stagingDir(ws, "mission-execution"));
    writeFileSync(join(ws, ".claude", "skills", "mission-planner", "scripts", "doctor.js"), "// stale\n");

    for (const choice of [undefined, "reconcile", "overwrite", "keep"] as const) {
      expect(() => installPack(PACK_SRC, ws, { store, ...(choice ? { localChanges: choice } : {}) }), String(choice)).toThrow(/not a directory/);
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(skillMd(ws, "mission-execution")).equals(local)).toBe(true);
    // Refused before ANY write: the stale script was not refreshed either.
    expect(readFileSync(join(ws, ".claude", "skills", "mission-planner", "scripts", "doctor.js"), "utf8")).toBe("// stale\n");
  });

  it("a symlinked .octobots/pack-updates makes the install refuse", () => {
    const { ws } = forked();
    const outside = mkdtempClean("pack-harden-out-");
    mkdirSync(join(ws, ".octobots"), { recursive: true });
    symlinkSync(outside, join(ws, ".octobots", "pack-updates"));
    expect(() => installPack(PACK_SRC, ws, { store })).toThrow(/not a directory/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("Overwrite never writes its saved copy through a dangling overwritten-local.md symlink", () => {
    const { ws, local } = forked();
    const target = join(mkdtempClean("pack-harden-out-"), "created-by-installer");
    mkdirSync(stagingDir(ws, "mission-execution"), { recursive: true });
    symlinkSync(target, join(stagingDir(ws, "mission-execution"), "overwritten-local.md"));

    installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });

    expect(existsSync(target)).toBe(false);
    const saved = join(stagingDir(ws, "mission-execution"), "overwritten-local.2.md");
    expect(readFileSync(saved).equals(local)).toBe(true);
  });

  it("writePending never writes through a planted temp-file symlink", () => {
    const ws = mkdtempClean("pack-harden-");
    const target = join(mkdtempClean("pack-harden-out-"), "victim");
    writeFileSync(target, "victim\n");
    mkdirSync(dirname(pendingPath(ws)), { recursive: true });
    symlinkSync(target, `${pendingPath(ws)}.${process.pid}.tmp`);
    writePending(ws, { packVersion: PACK, skills: [], kept: [] });
    expect(readFileSync(target, "utf8")).toBe("victim\n");
    expect(readPending(ws)).toEqual({ packVersion: PACK, skills: [], kept: [] });
  });
});

describe.runIf(posix)("no reader blocks on a FIFO or reads through a symlinked pending.json", () => {
  it("the host refuses a FIFO, a device and an oversized file", () => {
    const dir = mkdtempClean("pack-harden-");
    mkfifo(join(dir, "fifo"));
    expect(() => readRegularBytes(join(dir, "fifo"))).toThrow(/not a regular file/);
    expect(() => readRegularBytes("/dev/zero")).toThrow(/not a regular file/);
    writeFileSync(join(dir, "big"), Buffer.alloc(32));
    expect(() => readRegularBytes(join(dir, "big"), { max: 16 })).toThrow(/larger than/);
  });

  it("packStatus and readPending return promptly with a FIFO pending.json and a FIFO SKILL.md", () => {
    const { ws } = forked();
    mkfifo(pendingPath(ws));
    rmSync(skillMd(ws, "mission-completion-gate"));
    mkfifo(skillMd(ws, "mission-completion-gate"));
    expect(readPending(ws)).toBeNull();
    const st = packStatus(ws, PACK, store);
    expect(st.pendingReconcile).toEqual([]);
    expect(st.installed).toBe(false); // an unreadable pack SKILL.md is a broken install, not a hang
    expect(st.deviations.map((d) => d.skill)).toEqual(["mission-execution"]); // the FIFO is skipped
  });

  it("a symlinked pending.json is no record to the host, pending-io.mjs and the primer alike", () => {
    const ws = mkdtempClean("pack-harden-");
    const real = join(mkdtempClean("pack-harden-out-"), "pending.json");
    writeFileSync(real, JSON.stringify({ packVersion: PACK, skills: [{
      skill: "mission-execution", action: "reconcile", localVersion: "57-local", localSha256: "a".repeat(64),
      base: null, upstreamSha256: "b".repeat(64), retired: false, dir: `.octobots/pack-updates/v${PACK}/mission-execution`,
    }], kept: [] }));
    mkdirSync(dirname(pendingPath(ws)), { recursive: true });
    symlinkSync(real, pendingPath(ws));

    expect(readPending(ws)).toBeNull();
    const io = join(PACK_SRC, "skill", "mission-planner", "scripts", "pending-io.mjs");
    const r = spawnSync("node", ["--input-type=module", "-e", `import(${JSON.stringify(io)}).then((m) => console.log(m.readPending(${JSON.stringify(ws)}).state))`], { encoding: "utf8", timeout: 10_000 });
    expect(r.stdout.trim()).toBe("malformed");
    const out = execFileSync("node", [join(PACK_SRC, "hooks", "primer.mjs"), "--backend", "claude"], {
      cwd: ws, env: { ...process.env, CLAUDE_PROJECT_DIR: ws, CLAUDE_CONFIG_DIR: "" },
      input: JSON.stringify({ hook_event_name: "SessionStart" }), encoding: "utf8", timeout: 10_000,
    });
    expect(out).not.toMatch(/Pending pack reconciles/);
  });

  /** A workspace with the pack's own scripts installed and a FIFO at pending.json. */
  function fifoWorkspace(): string {
    const ws = mkdtempClean("pack-harden-");
    for (const s of ["mission-planner", "octobots-doctor"]) cpSync(join(PACK_SRC, "skill", s), join(ws, ".claude", "skills", s), { recursive: true });
    mkdirSync(join(ws, ".octobots", "campaigns"), { recursive: true });
    mkfifo(pendingPath(ws));
    return ws;
  }

  it("doctor.js finishes and reports the malformed record", () => {
    const ws = fifoWorkspace();
    const r = spawnSync("node", [join(ws, ".claude", "skills", "mission-planner", "scripts", "doctor.js"), "--root", ws, "--json"], { encoding: "utf8", timeout: 10_000 });
    expect(r.signal).toBeNull(); // not killed by the timeout
    expect(r.stdout).toMatch(/pending\.json is malformed/);
  });

  it("doctor.js finishes when a pack SKILL.md is a FIFO, and names it", () => {
    const ws = fifoWorkspace();
    mkfifo(skillMd(ws, "mission-execution"));
    const r = spawnSync("node", [join(ws, ".claude", "skills", "mission-planner", "scripts", "doctor.js"), "--root", ws, "--json"], { encoding: "utf8", timeout: 10_000 });
    expect(r.signal).toBeNull();
    expect(r.stdout).toMatch(/skill unreadable: mission-execution/);
  });

  it("pack-reconcile.mjs list refuses (exit 3) instead of hanging", () => {
    const ws = fifoWorkspace();
    const r = spawnSync("node", [join(ws, ".claude", "skills", "octobots-doctor", "scripts", "pack-reconcile.mjs"), "list"], { encoding: "utf8", timeout: 10_000, cwd: mkdtempClean("pack-harden-cwd-") });
    expect(r.signal).toBeNull();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/malformed/);
  });

  it("validate.js finishes and warns once", () => {
    const ws = fifoWorkspace();
    const campaign = join(ws, ".octobots", "campaigns", "c");
    mk(join(campaign, "campaign.yaml"), "name: C\nstatus: todo\ndescription: d\n");
    const r = spawnSync("node", [join(ws, ".claude", "skills", "mission-planner", "scripts", "validate.js"), campaign], { encoding: "utf8", timeout: 10_000 });
    expect(r.signal).toBeNull();
    expect(`${r.stdout}${r.stderr}`.match(/pending\.json is malformed/g)).toHaveLength(1);
  });
});

describe("pack-reconcile.mjs done: the live SKILL.md must be the finished merge", () => {
  const UPSTREAM = "---\nname: mission-completion-gate\nversion: 57\n---\n\n# Gate\n\nUpstream text.\n";
  const UPSTREAM_SHA = createHash("sha256").update(UPSTREAM).digest("hex");
  const SKILL = "mission-completion-gate";

  function ws(): string {
    const w = mkdtempClean("pack-harden-done-");
    for (const s of ["octobots-doctor", "mission-planner"]) cpSync(join(PACK_SRC, "skill", s), join(w, ".claude", "skills", s), { recursive: true });
    const d = join(w, ".octobots", "pack-updates", "v57", SKILL);
    mk(join(d, "upstream.md"), UPSTREAM);
    mk(join(d, "DECISIONS.md"), "# Decisions\n\n## Kept local\n\n## Taken from upstream\n\n## Conflicts\n\n- RESOLVED (user, 2026-10-05): green rule: keep local\n");
    mk(pendingPath(w), JSON.stringify({ packVersion: 57, skills: [{
      skill: SKILL, action: "reconcile", localVersion: "57-local", localSha256: "a".repeat(64), base: null,
      upstreamSha256: UPSTREAM_SHA, retired: false, dir: `.octobots/pack-updates/v57/${SKILL}`,
    }], kept: [] }));
    return w;
  }
  const live = (w: string, body: string, from = UPSTREAM_SHA) =>
    mk(skillMd(w, SKILL), `---\nname: ${SKILL}\nversion: 57+local\nreconciled-from: ${from}\n---\n\n${body}`);
  const done = (w: string) => spawnSync("node", [join(w, ".claude", "skills", "octobots-doctor", "scripts", "pack-reconcile.mjs"), "done", SKILL], { encoding: "utf8", timeout: 10_000 });

  it("refuses (exit 3) while a `<!-- ESCALATED: ... -->` placeholder line is still in the live file", () => {
    const w = ws();
    live(w, "# Gate\n\n<!-- ESCALATED: what counts as green: awaiting the user's answer, see DECISIONS.md -->\n");
    const before = readFileSync(pendingPath(w));
    const r = done(w);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/placeholder/);
    expect(r.stderr).toContain("<!-- ESCALATED: what counts as green");
    expect(readFileSync(pendingPath(w)).equals(before)).toBe(true);
  });

  it("accepts a file that only MENTIONS the placeholder form inside other text", () => {
    const w = ws();
    live(w, "# Gate\n\nWrite exactly `<!-- ESCALATED: <rule>: awaiting the user's answer, see DECISIONS.md -->` there.\n");
    const r = done(w);
    expect(r.status).toBe(0);
  });

  it("accepts reconciled-from in upper case, as the installer's detection does", () => {
    const w = ws();
    live(w, "# Gate\n\nMerged.\n", UPSTREAM_SHA.toUpperCase());
    expect(done(w).status).toBe(0);
  });

  it.runIf(posix)("refuses (exit 3) instead of hanging when DECISIONS.md is a FIFO", () => {
    const w = ws();
    live(w, "# Gate\n\nMerged.\n");
    const dec = join(w, ".octobots", "pack-updates", "v57", SKILL, "DECISIONS.md");
    execFileSync("rm", [dec]);
    mkfifo(dec);
    const r = done(w);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/not a readable regular file/);
  });
});

describe("fail-closed and error paths (coverage the gate asked for)", () => {
  it.runIf(posix && process.getuid?.() !== 0)("writePending rethrows a failed write and leaves no temp file behind", () => {
    const ws = mkdtempClean("pack-harden-");
    const dir = dirname(pendingPath(ws));
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      expect(() => writePending(ws, { packVersion: PACK, skills: [], kept: [] })).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("the brief calls a `closest` base approximate and a missing base a two-way merge", () => {
    const common = { skill: "mission-execution", packVersion: PACK, retired: false, localVersion: "57-local", localSha256: "a".repeat(64), upstreamSha256: "b".repeat(64), carried: [] };
    const closest = renderBrief({ ...common, base: { version: 50, sha256: "c".repeat(64), source: "closest", body: "" } });
    expect(closest).toContain(`- Base: v50, sha256 ${"c".repeat(64)}, source closest (approximate: the stored body closest to the local file)`);
    expect(closest).toContain("Inputs in this folder: local.md, base.md, upstream.md.");
    const twoWay = renderBrief({ ...common, base: null });
    expect(twoWay).toContain("- Base: none; the merge is two-way (local against upstream)");
    expect(twoWay).toContain("Inputs in this folder: local.md, upstream.md.");
  });
});

describe("the primer's health checks are file and environment reads only (M7-AC6)", () => {
  it("imports nothing but node:fs and node:path: no git, no network, no child process", () => {
    const src = readFileSync(join(PACK_SRC, "hooks", "primer.mjs"), "utf8");
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(["node:fs", "node:path"]);
    expect(src).not.toMatch(/\bimport\s*\(/); // no dynamic import
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\b(fetch|process\.binding)\s*\(/);
  });
});
