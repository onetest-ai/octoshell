import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadShippedStore } from "../../src/host/pack-deviations.js";

export const EXT_ROOT = join(__dirname, "..", "..");
export const PACK_SRC = join(EXT_ROOT, "resources", "octobots-pack");
export const store = loadShippedStore(join(EXT_ROOT, "resources", "shipped-skills.json.br"))!;

export const versionLine = (text: string, label: string): string => text.replace(/^version:.*$/m, `version: ${label}`);

/**
 * Solo's two real `57-local` forks: the bytes of OCTOBOTS_BOARD_COPIES' sibling `.claude` when that
 * is set to a board copy of solo (read, never written), else the shipped v56 files relabelled
 * `57-local` (same as test/pack-deviations.test.ts).
 */
export function forks(): Record<"mission-execution" | "mission-completion-gate", Buffer> {
  const out = {} as Record<"mission-execution" | "mission-completion-gate", Buffer>;
  const copies = (process.env.OCTOBOTS_BOARD_COPIES ?? "").split(":").filter(Boolean);
  for (const skill of ["mission-execution", "mission-completion-gate"] as const) {
    let real: Buffer | null = null;
    for (const dir of copies) {
      const f = join(dirname(dir), ".claude", "skills", skill, "SKILL.md");
      if (existsSync(f) && /^version: 57-local\s*$/m.test(readFileSync(f, "utf8"))) real = readFileSync(f);
    }
    out[skill] = real ?? Buffer.from(versionLine(store.bodies[store.versions["56"]![skill]![0]!]!, "57-local"));
  }
  return out;
}
