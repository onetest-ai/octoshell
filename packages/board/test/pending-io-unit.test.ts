// Unit tests for the pack's pending-io.mjs, the one pack-side reader and writer of
// .octobots/pack-updates/pending.json (doctor.js, validate.js and pack-reconcile.mjs import it). The
// host twin is pinned to it by the extension's test/pending-io-parity.test.ts over the shared fixture
// cases; this file runs the module in a child `node`, as the CLI tests do, so `pnpm coverage:pack`
// (c8 over child processes) counts it.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts");
const IO = pathToFileURL(join(SCRIPTS, "pending-io.mjs")).href;
const CASES = resolve(__dirname, "../../../apps/vscode-extension/test/fixtures/pending-cases.json");

/** Runs `body` (an async function body with `io` in scope) in a child node and returns its JSON result. */
function run(body: string, arg: unknown = null): unknown {
  const src =
    `import * as io from ${JSON.stringify(IO)};` +
    `const arg = JSON.parse(process.argv[1]);` +
    `const out = await (async () => { ${body} })();` +
    "console.log(JSON.stringify(out));";
  return JSON.parse(execFileSync("node", ["--input-type=module", "-e", src, JSON.stringify(arg)], { encoding: "utf8" }));
}

const cases = (JSON.parse(readFileSync(CASES, "utf8")) as { cases: Array<{ name: string; text: string; expected: unknown }> }).cases;

describe("pending-io.mjs", () => {
  it("summarises every fixture case as the fixture says", () => {
    const out = run("return arg.map((c) => io.pendingSummary(c.text));", cases) as unknown[];
    expect(out).toEqual(cases.map((c) => c.expected));
  });

  it("round-trips every valid case byte for byte", () => {
    const valid = cases.filter((c) => (c.expected as { packVersion: number | null }).packVersion !== null);
    const out = run("return arg.map((c) => io.serializePending(io.parsePending(c.text)));", valid) as string[];
    expect(out).toEqual(valid.map((c) => c.text));
  });

  it("accepts a dir only of the shape .octobots/pack-updates/v<N>/<skill>", () => {
    const out = run(
      "return [io.isStagingDir('.octobots/pack-updates/v57/mission-execution'), io.isStagingDir('.octobots/pack-updates/v57/mission-execution', 'mission-execution'), io.isStagingDir('.octobots/pack-updates/v57/mission-execution', 'mission-planner'), io.isStagingDir('../x'), io.isStagingDir('.octobots/pack-updates/v57/../../campaigns')];",
    );
    expect(out).toEqual([true, true, false, false, false]);
  });

  it("reads none, malformed and ok, and writes atomically with no rewrite when nothing changed", () => {
    const root = mkdtempSync(join(tmpdir(), "pending-io-unit-"));
    const valid = cases.find((c) => c.name === "valid")!.text;
    const out = run(
      `const r = arg.root;
       const s = [io.readPending(r).state];
       const fs = await import("node:fs");
       fs.mkdirSync(r + "/.octobots/pack-updates", { recursive: true });
       fs.writeFileSync(io.pendingFile(r), "{");
       s.push(io.readPending(r).state);
       const rec = io.parsePending(arg.valid);
       s.push(io.writePending(r, rec), io.writePending(r, rec));
       const back = io.readPending(r);
       s.push(back.state, back.record.skills.length, back.record.kept.length);
       s.push(io.writePending(r, { ...rec, kept: [] }));
       return s;`,
      { root, valid },
    );
    expect(out).toEqual(["none", "malformed", true, false, "ok", 2, 1, true]);
    expect(readdirSync(join(root, ".octobots", "pack-updates"))).toEqual(["pending.json"]);
  });

  it("reports an unreadable file as malformed and cleans up its temp file when the write fails", () => {
    const root = mkdtempSync(join(tmpdir(), "pending-io-unit-"));
    // pending.json as a non-empty directory: unreadable, and a rename cannot replace it.
    mkdirSync(join(root, ".octobots", "pack-updates", "pending.json"), { recursive: true });
    writeFileSync(join(root, ".octobots", "pack-updates", "pending.json", "x"), "");
    const out = run(
      `const s = [io.readPending(arg.root).state];
       try { io.writePending(arg.root, { packVersion: 57, skills: [], kept: [] }); s.push("wrote"); } catch { s.push("threw"); }
       return s;`,
      { root },
    );
    expect(out).toEqual(["malformed", "threw"]);
    expect(readdirSync(join(root, ".octobots", "pack-updates"))).toEqual(["pending.json"]);
  });
});
