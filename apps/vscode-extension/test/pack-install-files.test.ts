// v62: every judged pack file (skill scripts, hooks, the statusline, templates, the tokenomics CLI)
// is told apart from the pack's own by content, and a changed retired file is a retired deviation.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installPack, OCTOBOTS_PACK_VERSION, OCTOBOTS_SKILLS } from "../src/host/octobots-skill.js";
import { detectDeviations, deviationPrompt, recoverFileBase, type DetectOptions } from "../src/host/pack-deviations.js";
import { isJudgedPackPath, packFileEntryName, packFileRel } from "../src/host/pack-files.js";
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
