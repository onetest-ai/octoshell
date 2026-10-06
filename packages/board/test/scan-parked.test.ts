// Tests for the pack's mission-execution/scripts/scan-parked.js, the parked-test scan (mission M5
// AC6, task T5.5). Each case builds a scratch git repo, runs the script as a child `node` (so
// `pnpm coverage:pack` counts it), and asserts the file set, the hit rules, the signoff file, the
// exit codes and the --json shape.
//
// The fixture bodies live in test/fixtures/scan-parked/ as .txt files and are copied into the
// scratch repos under the names a case needs. They hold the very tokens the scan hunts for, so the
// scan must exclude that folder, which is one of the clauses under test. A literal token in THIS
// file would be a hit in the octoshell self-scan, so none appears here.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACK_SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-execution/scripts");
const SCRIPT = join(PACK_SCRIPTS, "scan-parked.js");
const REPO_ROOT = resolve(__dirname, "../../..");
// Snippets are assembled from parts so this file holds no literal parking token (see the header).
const SKIP_CALL = `${["it", "skip"].join(".")}("x", () => {});`;
const TODO_CALL = `${["it", "todo"].join(".")}("y");`;
const SKIPIF_CALL = `${["it", "skipIf"].join(".")}(a)("y", () => {});`;
const fixture = (name: string): string => readFileSync(join(__dirname, "fixtures", "scan-parked", name), "utf8");

type Hit = { file: string; line: number; text: string };
type Report = { unsigned: Hit[]; allowed: Hit[] };

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A scratch git repo whose index holds `files` (path -> text). `untracked` files are written but never added. */
function makeRepo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scan-parked-")));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [rel, text] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  if (Object.keys(files).length) execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: dir });
  return dir;
}

function scan(root: string | null, args: string[] = [], cwd = root ?? REPO_ROOT): SpawnSyncReturns<string> {
  const rootArgs = root === null ? [] : ["--root", root];
  return spawnSync("node", [SCRIPT, ...rootArgs, ...args], { cwd, encoding: "utf8", timeout: 30000 });
}
function report(root: string, args: string[] = []): { status: number | null; json: Report; stderr: string } {
  const r = scan(root, ["--json", ...args]);
  return { status: r.status, json: JSON.parse(r.stdout) as Report, stderr: r.stderr };
}
const lines = (hits: Hit[], file: string): number[] => hits.filter((h) => h.file === file).map((h) => h.line);

describe("scan-parked.js hit rules", () => {
  it("reports each vitest/jest parking call token once per line, with file, line and trimmed text", () => {
    const root = makeRepo({ "a.test.ts": fixture("vitest-hits.txt") });
    const { status, json } = report(root);
    expect(status).toBe(1);
    expect(lines(json.unsigned, "a.test.ts")).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(json.unsigned[0]).toEqual({ file: "a.test.ts", line: 2, text: fixture("vitest-hits.txt").split("\n")[1] });
    expect(json.unsigned.find((h) => h.line === 8)!.text).toBe(fixture("vitest-hits.txt").split("\n")[7]!.trim());
    expect(json.allowed).toEqual([]);
  });

  it("does not treat process.exit( or any identifier merely ending in xit as a hit, and lists skipIf/runIf as allowed", () => {
    const root = makeRepo({ "b.spec.ts": fixture("vitest-clean.txt") });
    const { status, json } = report(root);
    expect(status).toBe(0);
    expect(json.unsigned).toEqual([]);
    expect(json.allowed.map((h) => [h.file, h.line])).toEqual([["b.spec.ts", 8], ["b.spec.ts", 9]]);
  });

  it("reports pytest xfail/skip markers without reason=, a multi-line one at its decorator line, and imperative calls even with a reason", () => {
    const root = makeRepo({ "test_a.py": fixture("pytest-hits.txt") });
    const { status, json } = report(root);
    expect(status).toBe(1);
    expect(lines(json.unsigned, "test_a.py")).toEqual([3, 6, 9, 12, 15, 21, 24]);
    expect(json.unsigned.find((h) => h.line === 21)!.text).toBe(fixture("pytest-hits.txt").split("\n")[20]!.trim());
  });

  it("allows pytest skipif with a reason, and a marker that states reason= (also over several lines); importorskip is no hit", () => {
    const root = makeRepo({ "a_test.py": fixture("pytest-allowed.txt") });
    const { status, json } = report(root);
    expect(status).toBe(0);
    expect(json.unsigned).toEqual([]);
    expect(lines(json.allowed, "a_test.py")).toEqual([3, 6, 9]);
  });

  it("reports pytest skipif without any reason as unsigned (only skipif WITH a reason is allowed)", () => {
    const root = makeRepo({ "test_b.py": `@${["pytest", "mark", "skipif"].join(".")}(sys.platform == "win32")\ndef test_x(): ...\n` });
    const { status, json } = report(root);
    expect(status).toBe(1);
    expect(lines(json.unsigned, "test_b.py")).toEqual([1]);
  });
});

describe("scan-parked.js file set", () => {
  const HIT = `${SKIP_CALL}\n`;

  it("scans exactly the files git ls-files lists that match the test globs", () => {
    const matching = [
      "a.test.ts", "b.spec.js", "c.test.tsx", "d.spec.mjs", "test_e.py", "f_test.py", "x/y/g.test.ts",
      "tests/h.ts", "test/i.py", "pkg/test/deep/j.mjs", "pkg/tests/k.tsx",
    ];
    const ignored = ["src/main.ts", "latest.ts", "contest.py", "test_notes.md.bak.ts", "attest/l.ts", "testing/m.ts", "latest/n.ts", "tests/readme.md", "test/data.json", "pkg/tests/case.txt"];
    const files = Object.fromEntries([...matching, ...ignored].map((f) => [f, HIT]));
    const root = makeRepo(files);
    const { json } = report(root);
    expect(json.unsigned.map((h) => h.file).sort()).toEqual([...matching].sort());
  });

  it("excludes node_modules/, dist/ (at any depth) and its own fixtures folder", () => {
    const root = makeRepo({
      "node_modules/pkg/a.test.js": HIT,
      "packages/p/node_modules/q/b.test.js": HIT,
      "dist/c.test.js": HIT,
      "packages/p/dist/d.spec.js": HIT,
      "packages/board/test/fixtures/scan-parked/e.ts": HIT,
      "packages/board/test/fixtures/other/f.ts": HIT,
      "real.test.ts": HIT,
    });
    const { json } = report(root);
    expect(json.unsigned.map((h) => h.file).sort()).toEqual(["packages/board/test/fixtures/other/f.ts", "real.test.ts"]);
  });

  it("does not scan an untracked file", () => {
    const root = makeRepo({ "tracked.test.ts": "it('ok', () => {});\n" }, { "untracked.test.ts": HIT });
    const { status, json } = report(root);
    expect(status).toBe(0);
    expect(json.unsigned).toEqual([]);
  });

  it("--root names a directory under the repo: only its files, with paths relative to it", () => {
    const root = makeRepo({ "top.test.ts": HIT, "sub/inner.test.ts": HIT });
    const { json } = report(join(root, "sub"));
    expect(json.unsigned.map((h) => h.file)).toEqual(["inner.test.ts"]);
  });

  it("defaults --root to the current directory", () => {
    const root = makeRepo({ "top.test.ts": HIT });
    const r = scan(null, ["--json"], root);
    expect(r.status).toBe(1);
    expect((JSON.parse(r.stdout) as Report).unsigned.map((h) => h.file)).toEqual(["top.test.ts"]);
  });

  it("reads a tracked path that is now a FIFO without hanging, and skips an oversized or binary file with a note", () => {
    const root = makeRepo({ "fifo.test.ts": HIT, "big.test.ts": HIT, "bin.test.ts": HIT, "ok.test.ts": "it('x', () => {});\n" });
    rmSync(join(root, "fifo.test.ts"));
    execFileSync("mkfifo", [join(root, "fifo.test.ts")]);
    writeFileSync(join(root, "big.test.ts"), `${"x".repeat(3 * 1024 * 1024)}\n${HIT}`);
    writeFileSync(join(root, "bin.test.ts"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(HIT)]));
    const { status, json, stderr } = report(root);
    expect(status).toBe(0);
    expect(json.unsigned).toEqual([]);
    expect(stderr).toMatch(/fifo\.test\.ts/);
    expect(stderr).toMatch(/big\.test\.ts/);
    expect(stderr).toMatch(/bin\.test\.ts/);
  });

  it("does not follow a tracked symlink and skips a tracked file that was deleted from the working tree", () => {
    const root = makeRepo({ "real.test.ts": HIT, "gone.test.ts": HIT });
    rmSync(join(root, "gone.test.ts"));
    execFileSync("ln", ["-s", "real.test.ts", join(root, "link.test.ts")]);
    execFileSync("git", ["add", "link.test.ts"], { cwd: root });
    const { json } = report(root);
    expect(json.unsigned.map((h) => h.file)).toEqual(["real.test.ts"]);
  });
});

describe("scan-parked.js signoff", () => {
  const HIT = `${SKIP_CALL}\n${TODO_CALL}\n`;
  const signoff = (root: string, text: string): void => {
    mkdirSync(join(root, ".octobots"), { recursive: true });
    writeFileSync(join(root, ".octobots", "parked-signoff.txt"), text);
  };

  it("a `<path>:<line> <who> <date>` line exempts that hit, which moves to allowed; others stay unsigned", () => {
    const root = makeRepo({ "a.test.ts": HIT });
    signoff(root, "a.test.ts:1 artyom 2026-10-06\n");
    const { status, json } = report(root);
    expect(status).toBe(1);
    expect(json.unsigned.map((h) => h.line)).toEqual([2]);
    expect(json.allowed.map((h) => h.line)).toEqual([1]);
  });

  it("exits 0 once every hit is signed off", () => {
    const root = makeRepo({ "a.test.ts": HIT });
    signoff(root, "# parked on purpose\n\na.test.ts:1 artyom 2026-10-06\na.test.ts:2 jay 2026-10-07\n");
    const { status, json } = report(root);
    expect(status).toBe(0);
    expect(json.unsigned).toEqual([]);
    expect(json.allowed).toHaveLength(2);
  });

  it("a line with the wrong path, the wrong line, a bad date, no signer or extra fields signs nothing", () => {
    const root = makeRepo({ "a.test.ts": HIT });
    signoff(root, [
      "b.test.ts:1 artyom 2026-10-06",
      "a.test.ts:3 artyom 2026-10-06",
      "a.test.ts:1 artyom 06-10-2026",
      "a.test.ts:1 artyom 2026-13-45",
      "a.test.ts:1 2026-10-06",
      "a.test.ts:2 artyom 2026-10-06 and more",
      "a.test.ts 1 artyom 2026-10-06",
      "",
    ].join("\n"));
    const { status, json } = report(root);
    expect(status).toBe(1);
    expect(json.unsigned.map((h) => h.line)).toEqual([1, 2]);
  });

  it("accepts CRLF line endings and a ./ prefix on the path", () => {
    const root = makeRepo({ "a.test.ts": HIT });
    signoff(root, "./a.test.ts:1 artyom 2026-10-06\r\na.test.ts:2 jay 2026-10-07\r\n");
    expect(report(root).status).toBe(0);
  });

  it("is read from --root's own .octobots, and an unreadable signoff file (a directory) signs nothing", () => {
    const root = makeRepo({ "a.test.ts": HIT });
    mkdirSync(join(root, ".octobots", "parked-signoff.txt"), { recursive: true });
    const { status, json, stderr } = report(root);
    expect(status).toBe(1);
    expect(json.unsigned).toHaveLength(2);
    expect(stderr).toMatch(/parked-signoff\.txt/);
  });
});

describe("scan-parked.js output and errors", () => {
  it("prints a readable report without --json, and exits 0 with a summary when nothing is parked", () => {
    const root = makeRepo({ "a.test.ts": `${SKIP_CALL}\n`, "b.test.ts": `${SKIPIF_CALL}\n` });
    const dirty = scan(root);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toMatch(/unsigned/i);
    expect(dirty.stdout).toContain(`a.test.ts:1: ${SKIP_CALL}`);
    expect(dirty.stdout).toContain("b.test.ts:1");
    const clean = makeRepo({ "b.test.ts": `${SKIPIF_CALL}\n` });
    const ok = scan(clean);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/0 unsigned/);
    expect(ok.stdout).toMatch(/1 allowed/);
  });

  it("--json prints exactly {unsigned, allowed}, each entry {file, line, text}", () => {
    const root = makeRepo({ "a.test.ts": `${SKIP_CALL}\n${SKIPIF_CALL}\n` });
    const json = JSON.parse(scan(root, ["--json"]).stdout) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["allowed", "unsigned"]);
    for (const hit of [...(json.unsigned as Hit[]), ...(json.allowed as Hit[])]) {
      expect(Object.keys(hit).sort()).toEqual(["file", "line", "text"]);
    }
  });

  it("truncates a very long hit line", () => {
    const root = makeRepo({ "a.test.ts": `${["it", "skip"].join(".")}("${"x".repeat(500)}", () => {});\n` });
    expect(report(root).json.unsigned[0]!.text.length).toBeLessThanOrEqual(200);
  });

  it("exits 2 with a clear message outside a git repository", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "scan-parked-nogit-")));
    made.push(dir);
    writeFileSync(join(dir, "a.test.ts"), `${SKIP_CALL}\n`);
    const r = scan(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a git repository/i);
    expect(r.stdout).toBe("");
  });

  it.each([
    [["--bogus"]],
    [["--root"]],
    [["extra-positional"]],
    [["--root", "/definitely/not/a/dir/xyz"]],
  ])("exits 2 with a usage or root message for %j", (args) => {
    const r = spawnSync("node", [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage|root/i);
  });
});

describe("scan-parked.js on octoshell itself", () => {
  it("exits 0 and lists packages/graph/test/vault-calibration.test.ts:10 (describe.skipIf) as allowed, without unsigned hits", () => {
    const { status, json, stderr } = report(REPO_ROOT);
    expect(stderr).toBe("");
    expect(json.unsigned).toEqual([]);
    expect(status).toBe(0);
    const keys = json.allowed.map((h) => `${h.file}:${h.line}`);
    expect(keys).toContain("packages/graph/test/vault-calibration.test.ts:10");
    expect(json.allowed.find((h) => h.file === "packages/graph/test/vault-calibration.test.ts")!.text).toMatch(/^describe\.skipIf\(/);
  });

  it("reports T5.4's win32-conditional FIFO test as allowed, and never scans its own fixtures", () => {
    const { json } = report(REPO_ROOT);
    const tcIo = json.allowed.filter((h) => h.file === "packages/board/test/tc-io.test.ts");
    expect(tcIo.map((h) => h.text).join("\n")).toMatch(/skipIf\(process\.platform === "win32"\)\("never blocks on a README or TC that is a FIFO/);
    const all = [...json.allowed, ...json.unsigned];
    expect(all.some((h) => h.file.includes("fixtures/scan-parked/"))).toBe(false);
  });
});
