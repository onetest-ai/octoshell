import { STORE_MISSING } from "./octobots-skill.js";
import type { ShippedStore } from "./pack-deviations.js";

/**
 * The first check of an install: without the shipped-skill store a changed SKILL.md cannot be told
 * from the pack's own, so installPack writes nothing. Run it before any modal or question, so the
 * user is never asked something that cannot be acted on.
 */
export function prepareInstall(store: ShippedStore | null): { error: string } | { store: ShippedStore } {
  if (store === null) return { error: `Octobots: nothing was installed (${STORE_MISSING}).` };
  return { store };
}

/** The error message for an install that threw (e.g. a read-only `.claude`). */
export function installFailureMessage(err: unknown): string {
  return `Octobots: the install failed: ${err instanceof Error ? err.message : String(err)}`;
}
