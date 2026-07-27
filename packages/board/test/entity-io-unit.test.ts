/**
 * Direct unit tests for the pack's standalone `entity-io.mjs` — the single funnel every mutating
 * script reads and writes through. A field this module fails to model is destroyed by the next
 * script run, so its parse/serialize branches are the data-loss surface and are tested head-on
 * rather than only through the CLIs.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);

type Fields = Record<string, unknown>;
const io = (await import(pathToFileURL(join(SCRIPTS, "entity-io.mjs")).href)) as {
  ENTITY_KINDS: string[];
  newId: () => string;
  slugify: (s: unknown) => string;
  siblingSlugs: (dir: string) => Set<string>;
  uniqueSlug: (base: string, taken: Set<string>) => string;
  mapBoardStatus: (raw: unknown) => string | null;
  loadEntity: (text: string) => Fields;
  dumpEntity: (kind: string, fields: Fields) => string;
  resolveEntityFile: (arg: string, kinds?: string[]) => { file: string; kind: string; format: string } | null;
  readEntity: (file: string, format: string) => Fields;
  entityName: (dir: string, kind: string) => string;
  childDirs: (p: string) => string[];
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "entity-io-"));
}

describe("mapBoardStatus", () => {
  it("maps every alias onto its canonical status", () => {
    expect(io.mapBoardStatus("draft")).toBe("draft");
    expect(io.mapBoardStatus("Active")).toBe("executing");
    expect(io.mapBoardStatus("in progress")).toBe("executing");
    expect(io.mapBoardStatus("in_progress")).toBe("executing");
    expect(io.mapBoardStatus("running")).toBe("executing");
    expect(io.mapBoardStatus("awaiting approval")).toBe("awaitingApproval");
    expect(io.mapBoardStatus("awaitingApproval")).toBe("awaitingApproval");
    expect(io.mapBoardStatus("completed")).toBe("done");
    expect(io.mapBoardStatus("fail")).toBe("failed");
    expect(io.mapBoardStatus("canceled")).toBe("cancelled");
  });

  it("returns null for an unknown or empty status", () => {
    expect(io.mapBoardStatus("nearly")).toBeNull();
    expect(io.mapBoardStatus("")).toBeNull();
    expect(io.mapBoardStatus(undefined)).toBeNull();
  });
});

describe("slug helpers", () => {
  it("slugifies to a bounded, trimmed kebab string", () => {
    expect(io.slugify("M1 - Auth & Tokens!")).toBe("m1-auth-tokens");
    expect(io.slugify("  ---  ")).toMatch(/^[a-z0-9]{8}$/); // falls back to a generated id
    expect(io.slugify("x".repeat(80))).toHaveLength(50);
  });

  it("generates a 12-char id with no dashes", () => {
    expect(io.newId()).toMatch(/^[a-f0-9]{12}$/);
  });

  it("dedupes a slug against its siblings", () => {
    const taken = new Set(["ship", "ship-2"]);
    expect(io.uniqueSlug("ship", taken)).toBe("ship-3");
    expect(io.uniqueSlug("other", taken)).toBe("other");
  });

  it("reads sibling slugs from disk, and an empty set for a missing dir", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "file.txt"), "x", "utf8"); // files are not siblings
    expect([...io.siblingSlugs(dir)].sort()).toEqual(["a", "b"]);
    expect(io.siblingSlugs(join(dir, "missing")).size).toBe(0);
    expect(io.childDirs(join(dir, "missing"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadEntity tolerates malformed yaml shapes", () => {
  it("throws rather than treating a truncated file as a blank entity", () => {
    // Defaulting here would let a script overwrite a corrupt `<kind>.yaml` with an empty entity and
    // report success. Matches the app's entity-schema.ts, which throws the same way.
    expect(() => io.loadEntity("")).toThrow();
    expect(() => io.loadEntity("   ")).toThrow();
  });

  it("defaults every field for a document with no keys", () => {
    const f = io.loadEntity("{}");
    expect(f.name).toBe("");
    expect(f.description).toBe("");
    expect(f.acceptanceCriteria).toEqual([]);
    expect(f.documents).toEqual([]);
    expect(f.status).toBeUndefined();
    expect(f.notes).toBeUndefined();
  });

  it("drops criteria and documents that are not objects of the right shape", () => {
    const f = io.loadEntity(
      [
        "name: T1.1 - JWT",
        "acceptance_criteria:",
        "  - plain string",
        "  - text: real one",
        "    done: true",
        "documents:",
        "  - label: no target",
        "  - target: docs/a.md",
        "  - label: named",
        "    target: docs/b.md",
      ].join("\n"),
    );
    expect(f.acceptanceCriteria).toEqual([{ text: "real one", done: true }]);
    // A document with no target is dropped; one with no label falls back to its target.
    expect(f.documents).toEqual([
      { label: "docs/a.md", target: "docs/a.md" },
      { label: "named", target: "docs/b.md" },
    ]);
  });

  it("coerces non-string scalars and ignores a non-list criteria key", () => {
    const f = io.loadEntity("name: 42\ndescription: true\nacceptance_criteria: nope\n");
    expect(f.name).toBe("42");
    expect(f.description).toBe("true");
    expect(f.acceptanceCriteria).toEqual([]);
  });

  it("keeps every tokenomics value, including nested blocks", () => {
    expect(io.loadEntity("tokenomics:\n  effort_days: 2\n  size_tshirt: S\n  ok: true\n").tokenomics).toEqual({
      effort_days: 2,
      size_tshirt: "S",
      ok: true,
    });
    // A nested breakdown is content, not noise — dropping it would lose the estimate's basis on the
    // next unrelated write.
    expect(io.loadEntity("tokenomics:\n  nested:\n    a: 1\n").tokenomics).toEqual({ nested: { a: 1 } });
  });

  it("ignores a tokenomics value that is not a map", () => {
    expect(io.loadEntity("tokenomics: [1,2]\n").tokenomics).toBeUndefined();
    expect(io.loadEntity("tokenomics: 5\n").tokenomics).toBeUndefined();
  });
});

describe("dumpEntity emits only the keys each kind uses", () => {
  const base: Fields = { name: "X", description: "d", acceptanceCriteria: [], documents: [] };

  it("gives a campaign a target and documents but no severity", () => {
    const yaml = io.dumpEntity("campaign", { ...base });
    expect(yaml).toContain("target: ''");
    expect(yaml).toContain("documents: []");
    expect(yaml).not.toContain("severity:");
    expect(yaml).toContain("status: draft"); // defaults when absent
  });

  it("gives a bug the repro fields and no acceptance criteria", () => {
    const yaml = io.dumpEntity("bug", { ...base, severity: undefined });
    expect(yaml).toContain("severity: major");
    expect(yaml).toContain("steps_to_reproduce:");
    expect(yaml).toContain("rca:");
    expect(yaml).not.toContain("acceptance_criteria:");
    expect(yaml).not.toContain("documents:");
  });

  it("emits a task role only when set, and tokenomics only when non-empty", () => {
    expect(io.dumpEntity("task", { ...base })).not.toContain("role:");
    expect(io.dumpEntity("task", { ...base, role: "python-dev" })).toContain("role: python-dev");
    expect(io.dumpEntity("task", { ...base, tokenomics: {} })).not.toContain("tokenomics:");
    expect(io.dumpEntity("task", { ...base, tokenomics: { effort_days: 1 } })).toContain("effort_days: 1");
    // Tokenomics is a mission/task concern — a campaign never carries it.
    expect(io.dumpEntity("campaign", { ...base, tokenomics: { effort_days: 1 } })).not.toContain("tokenomics:");
  });
});

describe("legacy .md reads keep every field the yaml would carry", () => {
  const MD = [
    "# B1 - Token leak",
    "",
    "## Status",
    "in progress",
    "",
    "## Description",
    "tokens leak into logs",
    "",
    "## Severity",
    "Blocker",
    "",
    "## Steps to Reproduce",
    "1. sign in",
    "",
    "## Expected",
    "no token in the log",
    "",
    "## Actual",
    "the token is logged",
    "",
    "## RCA",
    "the logger serialises the whole request",
    "",
    "## Environment",
    "macOS 15",
    "",
    "<!-- Auto-generated by Octobots from the bug's fields above. -->",
    "",
    "## Decision",
    "redact at the logger, not the caller",
    "",
  ].join("\n");

  it("parses every bug section, including the appended decision", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bug.md"), MD, "utf8");
    const f = io.readEntity(join(dir, "bug.md"), "md");

    expect(f.name).toBe("B1 - Token leak");
    expect(f.description).toBe("tokens leak into logs");
    expect(f.severity).toBe("blocker");
    expect(f.stepsToReproduce).toBe("1. sign in");
    expect(f.expected).toBe("no token in the log");
    expect(f.actual).toBe("the token is logged");
    expect(f.rca).toBe("the logger serialises the whole request");
    expect(f.environment).toBe("macOS 15");
    expect(f.status).toBe("executing");
    expect(f.notes).toContain("redact at the logger, not the caller");
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses criteria, documents and target, and treats a placeholder section as empty", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "campaign.md"),
      [
        "# Q3 Rollout",
        "",
        "## Description",
        "_(none yet)_",
        "",
        "## Target",
        "every mission merged",
        "",
        "## Acceptance Criteria",
        "- [x] shipped",
        "- [ ] documented",
        "",
        "## Documents",
        "- [Spec](docs/spec.md)",
        "- not a link",
        "",
      ].join("\n"),
      "utf8",
    );
    const f = io.readEntity(join(dir, "campaign.md"), "md");

    expect(f.description).toBe(""); // `_(none yet)_` is a placeholder, not content
    expect(f.target).toBe("every mission merged");
    expect(f.acceptanceCriteria).toEqual([
      { text: "shipped", done: true },
      { text: "documented", done: false },
    ]);
    expect(f.documents).toEqual([{ label: "Spec", target: "docs/spec.md" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty fields for an md with no headings at all", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "task.md"), "just prose, no structure\n", "utf8");
    const f = io.readEntity(join(dir, "task.md"), "md");
    expect(f.name).toBe("");
    expect(f.acceptanceCriteria).toEqual([]);
    expect(f.notes).toBeUndefined(); // no managed-block boundary → nothing to preserve
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveEntityFile", () => {
  it("prefers yaml over a legacy md in the same folder", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "task.yaml"), "name: T1.1\n", "utf8");
    writeFileSync(join(dir, "task.md"), "# T1.1\n", "utf8");
    expect(io.resolveEntityFile(dir)).toMatchObject({ kind: "task", format: "yaml" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to md when there is no yaml", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "mission.md"), "# M1\n", "utf8");
    expect(io.resolveEntityFile(dir)).toMatchObject({ kind: "mission", format: "md" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("honours the caller's kind filter for folders and for files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bug.yaml"), "name: B1\n", "utf8");
    // A folder holding only a bug, asked for campaign/mission, is not a match.
    expect(io.resolveEntityFile(dir, ["campaign", "mission"])).toBeNull();
    // Nor is the bug file itself — returning it anyway is how a criterion got silently dropped.
    expect(io.resolveEntityFile(join(dir, "bug.yaml"), ["campaign", "mission", "task"])).toBeNull();
    expect(io.resolveEntityFile(join(dir, "bug.yaml"))).toMatchObject({ kind: "bug" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a missing path, an empty arg and a non-entity filename", () => {
    const dir = tempDir();
    expect(io.resolveEntityFile(join(dir, "missing"))).toBeNull();
    expect(io.resolveEntityFile("")).toBeNull();
    writeFileSync(join(dir, "notes.md"), "x", "utf8");
    expect(io.resolveEntityFile(join(dir, "notes.md"))).toBeNull();
    expect(io.resolveEntityFile(dir)).toBeNull(); // folder holds no entity file
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("entityName", () => {
  it("reads the name from yaml, then the md heading, then empty", () => {
    const dir = tempDir();
    expect(io.entityName(dir, "task")).toBe("");

    writeFileSync(join(dir, "task.md"), "# T1.1 - From md\n", "utf8");
    expect(io.entityName(dir, "task")).toBe("T1.1 - From md");

    writeFileSync(join(dir, "task.yaml"), "name: T1.1 - From yaml\n", "utf8");
    expect(io.entityName(dir, "task")).toBe("T1.1 - From yaml");

    writeFileSync(join(dir, "mission.md"), "no heading here\n", "utf8");
    expect(io.entityName(dir, "mission")).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});
