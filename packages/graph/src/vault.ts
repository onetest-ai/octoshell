import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { compare } from "./rollup.js";

/** One committed knowledge note, reduced to what path-matching needs. */
export interface VaultNote {
  /** Path relative to the vault root, e.g. "architecture/dual-schema-entity-io.md". */
  note: string;
  /** Frontmatter `name`, or the filename stem when absent or unparseable. */
  name: string;
  /** Frontmatter `description`, flattened to one line. Empty string when absent. */
  description: string;
  /** Frontmatter `verified` or `created`, as written. Null when neither is present. */
  verified: string | null;
  /** Everything after the frontmatter block. The whole file when there is none. */
  body: string;
}

/** Where the vault lives by default. Overridable per repo via `vaultPath`. */
export const DEFAULT_VAULT_PATH = ".agents/knowledge";

/**
 * A leading YAML frontmatter block. Non-greedy so a body containing its own
 * `---` (a markdown horizontal rule, which several notes in this repo use)
 * cannot swallow the rest of the file into the frontmatter.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * A folded YAML scalar (`description: >-`) arrives with embedded newlines, and
 * a description is interpolated into single-line CLI output and into `map.md`,
 * which is line-oriented. Collapse every run of whitespace to one space, once,
 * here — not at each of the three call sites.
 */
const oneLine = (v: string): string => v.replace(/\s+/gu, " ").trim();

/** Every `*.md` under `dir`, depth-first, as paths relative to `dir`. */
function markdownFiles(dir: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // absent or unreadable — an empty vault, never a throw
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...markdownFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/**
 * Read every note in the vault.
 *
 * Never throws. An absent vault, an unreadable file, an empty frontmatter
 * block (which `js-yaml@5.2.2` throws on rather than returning `undefined` —
 * see `.agents/knowledge/practices/js-yaml-empty-doc-and-bool-parsing.md`), or
 * malformed YAML each degrade to a thinner answer, exactly as `readGraphify`
 * degrades on a malformed `graph.json`. This is an OPTIONAL evidence tier; it
 * must not be able to break a `map` or `impact` run.
 *
 * `README.md` files are skipped at every level: the vault's own charter and
 * per-folder READMEs describe the layer, they are not facts about code, and
 * matching them would attach "here is what this folder is for" to a source
 * path as though it were a finding.
 */
export function readVault(repoRoot: string, vaultPath: string = DEFAULT_VAULT_PATH): VaultNote[] {
  const root = join(repoRoot, ...vaultPath.split("/"));
  const notes: VaultNote[] = [];

  for (const rel of markdownFiles(root)) {
    // The final PATH SEGMENT, not a suffix: `rel.endsWith("README.md")` would
    // also drop a genuine note named e.g. "customREADME.md", which merely
    // ends in that substring rather than being a README.
    const segment = rel.slice(rel.lastIndexOf("/") + 1);
    if (segment === "README.md") continue;

    let raw: string;
    try {
      raw = readFileSync(join(root, ...rel.split("/")), "utf8");
    } catch {
      continue;
    }

    const stem = segment.replace(/\.md$/u, "");
    const match = FRONTMATTER.exec(raw);
    const body = match === null ? raw : raw.slice(match[0].length);

    let front: Record<string, unknown> = {};
    if (match?.[1] !== undefined) {
      try {
        const doc: unknown = loadYaml(match[1]);
        if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
          front = doc as Record<string, unknown>;
        }
      } catch {
        // Empty, whitespace-only, or malformed frontmatter. The note still
        // counts — its BODY is where citations live, and that parsed fine.
      }
    }

    const description = str(front.description);
    notes.push({
      note: rel,
      name: str(front.name) ?? stem,
      description: description === null ? "" : oneLine(description),
      verified: str(front.verified) ?? str(front.created),
      body,
    });
  }

  // Deterministic, by the same comparator every other ordering in this package
  // uses — `readdirSync` order is filesystem-dependent, and this list reaches a
  // committed artifact through `render.ts`.
  return notes.sort((a, b) => compare(a.note, b.note));
}
