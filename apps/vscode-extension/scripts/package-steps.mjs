// The ordered step plan for scripts/package-vsix.mjs, kept pure so a test can pin it without
// running vsce, vite or the network.
//
// Packaging must leave every tracked file unchanged: a release is cut from a commit, and the VSIX
// has to be reproducible from exactly that commit. The two price refreshers rewrite tracked files
// (packages/tokenomics/src/prices.data.ts, the pack's tokenomics/prices.json), so they are OPT-IN
// (`--refresh-prices` or OCTOSHELL_PACKAGE_REFRESH_PRICES=1). A maintainer who wants fresh rates
// runs the refresh first and commits the result on its own, ahead of the release commit.
import { join } from "node:path";

/** True when the caller asked for the price refresh (flag or env var). */
export function wantsPriceRefresh(argv, env) {
  return argv.includes("--refresh-prices") || env.OCTOSHELL_PACKAGE_REFRESH_PRICES === "1";
}

/**
 * @param {{extDir: string, refreshPrices: boolean}} opts
 * @returns {Array<{label: string, cmd?: string, args?: string[], soft?: boolean, rm?: string[]}>}
 *   `soft` steps may fail without stopping the release; `rm` steps delete paths instead of running
 *   a command.
 */
export function packageSteps({ extDir, refreshPrices }) {
  const steps = [];

  if (refreshPrices) {
    // Both refreshers leave the cached table in place when upstream is unreachable, so a stale
    // table is the worst outcome; they disagree on exit code, so tolerance lives here.
    steps.push(
      {
        label: "extension price refresh",
        cmd: "node",
        args: [join(extDir, "..", "..", "packages", "tokenomics", "scripts", "update-prices.mjs")],
        soft: true,
      },
      {
        label: "pack price refresh",
        cmd: "node",
        args: [join(extDir, "resources", "octobots-pack", "tokenomics", "update-prices.mjs")],
        soft: true,
      },
    );
  }

  // The `build` script runs these two checks; packaging calls esbuild and vite directly, so it
  // must run them itself or a stale store / payload would ship.
  steps.push(
    { label: "verify graph payload", cmd: "node", args: ["scripts/graph-payload.mjs", "--verify"] },
    { label: "verify shipped-skill store", cmd: "node", args: ["scripts/shipped-skills.mjs", "--verify"] },
  );

  // vite runs with emptyOutDir:false, so a stale hashed bundle would otherwise ride along.
  steps.push({
    label: "clean webview output",
    rm: [join(extDir, "media", "assets"), join(extDir, "media", "index.html")],
  });
  steps.push(
    { label: "esbuild host bundle", cmd: "node", args: ["esbuild.mjs"] },
    { label: "vite webview build", cmd: "npx", args: ["--yes", "vite", "build"] },
  );
  return steps;
}
