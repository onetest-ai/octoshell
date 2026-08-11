/**
 * The ONE spelling of the `// octobots-pack-version: N` marker rule.
 *
 * Three pack payloads carry that marker and three functions used to re-derive the same regex to
 * read it: `parsePrimerVersion` (`octobots-skill.ts`), `parseTokenomicsVersion`
 * (`octobots-tokenomics.ts`) and `parseGraphVersion` (`octograph-install.ts`). They now all
 * delegate here, so "how staleness is decided" cannot come to mean three slightly different things
 * — a payload judged stale by one rule and current by another is a workspace that is never
 * prompted to upgrade, or prompted forever.
 *
 * The producers of the marker are: `resources/octobots-pack/hooks/primer.mjs` and the tokenomics
 * runner (literal comments, hand-bumped) and the octograph bundle (an esbuild `banner` — see
 * `scripts/graph-payload.mjs`). `test/pack-version-marker.test.ts` drives all three readers from
 * one shared list of cases.
 *
 * Deliberately unanchored: the marker sits on its own comment line in the primer and the tokenomics
 * runner, and on line 2 of a ~196KB single-line-heavy esbuild bundle. Only the FIRST match counts
 * (no `/g`), which is what keeps the banner authoritative over any later occurrence inside bundled
 * source text.
 */
export function parsePackVersionMarker(text: string): number | null {
  const m = text.match(/octobots-pack-version:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
