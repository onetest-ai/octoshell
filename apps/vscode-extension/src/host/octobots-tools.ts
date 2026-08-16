/**
 * `.octobots/tools/` — third-party CLIs the pack uses, installed ONCE per workspace and reused.
 *
 * Today that means `ccusage`, which tokenomics shells out to. It used to be invoked as
 * `npx -y ccusage@<pin>` on every single call, and `npx` re-resolves the package each time:
 * measured on this machine, 823ms per call against 29ms for an installed binary — 28x. The usage
 * wait loop makes up to fifteen calls, so that is ~12 seconds of resolution per session, paid
 * forever, for a tool that never changes between calls.
 *
 * WHY NOT VENDOR IT, like js-yaml and acorn? Because `ccusage` is a 5KB launcher whose real payload
 * is a PLATFORM-SPECIFIC native binary (`@ccusage/ccusage-{darwin,linux,win32}-{arm64,x64}`, ~3.2MB
 * each). Vendoring the launcher alone would still resolve the binary at run time; vendoring all six
 * would put ~19MB of native code into the VSIX; vendoring one would break every other platform.
 * A local install resolves exactly one — the right one for this machine — in ~340ms, once.
 *
 * PROJECT-LOCAL, and opt-in. It lives under the workspace like every other pack payload, so two
 * repos never share a resolved tool, and it is never installed without an explicit yes: it is the
 * one pack step that needs the network.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Pinned deliberately: the version tokenomics was already asking npx for. */
export const CCUSAGE_PIN = "ccusage@20.0.18";

/** Where tools live, relative to the repo root. */
export const TOOLS_REL = join(".octobots", "tools");

/** Absolute path of the installed `ccusage` binary, or null when it is not installed. */
export function resolveCcusage(repoRoot: string): string | null {
  const bin = join(repoRoot, TOOLS_REL, "node_modules", ".bin", "ccusage");
  return existsSync(bin) ? bin : null;
}

export interface ToolsStatus {
  /** `ccusage` is installed in this workspace. */
  ccusage: boolean;
  /** Its resolved path, or null. */
  ccusagePath: string | null;
}

export function toolsStatus(repoRoot: string): ToolsStatus {
  const p = resolveCcusage(repoRoot);
  return { ccusage: p !== null, ccusagePath: p };
}

/**
 * Install (or refresh) the pinned `ccusage` into `<repo>/.octobots/tools`.
 *
 * Returns true on success. NEVER THROWS: this is the only pack step that needs the network, and a
 * machine that is offline, behind a proxy, or without npm must still get a working pack — the
 * tokenomics scripts fall back to `npx` exactly as before, just slowly. A failed install that took
 * the whole install down with it would be a far worse trade.
 */
export function installTools(repoRoot: string): boolean {
  const dir = join(repoRoot, TOOLS_REL);
  try {
    mkdirSync(dir, { recursive: true });
    // `.octobots/` is a COMMITTED board directory in most repos, so node_modules must be excluded
    // or the first `git add` sweeps 3.5MB of native binary into the user's history.
    writeFileSync(
      join(dir, ".gitignore"),
      [
        "# Third-party CLIs installed once per workspace by the Octobots pack.",
        "# Machine-specific (ccusage resolves a native binary per platform) — never commit them.",
        "node_modules/",
        "package.json",
        "package-lock.json",
        "",
      ].join("\n"),
      "utf8",
    );
    execFileSync("npm", ["i", "--prefix", dir, "--no-audit", "--no-fund", "--silent", CCUSAGE_PIN], {
      stdio: "ignore",
      timeout: 120_000,
    });
    return resolveCcusage(repoRoot) !== null;
  } catch {
    return false;
  }
}

/** Remove the workspace's tools directory. Returns true when something was removed. */
export function removeTools(repoRoot: string): boolean {
  const dir = join(repoRoot, TOOLS_REL);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
