#!/usr/bin/env node
// qa-env.mjs: run a command against a QA database, never a real one. Config-driven and
// dependency-free, so it works on any project, not only one database layout.
//
//   node qa-env.mjs [--config <path>] <db> -- <cmd> [args...]
//
// The config (default `.octobots/qa-env.json` in the current directory) is JSON:
//
//   { "vars": { "<ENV_NAME>": "<template containing {db}>", ... },
//     "name_pattern": "<regex>",
//     "probe": "<optional shell command>" }
//
// See qa-env.example.json next to this file. What it does, in order:
//   1. exit 2 on a usage error (no `--`, no <db>, no <cmd>, an unknown option);
//   2. exit 3, naming the expected path, when the config is missing or unreadable; exit 3 when it
//      is malformed (bad JSON, `vars` not an object, `name_pattern` missing or not a regex, a value
//      that is not a string, a name that cannot be an environment variable, a non-string `probe`);
//   3. exit 3 when <db> does not match `name_pattern`;
//   4. exit 3, naming the variable, when any `vars` template lacks `{db}`;
//   5. export every var with every `{db}` replaced by <db>;
//   6. when `probe` is set, run it as a shell command with those vars in its environment; exit 4
//      unless its trimmed stdout equals <db> (also on a non-zero exit, a launch failure, or a
//      timeout: a hung probe is killed after 30 s, process group included; the override
//      QA_ENV_PROBE_TIMEOUT_MS exists for tests). The probe text is NOT templated: it reads the db
//      through the exported vars, e.g. `psql -tAc 'select current_database()'` using DATABASE_URL;
//   7. print `qa-env: target database = <db>` to stderr, run <cmd> with the inherited stdio, and
//      exit with its exit code (128+n when it dies from signal n; 127 / 126 when it cannot start).
//      SIGINT and SIGTERM sent to this process are forwarded to <cmd>.
// The command is spawned directly, with no shell, so its argv is passed verbatim and a <db> full
// of shell metacharacters stays inert (the probe is a shell command by contract, but never sees
// <db> spliced into its text, only in the environment).
//
// Safety decisions:
//   * `name_pattern` is ALWAYS anchored: it is compiled as `^(?:<pattern>)$`, so the whole name
//     must match. The pattern is first compiled on its own, so one that only works wrapped
//     (`a)|(b`) is rejected. An unanchored `qa_` therefore never matches `prod_qa_x`, and an
//     alternation like `^qa_|_scratch$` cannot match a prefix or suffix alone. An unanchored
//     match would be a bypass of the guard.
//   * The config is read only when it is a regular file of at most 1 MiB: opened non-blocking and
//     checked with fstat on that descriptor (the hardened reader the other pack scripts use), so a
//     FIFO, a directory or /dev/zero cannot hang or flood the guard. A symlink to a regular file
//     is followed on purpose (a repo may keep one shared config); the target is still checked.
import { spawn } from "node:child_process";
import { closeSync, constants as fsc, fstatSync, openSync, readFileSync } from "node:fs";
import { constants as osc } from "node:os";
import { resolve } from "node:path";

const DEFAULT_CONFIG = ".octobots/qa-env.json";
const MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USAGE = "usage: qa-env.mjs [--config <path>] <db> -- <cmd> [args...]";

const fail = (code, msg) => {
  process.stderr.write(`qa-env: ${msg}\n`);
  process.exit(code);
};

function parseArgs(argv) {
  const dd = argv.indexOf("--");
  if (dd === -1) fail(2, `missing \`--\` before the command\n${USAGE}`);
  const head = argv.slice(0, dd);
  const cmd = argv.slice(dd + 1);
  let config = DEFAULT_CONFIG;
  let db;
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--config") {
      if (i + 1 >= head.length) fail(2, `--config needs a path\n${USAGE}`);
      config = head[++i];
    } else if (a.startsWith("--config=")) {
      config = a.slice("--config=".length);
    } else if (a.startsWith("-") && a !== "-") {
      fail(2, `unknown option ${a}\n${USAGE}`);
    } else if (db === undefined) {
      db = a;
    } else {
      fail(2, `unexpected extra argument ${JSON.stringify(a)}\n${USAGE}`);
    }
  }
  if (db === undefined || db === "") fail(2, `missing <db>\n${USAGE}`);
  if (cmd.length === 0 || cmd[0] === "") fail(2, `missing <cmd> after \`--\`\n${USAGE}`);
  return { config, db, cmd };
}

/** The config's text, read only when it is a regular file of at most 1 MiB; throws otherwise. */
function readConfigText(file) {
  const fd = openSync(file, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_CONFIG_BYTES) throw new Error(`larger than ${MAX_CONFIG_BYTES} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function loadConfig(path) {
  const file = resolve(process.cwd(), path);
  let text;
  try {
    text = readConfigText(file);
  } catch (e) {
    if (e && e.code === "ENOENT") fail(3, `config not found: expected ${file}`);
    fail(3, `cannot read config ${file}: ${e && e.message ? e.message : e}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    fail(3, `malformed config ${file}: ${e.message}`);
  }
  const bad = (why) => fail(3, `malformed config ${file}: ${why}`);
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) bad("the root must be an object");
  const { vars, name_pattern: pattern, probe } = cfg;
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) bad("`vars` must be an object of NAME: template");
  for (const [name, tpl] of Object.entries(vars)) {
    if (!ENV_NAME.test(name)) bad(`var name ${JSON.stringify(name)} is not a valid environment variable name`);
    if (typeof tpl !== "string") bad(`var ${name} must be a string template`);
  }
  if (typeof pattern !== "string" || pattern === "") bad("`name_pattern` must be a non-empty regex string");
  let re;
  try {
    new RegExp(pattern); // on its own first: a pattern that only compiles once wrapped is an injection
    re = new RegExp(`^(?:${pattern})$`);
  } catch (e) {
    bad(`name_pattern is not a valid regex: ${e.message}`);
  }
  if (probe !== undefined && (typeof probe !== "string" || probe.trim() === "")) bad("`probe` must be a non-empty shell command string");
  return { vars, re, pattern, probe, file };
}

/** Runs the probe through a shell; resolves {ok, stdout, why}. A hung probe is killed with its group. */
function runProbe(probe, env) {
  const timeoutMs = Number(process.env.QA_ENV_PROBE_TIMEOUT_MS) > 0 ? Number(process.env.QA_ENV_PROBE_TIMEOUT_MS) : DEFAULT_PROBE_TIMEOUT_MS;
  return new Promise((done) => {
    const posix = process.platform !== "win32";
    const child = spawn(probe, { shell: true, env, detached: posix, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    let finished = false;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(r);
    };
    const kill = () => {
      try {
        if (posix) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, why: `probe timed out after ${timeoutMs} ms and was killed` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      if (out.length < MAX_CONFIG_BYTES) out += d;
    });
    child.on("error", (e) => finish({ ok: false, why: `probe could not start: ${e.message}` }));
    child.on("close", (code, signal) => {
      kill(); // reap a backgrounded grandchild that outlived the shell
      if (code !== 0) finish({ ok: false, why: `probe exited ${code === null ? `by ${signal}` : code}` });
      else finish({ ok: true, stdout: out.trim() });
    });
  });
}

function runCommand(cmd, env, db) {
  process.stderr.write(`qa-env: target database = ${db}\n`);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    });
  }
  child.on("error", (e) => {
    const code = e.code === "EACCES" ? 126 : 127;
    fail(code, `cannot run ${JSON.stringify(cmd[0])}: ${e.message}`);
  });
  child.on("close", (code, signal) => {
    if (signal) process.exit(128 + (osc.signals[signal] ?? 0));
    process.exit(code ?? 1);
  });
}

async function main() {
  const { config, db, cmd } = parseArgs(process.argv.slice(2));
  const { vars, re, pattern, probe, file } = loadConfig(config);
  if (!re.test(db)) fail(3, `refusing ${JSON.stringify(db)}: it does not match name_pattern ${JSON.stringify(pattern)} (anchored, whole name) in ${file}`);
  for (const [name, tpl] of Object.entries(vars)) {
    if (!tpl.includes("{db}")) fail(3, `var ${name} template ${JSON.stringify(tpl)} lacks {db}, so it could point at a real database (${file})`);
  }
  const env = { ...process.env };
  for (const [name, tpl] of Object.entries(vars)) env[name] = tpl.split("{db}").join(db);
  if (probe !== undefined) {
    const r = await runProbe(probe, env);
    if (!r.ok) fail(4, `probe failed for ${JSON.stringify(db)}: ${r.why}`);
    if (r.stdout !== db) fail(4, `probe reports database ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(db)}; not running the command`);
  }
  runCommand(cmd, env, db);
}

await main();
