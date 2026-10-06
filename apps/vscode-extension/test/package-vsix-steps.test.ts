import { describe, expect, it } from "vitest";
import { packageSteps, wantsPriceRefresh } from "../scripts/package-steps.mjs";

type Step = { label: string; cmd?: string; args?: string[]; soft?: boolean };
const argsOf = (s: Step) => s.args ?? [];
const labels = (steps: Step[]) => steps.map((s) => s.label);

describe("package-vsix step plan", () => {
  it("does not refresh prices by default, so packaging leaves tracked files unchanged", () => {
    const steps = packageSteps({ extDir: "/ext", refreshPrices: false }) as Step[];
    expect(steps.some((s) => argsOf(s).some((a) => a.endsWith("update-prices.mjs")))).toBe(false);
  });

  it("refreshes both price tables, softly and first, only when asked", () => {
    const steps = packageSteps({ extDir: "/ext", refreshPrices: true }) as Step[];
    const refresh = steps.filter((s) => argsOf(s).some((a) => a.endsWith("update-prices.mjs")));
    expect(refresh).toHaveLength(2);
    expect(refresh.every((s) => s.soft === true)).toBe(true);
    expect(steps.slice(0, 2)).toEqual(refresh);
  });

  it("verifies the shipped-skill store before it builds anything", () => {
    const steps = packageSteps({ extDir: "/ext", refreshPrices: false }) as Step[];
    const verify = steps.findIndex((s) => argsOf(s).includes("shipped-skills.mjs") || argsOf(s).some((a) => a.endsWith("shipped-skills.mjs")));
    const build = steps.findIndex((s) => argsOf(s).includes("esbuild.mjs"));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(build);
    expect(argsOf(steps[verify] as Step)).toContain("--verify");
    expect(steps[verify]?.soft).toBeFalsy();
  });

  it("cleans the webview output before the vite build", () => {
    const steps = packageSteps({ extDir: "/ext", refreshPrices: false }) as Step[];
    expect(labels(steps).indexOf("clean webview output")).toBeLessThan(
      steps.findIndex((s) => argsOf(s).includes("vite")),
    );
  });

  it("reads the refresh opt-in from the flag or the env var", () => {
    expect(wantsPriceRefresh([], {})).toBe(false);
    expect(wantsPriceRefresh(["--refresh-prices"], {})).toBe(true);
    expect(wantsPriceRefresh([], { OCTOSHELL_PACKAGE_REFRESH_PRICES: "1" })).toBe(true);
    expect(wantsPriceRefresh([], { OCTOSHELL_PACKAGE_REFRESH_PRICES: "0" })).toBe(false);
  });
});
