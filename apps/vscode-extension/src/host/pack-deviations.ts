import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { OCTOBOTS_SKILLS, RETIRED_SKILLS } from "./pack-skills.js";
import { parseSkillMarker, skillSha256 } from "./skill-marker.js";

/**
 * Deviation detection and base recovery for pack updates (M7).
 *
 * A workspace may carry a locally changed pack skill. Whether a `.claude/skills/<skill>/SKILL.md` is
 * the pack's own, a fork, or a reconciled fork is decided here against the store of every SKILL.md
 * the pack ever shipped (`resources/shipped-skills.json.br`, built by `scripts/shipped-skills.mjs`).
 * Only SKILL.md is judged: the rest of a skill's directory always installs. This module reads and
 * writes nothing in the workspace; staging is `pack-updates.ts`.
 */

/** The decoded `resources/shipped-skills.json.br`. */
export interface ShippedStore {
  /** `versions[N][skill]` lists the sha256 of every build at pack version N, oldest first. */
  versions: Record<string, Record<string, string[]>>;
  /** Every body hash, oldest first. */
  order: string[];
  /** sha256 (CRLF normalised to LF) -> SKILL.md text. */
  bodies: Record<string, string>;
}

/** Decodes the store, or null when the file is missing or is not a store. */
export function loadShippedStore(file: string): ShippedStore | null {
  try {
    const s = JSON.parse(brotliDecompressSync(readFileSync(file)).toString("utf8")) as Partial<ShippedStore> | null;
    if (!s || typeof s !== "object" || !s.versions || !Array.isArray(s.order) || !s.bodies) return null;
    return s as ShippedStore;
  } catch {
    return null;
  }
}

export type DeviationReason = "label" | "content" | "unknown-version" | "reconciled-older";

export interface Deviation {
  skill: string;
  /** The version label as written in the workspace's SKILL.md (`missing` when it has none). */
  version: string;
  reason: DeviationReason;
  retired: boolean;
  /** sha256 of the workspace's SKILL.md (CRLF normalised). */
  sha256: string;
}

export interface DeviationReport {
  /** In OCTOBOTS_SKILLS, then RETIRED_SKILLS, order. */
  deviations: Deviation[];
  /** `<N>+local` at the pack version whose `reconciled-from` is the pack's current SKILL.md. */
  reconciled: string[];
  /** A version above the pack version. Never a deviation; every install choice leaves it alone. */
  newer: string[];
}

export interface DetectOptions {
  /**
   * sha256 of each pack skill's CURRENT SKILL.md, when the caller has the pack at hand (installPack
   * does). Without it the newest build the store lists at the pack version stands for the current
   * file: `scripts/shipped-skills.mjs --verify` fails the build unless the current file is listed.
   */
  currentHashes?: Record<string, string>;
}

const skillFile = (repoRoot: string, skill: string): string => join(repoRoot, ".claude", "skills", skill, "SKILL.md");

/** The newest build the store lists for (skill, version), or undefined. */
function storedCurrent(store: ShippedStore | null, skill: string, version: number): string | undefined {
  return store?.versions[String(version)]?.[skill]?.at(-1);
}

/**
 * Classifies each pack and retired skill's SKILL.md in `repoRoot` (a skill that is not installed is
 * skipped). With `store` null (unreadable store) content cannot be checked: an integer version up to
 * the pack version is taken as the pack's own, and no `+local` skill can be called reconciled.
 */
export function detectDeviations(
  repoRoot: string,
  packVersion: number,
  store: ShippedStore | null,
  opts: DetectOptions = {},
): DeviationReport {
  const report: DeviationReport = { deviations: [], reconciled: [], newer: [] };
  const names = [
    ...OCTOBOTS_SKILLS.map((skill) => ({ skill, retired: false })),
    ...RETIRED_SKILLS.map((skill) => ({ skill, retired: true })),
  ];
  for (const { skill, retired } of names) {
    const file = skillFile(repoRoot, skill);
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const m = parseSkillMarker(text);
    const deviate = (reason: DeviationReason) =>
      report.deviations.push({ skill, version: m.label ?? "missing", reason, retired, sha256: m.sha256 });

    if (m.n !== null && m.n > packVersion) {
      report.newer.push(skill);
    } else if (m.kind === "none" || m.kind === "label") {
      deviate("label");
    } else if (m.kind === "plus-local") {
      const current = retired ? undefined : (opts.currentHashes?.[skill] ?? storedCurrent(store, skill, packVersion));
      if (m.n === packVersion && current !== undefined && m.reconciledFrom?.toLowerCase() === current) {
        report.reconciled.push(skill);
      } else {
        deviate("reconciled-older");
      }
    } else if (store === null) {
      // Integer version up to the pack version, nothing to compare against: treated as the pack's own.
    } else {
      const listed = store.versions[String(m.n)]?.[skill] ?? [];
      if (listed.length === 0) deviate("unknown-version");
      else if (!listed.includes(m.sha256)) deviate("content");
    }
  }
  return report;
}

export type BaseSource = "reconciled-from" | "workspace-git" | "declared" | "closest";

export interface RecoveredBase {
  version: number;
  sha256: string;
  source: BaseSource;
  /** The stored SKILL.md text (LF). */
  body: string;
}

/** The longest time git may spend, across all of rule 2's calls. Each call gets what is left of it. */
const GIT_BUDGET_MS = 2000;

/** The lowest version whose list for `skill` holds `hash`, else the lowest holding it for any skill. */
function versionOfBody(store: ShippedStore, hash: string, skill: string): number | null {
  const versions = Object.keys(store.versions).map(Number).sort((a, b) => a - b);
  for (const onlySkill of [true, false]) {
    for (const v of versions) {
      const per = store.versions[String(v)] ?? {};
      for (const [name, hashes] of Object.entries(per)) {
        if ((!onlySkill || name === skill) && hashes.includes(hash)) return v;
      }
    }
  }
  return null;
}

/**
 * Rule 2: the newest commit in the workspace's own history of the skill's SKILL.md whose body is a
 * shipped one. Skipped (null) when git is absent, `repoRoot` is not a repository, `.claude` is
 * ignored, or git runs past its time budget.
 */
function baseFromWorkspaceGit(repoRoot: string, skill: string, store: ShippedStore): RecoveredBase | null {
  const rel = `.claude/skills/${skill}/SKILL.md`;
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const deadline = Date.now() + GIT_BUDGET_MS;
  const git = (args: string[]): Buffer => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("git budget spent");
    return execFileSync("git", args, { cwd: repoRoot, env, timeout: left, maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
  };
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    try {
      git(["check-ignore", "-q", "--no-index", "--", rel]); // --no-index: ignored even if force-added
      return null; // exit 0: ignored
    } catch (err) {
      if ((err as { status?: number }).status !== 1) return null; // not "not ignored": treat as unusable
    }
    const commits = git(["log", "--format=%H", "--", rel]).toString("utf8").split("\n").filter(Boolean);
    for (const commit of commits) {
      let blob: Buffer;
      try {
        blob = git(["show", `${commit}:./${rel}`]);
      } catch (err) {
        if ((err as { status?: number }).status === undefined) throw err; // timeout or spawn failure
        continue; // the file does not exist at that commit (deleted by it)
      }
      const hash = skillSha256(blob.toString("utf8"));
      const body = store.bodies[hash];
      if (body === undefined) continue;
      const version = versionOfBody(store, hash, skill);
      if (version !== null) return { version, sha256: hash, source: "workspace-git", body };
    }
  } catch {
    return null;
  }
  return null;
}

/** Every distinct stored body for `skill` with version <= `max`, oldest first: [version, hash]. */
function candidates(store: ShippedStore, skill: string, max: number): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const seen = new Set<string>();
  const versions = Object.keys(store.versions).map(Number).filter((v) => v <= max).sort((a, b) => a - b);
  for (const v of versions) {
    for (const hash of store.versions[String(v)]?.[skill] ?? []) {
      if (seen.has(hash) || store.bodies[hash] === undefined) continue;
      seen.add(hash);
      out.push([v, hash]);
    }
  }
  return out;
}

/** Number of lines that differ between two texts: lines only in `a` plus lines only in `b`. */
export function changedLines(a: string, b: string): number {
  const x = a.split("\n");
  const y = b.split("\n");
  let lo = 0;
  while (lo < x.length && lo < y.length && x[lo] === y[lo]) lo++;
  let hx = x.length;
  let hy = y.length;
  while (hx > lo && hy > lo && x[hx - 1] === y[hy - 1]) {
    hx--;
    hy--;
  }
  const p = x.slice(lo, hx);
  const q = y.slice(lo, hy);
  let prev = new Uint32Array(q.length + 1);
  let cur = new Uint32Array(q.length + 1);
  for (let i = 1; i <= p.length; i++) {
    for (let j = 1; j <= q.length; j++) {
      cur[j] = p[i - 1] === q[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return p.length + q.length - 2 * prev[q.length]!;
}

/**
 * The base of a three-way merge for a deviated skill: the first of
 *  1. the stored body its `reconciled-from:` names (`reconciled-from`);
 *  2. the newest commit of the workspace's own git history of the SKILL.md whose body is a shipped
 *     one (`workspace-git`; git runs under a 2 s budget and the rule is skipped when git is absent,
 *     the directory is no repository or `.claude` is ignored);
 *  3. the EARLIEST stored body for (skill, N), N the leading integer of the version label (`declared`);
 *  4. the stored body with the fewest changed lines against the local file among those with version
 *     <= N, or all of them when the label has no leading integer (`closest`; approximate);
 *  5. null: the merge is two-way.
 * Rule 4 never picks a body newer than the declared version, and it ties toward the older body.
 */
export function recoverBase(
  repoRoot: string,
  skill: string,
  localBytes: Buffer | string,
  packVersion: number,
  store: ShippedStore,
): RecoveredBase | null {
  const local = typeof localBytes === "string" ? localBytes : localBytes.toString("utf8");
  const m = parseSkillMarker(local);

  const named = m.reconciledFrom?.toLowerCase();
  if (named && store.bodies[named] !== undefined) {
    const version = versionOfBody(store, named, skill);
    if (version !== null) return { version, sha256: named, source: "reconciled-from", body: store.bodies[named]! };
  }

  const fromGit = baseFromWorkspaceGit(repoRoot, skill, store);
  if (fromGit) return fromGit;

  if (m.n !== null) {
    const earliest = store.versions[String(m.n)]?.[skill]?.[0];
    if (earliest !== undefined && store.bodies[earliest] !== undefined) {
      return { version: m.n, sha256: earliest, source: "declared", body: store.bodies[earliest]! };
    }
  }

  const localLf = local.replace(/\r\n/g, "\n");
  let best: { version: number; hash: string; lines: number } | null = null;
  for (const [version, hash] of candidates(store, skill, m.n ?? packVersion)) {
    const lines = changedLines(store.bodies[hash]!, localLf);
    if (best === null || lines < best.lines) best = { version, hash, lines };
  }
  if (best) return { version: best.version, sha256: best.hash, source: "closest", body: store.bodies[best.hash]! };
  return null;
}
