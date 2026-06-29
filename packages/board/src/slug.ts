import { newId } from "./types.js";

/** Filesystem-safe slug from a display name; short-id fallback for empty/non-latin. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
  return s || newId().replace(/[^0-9a-f]/g, "").slice(0, 8);
}

/** `base`, else `base-2`, `base-3`, … — the first not already in `taken`. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
