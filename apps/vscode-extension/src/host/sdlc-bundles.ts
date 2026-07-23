/**
 * SDLC team bundles — the discovery + command-string logic behind the "Octobots: Install / Update
 * SDLC Team Bundle" commands. Octobots is a thin launcher over the sdlc-skills installer
 * (https://github.com/arozumenko/sdlc-skills): it picks a bundle and opens a terminal running the
 * installer, which owns the guided, interactive flow. Nothing here captures output or verifies the
 * install — sdlc-skills stays the single source of truth for what a bundle contains.
 */

export interface Bundle {
  id: string;
  label: string;
  description: string;
}

/**
 * The known bundles, used both as rich QuickPick metadata and as the offline fallback list. When
 * the dynamic catalog fetch fails, this is what the command still offers.
 */
export const FALLBACK_BUNDLES: Bundle[] = [
  {
    id: "feature-development",
    label: "Feature Development",
    description: "Cross-platform delivery team (scout, BA, PM, tech-lead, QA + dev roles).",
  },
  {
    id: "manual-qa",
    label: "Manual QA",
    description: "Six manual-QA specialists for live browser testing.",
  },
  {
    id: "test-automation",
    label: "Test Automation",
    description: "Automation pipeline: analyst → implementer → reviewer.",
  },
];

/** The GitHub contents API listing of the sdlc-skills `bundles/` directory. */
const BUNDLES_CONTENTS_URL = "https://api.github.com/repos/arozumenko/sdlc-skills/contents/bundles";

/**
 * A safe bundle id: a lowercase-kebab slug. Discovered ids are validated against this before they
 * are ever interpolated into the installer command — a directory name is untrusted input (the repo
 * could be compromised, or the user may point at a fork), and the command is auto-run in a terminal,
 * so anything outside this charset (spaces, `;`, `&&`, `$()`, …) is dropped rather than executed.
 */
const SAFE_BUNDLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Build the sdlc-skills installer command for a bundle. `update:true` appends `--update`, which the
 * installer treats as "overwrite existing installs" (it still preserves seeded briefings).
 */
export function bundleInstallCommand(id: string, opts: { update?: boolean } = {}): string {
  const base = `npx github:arozumenko/sdlc-skills init --bundle ${id}`;
  return opts.update ? `${base} --update` : base;
}

/**
 * Discover the available bundles. One GitHub contents API call lists the `bundles/` directory; each
 * subdirectory name is a bundle id, merged with FALLBACK_BUNDLES metadata (unknown ids appear with
 * the id as their label). On any failure — offline, non-200, malformed body, or no bundle dirs — it
 * returns FALLBACK_BUNDLES, so the command still works offline. `fetchImpl` is injectable for tests.
 */
export async function fetchBundleCatalog(fetchImpl: typeof fetch = fetch): Promise<Bundle[]> {
  try {
    const res = await fetchImpl(BUNDLES_CONTENTS_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return FALLBACK_BUNDLES;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return FALLBACK_BUNDLES;

    const ids = body
      .filter(
        (e): e is { name: string; type: string } =>
          typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string",
      )
      .filter((e) => e.type === "dir")
      .map((e) => e.name)
      // The id becomes a shell token in an auto-run terminal command — never trust a raw dir name.
      .filter((name) => SAFE_BUNDLE_ID.test(name));
    if (ids.length === 0) return FALLBACK_BUNDLES;

    const byId = new Map(FALLBACK_BUNDLES.map((b) => [b.id, b]));
    return ids.map(
      (id) =>
        byId.get(id) ?? {
          id,
          label: id,
          description: `An sdlc-skills team bundle (${id}).`,
        },
    );
  } catch {
    return FALLBACK_BUNDLES;
  }
}
