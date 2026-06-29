#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Parse flag-based CLI: --key value or --flag (boolean)
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--force") { args.force = true; continue; }
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      args[key] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Validate required args
const { id, title, backend, roster, description, orchestrator, force } = args;
const VALID_BACKENDS = ["claude", "copilot", "codex"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

if (!id || !title || !backend || !roster) {
  console.error(
    "usage: create-team.js --id <slug> --title <text> --backend <claude|copilot|codex> " +
    "--roster <r1,r2,...> [--orchestrator <role>] [--description <text>] [--force]",
  );
  process.exit(2);
}

if (!ID_RE.test(id)) {
  console.error(`create-team: invalid --id '${id}' (must match ^[a-z0-9][a-z0-9-]*$)`);
  process.exit(2);
}

if (!VALID_BACKENDS.includes(backend)) {
  console.error(`create-team: invalid --backend '${backend}' (must be one of: ${VALID_BACKENDS.join(", ")})`);
  process.exit(2);
}

const roles = roster.split(",").map((r) => r.trim()).filter(Boolean);
if (roles.length === 0) {
  console.error("create-team: --roster must be a non-empty comma-separated list of roles");
  process.exit(2);
}

if (orchestrator && !roles.includes(orchestrator)) {
  console.error(`create-team: --orchestrator "${orchestrator}" must be one of the roster roles: ${roles.join(", ")}`);
  process.exit(2);
}

// Resolve output path
const teamsDir = join(process.cwd(), ".octobots", "teams");
const outPath = join(teamsDir, `${id}.json`);

// Guard against overwrite
if (existsSync(outPath) && !force) {
  console.error(`create-team: team '${id}' already exists (use --force to overwrite)`);
  process.exit(1);
}

// Warn about uninstalled roles (non-fatal)
const agentsDir = join(process.cwd(), ".claude", "agents");
for (const role of roles) {
  const rolePath = join(agentsDir, role);
  if (!existsSync(rolePath) || !statSync(rolePath).isDirectory()) {
    console.error(`warning: role '${role}' is not installed in .claude/agents`);
  }
}

// Build marker (omit description key when not provided)
const marker = { id, title };
if (description !== undefined && description !== "") marker.description = description;
marker.roster = roles;
marker.backend = backend;
if (orchestrator) marker.orchestrator = orchestrator;

// Write
mkdirSync(teamsDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(marker, null, 2) + "\n", "utf8");
console.log(`created team: ${id} (.octobots/teams/${id}.json)`);
