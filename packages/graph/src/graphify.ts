import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./paths.js";
import { compare, type ModuleEdge } from "./rollup.js";

/** Edge types we treat as a declared dependency. Everything else is ignored. */
const IMPORT_TYPES = new Set(["imports", "import", "calls", "inherits", "extends"]);

interface RawNode { id?: unknown; file?: unknown; path?: unknown; file_path?: unknown }
interface RawEdge { source?: unknown; target?: unknown; type?: unknown; kind?: unknown }

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// `typeof null === "object"`, so a `null` ARRAY ELEMENT — what a truncated or
// partially-written Graphify run may well leave behind, e.g. `{"nodes":[null],
// "edges":[]}` — passes any `Array.isArray`/shape check on the document and
// then throws on the property read below (`raw.id`, `raw.type`). That throw
// escapes this function entirely, exactly like the bare document-level `null`
// handled above: the guard is what keeps "never throws" true for a malformed
// ELEMENT, not just a malformed document. Non-null junk (`{}`, a number, a
// string) already degrades gracefully — `str()` returns null for a property
// read off any of those without throwing — so only `null` (and, defensively,
// `undefined`, which JSON.parse never produces but a hand-built caller might)
// needs this check.
const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;

/**
 * Read module-level import edges out of a Graphify graph.json, if one exists.
 * Never throws: absent or malformed output degrades the spine, it does not
 * break the tool.
 */
export function readGraphify(
  repoRoot: string,
  moduleOf: (path: string) => string,
): ModuleEdge[] | null {
  const path = join(repoRoot, "graphify-out", "graph.json");
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }

  // `typeof null === "object"`, and a graph.json holding a bare `null` — what a
  // failed or empty Graphify run may well leave behind — is valid JSON, so it
  // survives the parse above and then throws on the property read below. That
  // throw escapes this function entirely: the guard is what keeps the
  // "never throws" contract true for every malformed document, not just the
  // ones that fail to parse.
  if (typeof parsed !== "object" || parsed === null) return null;

  const doc = parsed as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return null;

  const fileOf = new Map<string, string>();
  for (const raw of doc.nodes as RawNode[]) {
    if (isNil(raw)) continue;
    const id = str(raw.id);
    const file = str(raw.file) ?? str(raw.path) ?? str(raw.file_path);
    if (!id || !file) continue;
    // Graphify's output is a foreign document, and its paths are the one part
    // of it that reaches a committed artifact. Normalize each into the same
    // repo-relative namespace `harvest` reads out of git, and drop anything
    // that escapes the root — otherwise a node recorded as an absolute path
    // names a module after the checkout location (`/Users/<whoever>`, which
    // differs per machine) and one recorded as `../../x` names a module `../..`
    // outside the repo. Both would be emitted as real modules.
    const rel = repoRelative(repoRoot, file);
    if (rel === null) continue;
    fileOf.set(id, rel);
  }

  const acc = new Map<string, ModuleEdge>();
  for (const raw of doc.edges as RawEdge[]) {
    if (isNil(raw)) continue;
    const type = (str(raw.type) ?? str(raw.kind) ?? "").toLowerCase();
    if (!IMPORT_TYPES.has(type)) continue;
    const from = str(raw.source);
    const to = str(raw.target);
    if (!from || !to) continue;
    const fa = fileOf.get(from);
    const fb = fileOf.get(to);
    if (!fa || !fb) continue;

    const ma = moduleOf(fa);
    const mb = moduleOf(fb);
    if (ma === mb) continue;

    // NUL, not a space, exactly as `rollUp` keys its accumulator: module names
    // come from real path segments, which may contain spaces, so a space-joined
    // key makes ("a", "b c") and ("a b", "c") collide and quietly sums two
    // unrelated module edges into one. Written as an escape, never as a literal
    // control byte — a raw NUL in the source makes git treat this file as
    // binary and stop producing a reviewable diff for it.
    const key = `${ma}\u0000${mb}`;
    const existing = acc.get(key);
    if (existing) existing.weight += 1;
    else acc.set(key, { from: ma, to: mb, weight: 1 });
  }

  // Strongest first, ties broken on raw code units through the shared
  // comparator — byte-for-byte the order `rollUp` returns.
  //
  // Both are producers of `Analysis.moduleEdges`, and its consumer trims the
  // TAIL of that list to fit the token budget, documenting the survivors as the
  // strongest edges. Ordering one producer by weight and the other by name
  // makes that claim true on the co-change tier and false on the Graphify tier,
  // where the budget would instead drop whatever sorts last in the alphabet —
  // the strongest declared dependency in the repo if it happens to start with
  // "z". One list, one contract, whichever half built it.
  //
  // The code-unit tie-break is not optional either: `Spine.modules` sits beside
  // this list and is ordered by plain `.sort()`, so a locale collation here
  // would order the two by different rules (see `compare`).
  return [...acc.values()].sort(
    (x, y) => y.weight - x.weight || compare(x.from, y.from) || compare(x.to, y.to),
  );
}
