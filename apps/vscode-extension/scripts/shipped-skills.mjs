#!/usr/bin/env node
// Builds and verifies `resources/shipped-skills.json.br`: the store of every SKILL.md the Octobots
// pack has shipped. Pack updates (M7) classify a workspace's skill against it, recover the base of
// a three-way merge from it, and recognise a reconciled file by the hash it names.
//
// The store is ONE brotli-compressed JSON:
//
//   { versions: { "<N>": { "<skill>": ["<sha256>", ...] } },   // builds at pack version N, oldest first
//     order:    ["<sha256>", ...],                               // every body, oldest first
//     bodies:   { "<sha256>": "<SKILL.md text>" } }
//
// - The key is the sha256 of the body with CRLF normalised to LF, so a Windows checkout of the same
//   file hashes the same. Bodies are stored LF-normalised.
// - A pack version can have SEVERAL bodies per skill: M2 changed two SKILL.md bodies after the first
//   v57 build. `versions[N][skill][0]` is the EARLIEST build at N (base-recovery rule 3 reads it),
//   so the list order is load-bearing; it is commit order and is only ever appended to.
// - Versions that never shipped (22, 26, 31, 41) simply have no entry, and neither do 38-40, 52 and 53:
//   those bumps exist only on branches that were squash-merged or abandoned (never reachable from
//   main, never released), so a workspace on one of them reads as `unknown-version`.
//
// Modes:
//   --write   appends what is missing: first from the git history of the pack's SKILL.md files
//             (only commits reachable from HEAD), then from the current files. The ONLY mode that
//             reads git. Append-only, and writes nothing when there is nothing to add, so running
//             it on an unchanged tree changes no byte.
//   --verify  (default) reads NO git. Exits 1, naming the file, when a current pack SKILL.md is not
//             indexed under OCTOBOTS_PACK_VERSION, a stored body's sha256 differs from its key, or
//             an indexed entry has no body.
//
// Every change to a pack SKILL.md is followed by `--write`, with the store committed in the same PR.
// `--verify` runs in this package's `build` script, so a forgotten `--write` fails the build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(HERE, "..");
const SKILL_SRC = join(EXT_ROOT, "src", "host", "octobots-skill.ts");
const DEFAULT_PACK_SKILLS = join(EXT_ROOT, "resources", "octobots-pack", "skill");

/**
 * `SHIPPED_SKILLS_STORE_PATH` and `SHIPPED_SKILLS_PACK_DIR` exist for tests only: the failure
 * branches (unindexed file, tampered body) can only be reached by putting the inputs in those
 * states, and doing that to the real files would race every other test that reads them. The build
 * never sets them; if one is set in a shell the check runs against that path and fails loudly.
 * The pack dir override moves only the CURRENT files; the git history read always uses the real one.
 */
export const STORE_PATH =
  process.env.SHIPPED_SKILLS_STORE_PATH ?? join(EXT_ROOT, "resources", "shipped-skills.json.br");
export const PACK_SKILLS_DIR = process.env.SHIPPED_SKILLS_PACK_DIR ?? DEFAULT_PACK_SKILLS;

/** Reads OCTOBOTS_PACK_VERSION out of octobots-skill.ts by regex; bare node cannot import the .ts. */
export function readPackVersionFromSource(text = readFileSync(SKILL_SRC, "utf8")) {
  const m = text.match(/OCTOBOTS_PACK_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error(`could not find OCTOBOTS_PACK_VERSION in ${SKILL_SRC}`);
  return Number(m[1]);
}

/** sha256 of a SKILL.md body with CRLF normalised to LF. */
export function bodyHash(text) {
  return createHash("sha256").update(normalise(text)).digest("hex");
}

const normalise = (text) => text.replace(/\r\n/g, "\n");

/**
 * The integer in the first `version:` line of the frontmatter, or null. Frontmatter only: a
 * `version:` line further down the body is prose.
 */
export function frontmatterVersion(text) {
  const m = normalise(text).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return null;
  const v = m[1].match(/^version:[ \t]*(\d+)[ \t]*$/m);
  return v ? Number(v[1]) : null;
}

export function emptyStore() {
  return { versions: {}, order: [], bodies: {} };
}

export function decodeStore(bytes) {
  const store = JSON.parse(brotliDecompressSync(bytes).toString("utf8"));
  if (!store || typeof store !== "object" || !store.versions || !Array.isArray(store.order) || !store.bodies) {
    throw new Error("not a shipped-skills store: expected {versions, order, bodies}");
  }
  return store;
}

/**
 * Deterministic: the same JSON always compresses to the same bytes. A large window (2^24) because
 * the bodies are mostly near-copies of each other, further apart than the default 4 MB window.
 */
export function encodeStore(store) {
  const json = Buffer.from(JSON.stringify(store), "utf8");
  return brotliCompressSync(json, {
    params: {
      [zc.BROTLI_PARAM_QUALITY]: 11,
      [zc.BROTLI_PARAM_LGWIN]: 24,
      [zc.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });
}

/**
 * Appends one shipped body. Returns true when the store changed. An already-stored body is never
 * touched; it only gains an index entry if (version, skill) did not list it yet.
 */
export function addBody(store, version, skill, text) {
  const body = normalise(text);
  const hash = createHash("sha256").update(body).digest("hex");
  let changed = false;
  if (!(hash in store.bodies)) {
    store.bodies[hash] = body;
    store.order.push(hash);
    changed = true;
  }
  const perSkill = (store.versions[String(version)] ??= {});
  const list = (perSkill[skill] ??= []);
  if (!list.includes(hash)) {
    list.push(hash);
    changed = true;
  }
  return changed;
}

function git(args, cwd, opts = {}) {
  return execFileSync("git", args, { cwd, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/**
 * Every (commit, skill, text) for the pack's SKILL.md files, oldest first, over commits reachable
 * from HEAD. `-m` shows a merge against each parent, so a body that exists only in a conflict
 * resolution is still seen; repeats are harmless because bodies dedupe by hash. `--no-renames`
 * makes the `octobots` -> `mission-planner` rename an add plus a delete, so both skill names are
 * read. Deleted files are skipped: their last body is already in the store.
 */
function* historicalBodies() {
  const top = git(["rev-parse", "--show-toplevel"], EXT_ROOT).toString().trim();
  const packRel = relative(top, DEFAULT_PACK_SKILLS).split("\\").join("/");
  const log = git(
    ["log", "-m", "--reverse", "--topo-order", "--no-renames", "--name-status", "--format=%x00%H", "HEAD", "--", `${packRel}/*/SKILL.md`],
    top,
  ).toString("utf8");
  const versionAtCommit = new Map();
  const packVersionAt = (commit) => {
    if (versionAtCommit.has(commit)) return versionAtCommit.get(commit);
    let v = null;
    try {
      const srcRel = relative(top, SKILL_SRC).split("\\").join("/");
      const m = git(["show", `${commit}:${srcRel}`], top).toString("utf8").match(/OCTOBOTS_PACK_VERSION\s*=\s*(\d+)/);
      v = m ? Number(m[1]) : null;
    } catch {
      v = null;
    }
    versionAtCommit.set(commit, v);
    return v;
  };
  for (const block of log.split("\0").slice(1)) {
    const [commit, ...lines] = block.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const [status, path] = line.split("\t");
      if (!path || status.startsWith("D")) continue;
      const skill = path.split("/").at(-2);
      const buf = git(["cat-file", "blob", `${commit}:${path}`], top);
      const text = buf.toString("utf8");
      if (Buffer.compare(Buffer.from(text, "utf8"), buf) !== 0) {
        throw new Error(`${path} at ${commit} is not valid UTF-8`);
      }
      // The body's own `version:` line is what detection looks a file up by; the pack constant at
      // that commit is the fallback for a body without one.
      const version = frontmatterVersion(text) ?? packVersionAt(commit);
      if (version === null) throw new Error(`cannot tell the pack version of ${path} at ${commit}`);
      yield { commit, skill, version, text };
    }
  }
}

/** The current pack SKILL.md files: [{skill, file, text}]. */
export function currentSkills(dir = PACK_SKILLS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => {
      const file = join(dir, d.name, "SKILL.md");
      return { skill: d.name, file, text: readFileSync(file, "utf8") };
    })
    .sort((a, b) => (a.skill < b.skill ? -1 : 1));
}

function write() {
  const packVersion = readPackVersionFromSource();
  const store = existsSync(STORE_PATH) ? decodeStore(readFileSync(STORE_PATH)) : emptyStore();
  let added = 0;
  for (const { skill, version, text } of historicalBodies()) {
    if (addBody(store, version, skill, text)) added++;
  }
  for (const { skill, file, text } of currentSkills()) {
    const declared = frontmatterVersion(text);
    if (declared !== packVersion) {
      process.stderr.write(
        `${file}: frontmatter version is ${declared ?? "missing"} but OCTOBOTS_PACK_VERSION is ${packVersion}; ` +
          `bump every pack marker together before running --write.\n`,
      );
      process.exit(1);
    }
    if (addBody(store, packVersion, skill, text)) added++;
  }
  if (added === 0 && existsSync(STORE_PATH)) {
    process.stdout.write(`shipped-skills store is current: ${STORE_PATH} (${Object.keys(store.bodies).length} bodies).\n`);
    return;
  }
  const bytes = encodeStore(store);
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, bytes);
  process.stdout.write(
    `shipped-skills store written: ${STORE_PATH} (${bytes.length} bytes, ${Object.keys(store.bodies).length} bodies, ${added} added)\n`,
  );
}

/** Returns the problems found, one line each, each naming the file. Reads no git. */
export function verify() {
  const problems = [];
  const packVersion = readPackVersionFromSource();
  if (!existsSync(STORE_PATH)) {
    return [`${STORE_PATH}: missing. Run: node scripts/shipped-skills.mjs --write, then commit the result.`];
  }
  let store;
  try {
    store = decodeStore(readFileSync(STORE_PATH));
  } catch (err) {
    return [`${STORE_PATH}: unreadable (${err.message}). Run: node scripts/shipped-skills.mjs --write.`];
  }
  for (const [hash, body] of Object.entries(store.bodies)) {
    if (bodyHash(body) !== hash) {
      problems.push(`${STORE_PATH}: stored body ${hash} has normalised sha256 ${bodyHash(body)}`);
    }
  }
  for (const [version, skills] of Object.entries(store.versions)) {
    for (const [skill, hashes] of Object.entries(skills)) {
      for (const hash of hashes) {
        if (typeof store.bodies[hash] !== "string") {
          problems.push(`${STORE_PATH}: v${version} ${skill} lists ${hash} but stores no body for it`);
        }
      }
    }
  }
  for (const { skill, file, text } of currentSkills()) {
    const listed = store.versions[String(packVersion)]?.[skill] ?? [];
    if (!listed.includes(bodyHash(text))) {
      problems.push(
        `${file}: not indexed under pack version ${packVersion} in the shipped-skills store. ` +
          `Run: node scripts/shipped-skills.mjs --write, then commit the store.`,
      );
    }
  }
  return problems;
}

function main() {
  const mode = process.argv[2] ?? "--verify";
  if (mode !== "--verify" && mode !== "--write") {
    process.stderr.write(`shipped-skills: unknown mode "${mode}"; expected --verify or --write\n`);
    process.exit(2);
    return;
  }
  if (mode === "--write") {
    write();
    return;
  }
  const problems = verify();
  if (problems.length > 0) {
    process.stderr.write(problems.join("\n") + "\n");
    process.exit(1);
    return;
  }
  process.stdout.write("shipped-skills store is current.\n");
}

/** True when this module IS the process entry point (see graph-payload.mjs for why not a string compare). */
export function isDirectRun(metaUrl, argv1) {
  if (!argv1) return false;
  return metaUrl === pathToFileURL(argv1).href;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  }
}
