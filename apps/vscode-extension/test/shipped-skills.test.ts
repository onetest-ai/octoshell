import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readPackVersionFromSource } from "../scripts/shipped-skills.mjs";
import { OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const EXT_ROOT = join(__dirname, "..");
const SCRIPT = join(EXT_ROOT, "scripts", "shipped-skills.mjs");
const STORE_PATH = join(EXT_ROOT, "resources", "shipped-skills.json.br");
const PACK_SKILLS = join(EXT_ROOT, "resources", "octobots-pack", "skill");

interface Store {
  versions: Record<string, Record<string, string[]>>;
  order: string[];
  bodies: Record<string, string>;
}

const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const readStore = (path = STORE_PATH): Store =>
  JSON.parse(brotliDecompressSync(readFileSync(path)).toString("utf8")) as Store;
const writeStore = (path: string, store: Store) =>
  writeFileSync(path, brotliCompressSync(Buffer.from(JSON.stringify(store), "utf8")));
const currentSkills = () =>
  readdirSync(PACK_SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PACK_SKILLS, d.name, "SKILL.md")))
    .map((d) => d.name);

/** Runs the script. `GIT_DIR` points at an empty directory by default, so any git read fails. */
function run(mode: string, env: Record<string, string> = {}, noGit = true) {
  const env2: Record<string, string> = { ...(process.env as Record<string, string>), ...env };
  if (noGit) env2.GIT_DIR = mkdtempClean("shipped-skills-nogit-");
  return spawnSync("node", [SCRIPT, mode], { cwd: EXT_ROOT, env: env2, encoding: "utf8" });
}

/** A scratch copy of the pack's skills and the store, plus the env that points the script at them. */
function scratch() {
  const root = mkdtempClean("shipped-skills-");
  const skills = join(root, "skill");
  cpSync(PACK_SKILLS, skills, { recursive: true });
  const store = join(root, "shipped-skills.json.br");
  cpSync(STORE_PATH, store);
  return {
    skills,
    store,
    env: { SHIPPED_SKILLS_STORE_PATH: store, SHIPPED_SKILLS_PACK_DIR: skills },
  };
}

describe("resources/shipped-skills.json.br (committed store)", () => {
  const store = readStore();

  it("indexes every current pack SKILL.md under OCTOBOTS_PACK_VERSION with its body stored", () => {
    const skills = currentSkills();
    expect(skills.length).toBeGreaterThanOrEqual(4);
    for (const skill of skills) {
      const text = readFileSync(join(PACK_SKILLS, skill, "SKILL.md"), "utf8");
      const hash = sha(text);
      expect(store.versions[String(OCTOBOTS_PACK_VERSION)]?.[skill], skill).toContain(hash);
      expect(store.bodies[hash], skill).toBe(text.replace(/\r\n/g, "\n"));
    }
  });

  it("holds the pre-retirement history: workflow-designer at 56 and the pre-rename octobots skill at 18", () => {
    expect(store.versions["56"]?.["workflow-designer"]?.length).toBeGreaterThanOrEqual(1);
    expect(store.versions["18"]?.["octobots"]?.length).toBe(1);
    expect(store.versions["19"]?.["mission-planner"]?.length).toBeGreaterThanOrEqual(1);
  });

  it("lists the v56 mission-execution and mission-completion-gate files", () => {
    const hashes = (skill: string) => store.versions["56"]?.[skill] ?? [];
    expect(hashes("mission-execution").some((h) => h.startsWith("9af2c928"))).toBe(true);
    expect(hashes("mission-completion-gate").some((h) => h.startsWith("008de10a"))).toBe(true);
  });

  it("never lists the versions that were never shipped", () => {
    for (const v of ["22", "26", "31", "41"]) expect(store.versions[v], v).toBeUndefined();
  });

  it("keeps every build of v57 in commit order: the v56-text-plus-marker body of 800c62c comes first", () => {
    // 800c62c ("bump workflow pack to v57") was the first v57 build; M2 changed these two bodies
    // at v57 afterwards. Base-recovery rule 3 reads index 0 as the EARLIEST body for (skill, N).
    const v57 = store.versions["57"] ?? {};
    expect(v57["mission-execution"]?.[0]).toBe(
      "92e7eebb995bacf738751d47989944914be146a5d9410378d84e69708fd42755",
    );
    expect(v57["mission-completion-gate"]?.[0]).toBe(
      "cea02af4cb23b7d25dafad8fac3de934f4bd28bafa09e146f27796b7ac80b6c7",
    );
    expect(v57["mission-execution"]?.length).toBeGreaterThan(1);
    expect(v57["mission-completion-gate"]?.length).toBeGreaterThan(1);
  });

  it("is self-consistent: every body hashes to its key, every index entry has a body and is in order", () => {
    for (const [key, body] of Object.entries(store.bodies)) expect(sha(body), key).toBe(key);
    const order = new Set(store.order);
    expect(order.size).toBe(store.order.length);
    for (const skills of Object.values(store.versions)) {
      for (const hashes of Object.values(skills)) {
        for (const h of hashes) {
          expect(store.bodies[h], h).toBeTypeOf("string");
          expect(order.has(h), h).toBe(true);
        }
      }
    }
    expect(Object.keys(store.bodies).sort()).toEqual([...store.order].sort());
  });

  it("stays within the 100 KB budget", () => {
    expect(readFileSync(STORE_PATH).length).toBeLessThanOrEqual(100 * 1024);
  });
});

describe("scripts/shipped-skills.mjs --verify", () => {
  it("exits 0 on the committed store and reads no git (GIT_DIR points at an empty directory)", () => {
    const r = run("--verify");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("reads the pack version from source the same way the typed constant spells it", () => {
    expect(readPackVersionFromSource()).toBe(OCTOBOTS_PACK_VERSION);
  });

  it("defaults to --verify when called with no mode", () => {
    const r = spawnSync("node", [SCRIPT], { cwd: EXT_ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("exits 1 naming the file when a current SKILL.md is not indexed", () => {
    const s = scratch();
    const file = join(s.skills, "mission-execution", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8") + "\nan unrecorded local edit\n");
    const r = run("--verify", s.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(file);
    expect(r.stderr).toContain("not indexed");
  });

  it("exits 1 naming the store when a stored body's normalised sha256 differs from its key", () => {
    const s = scratch();
    const store = readStore(s.store);
    const key = store.versions["56"]?.["mission-execution"]?.[0] as string;
    store.bodies[key] = (store.bodies[key] as string) + "tampered\n";
    writeStore(s.store, store);
    const r = run("--verify", s.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(s.store);
    expect(r.stderr).toContain(key);
  });

  it("hashes a body with CRLF normalised to LF: a CRLF checkout of a current SKILL.md still verifies", () => {
    const s = scratch();
    const file = join(s.skills, "mission-planner", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    expect(run("--verify", s.env).status).toBe(0);
  });

  it("exits 1 when an indexed entry has no body", () => {
    const s = scratch();
    const store = readStore(s.store);
    const key = store.versions["56"]?.["mission-execution"]?.[0] as string;
    delete store.bodies[key];
    writeStore(s.store, store);
    const r = run("--verify", s.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(s.store);
    expect(r.stderr).toContain(key);
  });

  it("exits 1 naming the store when it is missing", () => {
    const s = scratch();
    const missing = join(dirname(s.store), "absent.br");
    const r = run("--verify", { ...s.env, SHIPPED_SKILLS_STORE_PATH: missing });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(missing);
  });

  it("exits 2 on an unknown mode", () => {
    const r = run("--bogus");
    expect(r.status).toBe(2);
  });
});

describe("scripts/shipped-skills.mjs --write", () => {
  it("changes no byte of the committed store on an unchanged tree", () => {
    const s = scratch();
    const before = readFileSync(s.store);
    const r = run("--write", s.env, false);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(Buffer.compare(readFileSync(s.store), before)).toBe(0);
  });

  it("rebuilds the shipped history from git alone when the store is absent", () => {
    // The strongest check that --write reads the history right: starting from nothing it must
    // regenerate every earlier version exactly as committed (CI checks out with fetch-depth 0).
    const s = scratch();
    const fresh = join(dirname(s.store), "fresh.br");
    const r = run("--write", { ...s.env, SHIPPED_SKILLS_STORE_PATH: fresh }, false);
    expect(r.status).toBe(0);
    const a = readStore(fresh);
    const b = readStore(STORE_PATH);
    for (const [v, skills] of Object.entries(b.versions)) {
      if (Number(v) >= OCTOBOTS_PACK_VERSION) continue;
      expect(a.versions[v], v).toEqual(skills);
    }
    // Later builds of the current version are all reachable from HEAD too.
    for (const [skill, hashes] of Object.entries(b.versions[String(OCTOBOTS_PACK_VERSION)] ?? {})) {
      expect(a.versions[String(OCTOBOTS_PACK_VERSION)]?.[skill]).toEqual(hashes);
    }
    for (const h of Object.keys(a.bodies)) expect(b.bodies[h]).toBe(a.bodies[h]);
  }, 60_000);

  it("appends a changed SKILL.md to the end of its version and of the order, leaving the rest alone", () => {
    const s = scratch();
    const before = readStore(s.store);
    const file = join(s.skills, "mission-execution", "SKILL.md");
    const text = readFileSync(file, "utf8") + "\nanother rule\n";
    writeFileSync(file, text);

    const r = run("--write", s.env, false);
    expect(r.status).toBe(0);

    const after = readStore(s.store);
    const v = String(OCTOBOTS_PACK_VERSION);
    const added = sha(text);
    expect(after.versions[v]?.["mission-execution"]).toEqual([
      ...(before.versions[v]?.["mission-execution"] ?? []),
      added,
    ]);
    expect(after.order).toEqual([...before.order, added]);
    expect(after.bodies[added]).toBe(text);
    for (const [k, body] of Object.entries(before.bodies)) expect(after.bodies[k]).toBe(body);
    expect(run("--verify", s.env).status).toBe(0);

    // A second --write is a no-op.
    const bytes = readFileSync(s.store);
    expect(run("--write", s.env, false).status).toBe(0);
    expect(Buffer.compare(readFileSync(s.store), bytes)).toBe(0);
  });

  it("refuses a current SKILL.md whose version line is not OCTOBOTS_PACK_VERSION, naming the file", () => {
    const s = scratch();
    const file = join(s.skills, "mission-planner", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^version: .*$/m, "version: 9999"));
    const before = readFileSync(s.store);
    const r = run("--write", s.env, false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(file);
    expect(Buffer.compare(readFileSync(s.store), before)).toBe(0);
  });

  it("creates the store (and its directory) when none exists yet", () => {
    const s = scratch();
    const nested = join(dirname(s.store), "a", "b", "store.br");
    const r = run("--write", { ...s.env, SHIPPED_SKILLS_STORE_PATH: nested }, false);
    expect(r.status).toBe(0);
    expect(existsSync(nested)).toBe(true);
    expect(run("--verify", { ...s.env, SHIPPED_SKILLS_STORE_PATH: nested }).status).toBe(0);
  });
});

describe("wiring", () => {
  it("the extension's build script runs --verify beside graph-payload --verify", () => {
    const pkg = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("node scripts/shipped-skills.mjs --verify");
    expect(pkg.scripts.build).toContain("node scripts/graph-payload.mjs --verify");
  });

  it(".gitattributes marks the store -text and the .vscodeignore does not exclude it", () => {
    const attrs = readFileSync(join(EXT_ROOT, "..", "..", ".gitattributes"), "utf8");
    expect(attrs).toMatch(
      /^apps\/vscode-extension\/resources\/shipped-skills\.json\.br\s+-text\b/m,
    );
    const ignore = readFileSync(join(EXT_ROOT, ".vscodeignore"), "utf8").split("\n");
    const excludes = ignore.filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("!"));
    expect(excludes.filter((l) => /resources|\.br\b|shipped/.test(l))).toEqual([]);
  });
});
