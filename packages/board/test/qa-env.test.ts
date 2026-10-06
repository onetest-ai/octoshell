// Tests for the pack's mission-execution/scripts/qa-env.mjs, the config-driven QA database guard
// (mission M5 AC4). Each test runs the script as a child `node` in a scratch directory, so
// `pnpm coverage:pack` (c8 over child processes) counts it. A marker file written by the guarded
// command proves whether the command ran.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-execution/scripts/qa-env.mjs",
);

let dir: string;
let marker: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-env-")));
  marker = join(dir, "ran.txt");
  mkdirSync(join(dir, ".octobots"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeConfig = (cfg: unknown, path = join(dir, ".octobots", "qa-env.json")) =>
  writeFileSync(path, typeof cfg === "string" ? cfg : JSON.stringify(cfg));

const CFG = { vars: { DATABASE_URL: "postgres://localhost/{db}" }, name_pattern: "^qa_[a-z0-9_]+$" };
/** A command that records that it ran, then prints the named env vars as JSON. */
const touch = () => ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env))`];

function qa(args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, timeout: 20000 });
}
const ranEnv = () => JSON.parse(readFileSync(marker, "utf8")) as Record<string, string>;

describe("qa-env.mjs usage", () => {
  it("exits 2 without a `--`", () => {
    writeConfig(CFG);
    const r = qa(["qa_x", "node", "-v"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });
  it("exits 2 without a db", () => {
    writeConfig(CFG);
    expect(qa(["--", ...touch()]).status).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });
  it("exits 2 without a command", () => {
    writeConfig(CFG);
    expect(qa(["qa_x", "--"]).status).toBe(2);
  });
  it("exits 2 on an unknown option, a second db, or --config without a value", () => {
    writeConfig(CFG);
    expect(qa(["--bogus", "qa_x", "--", ...touch()]).status).toBe(2);
    expect(qa(["qa_x", "qa_y", "--", ...touch()]).status).toBe(2);
    expect(qa(["qa_x", "--config"]).status).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("qa-env.mjs refusals (exit 3, command not run)", () => {
  it("refuses a db that does not match name_pattern", () => {
    writeConfig(CFG);
    const r = qa(["prod", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("prod");
    expect(r.stderr).toContain("name_pattern");
    expect(existsSync(marker)).toBe(false);
  });

  it("anchors name_pattern: an unanchored `qa_` never matches prod_qa_x", () => {
    writeConfig({ ...CFG, name_pattern: "qa_" });
    expect(qa(["prod_qa_x", "--", ...touch()]).status).toBe(3);
    expect(qa(["qa_x", "--", ...touch()]).status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(qa(["qa_", "--", ...touch()]).status).toBe(0);
  });

  it("says the match is whole-name when the pattern only matches a part of the db", () => {
    writeConfig({ ...CFG, name_pattern: "^qa_" });
    const r = qa(["qa_x", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/must match the WHOLE name/);
    writeConfig({ ...CFG, name_pattern: "^qa_" });
    expect(qa(["prod", "--", ...touch()]).stderr).not.toMatch(/WHOLE name/);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a trailing newline even when the pattern ends in $", () => {
    writeConfig(CFG);
    expect(qa(["qa_x\n", "--", ...touch()]).status).toBe(3);
    expect(existsSync(marker)).toBe(false);
  });

  it("anchors an alternation that merely starts with ^ and ends with $", () => {
    writeConfig({ ...CFG, name_pattern: "^qa_|_scratch$" });
    expect(qa(["qa_prod_users", "--", ...touch()]).status).toBe(3);
    expect(qa(["prod_scratch", "--", ...touch()]).status).toBe(3);
    expect(existsSync(marker)).toBe(false);
  });

  it("matches the whole name, newlines included", () => {
    writeConfig({ ...CFG, name_pattern: "qa_[a-z]+" });
    expect(qa(["qa_ok\nprod", "--", ...touch()]).status).toBe(3);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a template that lacks {db}, naming the var", () => {
    writeConfig({ ...CFG, vars: { OK_URL: "pg://h/{db}", REAL_DB_URL: "postgres://localhost/prod" } });
    const r = qa(["qa_x", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("REAL_DB_URL");
    expect(r.stderr).not.toContain("OK_URL");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a missing config, naming the expected path", () => {
    const r = qa(["qa_x", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(join(dir, ".octobots", "qa-env.json"));
    expect(existsSync(marker)).toBe(false);
  });

  it("names the --config path when that one is missing", () => {
    const r = qa(["qa_x", "--config", "nope/qa.json", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(join(dir, "nope", "qa.json"));
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a non-object root", "[]"],
    ["vars not an object", { vars: [], name_pattern: "^qa_.*" }],
    ["vars missing", { name_pattern: "^qa_.*" }],
    ["name_pattern missing", { vars: { A: "{db}" } }],
    ["name_pattern empty", { vars: { A: "{db}" }, name_pattern: "" }],
    ["name_pattern an invalid regex", { vars: { A: "{db}" }, name_pattern: "(" }],
    ["a var value that is not a string", { vars: { A: 1 }, name_pattern: "^qa_.*" }],
    ["a var name that cannot be an env name", { vars: { "A=B": "{db}" }, name_pattern: ".*" }],
    ["probe not a string", { ...CFG, probe: 5 }],
    ["a name_pattern that only compiles once wrapped", { vars: { A: "{db}" }, name_pattern: "a)|(b" }],
  ])("exits 3 on %s", (_label, cfg) => {
    writeConfig(cfg);
    const r = qa(["qa_x", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("qa-env");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a config over 1 MiB", () => {
    writeConfig(JSON.stringify({ ...CFG, pad: "x".repeat(1024 * 1024 + 1) }));
    const r = qa(["qa_x", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/larger than/);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a directory in place of the config", () => {
    mkdirSync(join(dir, "cfgdir"));
    const r = qa(["qa_x", "--config", "cfgdir", "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a FIFO in place of the config instead of hanging", () => {
    const fifo = join(dir, "fifo.json");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const r = qa(["qa_x", "--config", fifo, "--", ...touch()]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/not a regular file/);
  });

  it("reads a config reached through a symlink to a regular file", () => {
    writeConfig(CFG, join(dir, "real.json"));
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    expect(qa(["qa_x", "--config", "link.json", "--", ...touch()]).status).toBe(0);
  });
});

describe("qa-env.mjs probe (exit 4, command not run)", () => {
  const probeOut = (s: string) => `node -e 'process.stdout.write(${JSON.stringify(s)})'`;

  it("exits 4 when the probe's trimmed stdout differs from the db", () => {
    writeConfig({ ...CFG, probe: probeOut("other_db\n") });
    const r = qa(["qa_x", "--", ...touch()]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("qa_x");
    expect(r.stderr).toContain("other_db");
    expect(existsSync(marker)).toBe(false);
  });

  it("passes when the trimmed stdout equals the db", () => {
    writeConfig({ ...CFG, probe: probeOut("  qa_x \n") });
    expect(qa(["qa_x", "--", ...touch()]).status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("runs the probe with the substituted vars, and a shell", () => {
    writeConfig({ ...CFG, probe: 'echo "${DATABASE_URL##*/}"' });
    expect(qa(["qa_x", "--", ...touch()]).status).toBe(0);
  });

  it("does not substitute {db} into the probe text", () => {
    writeConfig({ ...CFG, probe: "echo '{db}'" });
    expect(qa(["qa_x", "--", ...touch()]).status).toBe(4);
  });

  it("exits 4 when the probe itself fails", () => {
    writeConfig({ ...CFG, probe: "echo qa_x; exit 7" });
    const r = qa(["qa_x", "--", ...touch()]);
    expect(r.status).toBe(4);
    expect(existsSync(marker)).toBe(false);
  });

  it("exits 4 when the probe cannot start", () => {
    writeConfig({ ...CFG, probe: "definitely-not-a-command-qa-env" });
    expect(qa(["qa_x", "--", ...touch()]).status).toBe(4);
  });

  it("kills a hung probe at the timeout and exits 4", () => {
    writeConfig({ ...CFG, probe: "sleep 60" });
    const t0 = Date.now();
    const r = qa(["qa_x", "--", ...touch()], { QA_ENV_PROBE_TIMEOUT_MS: "400" });
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/timed out/);
    expect(existsSync(marker)).toBe(false);
  });

  it("kills the whole probe process group, so a grandchild holding stdout cannot hang the guard", () => {
    writeConfig({ ...CFG, probe: "(sleep 60; echo qa_x) & wait" });
    const t0 = Date.now();
    const r = qa(["qa_x", "--", ...touch()], { QA_ENV_PROBE_TIMEOUT_MS: "400" });
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.status).toBe(4);
  });

  it("kills the probe's process group and exits 128+n when interrupted during the probe", async () => {
    const pidFile = join(dir, "probe.pid");
    writeConfig({ ...CFG, probe: `echo $$ > ${JSON.stringify(pidFile)}; sleep 60; echo qa_x` });
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      rmSync(pidFile, { force: true });
      const child = spawn("node", [SCRIPT, "qa_x", "--", ...touch()], { cwd: dir, stdio: "ignore" });
      const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      child.kill(sig);
      expect(await exited).toBe(code);
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(-pid, 0)).toThrow(); // the probe's whole group is gone
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("exits 128+n, not by the default signal disposition, when interrupted right after the probe spawns", async () => {
    const pidFile = join(dir, "probe.pid");
    writeConfig({ ...CFG, probe: `echo $$ > ${JSON.stringify(pidFile)}; sleep 60; echo qa_x` });
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      rmSync(pidFile, { force: true });
      // QA_ENV_TEST_PAUSE_AFTER_SPAWN_MS (test-only) blocks the script for 1.5 s right after the probe spawns;
      // the signal lands inside that window, where a handler installed after the spawn would not exist yet.
      const child = spawn("node", [SCRIPT, "qa_x", "--", ...touch()], {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, QA_ENV_TEST_PAUSE_AFTER_SPAWN_MS: "1500" },
      });
      const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      child.kill(sig);
      expect(await exited).toBe(code);
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(-pid, 0)).toThrow();
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("defaults the probe timeout to 30 s (documented in the usage text)", () => {
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/30_000|30000/);
  });
});

describe("qa-env.mjs running the command", () => {
  it("exports every var with every {db} replaced, and prints the target db to stderr", () => {
    writeConfig({
      vars: { DATABASE_URL: "postgres://localhost/{db}", TWICE: "{db}-{db}", SYNC: "psycopg2://h/{db}?x={db}" },
      name_pattern: "^qa_[a-z0-9_]+$",
    });
    const r = qa(["qa_x1", "--", ...touch()]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("qa_x1");
    const env = ranEnv();
    expect(env.DATABASE_URL).toBe("postgres://localhost/qa_x1");
    expect(env.TWICE).toBe("qa_x1-qa_x1");
    expect(env.SYNC).toBe("psycopg2://h/qa_x1?x=qa_x1");
  });

  it("overrides an inherited var of the same name", () => {
    writeConfig(CFG);
    qa(["qa_x", "--", ...touch()], { DATABASE_URL: "postgres://prod/real" });
    expect(ranEnv().DATABASE_URL).toBe("postgres://localhost/qa_x");
  });

  it("refuses a config that declares no vars, so an inherited DATABASE_URL cannot slip through", () => {
    writeConfig({ vars: {}, name_pattern: "^qa_.*" });
    const r = qa(["qa_x", "--", ...touch()], { DATABASE_URL: "postgres://prod/real" });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/declares no variable/);
    expect(r.stderr).not.toContain("target database");
    expect(existsSync(marker)).toBe(false);
  });

  it("passes an undeclared inherited var through unchanged (documented: declare every DB var)", () => {
    writeConfig(CFG);
    expect(qa(["qa_x", "--", ...touch()], { OTHER_DB_URL: "postgres://prod/real" }).status).toBe(0);
    expect(ranEnv().OTHER_DB_URL).toBe("postgres://prod/real");
  });

  it("reads --config <path> and --config=<path>, before or after the db", () => {
    writeConfig({ ...CFG, vars: { FROM: "custom-{db}" } }, join(dir, "custom.json"));
    expect(qa(["--config", "custom.json", "qa_x", "--", ...touch()]).status).toBe(0);
    expect(ranEnv().FROM).toBe("custom-qa_x");
    rmSync(marker);
    expect(qa(["qa_y", "--config=custom.json", "--", ...touch()]).status).toBe(0);
    expect(ranEnv().FROM).toBe("custom-qa_y");
  });

  it("passes the command's exit code through", () => {
    writeConfig(CFG);
    expect(qa(["qa_x", "--", "node", "-e", "process.exit(42)"]).status).toBe(42);
  });

  it("passes argv through verbatim, with no shell", () => {
    writeConfig(CFG);
    const out = join(dir, "argv.json");
    const r = qa(["qa_x", "--", "node", "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`, "a b", "$HOME", "x;touch pwned", "--", "*"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["a b", "$HOME", "x;touch pwned", "--", "*"]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("is safe with a db full of shell metacharacters that the pattern allows", () => {
    writeConfig({ vars: { D: "{db}" }, name_pattern: ".*" });
    const evil = `qa_$(touch ${join(dir, "pwned")});\`touch ${join(dir, "pwned2")}\``;
    expect(qa([evil, "--", ...touch()]).status).toBe(0);
    expect(ranEnv().D).toBe(evil);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(existsSync(join(dir, "pwned2"))).toBe(false);
  });

  it("exits 127 with a message when the command does not exist", () => {
    writeConfig(CFG);
    const r = qa(["qa_x", "--", "definitely-not-a-command-qa-env"]);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("definitely-not-a-command-qa-env");
  });

  it("exits 128+n when the command dies from a signal", () => {
    writeConfig(CFG);
    expect(qa(["qa_x", "--", "node", "-e", "process.kill(process.pid, 'SIGTERM')"]).status).toBe(143);
    expect(qa(["qa_x", "--", "node", "-e", "process.kill(process.pid, 'SIGKILL')"]).status).toBe(137);
  });

  it("forwards SIGTERM and SIGINT to the command", async () => {
    writeConfig(CFG);
    for (const [sig, code] of [["SIGTERM", 7], ["SIGINT", 8]] as const) {
      const got = join(dir, `got-${sig}.txt`);
      const ready = join(dir, `ready-${sig}.txt`);
      const body =
        `const fs=require("fs");process.on(${JSON.stringify(sig)},()=>{fs.writeFileSync(${JSON.stringify(got)},"x");process.exit(${code})});` +
        `fs.writeFileSync(${JSON.stringify(ready)},"1");setInterval(()=>{},1000)`;
      const child = spawn("node", [SCRIPT, "qa_x", "--", "node", "-e", body], { cwd: dir, stdio: "ignore" });
      const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(ready)).toBe(true);
      child.kill(sig);
      expect(await exited).toBe(code);
      expect(existsSync(got)).toBe(true);
    }
  });
});
