import { describe, it, expect } from "vitest";
import {
  FALLBACK_BUNDLES,
  bundleInstallCommand,
  fetchBundleCatalog,
} from "../src/host/sdlc-bundles.js";

describe("bundleInstallCommand", () => {
  it("builds the install command for a bundle id", () => {
    expect(bundleInstallCommand("manual-qa")).toBe(
      "npx github:arozumenko/sdlc-skills init --bundle manual-qa",
    );
  });

  it("appends --update in update mode", () => {
    expect(bundleInstallCommand("manual-qa", { update: true })).toBe(
      "npx github:arozumenko/sdlc-skills init --bundle manual-qa --update",
    );
  });

  it("does not append --update when update is false", () => {
    expect(bundleInstallCommand("test-automation", { update: false })).toBe(
      "npx github:arozumenko/sdlc-skills init --bundle test-automation",
    );
  });
});

describe("FALLBACK_BUNDLES", () => {
  it("ships every known bundle with rich metadata", () => {
    const ids = FALLBACK_BUNDLES.map((b) => b.id);
    expect(ids).toEqual([
      "feature-development",
      "manual-qa",
      "product-management",
      "test-automation",
    ]);
    for (const b of FALLBACK_BUNDLES) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  // The symptom that sent us here: a bundle present in sdlc-skills but absent from this table
  // renders as its own slug plus a generic sentence, which reads as an unfinished product rather
  // than as missing metadata. A label equal to the id is the tell.
  it("gives every bundle a human label, never a bare slug", () => {
    for (const b of FALLBACK_BUNDLES) {
      expect(b.label).not.toBe(b.id);
    }
  });
});

/** A GitHub contents API response body: a mix of dir + file entries. */
function contentsJson(names: Array<{ name: string; type: "dir" | "file" }>): string {
  return JSON.stringify(names.map((n) => ({ name: n.name, type: n.type })));
}

function okResponse(body: string): Response {
  return { ok: true, status: 200, json: async () => JSON.parse(body) } as unknown as Response;
}

describe("fetchBundleCatalog", () => {
  it("merges discovered ids with fallback metadata, ignoring non-dir entries", async () => {
    const fetchImpl = async () =>
      okResponse(
        contentsJson([
          { name: "manual-qa", type: "dir" },
          { name: "feature-development", type: "dir" },
          { name: "README.md", type: "file" }, // must be ignored
        ]),
      );
    const catalog = await fetchBundleCatalog(fetchImpl as unknown as typeof fetch);
    const byId = Object.fromEntries(catalog.map((b) => [b.id, b]));
    expect(Object.keys(byId).sort()).toEqual(["feature-development", "manual-qa"]);
    // Known ids keep their rich fallback label (not the bare id).
    expect(byId["manual-qa"]!.label).toBe(
      FALLBACK_BUNDLES.find((b) => b.id === "manual-qa")!.label,
    );
  });

  it("synthesizes an entry for an unknown discovered id (label === id)", async () => {
    const fetchImpl = async () =>
      okResponse(contentsJson([{ name: "data-engineering", type: "dir" }]));
    const catalog = await fetchBundleCatalog(fetchImpl as unknown as typeof fetch);
    const unknown = catalog.find((b) => b.id === "data-engineering");
    expect(unknown).toBeDefined();
    expect(unknown!.label).toBe("data-engineering");
    expect(unknown!.description.length).toBeGreaterThan(0);
  });

  it("falls back to FALLBACK_BUNDLES when the fetch rejects", async () => {
    const fetchImpl = async () => {
      throw new Error("offline");
    };
    expect(await fetchBundleCatalog(fetchImpl as unknown as typeof fetch)).toEqual(FALLBACK_BUNDLES);
  });

  it("falls back on a non-200 response", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 }) as unknown as Response;
    expect(await fetchBundleCatalog(fetchImpl as unknown as typeof fetch)).toEqual(FALLBACK_BUNDLES);
  });

  it("falls back on a malformed (non-array) body", async () => {
    const fetchImpl = async () =>
      ({ ok: true, status: 200, json: async () => ({ nope: true }) }) as unknown as Response;
    expect(await fetchBundleCatalog(fetchImpl as unknown as typeof fetch)).toEqual(FALLBACK_BUNDLES);
  });

  it("falls back when the discovery yields no bundle dirs", async () => {
    const fetchImpl = async () => okResponse(contentsJson([{ name: "README.md", type: "file" }]));
    expect(await fetchBundleCatalog(fetchImpl as unknown as typeof fetch)).toEqual(FALLBACK_BUNDLES);
  });

  it("drops ids with unsafe characters — a dir name is never trusted as a shell token", async () => {
    // A compromised/forked repo could name a bundle dir with shell metacharacters; the id ends up
    // in an auto-run terminal command, so anything outside the safe slug charset must be excluded.
    const fetchImpl = async () =>
      okResponse(
        contentsJson([
          { name: "manual-qa", type: "dir" }, // safe → kept
          { name: "x; rm -rf ~", type: "dir" }, // injection → dropped
          { name: "$(curl evil)", type: "dir" }, // injection → dropped
          { name: "Feature_Dev", type: "dir" }, // underscores/caps → dropped
        ]),
      );
    const catalog = await fetchBundleCatalog(fetchImpl as unknown as typeof fetch);
    expect(catalog.map((b) => b.id)).toEqual(["manual-qa"]);
  });
});

/**
 * Labels and descriptions used to be COPIED into FALLBACK_BUNDLES from data owned by sdlc-skills,
 * with no signal when upstream changed. Two of three entries had already drifted, and a bundle
 * absent from the table rendered as its bare slug. Upstream `bundles/<id>/bundle.json` is now the
 * authority; the table is strictly the offline path.
 * (github.com/onetest-ai/octoshell/issues/96)
 */
describe("fetchBundleCatalog reads bundle.json as the authority", () => {
  /** Route the contents listing and each bundle.json to different bodies, as the real host does. */
  function routed(listing: Array<{ name: string; type: string }>, meta: Record<string, unknown>) {
    return (async (url: string) => {
      if (url.includes("/contents/bundles")) return okResponse(contentsJson(listing));
      const id = /bundles\/([^/]+)\/bundle\.json/.exec(url)?.[1];
      if (id && id in meta) return okResponse(JSON.stringify(meta[id]));
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("prefers upstream title/description over the hardcoded table", async () => {
    const catalog = await fetchBundleCatalog(
      routed([{ name: "manual-qa", type: "dir" }], {
        "manual-qa": { title: "Manual Testing Team", description: "Upstream description wins." },
      }),
    );
    expect(catalog[0]!.label).toBe("Manual Testing Team");
    expect(catalog[0]!.description).toBe("Upstream description wins.");
    // and it is genuinely different from what this repo hardcodes — the drift the issue reported
    expect(catalog[0]!.label).not.toBe(FALLBACK_BUNDLES.find((b) => b.id === "manual-qa")!.label);
  });

  it("a bundle absent from the table appears with its real name, not its slug", async () => {
    const catalog = await fetchBundleCatalog(
      routed([{ name: "brand-new", type: "dir" }], {
        "brand-new": { title: "Brand New Team", description: "Ships without an octoshell change." },
      }),
    );
    expect(catalog[0]!.label).toBe("Brand New Team");
    expect(catalog[0]!.label).not.toBe("brand-new"); // the visible symptom in the issue
  });

  it("falls back to the table when a bundle.json is unreachable", async () => {
    const catalog = await fetchBundleCatalog(routed([{ name: "manual-qa", type: "dir" }], {}));
    const fb = FALLBACK_BUNDLES.find((b) => b.id === "manual-qa")!;
    expect(catalog[0]!.label).toBe(fb.label);
    expect(catalog[0]!.description).toBe(fb.description);
  });

  it("one unreachable bundle.json does not cost the rest of the catalog", async () => {
    const catalog = await fetchBundleCatalog(
      routed([{ name: "manual-qa", type: "dir" }, { name: "test-automation", type: "dir" }], {
        "test-automation": { title: "Test Automation Team", description: "ok" },
      }),
    );
    expect(catalog).toHaveLength(2);
    expect(catalog.find((b) => b.id === "test-automation")!.label).toBe("Test Automation Team");
  });

  // ── untrusted remote text reaching a QuickPick ──────────────────────────────────────────────
  it("strips newlines, so remote text cannot forge a second QuickPick row", async () => {
    const catalog = await fetchBundleCatalog(
      routed([{ name: "manual-qa", type: "dir" }], {
        "manual-qa": {
          title: "Real Team\nFAKE ROW — install malware",
          description: "line one\r\nline two",
        },
      }),
    );
    expect(catalog[0]!.label).not.toContain("\n");
    expect(catalog[0]!.description).not.toContain("\n");
    expect(catalog[0]!.label).toBe("Real Team FAKE ROW — install malware");
  });

  it("caps absurd lengths rather than rendering a wall of text", async () => {
    const catalog = await fetchBundleCatalog(
      routed([{ name: "manual-qa", type: "dir" }], {
        "manual-qa": { title: "T".repeat(500), description: "D".repeat(5000) },
      }),
    );
    expect(catalog[0]!.label.length).toBeLessThanOrEqual(60);
    expect(catalog[0]!.description.length).toBeLessThanOrEqual(200);
  });

  it("ignores non-string and empty fields, falling back rather than rendering junk", async () => {
    const fb = FALLBACK_BUNDLES.find((b) => b.id === "manual-qa")!;
    const catalog = await fetchBundleCatalog(
      routed([{ name: "manual-qa", type: "dir" }], {
        "manual-qa": { title: 42, description: "   " },
      }),
    );
    expect(catalog[0]!.label).toBe(fb.label);
    expect(catalog[0]!.description).toBe(fb.description);
  });
});
