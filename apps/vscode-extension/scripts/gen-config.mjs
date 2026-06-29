// Regenerates the octoshell.providers.*.enabled + octoshell.defaultProvider config in
// package.json from src/providers.json. Run via `pnpm gen:config` before build; the result
// is COMMITTED so CI can re-run and diff to catch drift.
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const providers = JSON.parse(readFileSync(new URL("../src/providers.json", here), "utf8"));
const pkgUrl = new URL("../package.json", here);
const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));

pkg.contributes ??= {};
const cfg = (pkg.contributes.configuration ??= { title: "Octoshell", properties: {} });
cfg.properties ??= {};

// Drop previously-generated keys, then re-add (deterministic order → idempotent).
for (const k of Object.keys(cfg.properties)) {
  if (k.startsWith("octoshell.providers.") || k === "octoshell.defaultProvider") {
    delete cfg.properties[k];
  }
}
for (const p of providers) {
  // Key ends in `.available`: VS Code title-cases the last segment into the heading
  // ("…: Available"), which reads as a yes/no property even when unchecked — clearer than
  // "Enabled". Availability here = the user's intent to expose the provider; whether the
  // launcher is actually installed is a discovery concern shown in "Octoshell: Show Diagnostics".
  cfg.properties[`octoshell.providers.${p.id}.available`] = {
    type: "boolean",
    default: p.defaultEnabled,
    scope: "window",
    description: `Make the ${p.label} agent provider available in new chats.`,
  };
}
cfg.properties["octoshell.defaultProvider"] = {
  type: "string",
  default: providers[0].id,
  scope: "window",
  markdownDescription:
    `Default agent provider for new chats. Known: ${providers.map((p) => "`" + p.id + "`").join(", ")}. A custom agent id is also accepted.`,
};

writeFileSync(pkgUrl, JSON.stringify(pkg, null, 2) + "\n");
console.log("Regenerated octoshell.providers.* config from providers.json");
