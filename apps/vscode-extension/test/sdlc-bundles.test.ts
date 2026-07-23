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
  it("ships the three known bundles with rich metadata", () => {
    const ids = FALLBACK_BUNDLES.map((b) => b.id);
    expect(ids).toEqual(["feature-development", "manual-qa", "test-automation"]);
    for (const b of FALLBACK_BUNDLES) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
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
});
