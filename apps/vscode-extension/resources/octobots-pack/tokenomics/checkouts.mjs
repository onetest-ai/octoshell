// Where this project's Claude Code transcripts live: ONE rule for the tokenomics pack scripts.
//
// collect.mjs reads its population from here and verify.mjs cross-checks ccusage against the same
// population, so both import this module rather than each spelling the rule. (The extension's TS
// twin, packages/tokenomics/src/claude-source.ts, is an intentional dual held to collect.mjs by
// claude-source-parity.test.ts.) No side effects on import; it asks git and reads directories.
//
// A project is its MAIN checkout plus every worktree git registers for it. A session started inside
// a worktree has its own slug directory, so those are read too. Without git the path decides.
//
// Roots, in priority order (see README):
//   1. explicit: `--projects-dir DIR` or env OCTOBOTS_TOKENOMICS_PROJECTS_DIR
//   2. `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`
//   3. legacy repo-local `<main checkout>/.claude/projects` (read in ADDITION)
// Under each root only THIS project's slug directories belong to it: the main checkout's, its
// registered worktrees', and those of removed worktrees directly under `.worktrees/` or
// `.claude/worktrees/`. (See listSessions for the proof each needs.)
//
// Not named roots.mjs on purpose: an update keeps a locally changed roots.mjs, and scripts that need
// these exports must still load beside it.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** `--project-dir DIR`, else $CLAUDE_PROJECT_DIR, else cwd; resolved so a relative path or a trailing slash cannot change the slug. */
export function resolveProjectDir(argv, env = process.env, cwd = process.cwd()) {
  const i = argv.indexOf("--project-dir");
  return resolve(i !== -1 ? argv[i + 1] : (env.CLAUDE_PROJECT_DIR ?? cwd));
}

/** The environment without git's location variables: a hook exports GIT_DIR, and it outranks any cwd. */
export function gitFreeEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
}

function git(cwd, ...a) {
  try {
    return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, env: gitFreeEnv() });
  } catch {
    return null; // no git, not a repository, or the directory is gone
  }
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

const WT = /(?:^|\/)(?:\.claude\/worktrees|\.worktrees)(?:\/|$)/;

/** `<main>/.claude/worktrees/<name>` and `<main>/.worktrees/<name>` -> `<main>`, by path alone. */
function mainByPath(dir) {
  const m = dir.match(WT);
  return m && m.index > 0 ? dir.slice(0, m.index) : dir;
}

const commonDir = (dir) => {
  const out = git(dir, "rev-parse", "--git-common-dir");
  return out ? real(resolve(dir, out.trim())) : null;
};

/**
 * The project's checkouts: `{ mainDir, worktrees, sub }`. `mainDir` keeps the caller's spelling when
 * that is the same directory; `worktrees` holds the other registered checkouts. A workspace that is a
 * subdirectory (`sub`) of its repository stays that subdirectory, in every checkout.
 */
export function projectCheckouts(projectDir) {
  const byPath = mainByPath(projectDir);
  const out = git(projectDir, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir");
  const [top, gitDir, commonRel] = out ? out.split("\n") : [];
  if (!top || !gitDir || !commonRel) return { mainDir: byPath, worktrees: [], sub: "" };
  const here = real(projectDir);
  let sub = relative(real(top), here);
  const common = real(resolve(projectDir, commonRel));
  const list = (git(projectDir, "worktree", "list", "--porcelain") ?? "").split("\n")
    .filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
  let mainDir = projectDir;
  if (common === real(gitDir)) {
    // A plain folder under <main>/.worktrees/ (a removed worktree) still means <main>.
    const m = sub.match(WT);
    if (m) {
      const tail = sub.slice(m.index);
      mainDir = projectDir.endsWith(tail) ? projectDir.slice(0, -tail.length).replace(/\/$/, "") : join(top, sub.slice(0, m.index));
      sub = sub.slice(0, m.index);
    }
  } else if (list[0] && existsSync(join(list[0], ".git")) && commonDir(list[0]) === common) {
    const first = join(list[0], sub);
    mainDir = real(byPath) === real(first) ? byPath : first;
  } // else the main is bare (or a submodule's / --separate-git-dir's): there is no checkout to point at
  // A listed path may since hold some other repository: it counts when it is gone or still ours.
  const worktrees = list.slice(1).filter((w) => !existsSync(w) || commonDir(w) === common)
    .map((w) => join(w, sub)).filter((w) => real(w) !== real(mainDir));
  return { mainDir, worktrees, sub };
}

/** The main checkout alone (see projectCheckouts). */
export function mainCheckoutDir(projectDir) {
  return projectCheckouts(projectDir).mainDir;
}

/** Is `cwd` inside one of `dirs`, with no other repository's checkout in between? */
export function cwdInside(cwd, dirs) {
  for (const dir of dirs) {
    const d = real(dir), c = real(cwd);
    if (c !== d && !c.startsWith(d + sep)) continue;
    let p = c;
    while (p !== d && !existsSync(join(p, ".git"))) p = dirname(p);
    if (p === d) return true;
  }
  return false;
}

/**
 * Claude Code names a project's transcript dir by replacing every character that is not
 * [A-Za-z0-9] in the absolute path with "-" ("/", "_" and "." included: `applied_ai` is stored as
 * `applied-ai`).
 */
export function projectSlug(mainDir) {
  return mainDir.replace(/[^A-Za-z0-9]/g, "-");
}

/** The transcript roots, deduplicated, in priority order (module header). */
export function resolveRoots(mainDir, argv, env = process.env) {
  const i = argv.indexOf("--projects-dir");
  const explicit = (i !== -1 ? argv[i + 1] : null) || env.OCTOBOTS_TOKENOMICS_PROJECTS_DIR;
  const roots = explicit
    ? [explicit]
    : [join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")];
  roots.push(join(mainDir, ".claude", "projects")); // legacy snapshot, read in addition
  return [...new Set(roots)];
}

/** The first `cwd` a transcript records, or null. Reads only as far as it must. */
function firstCwd(file) {
  let fd;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(1 << 16);
    let parts = []; // the unfinished line, in chunks
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      const chunk = Buffer.from(buf.subarray(0, n));
      let at = 0;
      for (;;) {
        const nl = chunk.indexOf(10, at);
        if (nl === -1 && n > 0) break;
        const line = Buffer.concat([...parts, chunk.subarray(at, nl === -1 ? n : nl)]).toString("utf8");
        parts = [];
        if (line.includes('"cwd"')) {
          try {
            const d = JSON.parse(line);
            if (typeof d?.cwd === "string" && d.cwd) return d.cwd;
          } catch { /* not a whole record */ }
        }
        if (nl === -1) return null;
        at = nl + 1;
      }
      parts.push(chunk.subarray(at));
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const entries = (p) => { try { return readdirSync(p); } catch { return []; } };

/**
 * Every session transcript of the project: `{ root, dir, slug, sessionId, file, checkout }`, main
 * checkout first under each root; `checkout` is the directory whose reflog covers the session, or
 * null. Two paths can share a slug, so the directory a session records decides. A directory that is
 * gone can prove less: under the main slug it was the project before a rename, and directly under
 * .worktrees/ or .claude/worktrees/ it was a worktree.
 */
export function listSessions({ mainDir, worktrees, sub, slug, roots }) {
  const same = (a, b) => a === b || real(a) === real(b);
  const bySlug = new Map();
  for (const w of worktrees) {
    const k = projectSlug(w);
    if (k !== slug) bySlug.set(k, [...(bySlug.get(k) ?? []), w]);
  }
  const top = sub ? resolve(mainDir, relative(sub, "")) : mainDir;
  const parents = [...new Set([top, real(top)].flatMap((t) => [join(t, ".worktrees"), join(t, ".claude", "worktrees")]))];
  const out = [];
  for (const root of roots) {
    const add = (name, accept) => {
      const dir = join(root, name);
      for (const e of entries(dir)) {
        if (!e.endsWith(".jsonl")) continue;
        const file = join(dir, e);
        const checkout = accept(firstCwd(file));
        if (checkout !== undefined) out.push({ root, dir, slug: name, sessionId: e.slice(0, -6), file, checkout });
      }
    };
    if (!isDir(root)) continue;
    add(slug, (cwd) => (cwd !== null && projectSlug(cwd) === slug && existsSync(cwd) && !same(cwd, mainDir) ? undefined : mainDir));
    // A session that moved into a worktree still records the main checkout first.
    for (const [k, dirs] of bySlug) {
      add(k, (cwd) => (cwd === null ? undefined : dirs.find((d) => same(d, cwd)) ?? (same(cwd, mainDir) ? dirs[0] : undefined)));
    }
    for (const name of entries(root)) {
      if (name === slug || bySlug.has(name) || !parents.some((p) => name.startsWith(`${projectSlug(p)}-`))) continue;
      add(name, (cwd) => {
        if (cwd === null || projectSlug(cwd) !== name || (sub && !cwd.endsWith(`/${sub}`))) return undefined;
        const wt = sub ? cwd.slice(0, -sub.length - 1) : cwd;
        return parents.includes(dirname(wt)) && !existsSync(wt) ? null : undefined;
      });
    }
  }
  return out;
}

/** Everything a script needs to locate this project's transcripts, from its own argv. */
export function locateTranscripts(argv, env = process.env, cwd = process.cwd()) {
  const projectDir = resolveProjectDir(argv, env, cwd);
  const { mainDir, worktrees, sub } = projectCheckouts(projectDir);
  return { projectDir, mainDir, worktrees, sub, slug: projectSlug(mainDir), roots: resolveRoots(mainDir, argv, env) };
}
