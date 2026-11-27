// v62: every judged pack file (skill scripts, hooks, the statusline, templates, the tokenomics CLI)
// is told apart from the pack's own by content, and a changed retired file is a retired deviation.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installPack, OCTOBOTS_PACK_VERSION, OCTOBOTS_SKILLS, packStatus } from "../src/host/octobots-skill.js";
import { detectDeviations, deviationPrompt, installCompletionMessage, recoverFileBase, shouldPromptOnActivation, type DetectOptions } from "../src/host/pack-deviations.js";
import { isJudgedPackPath, packFileEntryName, packFileRel } from "../src/host/pack-files.js";
import { readPending, serializePending } from "../src/host/pack-updates.js";
import { skillSha256 } from "../src/host/skill-marker.js";
import { PACK_SRC, store } from "./fixtures/pack-store.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PACK = OCTOBOTS_PACK_VERSION;
const VALIDATE = "skill/mission-planner/scripts/validate.js";
const LIST = "skill/mission-planner/scripts/list.js";
const COLLECT = "tokenomics/collect.mjs";
const SET_STEP = "skill/mission-planner/scripts/set-step.js";

const packText = (key: string) => readFileSync(join(PACK_SRC, ...key.split("/")), "utf8");
const live = (ws: string, key: string) => join(ws, ...packFileRel(key).split("/"));
const mk = (p: string, content: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };

/** Every body the pack shipped for `key` but the current one, oldest first (a retired key has no current one). */
function olderBodies(key: string): string[] {
  const current = store.versions[String(PACK)]?.[key] ? skillSha256(packText(key)) : null;
  const seen = new Set<string>();
  for (const v of Object.keys(store.versions).map(Number).sort((a, b) => a - b)) {
    for (const h of store.versions[String(v)]?.[key] ?? []) if (h !== current) seen.add(h);
  }
  return [...seen].map((h) => store.bodies[h]!);
}
function olderShipped(key: string): string {
  const b = olderBodies(key)[0];
  if (b === undefined) throw new Error(`no older shipped body of ${key}`);
  return b;
}

/** A workspace with the current pack installed. */
function installed(): string {
  const ws = mkdtempClean("pack-files-");
  installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
  return ws;
}

/** `text` with its marker line after a leading shebang line, or first when there is none. */
function marked(text: string, sha256: string, syntax = "//"): string {
  const line = `${syntax} octobots-reconciled-from: ${sha256}${syntax === "<!--" ? " -->" : ""}\n`;
  const shebang = text.match(/^#!.*\r?\n/)?.[0] ?? "";
  return shebang + line + text.slice(shebang.length);
}

// The caller's view of the current pack (installPack), and none (packStatus's store fallback).
const currentHashes = Object.fromEntries(OCTOBOTS_SKILLS.map((s) => [s, skillSha256(packText(`skill/${s}/SKILL.md`))]));
function judgedFiles(dir: string): string[] {
  return readdirSync(join(PACK_SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const key = `${dir}/${e.name}`;
    return e.isDirectory() ? judgedFiles(key) : isJudgedPackPath(key) ? [key] : [];
  });
}
const currentFiles = Object.fromEntries(
  ["skill", "hooks", "statusline", "tokenomics"].flatMap(judgedFiles).map((k) => [k, skillSha256(packText(k))]),
);
const MODES: Array<[string, DetectOptions]> = [["with the pack at hand", { currentHashes, currentFiles }], ["from the store alone", {}]];

describe.each(MODES)("detectDeviations judges every pack file, %s", (_mode, opts) => {
  const detect = (ws: string) => detectDeviations(ws, PACK, store, opts);

  it("a pristine install has no deviation and nothing skipped", () => {
    expect(detect(installed())).toEqual({ deviations: [], reconciled: [], newer: [], skipped: [] });
  });

  it("a changed skill script is a deviation", () => {
    const ws = installed();
    const text = packText(VALIDATE) + "// local\n";
    writeFileSync(live(ws, VALIDATE), text);
    expect(detect(ws).deviations).toEqual([
      expect.objectContaining({
        skill: "skill-mission-planner-scripts-validate-js", file: VALIDATE, reason: "content", retired: false, sha256: skillSha256(text),
      }),
    ]);
  });

  it.each([
    ["hooks/primer.mjs", "// local\n"],
    ["statusline/statusline.sh", "# local\n"],
    ["skill/mission-planner/templates/TC-template.md", "local\n"],
  ])("a changed hook, the statusline and the TC template are deviations: %s", (key, extra) => {
    const ws = installed();
    mk(live(ws, key), packText(key) + extra);
    expect(detect(ws).deviations).toEqual([
      expect.objectContaining({ skill: packFileEntryName(key), file: key, reason: "content", retired: false }),
    ]);
  });

  it.each([VALIDATE, "hooks/primer.mjs", "statusline/statusline.sh", COLLECT])("an older shipped body is not a deviation: %s", (key) => {
    const ws = installed();
    mk(live(ws, key), olderShipped(key));
    expect(detect(ws).deviations).toEqual([]);
  });

  it("pack-owned JSON is never judged", () => {
    const ws = installed();
    writeFileSync(join(ws, ".claude/skills/mission-planner/scripts/package.json"), "{\"local\":1}\n");
    writeFileSync(join(ws, ".octobots/hooks/required-hooks.json"), "{\"local\":1}\n");
    const changed = live(ws, VALIDATE);
    writeFileSync(changed, "// local\n"); // a control: judging did run
    expect(detect(ws).deviations.map((d) => d.file)).toEqual([VALIDATE]);
  });

  it.each([COLLECT, VALIDATE])("marker loop: pack body plus marker is not a deviation: %s", (key) => {
    const ws = installed();
    const b = olderShipped(key);
    const text = marked(b, skillSha256(b));
    writeFileSync(live(ws, key), text);
    expect(detect(ws)).toMatchObject({ deviations: [], reconciled: [] });
    writeFileSync(live(ws, key), text + "// local\n");
    expect(detect(ws).deviations).toEqual([expect.objectContaining({ file: key, reason: "reconciled-older" })]);
  });

  // list.js has one older body, so its marker names a hash the pack never shipped.
  it.each([COLLECT, VALIDATE, LIST])("a deliberately kept older body is protected: %s", (key) => {
    const ws = installed();
    const [b, other] = olderBodies(key);
    writeFileSync(live(ws, key), marked(b!, other === undefined ? "a".repeat(64) : skillSha256(other)));
    expect(detect(ws).deviations).toEqual([expect.objectContaining({ file: key, reason: "reconciled-older" })]);

    writeFileSync(live(ws, key), marked(b!, skillSha256(packText(key))));
    expect(detect(ws)).toMatchObject({ deviations: [], reconciled: [packFileEntryName(key)] });
  });

  it.each([COLLECT, VALIDATE])("current body with an older marker is not a deviation: %s", (key) => {
    const ws = installed();
    writeFileSync(live(ws, key), marked(packText(key), skillSha256(olderShipped(key))));
    expect(detect(ws)).toMatchObject({ deviations: [], reconciled: [] });
  });

  it.each([SET_STEP, "skill/octobots/scripts/validate.js"])("a changed retired file is a retired deviation; an unchanged one is not: %s", (key) => {
    const ws = installed();
    mk(live(ws, key), "local\n");
    const { deviations } = detect(ws);
    expect(deviations).toEqual([expect.objectContaining({ skill: packFileEntryName(key), file: key, reason: "content", retired: true })]);
    expect(deviationPrompt(deviations, PACK).detail).toContain(
      `• ${packFileRel(key)}: differs from every file the pack shipped; retired in v${PACK}, so Overwrite deletes it`,
    );
    writeFileSync(live(ws, key), olderShipped(key));
    expect(detect(ws).deviations).toEqual([]);
  });

  // The template has no older body: its current one stands in, then an unshipped text.
  it("the marker in # and <!-- syntax", () => {
    const ws = installed();
    const sl = "statusline/statusline.sh";
    const tc = "skill/mission-planner/templates/TC-template.md";
    const b = olderShipped(sl);
    mk(live(ws, sl), marked(b, skillSha256(b), "#"));
    mk(live(ws, tc), marked(packText(tc), "a".repeat(64), "<!--"));
    expect(detect(ws)).toMatchObject({ deviations: [], reconciled: [] });

    mk(live(ws, sl), marked(b, "a".repeat(64), "#"));
    mk(live(ws, tc), marked(packText(tc) + "local\n", "a".repeat(64), "<!--"));
    expect(detect(ws).deviations.map((d) => [d.file, d.reason])).toEqual([[tc, "reconciled-older"], [sl, "reconciled-older"]]);

    mk(live(ws, sl), marked(b, skillSha256(packText(sl)), "#"));
    mk(live(ws, tc), marked("local\n", skillSha256(packText(tc)), "<!--"));
    expect(detect(ws)).toMatchObject({ deviations: [], reconciled: [packFileEntryName(tc), packFileEntryName(sl)] });
  });

  it("a retired file with a marker: its own body is not a deviation, a changed one is", () => {
    const ws = installed();
    const b = olderShipped(SET_STEP);
    mk(live(ws, SET_STEP), marked(b, skillSha256(b)));
    expect(detect(ws)).toMatchObject({ deviations: [], reconciled: [] });
    for (const text of [marked(b, skillSha256(b)) + "// local\n", marked(b, "a".repeat(64))]) {
      writeFileSync(live(ws, SET_STEP), text);
      expect(detect(ws).deviations).toEqual([expect.objectContaining({ file: SET_STEP, reason: "reconciled-older", retired: true })]);
    }
  });

  it("a second marker line is local content: only the first is stripped, and only the first is read", () => {
    const ws = installed();
    const b = olderShipped(VALIDATE);
    const current = skillSha256(packText(VALIDATE));
    writeFileSync(live(ws, VALIDATE), marked(marked(b, current), skillSha256(b)));
    expect(detect(ws)).toMatchObject({ deviations: [{ file: VALIDATE, reason: "reconciled-older" }], reconciled: [] });
    writeFileSync(live(ws, VALIDATE), marked(marked(b, skillSha256(b)), current));
    expect(detect(ws)).toMatchObject({ deviations: [], reconciled: [packFileEntryName(VALIDATE)] });
  });

  it("special files are skipped", () => {
    const ws = installed();
    const fifo = live(ws, "hooks/primer.mjs");
    rmSync(fifo);
    execFileSync("mkfifo", [fifo]);
    const outside = join(mkdtempClean("pack-files-out-"), "statusline.sh");
    writeFileSync(outside, "# not the pack's\n");
    symlinkSync(outside, live(ws, "statusline/statusline.sh"));
    rmSync(live(ws, VALIDATE));
    mkdirSync(live(ws, VALIDATE));
    // A blocking open would block this thread, vitest's timeout with it: after 3 s the helper opens
    // the FIFO read-write, which releases such a reader, and the elapsed time fails the test.
    const helper = spawn(process.execPath, ["-e", "setTimeout(() => require('fs').closeSync(require('fs').openSync(process.argv[1], 'r+')), 3000)", fifo], { stdio: "ignore" });
    try {
      const start = Date.now();
      const r = detect(ws);
      expect(Date.now() - start).toBeLessThan(2500);
      expect(r.deviations).toEqual([]);
      expect([...r.skipped].sort()).toEqual([".claude/skills/mission-planner/scripts/validate.js", ".octobots/hooks/primer.mjs", ".octobots/statusline.sh"]);
    } finally {
      helper.kill("SIGKILL");
    }
  }, 10_000);
});

describe("detectDeviations and recoverFileBase, other cases", () => {
  it("no store: neither throws nor reports a file deviation", () => {
    const ws = installed();
    writeFileSync(live(ws, VALIDATE), "// local\n");
    mk(live(ws, SET_STEP), "local\n");
    expect(detectDeviations(ws, PACK, null, { currentHashes, currentFiles }).deviations).toEqual([]);
    expect(detectDeviations(ws, PACK, null).deviations).toEqual([]);
  });

  it("no store: a file whose marker names the current body is still reconciled", () => {
    const ws = installed();
    writeFileSync(live(ws, VALIDATE), marked("// local\n", skillSha256(packText(VALIDATE))));
    expect(detectDeviations(ws, PACK, null, { currentFiles })).toMatchObject({ deviations: [], reconciled: [packFileEntryName(VALIDATE)] });
    expect(detectDeviations(ws, PACK, null)).toMatchObject({ deviations: [], reconciled: [] });
  });

  it("recoverFileBase takes a pack path and reads the marker's body", () => {
    const b = olderShipped(VALIDATE);
    const base = recoverFileBase(installed(), VALIDATE, marked(b, skillSha256(b)) + "// local\n", PACK, store);
    expect(base).toMatchObject({ source: "reconciled-from", sha256: skillSha256(b), body: b });
  });

  it("recoverFileBase reads the workspace's git history at the file's workspace path", () => {
    const ws = installed();
    const b = olderShipped(VALIDATE);
    writeFileSync(live(ws, VALIDATE), b);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: ws, stdio: "ignore" });
    git("init", "-q");
    git("add", packFileRel(VALIDATE));
    git("commit", "-qm", "install");
    expect(recoverFileBase(ws, VALIDATE, b + "// local\n", PACK, store)).toMatchObject({ source: "workspace-git", sha256: skillSha256(b) });
  });
});

describe("installPack: a symlinked tokenomics file", () => {
  it.each([["live", true], ["dangling", false]])("%s: never copied through, the link stays", (_name, exists) => {
    const ws = installed();
    const outside = join(mkdtempClean("pack-files-out-"), "collect.mjs");
    if (exists) writeFileSync(outside, "// not the pack's\n");
    rmSync(live(ws, COLLECT));
    symlinkSync(outside, live(ws, COLLECT));
    installPack(PACK_SRC, ws, { store });
    expect(existsSync(outside) ? readFileSync(outside, "utf8") : null).toBe(exists ? "// not the pack's\n" : null);
    expect(lstatSync(live(ws, COLLECT)).isSymbolicLink()).toBe(true);
  });

  it("a missing tokenomics file is installed", () => {
    const ws = installed();
    rmSync(live(ws, COLLECT));
    installPack(PACK_SRC, ws, { store });
    expect(readFileSync(live(ws, COLLECT), "utf8")).toBe(packText(COLLECT));
  });
});

const stagingDir = (ws: string, key: string, v: number = PACK) => join(ws, ".octobots", "pack-updates", `v${v}`, packFileEntryName(key));
const read = (p: string) => readFileSync(p, "utf8");
const STATUSLINE = "statusline/statusline.sh";
const PRIMER = "hooks/primer.mjs";
const RUN = "tokenomics/run.mjs";
const FLIP = "hooks/status-flip.mjs";
const TC = "skill/mission-planner/templates/TC-template.md";

/** The text was kept live and staged, base.md included when a base was recovered. */
function expectStaged(ws: string, key: string, local: string, res: { pending: string[] }): void {
  const name = packFileEntryName(key);
  expect(read(live(ws, key))).toBe(local);
  expect(res.pending).toContain(name);
  const dir = stagingDir(ws, key);
  expect(read(join(dir, "local.md"))).toBe(local);
  expect(read(join(dir, "upstream.md"))).toBe(packText(key));
  expect(read(join(dir, "RECONCILE.md"))).toContain(`- File: ${packFileRel(key)} (pending entry ${name})`);
  const entry = readPending(ws)!.skills.find((e) => e.skill === name)!;
  expect(entry).toMatchObject({ retired: false, localSha256: skillSha256(local), upstreamSha256: skillSha256(packText(key)) });
  expect(existsSync(join(dir, "base.md"))).toBe(entry.base !== null);
}

/** Runs `fn` with `fifo` in place; from 8 s on a helper releases any blocked open of it, so a hang fails the test. */
function unblocked<T>(fifo: string, fn: () => T): T {
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => setInterval(() => { const fs = require('fs'); fs.closeSync(fs.openSync(process.argv[1], 'r+')); }, 20), 8000)", fifo], { stdio: "ignore" });
  try {
    const start = Date.now();
    const r = fn();
    expect(Date.now() - start).toBeLessThan(7000);
    return r;
  } finally {
    helper.kill("SIGKILL");
  }
}

describe("installPack: a changed pack file is kept and staged", () => {
  it("a changed skill script is kept byte for byte and staged; its siblings update", () => {
    const ws = installed();
    const local = packText(VALIDATE) + "// local\n";
    writeFileSync(live(ws, VALIDATE), local);
    writeFileSync(live(ws, LIST), olderShipped(LIST));
    const res = installPack(PACK_SRC, ws, { store });
    expectStaged(ws, VALIDATE, local, res);
    expect(read(live(ws, LIST))).toBe(packText(LIST));
    expect(res.pending).toEqual(["skill-mission-planner-scripts-validate-js"]);
    const brief = read(join(ws, `.octobots/pack-updates/v${PACK}/skill-mission-planner-scripts-validate-js/RECONCILE.md`));
    expect(brief).toContain("- File: .claude/skills/mission-planner/scripts/validate.js");
    expect(brief).toContain(`// octobots-reconciled-from: ${skillSha256(packText(VALIDATE))}`);
  });

  it("a changed hook is kept and staged", () => {
    const ws = installed();
    const local = packText(FLIP) + "// local\n";
    writeFileSync(live(ws, FLIP), local);
    writeFileSync(live(ws, "hooks/work-log.mjs"), olderShipped("hooks/work-log.mjs"));
    const res = installPack(PACK_SRC, ws, { store });
    expectStaged(ws, FLIP, local, res);
    expect(read(live(ws, "hooks/work-log.mjs"))).toBe(packText("hooks/work-log.mjs"));
  });

  it("statusline, registered: kept, staged, still executable", () => {
    const ws = installed();
    installPack(PACK_SRC, ws, { store, statusline: true });
    const local = packText(STATUSLINE) + "# local\n";
    writeFileSync(live(ws, STATUSLINE), local);
    const res = installPack(PACK_SRC, ws, { store });
    expectStaged(ws, STATUSLINE, local, res);
    expect(res.statusline).toBe("registered");
    expect(statSync(live(ws, STATUSLINE)).mode & 0o111).toBe(0o111);
    expect(read(join(stagingDir(ws, STATUSLINE), "RECONCILE.md"))).toContain(`# octobots-reconciled-from: ${skillSha256(packText(STATUSLINE))}`);
  });

  it.each([undefined, false])("statusline, not registered (statusline: %s): staged, untouched; Overwrite replaces it without registering", (statusline) => {
    const ws = installed();
    const opts = { store, ...(statusline === undefined ? {} : { statusline }) };
    const local = packText(STATUSLINE) + "# local\n";
    mk(live(ws, STATUSLINE), local);
    expectStaged(ws, STATUSLINE, local, installPack(PACK_SRC, ws, opts));
    installPack(PACK_SRC, ws, { ...opts, localChanges: "keep" });
    expect(read(live(ws, STATUSLINE))).toBe(local);
    const res = installPack(PACK_SRC, ws, { ...opts, localChanges: "overwrite" });
    expect(read(live(ws, STATUSLINE))).toBe(packText(STATUSLINE));
    expect(read(join(stagingDir(ws, STATUSLINE), "overwritten-local.md"))).toBe(local);
    expect(res.statusline).toBe("skipped");
    expect(existsSync(join(ws, ".claude", "settings.json")) ? read(join(ws, ".claude", "settings.json")) : "").not.toContain("statusline.sh");
    expect(installPack(PACK_SRC, ws, opts).pending).toEqual([]);
  });

  it("TC template is kept and staged; the brief puts the marker after the frontmatter", () => {
    const ws = installed();
    const local = packText(TC) + "local\n";
    writeFileSync(live(ws, TC), local);
    expectStaged(ws, TC, local, installPack(PACK_SRC, ws, { store }));
    const brief = read(join(stagingDir(ws, TC), "RECONCILE.md"));
    expect(brief).toContain(`<!-- octobots-reconciled-from: ${skillSha256(packText(TC))} -->`);
    expect(brief).toContain("right after the closing `---`");
  });

  it("a Markdown file without frontmatter gets no frontmatter instruction", () => {
    const ws = installed();
    const key = "tokenomics/README.md";
    const local = packText(key) + "local\n";
    writeFileSync(live(ws, key), local);
    expectStaged(ws, key, local, installPack(PACK_SRC, ws, { store }));
    expect(read(join(stagingDir(ws, key), "RECONCILE.md"))).not.toContain("closing `---`");
  });

  it("pack-owned JSON is replaced, nothing staged", () => {
    const ws = installed();
    const json = ["skill/mission-planner/scripts/package.json", "hooks/required-hooks.json"];
    for (const k of json) writeFileSync(live(ws, k), "{\"local\":1}\n");
    const res = installPack(PACK_SRC, ws, { store });
    for (const k of json) {
      expect(read(live(ws, k))).toBe(packText(k));
      expect(res.pending.some((p) => p.startsWith(packFileEntryName(k)))).toBe(false);
    }
  });

  it("every choice leaves a reconciled file alone, Overwrite included", () => {
    for (const localChanges of ["reconcile", "overwrite", "keep"] as const) {
      for (const key of [VALIDATE, FLIP, STATUSLINE, COLLECT]) {
        const ws = installed();
        const local = marked("local\n", skillSha256(packText(key)), key === STATUSLINE ? "#" : "//");
        mk(live(ws, key), local);
        const res = installPack(PACK_SRC, ws, { store, localChanges, ...(key === STATUSLINE ? { statusline: true } : {}) });
        expect(read(live(ws, key)), `${key} ${localChanges}`).toBe(local);
        expect([res.pending, res.kept]).toEqual([[], []]);
      }
    }
  });

  it("a second identical install reuses the entry", () => {
    const ws = installed();
    writeFileSync(live(ws, VALIDATE), "// local\n");
    installPack(PACK_SRC, ws, { store });
    writeFileSync(join(stagingDir(ws, VALIDATE), "merged.md"), "half merged\n");
    expect(installPack(PACK_SRC, ws, { store }).pending).toEqual([packFileEntryName(VALIDATE)]);
    expect(read(join(stagingDir(ws, VALIDATE), "merged.md"))).toBe("half merged\n");
  });
});

describe("installPack: retired files", () => {
  it("deletes the retired mission-gate hook an older pack installed", () => {
    const ws = installed();
    const key = "hooks/mission-gate.mjs";
    const hash = Object.values(store.versions).flatMap((v) => v[key] ?? [])[0]!;
    mk(live(ws, key), store.bodies[hash]!);
    expect(installPack(PACK_SRC, ws, { store }).pending).toEqual([]);
    expect(existsSync(live(ws, key))).toBe(false);
  });

  it("a changed retired file is kept and staged as retired; an unchanged one is deleted", () => {
    const ws = installed();
    mk(live(ws, SET_STEP), "// local\n");
    const res = installPack(PACK_SRC, ws, { store });
    const name = packFileEntryName(SET_STEP);
    expect(read(live(ws, SET_STEP))).toBe("// local\n");
    expect(res.pending).toEqual([name]);
    expect(readdirSync(stagingDir(ws, SET_STEP)).sort()).toEqual(["RECONCILE.md", "base.md", "local.md"]);
    const brief = read(join(stagingDir(ws, SET_STEP), "RECONCILE.md"));
    expect(brief).toContain("This file is retired.");
    expect(brief).not.toContain("- Upstream: pack");
    expect(brief).not.toContain("upstream.md");
    expect(brief).not.toContain("octobots-reconciled-from:");
    expect(readPending(ws)!.skills).toEqual([expect.objectContaining({ skill: name, retired: true, upstreamSha256: null })]);

    writeFileSync(live(ws, SET_STEP), olderShipped(SET_STEP));
    expect(installPack(PACK_SRC, ws, { store }).pending).toEqual([]);
    expect(existsSync(live(ws, SET_STEP))).toBe(false);
  });

  it("the same for a retired skill's script, its SKILL.md unchanged", () => {
    const key = "skill/octobots/scripts/validate.js";
    const ws = installed();
    mk(live(ws, "skill/octobots/SKILL.md"), olderShipped("octobots"));
    mk(live(ws, key), "// local\n");
    mk(live(ws, "skill/octobots/scripts/list.js"), olderShipped("skill/octobots/scripts/list.js"));
    mk(live(ws, "skill/octobots/scripts/package.json"), "{}\n");
    mk(live(ws, "skill/octobots/scripts/mine.js"), "// mine\n");
    const res = installPack(PACK_SRC, ws, { store });
    expect(read(live(ws, key))).toBe("// local\n");
    expect(readdirSync(join(ws, ".claude/skills/octobots")).sort()).toEqual(["scripts"]);
    expect(readdirSync(join(ws, ".claude/skills/octobots/scripts")).sort()).toEqual(["mine.js", "validate.js"]);
    expect(res.pending).toEqual([packFileEntryName(key)]);
    expect(res.keptFiles).toEqual([".claude/skills/octobots/scripts/mine.js"]);
    expect(existsSync(join(stagingDir(ws, key), "upstream.md"))).toBe(false);

    writeFileSync(live(ws, key), olderShipped(key));
    rmSync(live(ws, "skill/octobots/scripts/mine.js"));
    expect(installPack(PACK_SRC, ws, { store }).pending).toEqual([]);
    expect(existsSync(join(ws, ".claude/skills/octobots"))).toBe(false);
  });

  it("Overwrite saves a retired file and deletes it; Keep leaves it", () => {
    for (const key of [SET_STEP, "skill/octobots/scripts/validate.js"]) {
      const ws = installed();
      mk(live(ws, key), "// local\n");
      installPack(PACK_SRC, ws, { store, localChanges: "keep" });
      expect(read(live(ws, key))).toBe("// local\n");
      installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
      expect(existsSync(live(ws, key))).toBe(false);
      expect(read(join(stagingDir(ws, key), "overwritten-local.md"))).toBe("// local\n");
    }
  });

  it("a symlink, dangling link or empty directory at a retired path is left, not deleted or pruned", () => {
    const ws = installed();
    const out = mkdtempClean("pack-files-out-");
    writeFileSync(join(out, "t.js"), "// outside\n");
    symlinkSync(join(out, "t.js"), live(ws, SET_STEP));
    const [link, dir] = ["skill/octobots/scripts/list.js", "skill/octobots/scripts/validate.js"];
    mkdirSync(live(ws, dir!), { recursive: true });
    symlinkSync(join(out, "none.js"), live(ws, link!));
    for (const localChanges of [undefined, "overwrite"] as const) {
      const res = installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
      expect(res.skipped.sort()).toEqual([SET_STEP, link!, dir!].map(packFileRel).sort());
      expect(res.keptFiles).toEqual([]);
      expect(lstatSync(live(ws, SET_STEP)).isSymbolicLink()).toBe(true);
      expect(lstatSync(live(ws, link!)).isSymbolicLink()).toBe(true);
      expect(lstatSync(live(ws, dir!)).isDirectory()).toBe(true);
      expect(read(join(out, "t.js"))).toBe("// outside\n");
    }
  });
});

describe("installPack: special files", () => {
  const KEYS = [STATUSLINE, PRIMER, VALIDATE, COLLECT];
  it.each([["live", true], ["dangling", false]] as const)("symlinks (%s): never written through or replaced, and reported", (_n, exists) => {
    for (const localChanges of [undefined, "overwrite", "keep"] as const) {
      const ws = installed();
      installPack(PACK_SRC, ws, { store, statusline: true });
      const out = mkdtempClean("pack-files-out-");
      const target = (k: string) => join(out, packFileEntryName(k));
      for (const k of KEYS) {
        if (exists) writeFileSync(target(k), "// outside\n");
        rmSync(live(ws, k));
        symlinkSync(target(k), live(ws, k));
      }
      const res = installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
      for (const k of KEYS) {
        expect(readlinkSync(live(ws, k))).toBe(target(k));
        expect(existsSync(target(k)) ? read(target(k)) : null).toBe(exists ? "// outside\n" : null);
      }
      expect(res.skipped.sort()).toEqual(KEYS.map(packFileRel).sort());
      expect(res.pending).toEqual([]);
      expect(installCompletionMessage(res, PACK)).toContain(".octobots/hooks/primer.mjs");
      expect(packStatus(ws, PACK, store)).toMatchObject({ installed: true, upToDateExceptLocal: true });
    }
  });

  it.each([PRIMER, STATUSLINE, RUN])("a FIFO at %s: installPack and packStatus return", (key) => {
    const ws = installed();
    installPack(PACK_SRC, ws, { store, statusline: true });
    rmSync(live(ws, key));
    execFileSync("mkfifo", [live(ws, key)]);
    unblocked(live(ws, key), () => {
      for (const localChanges of [undefined, "overwrite"] as const) {
        const res = installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
        expect(res.skipped).toEqual([packFileRel(key)]);
      }
      expect(packStatus(ws, PACK, store)).toMatchObject({ installed: true, upToDateExceptLocal: true });
      packStatus(ws, PACK, null);
    });
    expect(lstatSync(live(ws, key)).isFIFO()).toBe(true);
  }, 30_000);

  it("a directory at a judged path is left and the install finishes", () => {
    const ws = installed();
    rmSync(live(ws, VALIDATE));
    mkdirSync(live(ws, VALIDATE));
    expect(installPack(PACK_SRC, ws, { store }).skipped).toEqual([packFileRel(VALIDATE)]);
    expect(lstatSync(live(ws, VALIDATE)).isDirectory()).toBe(true);
  });

  it.each(["prices.json", "prices.local.json"])("a symlinked %s, live or dangling, is never copied through", (file) => {
    for (const exists of [true, false]) {
      const ws = installed();
      const target = join(mkdtempClean("pack-files-out-"), file);
      if (exists) writeFileSync(target, "{}\n");
      const path = join(ws, ".octobots", "tokenomics", file);
      rmSync(path, { force: true });
      symlinkSync(target, path);
      const res = installPack(PACK_SRC, ws, { store });
      expect(existsSync(target) ? read(target) : null).toBe(exists ? "{}\n" : null);
      expect(readlinkSync(path)).toBe(target);
      expect(res.prices).toMatchObject({ kept: true });
    }
  });

  it("a clean install skips nothing, and says nothing about it", () => {
    const res = installPack(PACK_SRC, installed(), { store });
    expect(res.skipped).toEqual([]);
    expect(installCompletionMessage(res, PACK)).not.toMatch(/left/i);
  });
});

describe("packStatus with a local primer", () => {
  const bump = (text: string, marker: string) => text.replace(/^.*octobots-pack-version:.*\r?\n/m, marker);
  it.each([["an old marker", "// octobots-pack-version: 1\n"], ["no marker", ""]])("changed, kept and reconciled, with %s", (_n, marker) => {
    const ws = installed();
    const status = () => packStatus(ws, PACK, store);
    const prompts = () => shouldPromptOnActivation(status(), readPending(ws), PACK);
    const text = bump(packText(PRIMER), marker) + "// local\n";
    expect(text).not.toContain(`octobots-pack-version: ${PACK}`);
    writeFileSync(live(ws, PRIMER), text);
    expect(status()).toMatchObject({ installed: true, upToDate: false, upToDateExceptLocal: true });
    expect(prompts()).toBe(true);
    installPack(PACK_SRC, ws, { store });
    expect(status()).toMatchObject({ installed: true, upToDateExceptLocal: true });
    expect(prompts()).toBe(false);
    installPack(PACK_SRC, ws, { store, localChanges: "keep" });
    expect(status()).toMatchObject({ installed: true, upToDateExceptLocal: true });
    expect(prompts()).toBe(false);
    writeFileSync(live(ws, PRIMER), marked(text, skillSha256(packText(PRIMER))));
    expect(status()).toMatchObject({ installed: true, upToDate: true, upToDateExceptLocal: true });
    expect(prompts()).toBe(false);
  });
});

describe("installPack: marker loop, choices and messages", () => {
  it.each([COLLECT, VALIDATE])("marker loop end to end: %s", (key) => {
    const ws = installed();
    const b = olderShipped(key);
    writeFileSync(live(ws, key), marked(b, skillSha256(b)));
    const res = installPack(PACK_SRC, ws, { store });
    expect(read(live(ws, key))).toBe(packText(key));
    expect(res.pending).not.toContain(packFileEntryName(key));
    expect(readPending(ws)?.skills ?? []).toEqual([]);

    const chosen = marked(b, skillSha256(packText(key)));
    writeFileSync(live(ws, key), chosen);
    expect(installPack(PACK_SRC, ws, { store }).pending).toEqual([]);
    expect(read(live(ws, key))).toBe(chosen);
    expect(readPending(ws)?.skills ?? []).toEqual([]);
  });

  it.each([VALIDATE, FLIP, COLLECT, TC])("Overwrite and Keep: %s", (key) => {
    const ws = installed();
    const name = packFileEntryName(key);
    const local = packText(key) + "// local\n";
    writeFileSync(live(ws, key), local);
    const kept = installPack(PACK_SRC, ws, { store, localChanges: "keep" });
    expect(read(live(ws, key))).toBe(local);
    expect(kept).toMatchObject({ pending: [], kept: [name] });
    expect(readPending(ws)!.kept).toEqual([{ skill: name, packVersion: PACK, sha256: skillSha256(local) }]);
    expect(installPack(PACK_SRC, ws, { store })).toMatchObject({ pending: [], kept: [name] });
    expect(read(live(ws, key))).toBe(local);

    const res = installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
    expect(read(join(stagingDir(ws, key), "overwritten-local.md"))).toBe(local);
    expect(read(live(ws, key))).toBe(packText(key));
    expect(res).toMatchObject({ pending: [], kept: [] });
    expect(readPending(ws)).toMatchObject({ skills: [], kept: [] });
  });

  it("the prompt and the message name the workspace path", () => {
    const ws = installed();
    writeFileSync(live(ws, VALIDATE), "// local\n");
    const { deviations } = packStatus(ws, PACK, store);
    expect(deviationPrompt(deviations, PACK).detail).toContain(".claude/skills/mission-planner/scripts/validate.js");
    expect(installCompletionMessage(installPack(PACK_SRC, ws, { store }), PACK)).toContain("skill-mission-planner-scripts-validate-js");
  });
});

describe("v61 record", () => {
  const name = "tokenomics-collect-mjs";
  const local = packText(COLLECT) + "// local\n";
  function seed(ws: string, v: number): string {
    const b = olderShipped(COLLECT);
    const dir = stagingDir(ws, COLLECT, v);
    writeFileSync(live(ws, COLLECT), local);
    mk(join(dir, "local.md"), local);
    mk(join(dir, "base.md"), b);
    mk(join(dir, "upstream.md"), packText(COLLECT));
    mk(join(dir, "RECONCILE.md"), `# Reconcile .octobots/tokenomics/collect.mjs (pack v${v})\n\n- File: .octobots/tokenomics/collect.mjs (pending entry ${name})\n`);
    mk(join(ws, ".octobots", "pack-updates", "pending.json"), serializePending({
      packVersion: v,
      skills: [{
        skill: name, action: "reconcile", localVersion: "unversioned", localSha256: skillSha256(local),
        base: { version: 57, sha256: skillSha256(b), source: "closest" }, upstreamSha256: skillSha256(packText(COLLECT)),
        retired: false, dir: `.octobots/pack-updates/v${v}/${name}`,
      }],
      kept: [],
    }));
    return dir;
  }

  it("an entry in v61's format at this pack version is reused", () => {
    const ws = installed();
    const dir = seed(ws, PACK);
    const brief = read(join(dir, "RECONCILE.md"));
    const before = readPending(ws);
    installPack(PACK_SRC, ws, { store });
    expect(readPending(ws)).toEqual(before);
    expect(read(join(dir, "RECONCILE.md"))).toBe(brief);
  });

  it("a v61 record is re-staged, its open escalation carried over and its log kept", () => {
    const ws = installed();
    const dir = seed(ws, 61);
    const open = "- ESCALATED: reflog: local a; upstream b; question c?";
    writeFileSync(join(dir, "DECISIONS.md"), `# Decisions\n${open}\n`);
    expect(readPending(ws)!.packVersion).toBe(61);
    const res = installPack(PACK_SRC, ws, { store });
    expectStaged(ws, COLLECT, local, res);
    expect(readPending(ws)).toMatchObject({ packVersion: PACK, skills: [{ skill: name, dir: `.octobots/pack-updates/v${PACK}/${name}` }] });
    const brief = read(join(stagingDir(ws, COLLECT), "RECONCILE.md"));
    expect(brief).toContain("Carried over from v61:");
    expect(brief).toContain(open);
    expect(readdirSync(dir)).toEqual(["DECISIONS.md"]);
    expect(read(join(dir, "DECISIONS.md"))).toContain(open);
  });
});

describe("a skill newer than the pack", () => {
  const NAME = packFileEntryName(VALIDATE);
  const FUTURE = "// from the future\n";
  function makeNewer(ws: string): void {
    const md = live(ws, "skill/mission-planner/SKILL.md");
    writeFileSync(md, read(md).replace(/^version:.*$/m, `version: ${PACK + 1}`));
  }
  function newer(): string {
    const ws = installed();
    makeNewer(ws);
    writeFileSync(live(ws, VALIDATE), FUTURE);
    return ws;
  }

  it.each([undefined, "reconcile", "overwrite", "keep"] as const)("%s: a changed file is left, not staged, kept or prompted for, twice over", (localChanges) => {
    const ws = newer();
    writeFileSync(live(ws, LIST), marked("// local\n", skillSha256(packText(LIST)))); // would be reconciled
    for (let i = 0; i < 2; i++) {
      expect(detectDeviations(ws, PACK, store, { currentHashes, currentFiles })).toEqual({ deviations: [], reconciled: [], newer: ["mission-planner"], skipped: [] });
      const st = packStatus(ws, PACK, store);
      expect(st).toMatchObject({ installed: true, upToDate: false, upToDateExceptLocal: true, deviations: [], reconciled: [] });
      expect(shouldPromptOnActivation(st, readPending(ws), PACK)).toBe(false);
      const res = installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
      expect(res).toMatchObject({ pending: [], kept: [], skipped: [] });
      expect(read(live(ws, VALIDATE))).toBe(FUTURE);
      expect(existsSync(join(ws, ".octobots", "pack-updates"))).toBe(false);
    }
  });

  it("a changed file of another skill, a hook or tokenomics is still judged", () => {
    const ws = newer();
    const keys = ["skill/mission-execution/scripts/scan-parked.js", FLIP, COLLECT];
    for (const k of keys) writeFileSync(live(ws, k), "// local\n");
    expect(detectDeviations(ws, PACK, store).deviations.map((d) => d.file).sort()).toEqual([...keys].sort());
  });

  it("a symlink or directory at a current path is left and not listed", () => {
    const ws = newer();
    const target = join(mkdtempClean("pack-files-out-"), "none.js");
    rmSync(live(ws, VALIDATE));
    symlinkSync(target, live(ws, VALIDATE));
    rmSync(live(ws, LIST));
    mkdirSync(live(ws, LIST));
    expect(installPack(PACK_SRC, ws, { store, localChanges: "overwrite" }).skipped).toEqual([]);
    expect(readlinkSync(live(ws, VALIDATE))).toBe(target);
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(live(ws, LIST)).isDirectory()).toBe(true);
  });

  it("a retired file in it is still judged: kept by default, saved before Overwrite deletes it, a symlink left", () => {
    const ws = newer();
    mk(live(ws, SET_STEP), "// local\n");
    expect(installPack(PACK_SRC, ws, { store }).pending).toEqual([packFileEntryName(SET_STEP)]);
    expect(read(live(ws, SET_STEP))).toBe("// local\n");
    installPack(PACK_SRC, ws, { store, localChanges: "keep" });
    expect(read(live(ws, SET_STEP))).toBe("// local\n");
    installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
    expect(existsSync(live(ws, SET_STEP))).toBe(false);
    expect(read(join(stagingDir(ws, SET_STEP), "overwritten-local.md"))).toBe("// local\n");
    expect(read(live(ws, VALIDATE))).toBe(FUTURE);

    const target = join(mkdtempClean("pack-files-out-"), "t.js");
    symlinkSync(target, live(ws, SET_STEP));
    expect(installPack(PACK_SRC, ws, { store, localChanges: "overwrite" }).skipped).toEqual([packFileRel(SET_STEP)]);
    expect(readlinkSync(live(ws, SET_STEP))).toBe(target);
  });

  it("a newer retired skill is left whole: its changed files are neither judged nor deleted", () => {
    const key = "skill/octobots/scripts/validate.js";
    for (const localChanges of [undefined, "overwrite"] as const) {
      const ws = installed();
      mk(live(ws, "skill/octobots/SKILL.md"), `---\nname: octobots\nversion: ${PACK + 1}\n---\n`);
      mk(live(ws, key), FUTURE);
      const res = installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
      expect(res).toMatchObject({ pending: [], kept: [], skipped: [] });
      expect(read(live(ws, key))).toBe(FUTURE);
      expect(existsSync(join(ws, ".octobots", "pack-updates"))).toBe(false);
    }
  });

  it.each([undefined, "overwrite", "keep"] as const)("%s: an entry staged before the skill became newer is dropped; its folder and DECISIONS.md stay", (localChanges) => {
    const ws = installed();
    writeFileSync(live(ws, VALIDATE), FUTURE);
    installPack(PACK_SRC, ws, { store });
    const dir = stagingDir(ws, VALIDATE);
    const log = "# Decisions\n- ESCALATED: x: local a; upstream b; question c?\n";
    writeFileSync(join(dir, "DECISIONS.md"), log);
    makeNewer(ws);
    const res = installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
    expect(res).toMatchObject({ pending: [], kept: [] });
    expect(readPending(ws)!.skills.map((e) => e.skill)).not.toContain(NAME);
    expect(read(join(dir, "DECISIONS.md"))).toBe(log);
    expect(read(join(dir, "local.md"))).toBe(FUTURE);
    expect(read(live(ws, VALIDATE))).toBe(FUTURE);
  });
});

describe("an entry that leaves the report and comes back", () => {
  const MD = "skill/mission-execution/SKILL.md";
  const OPEN = "- ESCALATED: rule: local a; upstream b; question c?";
  const FIRST: Record<string, string> = { [VALIDATE]: packText(VALIDATE) + "// one\n", [MD]: packText(MD) + "\none\n" };
  const SECOND: Record<string, string> = { [VALIDATE]: packText(VALIDATE) + "// two\n", [MD]: packText(MD) + "\ntwo\n" };
  const entryName = (key: string) => (key === MD ? "mission-execution" : packFileEntryName(key));
  const folder = (ws: string, key: string, v: number = PACK) => join(ws, ".octobots", "pack-updates", `v${v}`, entryName(key));
  const install = (ws: string, v: number = PACK) => installPack(PACK_SRC, ws, { store, packVersion: v });
  const entries = (ws: string) => readPending(ws)!.skills.map((e) => e.skill);

  function staged(key: string): string {
    const ws = installed();
    writeFileSync(live(ws, key), FIRST[key]!);
    install(ws);
    return ws;
  }
  /** Where the open question sits: the agent's log, or only a brief that itself carried it. */
  function question(dir: string, where: string): void {
    writeFileSync(join(dir, "merged.md"), "stale merge\n");
    if (where === "DECISIONS.md") writeFileSync(join(dir, where), `# Decisions\n${OPEN}\n`);
    else writeFileSync(join(dir, where), `# Reconcile\n\nCarried over from v${PACK - 1}:\n${OPEN}\n\nInputs\n`);
  }
  function symlinked(ws: string, key: string): void {
    const target = join(mkdtempClean("pack-files-out-"), "elsewhere");
    writeFileSync(target, "// elsewhere\n");
    rmSync(live(ws, key));
    symlinkSync(target, live(ws, key));
  }
  /** Writes `text` at the path of `key`, in place of whatever is there. */
  function restore(ws: string, key: string, text: string): void {
    rmSync(live(ws, key));
    writeFileSync(live(ws, key), text);
  }
  function relabel(ws: string, skill: string, v: number): void {
    const md = live(ws, `skill/${skill}/SKILL.md`);
    writeFileSync(md, read(md).replace(/^version:.*$/m, `version: ${v}`));
  }
  const ROUTES: Array<[string, string, (ws: string) => void, (ws: string) => void]> = [
    ["pristine", VALIDATE, (ws) => restore(ws, VALIDATE, packText(VALIDATE)), () => {}],
    ["pristine", MD, (ws) => restore(ws, MD, packText(MD)), () => {}],
    ["skipped", VALIDATE, (ws) => symlinked(ws, VALIDATE), () => {}],
    ["newer", VALIDATE, (ws) => relabel(ws, "mission-planner", PACK + 1), (ws) => relabel(ws, "mission-planner", PACK)],
    ["newer", MD, (ws) => relabel(ws, "mission-execution", PACK + 1), () => {}],
  ];

  describe.each(ROUTES)("%s: %s", (route, key, leave, back) => {
    it.each(["DECISIONS.md", "RECONCILE.md"])("merged.md goes and the question of %s is carried", (where) => {
      const ws = staged(key);
      const dir = folder(ws, key);
      question(dir, where);
      leave(ws);
      expect(install(ws).pending).toEqual([]);
      expect(entries(ws)).toEqual(route === "skipped" ? [entryName(key)] : []);
      back(ws);
      restore(ws, key, SECOND[key]!);
      expect(install(ws).pending).toEqual([entryName(key)]);
      expect(read(join(dir, "local.md"))).toBe(SECOND[key]);
      expect(existsSync(join(dir, "merged.md"))).toBe(false);
      const brief = read(join(dir, "RECONCILE.md"));
      expect(brief).toContain(`Carried over from v${where === "DECISIONS.md" ? PACK : PACK - 1}:\n${OPEN}\n`);
      expect(brief.split("Carried over from").length).toBe(2);
      if (where === "DECISIONS.md") expect(read(join(dir, where))).toContain(OPEN);
    });
  });

  it("a kept file re-opened over an old folder carries its question too", () => {
    const ws = staged(VALIDATE);
    question(folder(ws, VALIDATE), "DECISIONS.md");
    installPack(PACK_SRC, ws, { store, localChanges: "keep" });
    installPack(PACK_SRC, ws, { store, localChanges: "reconcile" });
    expect(read(join(folder(ws, VALIDATE), "RECONCILE.md"))).toContain(OPEN);
  });

  it.each([undefined, "reconcile", "overwrite", "keep"] as const)("%s: a skipped file keeps its pending record unchanged, its folder too", (localChanges) => {
    const ws = staged(VALIDATE);
    const dir = folder(ws, VALIDATE);
    question(dir, "DECISIONS.md");
    const before = readPending(ws);
    symlinked(ws, VALIDATE);
    const res = installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
    expect(res).toMatchObject({ pending: [], kept: [], skipped: [packFileRel(VALIDATE)] });
    expect(readPending(ws)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(["DECISIONS.md", "RECONCILE.md", "base.md", "local.md", "merged.md", "upstream.md"]);
    const st = packStatus(ws, PACK, store);
    expect(shouldPromptOnActivation(st, readPending(ws), PACK)).toBe(false);
    const list = spawnSync("node", [live(ws, "skill/octobots-doctor/scripts/pack-reconcile.mjs"), "list"], { encoding: "utf8" });
    expect(list).toMatchObject({ status: 0, stderr: "" });
    expect(list.stdout).toContain(`folder: .octobots/pack-updates/v${PACK}/${packFileEntryName(VALIDATE)}/`);
    // Back unchanged at the same version: the same entry, its merge in progress untouched.
    restore(ws, VALIDATE, FIRST[VALIDATE]!);
    install(ws);
    expect(readPending(ws)).toEqual(before);
    expect(read(join(dir, "merged.md"))).toBe("stale merge\n");
  });

  it.each([undefined, "reconcile", "overwrite", "keep"] as const)("%s: a skipped file keeps its kept record unchanged", (localChanges) => {
    const ws = installed();
    writeFileSync(live(ws, VALIDATE), FIRST[VALIDATE]!);
    installPack(PACK_SRC, ws, { store, localChanges: "keep" });
    const before = readPending(ws)!.kept;
    symlinked(ws, VALIDATE);
    installPack(PACK_SRC, ws, { store, ...(localChanges ? { localChanges } : {}) });
    expect(readPending(ws)).toMatchObject({ skills: [], kept: before });
    restore(ws, VALIDATE, FIRST[VALIDATE]!);
    expect(install(ws)).toMatchObject({ pending: [], kept: [packFileEntryName(VALIDATE)] });
  });

  it("skipped across a bump: the older folder stays the entry's, and the next readable install restages from it", () => {
    const ws = staged(VALIDATE);
    question(folder(ws, VALIDATE), "DECISIONS.md");
    install(ws, PACK + 1);
    writeFileSync(join(folder(ws, VALIDATE, PACK + 1), "merged.md"), "stale merge\n");
    const older = readPending(ws)!.skills;
    symlinked(ws, VALIDATE);
    install(ws, PACK + 2);
    expect(readPending(ws)).toMatchObject({ packVersion: PACK + 2, skills: older });
    const list = spawnSync("node", [live(ws, "skill/octobots-doctor/scripts/pack-reconcile.mjs"), "list"], { encoding: "utf8" });
    expect(list.stdout).toContain(`upstream v${PACK + 1}`);

    restore(ws, VALIDATE, FIRST[VALIDATE]!);
    // Staged for the older version only: readable again, it is asked about.
    const { deviations } = detectDeviations(ws, PACK + 2, store, { currentFiles, currentHashes });
    const status = { installed: true, upToDate: false, upToDateExceptLocal: true, deviations: deviations.filter((d) => d.file === VALIDATE) };
    expect(status.deviations.length).toBe(1);
    expect(shouldPromptOnActivation(status, readPending(ws), PACK + 2)).toBe(true);
    install(ws, PACK + 2);
    expect(shouldPromptOnActivation(status, readPending(ws), PACK + 2)).toBe(false);
    const dir = folder(ws, VALIDATE, PACK + 2);
    expect(read(join(dir, "RECONCILE.md"))).toContain(`Carried over from v${PACK}:\n${OPEN}\n`);
    expect(readdirSync(dir).sort()).toEqual(["RECONCILE.md", "base.md", "local.md", "upstream.md"]);
    expect(existsSync(folder(ws, VALIDATE, PACK + 1))).toBe(false);
    expect(readPending(ws)!.skills).toEqual([expect.objectContaining({ dir: `.octobots/pack-updates/v${PACK + 2}/${packFileEntryName(VALIDATE)}` })]);
  });
});
