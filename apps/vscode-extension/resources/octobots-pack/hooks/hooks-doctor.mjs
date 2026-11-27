#!/usr/bin/env node
// Read-only hook doctor: are this repo's Claude Code hooks and git commit hooks wired the way the pack
// expects? It NEVER writes .claude/settings.json or the repo's hooks directory; it prints what is
// missing, who owns the fix, and the exact command or file text, and the person runs it.
//
//   node .octobots/hooks/hooks-doctor.mjs [--root <dir>] [--settings <file>] [--override <file>] [--no-git]
//
// (a) .claude/settings.json, by script path. The default required list is octoshell's own four entries
//     (required-hooks.json next to this script, derived from the installer's own list). A repo adds the
//     entries of other installers in .agents/settings/required-hooks.json: add-only, same schema
//     (version, installers, hooks), keyed by event + script + arg. Entries match by script path (and,
//     for a shared launcher, its first positional argument), never by the command string or a checkout
//     path, and, when an entry names a matcher, by that matcher.
// (b) the git side: core.hooksPath is set, and the two shims (prepare-commit-msg, commit-msg) exist
//     there, hold the pack's shim text (trailing whitespace aside), and are executable both on disk and,
//     when tracked, in the git index. A repo commits the shims once; the pack never writes them.
//
// Exit: 0 all wired, 1 something missing, 2 a settings or list file is unreadable.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_SCRIPT = ".octobots/hooks/prepare-commit-msg.mjs";

/**
 * The shim texts packs v59-v63 printed, verbatim. A repo that committed one still works; the doctor
 * reports it as older and prints the current text instead of calling it a problem.
 */
export const LEGACY_SHIMS = {
  "prepare-commit-msg": [
    [
      "#!/bin/sh",
      "# Attribution is advisory: a missing runtime or pack script must not block Git.",
      'command -v node >/dev/null || { echo "prepare-commit-msg: warning: node not found, no mission trailer added" >&2; exit 0; }',
      `helper="$(git rev-parse --show-toplevel)/${PACK_SCRIPT}"`,
      '[ -f "$helper" ] || { echo "prepare-commit-msg: warning: $helper not found, no mission trailer added" >&2; exit 0; }',
      'node "$helper" "$@"',
      "exit 0",
      "",
    ].join("\n"),
  ],
  "commit-msg": [
    [
      "#!/bin/sh",
      "# Adds the mission trailer that prepare-commit-msg deferred until the editor closed. Advisory: never blocks.",
      "command -v node >/dev/null || exit 0",
      `helper="$(git rev-parse --show-toplevel)/${PACK_SCRIPT}"`,
      '[ -f "$helper" ] || exit 0',
      'node "$helper" --after-edit "$@"',
      "exit 0",
      "",
    ].join("\n"),
  ],
};

/**
 * The two shims a repo commits at <core.hooksPath>/, mode 100755. Guarded like solo's M2 shims:
 * attribution is advisory, so a missing node or a missing pack script (a fresh worktree, or a repo that
 * commits the shim before the pack reaches it) prints one warning line and exits 0, never a stack trace.
 */
export const SHIMS = {
  "prepare-commit-msg": [
    "#!/bin/sh",
    "# Attribution is advisory: a missing runtime or pack script must not block Git.",
    'command -v node >/dev/null || { echo "prepare-commit-msg: warning: node not found, no mission trailer added" >&2; exit 0; }',
    'root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0',
    `helper="$root/${PACK_SCRIPT}"`,
    '[ -f "$helper" ] || { echo "prepare-commit-msg: warning: $helper not found, no mission trailer added" >&2; exit 0; }',
    'out="$(node "$helper" "$@" 2>&1 >/dev/null)" || { echo "prepare-commit-msg: warning: $helper failed, no mission trailer added" >&2; exit 0; }',
    '[ -z "$out" ] || printf \'%s\\n\' "$out" >&2',
    "exit 0",
    "",
  ].join("\n"),
  "commit-msg": [
    "#!/bin/sh",
    "# Adds the mission trailer that prepare-commit-msg deferred until the editor closed. Advisory: never blocks.",
    "command -v node >/dev/null || exit 0",
    'root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0',
    `helper="$root/${PACK_SCRIPT}"`,
    '[ -f "$helper" ] || exit 0',
    'out="$(node "$helper" --after-edit "$@" 2>&1 >/dev/null)" || exit 0',
    '[ -z "$out" ] || printf \'%s\\n\' "$out" >&2',
    "exit 0",
    "",
  ].join("\n"),
};

/** Shell-style split: whitespace separates, '...' and "..." group, backslash escapes outside single quotes. */
export function tokenize(cmd) {
  const out = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

// A token is the script when it equals the path or ends with it on a "/" boundary. Trust limit: only that
// path suffix is compared, so a registered copy in another checkout counts as wired.
const isScript = (tok, script) => tok === script || tok.endsWith("/" + script);
const keyOf = (h) => `${h.event}|${h.script}|${h.arg ?? ""}`;

/** Structural problems with the part of settings.json the doctor reads, as printable lines. */
export function settingsProblems(settings, events) {
  const out = [];
  const hooks = settings?.hooks;
  if (hooks !== undefined && (hooks === null || typeof hooks !== "object" || Array.isArray(hooks))) {
    return ["hooks is not an object"];
  }
  for (const event of events) {
    const entries = hooks?.[event];
    if (entries !== undefined && !Array.isArray(entries)) out.push(`${event} is not an array of entries`);
  }
  return out;
}

function wired(settings, { event, script, arg, sync, matcher }) {
  const hooks = settings?.hooks;
  const entries = hooks && typeof hooks === "object" ? hooks[event] : undefined;
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (e) =>
      (matcher === undefined || e?.matcher === matcher) &&
      (Array.isArray(e?.hooks) ? e.hooks : []).some((h) => {
        const toks = tokenize(String(h?.command ?? ""));
        const i = toks.findIndex((t) => isScript(t, script));
        if (i < 0) return false;
        // A shared launcher runs its FIRST positional argument as the verb.
        return (!arg || toks[i + 1] === arg) && (!sync || h?.async !== true);
      }),
  );
}

/** Pure check. Returns the required hooks that settings does not wire, each joined to its installer. */
export function checkHooks(list, settings) {
  return list.hooks
    .filter((h) => !wired(settings, h))
    .map((h) => ({ ...h, installer: list.installers[h.installer ?? h.owner] ?? { command: `(no installer declared for owner "${h.owner}")` } }));
}

/** The default list plus a repo's override: add-only, keyed by event + script + arg; the default wins a clash. */
export function mergeLists(base, extra) {
  const keys = new Set(base.hooks.map(keyOf));
  return {
    installers: { ...(extra?.installers ?? {}), ...base.installers },
    hooks: [...base.hooks, ...(extra?.hooks ?? []).filter((h) => !keys.has(keyOf(h)))],
    pendingUpstream: extra?.pendingUpstream ?? [],
  };
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: err.message };
  }
}

const gitOut = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

// A linked worktree has no gitignored .claude/settings.json; the live one is in the main checkout.
function defaultSettingsPath(root) {
  const own = join(root, ".claude", "settings.json");
  if (existsSync(own)) return own;
  const common = gitOut(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common ? join(dirname(common), ".claude", "settings.json") : own;
}

function printShims(dirRel, names) {
  for (const name of names) {
    console.log(`           ${dirRel}/${name} (commit it with mode 100755: git add --chmod=+x ${dirRel}/${name}):`);
    console.log(`--- ${dirRel}/${name} ---`);
    console.log(SHIMS[name].trimEnd());
    console.log("--- end ---");
  }
}

// Trailing whitespace does not change what a shim runs. A carriage return does: the kernel reads it as part
// of the interpreter's name.
const normalShim = (text) => text.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").trimEnd();
const differsFromShim = (text, name) => text.includes("\r") || normalShim(text) !== normalShim(SHIMS[name]);

const isLegacyShim = (text, name) => !text.includes("\r") && LEGACY_SHIMS[name].some((l) => normalShim(l) === normalShim(text));

/** The git side. Returns the number of problems found; prints each with its fix. */
function checkGit(root) {
  const top = gitOut(root, "rev-parse", "--show-toplevel") ?? root;
  let problems = 0;
  const bad = (msg) => {
    problems++;
    console.log(`  MISSING  git          ${msg}`);
  };
  const hp = gitOut(root, "config", "--get", "core.hooksPath");
  if (!hp) {
    bad("core.hooksPath is not set");
    console.log("           fix: git config core.hooksPath .githooks");
    console.log("           then commit these shims in that directory:");
    printShims(".githooks", Object.keys(SHIMS));
    return problems;
  }
  const dir = isAbsolute(hp) ? hp : join(top, hp);
  const dirRel = isAbsolute(hp) ? hp : hp.replace(/\/+$/, "");
  // Git refuses a path that goes through a symlink, such as a symlinked absolute hooksPath.
  let realDir = dir;
  try {
    realDir = realpathSync(dir);
  } catch {
    /* A hooks directory that does not exist is reported shim by shim. */
  }
  const missingShims = [];
  for (const name of Object.keys(SHIMS)) {
    const file = join(dir, name);
    if (!existsSync(file)) {
      bad(`shim ${dirRel}/${name} is missing`);
      missingShims.push(name);
      continue;
    }
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      bad(`shim ${dirRel}/${name} cannot be read (${err.code})`);
      missingShims.push(name);
      continue;
    }
    // An older pack shim still works, so it is a note, not a problem; the mode checks below still apply to it.
    const legacy = isLegacyShim(text, name);
    if (legacy) {
      console.log(`  update   git          ${dirRel}/${name} is an older pack shim; replace it with:`);
      printShims(dirRel, [name]);
    }
    if (!text.includes(PACK_SCRIPT)) {
      bad(`shim ${dirRel}/${name} does not run ${PACK_SCRIPT}`);
      missingShims.push(name);
    } else if (text.includes("--after-edit") !== (name === "commit-msg")) {
      // The two shims share one script; the entry point is the --after-edit flag (commit-msg only).
      bad(`shim ${dirRel}/${name} ${name === "commit-msg" ? "does not pass" : "must not pass"} --after-edit to ${PACK_SCRIPT}`);
      missingShims.push(name);
    } else if (!legacy && differsFromShim(text, name)) {
      bad(`shim ${dirRel}/${name} differs from the pack shim`);
      missingShims.push(name);
    } else if ((statSync(file).mode & 0o111) === 0) {
      bad(`shim ${dirRel}/${name} is not executable`);
      console.log(`           fix: git add --chmod=+x ${dirRel}/${name} && chmod +x ${dirRel}/${name}`);
    } else if (gitOut(top, "ls-files", "-s", "--", join(realDir, name))?.startsWith("100644 ")) {
      // An executable working copy hides it here; every fresh clone gets a shim git will not run.
      const fixPath = realDir === dir ? `${dirRel}/${name}` : join(realDir, name);
      bad(`shim ${dirRel}/${name} is committed without the executable bit`);
      console.log(`           fix: git add --chmod=+x ${fixPath} && chmod +x ${fixPath}`);
    } else console.log(`  ok       git          ${dirRel}/${name}`);
  }
  if (missingShims.length) {
    console.log(`           fix: git config core.hooksPath ${dirRel}   (already set; the shims below go there)`);
    printShims(dirRel, missingShims);
  }
  if (!existsSync(join(top, PACK_SCRIPT))) {
    bad(`${PACK_SCRIPT} is not installed (the shims would do nothing)`);
    console.log('           fix: VS Code command palette: "Octobots: Install Octobots Pack" (current Octobots extension)');
  }
  return problems;
}

function main(argv) {
  const val = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };
  const root = resolve(val("--root") ?? gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd());
  const settingsPath = resolve(val("--settings") ?? defaultSettingsPath(root));
  const overridePath = resolve(val("--override") ?? join(root, ".agents", "settings", "required-hooks.json"));

  const base = readJson(join(HERE, "required-hooks.json"));
  if (base.error) {
    console.error(`hooks-doctor: the default list ${join(HERE, "required-hooks.json")} is unreadable: ${base.error}`);
    return 2;
  }
  let extra = null;
  if (existsSync(overridePath)) {
    const o = readJson(overridePath);
    if (o.error) {
      console.error(`hooks-doctor: the repo list ${overridePath} is unreadable: ${o.error}`);
      return 2;
    }
    extra = o.value;
  }
  const list = mergeLists(base.value, extra);

  let settings = {};
  if (existsSync(settingsPath)) {
    const s = readJson(settingsPath);
    if (s.error) {
      console.log(`hooks-doctor: ${settingsPath} is not valid JSON (${s.error}); nothing could be checked. Fix it by hand.`);
      return 2;
    }
    settings = s.value;
  }

  console.log(`hooks-doctor: ${settingsPath}${existsSync(settingsPath) ? "" : " (file does not exist)"}`);
  let problems = 0;
  for (const p of settingsProblems(settings, new Set(list.hooks.map((h) => h.event)))) {
    problems++;
    console.log(`  MALFORMED  ${p}; fix .claude/settings.json by hand`);
  }
  const missing = checkHooks(list, settings);
  const missingKeys = new Set(missing.map(keyOf));
  const label = (h) => `${h.script}${h.arg ? " " + h.arg : ""}${h.matcher ? ` [${h.matcher}]` : ""}${h.sync ? " (sync required)" : ""}`;
  for (const h of list.hooks) if (!missingKeys.has(keyOf(h))) console.log(`  ok       ${h.event.padEnd(13)} ${label(h)}`);
  for (const m of missing) {
    console.log(`  MISSING  ${m.event.padEnd(13)} ${label(m)}  (owner: ${m.owner}, ${m.installer.source ?? ""})`);
    console.log(`           fix: ${m.installer.command}`);
  }
  problems += missing.length;
  // An entry can be registered before its payload has reached this checkout.
  for (const h of list.hooks) {
    if (h.payload && !existsSync(join(root, h.payload))) console.log(`  absent   ${h.payload}: script not present: ${h.payloadHint ?? "install its owner first"}`);
  }
  for (const p of list.pendingUpstream) console.log(`  pending  ${p.task} (${p.owner}): ${p.what}; add to the list when it ships`);

  if (!argv.includes("--no-git")) problems += checkGit(root);
  console.log(problems ? `hooks-doctor: ${problems} problem(s)` : `hooks-doctor: ok (${list.hooks.length} hooks wired, git shims in place)`);
  return problems ? 1 : 0;
}

// realpath on both sides: a symlinked temp dir (macOS /var -> /private/var) would otherwise never match.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
