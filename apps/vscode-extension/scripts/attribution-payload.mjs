// Generate the dependency-free pack resolver from the library's source of truth.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
const source = new URL("../../../packages/tokenomics/src/attribution.ts", import.meta.url);
const target = new URL("../resources/octobots-pack/tokenomics/attribution.mjs", import.meta.url);
const { code } = await transform(readFileSync(source, "utf8"), {
  loader: "ts",
  target: "es2022",
  format: "esm"
});
const payload = "// Generated from packages/tokenomics/src/attribution.ts. Do not edit.\n" + code;
if (process.argv.includes("--write")) writeFileSync(target, payload);
else if (readFileSync(target, "utf8") !== payload) {
  throw new Error(
    `Stale ${fileURLToPath(target)}; run node apps/vscode-extension/scripts/attribution-payload.mjs --write`
  );
}
