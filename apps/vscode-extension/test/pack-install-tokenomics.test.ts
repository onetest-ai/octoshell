// #191: installPack must never silently replace a tokenomics file the workspace changed. A file the
// pack shipped at any version is the pack's own and is replaced; any other body is kept, and staged
// for the octobots-doctor reconcile exactly as a changed SKILL.md is.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { PACK_SRC, store } from "./fixtures/pack-store.js";
import { installPack, packStatus, OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { detectDeviations, deviationPrompt, installCompletionMessage } from "../src/host/pack-deviations.js";
import { readPending } from "../src/host/pack-updates.js";
import { tokenomicsEntryName } from "../src/host/pack-skills.js";
import { fileReconciledFrom, skillSha256 } from "../src/host/skill-marker.js";
import { fileReconciledFrom as fileReconciledFromMjs } from "../resources/octobots-pack/skill/mission-planner/scripts/skill-marker.mjs";

const PACK = OCTOBOTS_PACK_VERSION;
const TOK_SRC = join(PACK_SRC, "tokenomics");
const packText = (file: string) => readFileSync(join(TOK_SRC, file), "utf8");
const live = (ws: string, file: string) => join(ws, ".octobots", "tokenomics", file);
const stagingDir = (ws: string, file: string) => join(ws, ".octobots", "pack-updates", `v${PACK}`, tokenomicsEntryName(file));
const mk = (p: string, content: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };

/** An older body the pack really shipped for `file` (not the current one). */
function olderShipped(file: string): string {
  const current = skillSha256(packText(file));
  for (const v of Object.keys(store.versions).map(Number).sort((a, b) => a - b)) {
    for (const h of store.versions[String(v)]?.[`tokenomics/${file}`] ?? []) if (h !== current) return store.bodies[h]!;
  }
  throw new Error(`no older shipped body of ${file}`);
}

/** A workspace with the current pack installed, its ledger data present. */
function installed(): string {
  const ws = mkdtempClean("pack-tok-");
  installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
  mk(live(ws, "runs.json"), "{\"runs\":[]}\n");
  mk(live(ws, "worklog.jsonl"), "{\"a\":1}\n");
  mk(live(ws, "raw/segments.jsonl"), "{\"segment_id\":\"s\"}\n");
  return ws;
}

describe("the shipped store holds the tokenomics CLI", () => {
  it("indexes every current pack tokenomics file under the pack version, except the workspace-owned price files", () => {
    for (const file of readdirSync(TOK_SRC)) {
      const listed = store.versions[String(PACK)]?.[`tokenomics/${file}`];
      if (file === "prices.json" || file === "prices.local.json") expect(listed, file).toBeUndefined();
      else expect(listed, file).toContain(skillSha256(packText(file)));
    }
  });
});

describe("fileReconciledFrom (host and pack twins)", () => {
  const H = "c".repeat(64);
  it.each([
    ["a // comment", `#!/usr/bin/env node\n// octobots-reconciled-from: ${H}\ncode\n`, H],
    ["a Markdown comment, upper case", `<!-- octobots-reconciled-from: ${H.toUpperCase()} -->\n`, H],
    ["a hash comment, CRLF", `# octobots-reconciled-from: ${H}\r\n`, H],
    ["absent", "code\n", null],
    ["too short", `// octobots-reconciled-from: ${"c".repeat(63)}\n`, null],
    ["too long", `// octobots-reconciled-from: ${"c".repeat(65)}\n`, null],
  ])("%s", (_n, text, want) => {
    expect(fileReconciledFrom(text)).toBe(want);
    expect(fileReconciledFromMjs(text)).toBe(want);
  });
});

describe("installPack: tokenomics files (#191)", () => {
  it("replaces a file the pack shipped at an older version, silently (no deviation, nothing staged)", () => {
    const ws = installed();
    writeFileSync(live(ws, "rollup.mjs"), olderShipped("rollup.mjs"));
    expect(detectDeviations(ws, PACK, store).deviations).toEqual([]);
    installPack(PACK_SRC, ws, { store });
    expect(readFileSync(live(ws, "rollup.mjs"), "utf8")).toBe(packText("rollup.mjs"));
    expect(existsSync(stagingDir(ws, "rollup.mjs"))).toBe(false);
  });

  it("keeps a locally changed file byte-identical, stages it, installs the rest and never touches the ledger", () => {
    const ws = installed();
    const local = packText("collect.mjs") + "\n// a project's own fix\n";
    writeFileSync(live(ws, "collect.mjs"), local);
    writeFileSync(live(ws, "rollup.mjs"), olderShipped("rollup.mjs"));
    const ledger = ["runs.json", "worklog.jsonl", "raw/segments.jsonl"].map((f) => [f, readFileSync(live(ws, f))] as const);

    const res = installPack(PACK_SRC, ws, { store });

    expect(readFileSync(live(ws, "collect.mjs"), "utf8")).toBe(local);
    expect(readFileSync(live(ws, "rollup.mjs"), "utf8")).toBe(packText("rollup.mjs"));
    for (const [f, bytes] of ledger) expect(readFileSync(live(ws, f)).equals(bytes), f).toBe(true);
    const name = tokenomicsEntryName("collect.mjs");
    expect(name).toBe("tokenomics-collect-mjs");
    expect(res.pending).toContain(name);

    const dir = stagingDir(ws, "collect.mjs");
    expect(readFileSync(join(dir, "local.md"), "utf8")).toBe(local);
    expect(readFileSync(join(dir, "upstream.md"), "utf8")).toBe(packText("collect.mjs"));
    const brief = readFileSync(join(dir, "RECONCILE.md"), "utf8");
    expect(brief).toContain("# Reconcile .octobots/tokenomics/collect.mjs");
    expect(brief).toContain("octobots-doctor");

    const e = readPending(ws)!.skills.find((s) => s.skill === name)!;
    expect(e).toMatchObject({
      localSha256: skillSha256(local),
      upstreamSha256: skillSha256(packText("collect.mjs")),
      retired: false,
      dir: `.octobots/pack-updates/v${PACK}/${name}`,
    });
    // Without git history the closest shipped body is the base, and it is the current one here.
    expect(e.base?.source).toBe("closest");
    expect(readFileSync(join(dir, "base.md"), "utf8")).toBe(packText("collect.mjs"));
  });

  it("recovers the base from the workspace's own git history (the shipped body the fork started from)", () => {
    const ws = installed();
    const base = olderShipped("collect.mjs");
    writeFileSync(live(ws, "collect.mjs"), base);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: ws, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q");
    git("add", ".octobots/tokenomics/collect.mjs");
    git("commit", "-qm", "install");
    writeFileSync(live(ws, "collect.mjs"), base + "\n// reflog fallback\n");
    git("commit", "-qam", "fork");

    installPack(PACK_SRC, ws, { store });

    const e = readPending(ws)!.skills.find((s) => s.skill === "tokenomics-collect-mjs")!;
    expect(e.base?.source).toBe("workspace-git");
    expect(e.base?.sha256).toBe(skillSha256(base));
    expect(readFileSync(join(stagingDir(ws, "collect.mjs"), "base.md"), "utf8")).toBe(base);
  });

  it("overwrite replaces the file and saves the local text first", () => {
    const ws = installed();
    const local = packText("verify.mjs") + "\n// local\n";
    writeFileSync(live(ws, "verify.mjs"), local);
    installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
    expect(readFileSync(live(ws, "verify.mjs"), "utf8")).toBe(packText("verify.mjs"));
    expect(readFileSync(join(stagingDir(ws, "verify.mjs"), "overwritten-local.md"), "utf8")).toBe(local);
    expect(readPending(ws)?.skills ?? []).toEqual([]);
  });

  it("keep leaves the file, stages nothing, and is remembered by the next default install", () => {
    const ws = installed();
    const local = packText("verify.mjs") + "\n// local\n";
    writeFileSync(live(ws, "verify.mjs"), local);
    installPack(PACK_SRC, ws, { store, localChanges: "keep" });
    expect(readFileSync(live(ws, "verify.mjs"), "utf8")).toBe(local);
    expect(readPending(ws)!.kept.map((k) => k.skill)).toEqual(["tokenomics-verify-mjs"]);
    const res = installPack(PACK_SRC, ws, { store });
    expect(res.pending).toEqual([]);
    expect(readFileSync(live(ws, "verify.mjs"), "utf8")).toBe(local);
  });

  it("a file reconciled against the current pack body is neither replaced nor staged", () => {
    const ws = installed();
    const merged = `#!/usr/bin/env node\n// octobots-reconciled-from: ${skillSha256(packText("run.mjs"))}\n// octobots-pack-version: 1\n// merged\n`;
    writeFileSync(live(ws, "run.mjs"), merged);
    const report = detectDeviations(ws, PACK, store);
    expect(report.deviations).toEqual([]);
    expect(report.reconciled).toEqual(["tokenomics-run-mjs"]);
    const res = installPack(PACK_SRC, ws, { store });
    expect(res.pending).toEqual([]);
    expect(readFileSync(live(ws, "run.mjs"), "utf8")).toBe(merged);
    // Its own (old) version marker is a local matter, not a stale CLI.
    expect(packStatus(ws, PACK, store)).toMatchObject({ installed: true, upToDate: true });
  });

  it("a file reconciled against an older pack body is staged again, with that body as its base", () => {
    const ws = installed();
    const older = olderShipped("collect.mjs");
    writeFileSync(live(ws, "collect.mjs"), `// octobots-reconciled-from: ${skillSha256(older)}\n${older}// local\n`);
    const [d] = detectDeviations(ws, PACK, store).deviations;
    expect(d).toMatchObject({ skill: "tokenomics-collect-mjs", file: "tokenomics/collect.mjs", reason: "reconciled-older" });
    installPack(PACK_SRC, ws, { store });
    const e = readPending(ws)!.skills.find((s) => s.skill === "tokenomics-collect-mjs")!;
    expect(e.base).toMatchObject({ source: "reconciled-from", sha256: skillSha256(older) });
  });

  it("never judges prices.json or a file the pack does not ship", () => {
    const ws = installed();
    writeFileSync(live(ws, "prices.json"), "{\"local\":true}\n");
    mk(live(ws, "collect-local.mjs"), "// the project's own stage\n");
    expect(detectDeviations(ws, PACK, store).deviations).toEqual([]);
    installPack(PACK_SRC, ws, { store });
    expect(readFileSync(live(ws, "prices.json"), "utf8")).toBe("{\"local\":true}\n");
    expect(readFileSync(live(ws, "collect-local.mjs"), "utf8")).toBe("// the project's own stage\n");
  });

  it("packStatus: a pending changed run.mjs is answered locally, not a stale CLI", () => {
    const ws = installed();
    writeFileSync(live(ws, "run.mjs"), packText("run.mjs").replace(/octobots-pack-version:\s*\d+/, "octobots-pack-version: 1") + "// local stage\n");
    installPack(PACK_SRC, ws, { store });
    const st = packStatus(ws, PACK, store);
    expect(st).toMatchObject({ installed: true, upToDate: false, upToDateExceptLocal: true });
    expect(st.deviations.map((d) => d.skill)).toEqual(["tokenomics-run-mjs"]);
  });

  it("the install prompt names the file", () => {
    const ws = installed();
    writeFileSync(live(ws, "collect.mjs"), "// fork\n");
    const p = deviationPrompt(detectDeviations(ws, PACK, store).deviations, PACK);
    expect(p.message).toBe("Octobots: 1 pack skill(s) or file(s) in this workspace were changed locally.");
    expect(p.detail).toContain("• .octobots/tokenomics/collect.mjs: differs from every file the pack shipped");
    expect(p.detail).toContain("would replace or delete these skills and files:");
  });
});

describe("pack-reconcile.mjs done for a tokenomics entry", () => {
  const script = (ws: string) => join(ws, ".claude", "skills", "octobots-doctor", "scripts", "pack-reconcile.mjs");
  const run = (ws: string, ...args: string[]) => spawnSync("node", [script(ws), ...args], { encoding: "utf8" });

  function staged(): string {
    const ws = installed();
    writeFileSync(live(ws, "collect.mjs"), packText("collect.mjs") + "\n// fork\n");
    installPack(PACK_SRC, ws, { store });
    return ws;
  }
  const decisions = (ws: string, text: string) => writeFileSync(join(stagingDir(ws, "collect.mjs"), "DECISIONS.md"), text);
  const CLOSED = "# collect.mjs: reconcile\n\n## Kept local\n\n- RESOLVED: fork: kept\n\n## Taken from upstream\n\n## Conflicts\n";

  it("list names the file and the marker line to add", () => {
    const ws = staged();
    const r = run(ws, "list");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("file: .octobots/tokenomics/collect.mjs");
    expect(r.stdout).toContain(`octobots-reconciled-from: ${skillSha256(packText("collect.mjs"))}`);
  });

  it("refuses without the marker, refuses an ESCALATED placeholder, then clears the entry", () => {
    const ws = staged();
    decisions(ws, CLOSED);
    let r = run(ws, "done", "tokenomics-collect-mjs");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("octobots-reconciled-from");

    const marker = `// octobots-reconciled-from: ${skillSha256(packText("collect.mjs"))}\n`;
    writeFileSync(live(ws, "collect.mjs"), marker + "// ESCALATED: fork: awaiting the user's answer, see DECISIONS.md\n");
    r = run(ws, "done", "tokenomics-collect-mjs");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("ESCALATED");

    writeFileSync(live(ws, "collect.mjs"), marker + packText("collect.mjs") + "// local\n");
    r = run(ws, "done", "tokenomics-collect-mjs");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readPending(ws)!.skills).toEqual([]);
    // And the next install leaves the reconciled file alone.
    const res = installPack(PACK_SRC, ws, { store });
    expect(res.pending).toEqual([]);
    expect(readFileSync(live(ws, "collect.mjs"), "utf8")).toBe(marker + packText("collect.mjs") + "// local\n");
  });
});

describe("installTokenomics: .octobots/tokenomics/.gitignore", () => {
  const ignore = (ws: string) => join(ws, ".octobots", "tokenomics", ".gitignore");
  it("ignores the hook's diagnostics.jsonl and keeps the ledger tracked", () => {
    const ws = installed();
    expect(readFileSync(ignore(ws), "utf8")).toBe("diagnostics.jsonl\n");
    execFileSync("git", ["init", "-q"], { cwd: ws });
    mk(live(ws, "diagnostics.jsonl"), "{}\n");
    const ignored = (rel: string) => spawnSync("git", ["check-ignore", "-q", rel], { cwd: ws }).status === 0;
    expect(ignored(".octobots/tokenomics/diagnostics.jsonl")).toBe(true);
    for (const f of ["runs.json", "worklog.jsonl", "raw/segments.jsonl"]) expect(ignored(`.octobots/tokenomics/${f}`), f).toBe(false);
  });
  it("adds the line to the workspace's own file once, keeping its lines", () => {
    const ws = mkdtempClean("pack-tok-ign-");
    mk(ignore(ws), "report.html");
    installPack(PACK_SRC, ws, { store });
    installPack(PACK_SRC, ws, { store });
    expect(readFileSync(ignore(ws), "utf8")).toBe("report.html\ndiagnostics.jsonl\n");
  });
});

describe("installTokenomics: a .gitignore that is not a plain file", () => {
  it("a FIFO is left alone and the install finishes (never blocks)", () => {
    const ws = mkdtempClean("pack-tok-fifo-");
    mkdirSync(join(ws, ".octobots", "tokenomics"), { recursive: true });
    execFileSync("mkfifo", [join(ws, ".octobots", "tokenomics", ".gitignore")]);
    // A blocking read would hang here; vitest's timeout turns that into a failure.
    const res = installPack(PACK_SRC, ws, { store });
    expect(res.written).toBeGreaterThan(0);
    expect(readFileSync(live(ws, "run.mjs"), "utf8")).toBe(packText("run.mjs"));
  }, 10_000);

  it("a directory is left alone and the rest of the pack still installs", () => {
    const ws = mkdtempClean("pack-tok-dir-");
    mkdirSync(join(ws, ".octobots", "tokenomics", ".gitignore"), { recursive: true });
    const res = installPack(PACK_SRC, ws, { store, hooks: true });
    expect(res.hooksRegistered).toBe(true);
    expect(readFileSync(live(ws, "run.mjs"), "utf8")).toBe(packText("run.mjs"));
  });
});

// A workspace's prices.json is its own (update-prices.mjs refreshes it), so the install keeps it. It
// must not do so silently: the result says it was kept and, when the pack's table is newer than the
// workspace's, that it should be refreshed. Found on coach-android's v60 install.
describe("installPack: a workspace prices.json is kept, and the install says so", () => {
  const withPrices = (fetchedAt: string | null) => {
    const ws = installed();
    const table = { _source: "test", ...(fetchedAt ? { fetched_at: fetchedAt } : {}), models: { "my-model": { input_cost_per_token: 1e-6 } } };
    mk(live(ws, "prices.json"), JSON.stringify(table, null, 2) + "\n");
    return ws;
  };
  const packFetchedAt = JSON.parse(packText("prices.json")).fetched_at as string;

  it("reports kept and stale when the workspace table is older than the pack's; the file is untouched", () => {
    const ws = withPrices("2026-01-01");
    const before = readFileSync(live(ws, "prices.json"));
    const res = installPack(PACK_SRC, ws, { store });
    expect(readFileSync(live(ws, "prices.json"))).toEqual(before);
    expect(res.prices).toEqual({ kept: true, stale: true, workspaceFetchedAt: "2026-01-01", packFetchedAt });
    expect(installCompletionMessage(res, PACK)).toMatch(/kept your \.octobots\/tokenomics\/prices\.json.*update-prices\.mjs/i);
    expect(res.pending.some((p) => p.startsWith("tokenomics-prices"))).toBe(false); // not staged for the doctor
  });

  it("reports kept, not stale, when the workspace table is as new as the pack's or newer", () => {
    const ws = withPrices("2099-01-01");
    const res = installPack(PACK_SRC, ws, { store });
    expect(res.prices).toEqual({ kept: true, stale: false, workspaceFetchedAt: "2099-01-01", packFetchedAt });
    const msg = installCompletionMessage(res, PACK);
    expect(msg).toMatch(/kept your \.octobots\/tokenomics\/prices\.json/i);
    expect(msg).not.toMatch(/update-prices/);
  });

  it("treats a table with no readable fetched_at as stale", () => {
    for (const ws of [withPrices(null), (() => { const w = installed(); mk(live(w, "prices.json"), "not json"); return w; })()]) {
      const res = installPack(PACK_SRC, ws, { store });
      expect(res.prices).toEqual({ kept: true, stale: true, workspaceFetchedAt: null, packFetchedAt });
    }
  });

  it("says nothing about prices on a first install, which writes the pack's table", () => {
    const ws = mkdtempClean("pack-tok-first-");
    const res = installPack(PACK_SRC, ws, { store });
    expect(res.prices).toBeUndefined();
    expect(readFileSync(live(ws, "prices.json"), "utf8")).toBe(packText("prices.json"));
    expect(installCompletionMessage(res, PACK)).not.toMatch(/prices\.json/);
  });
});
