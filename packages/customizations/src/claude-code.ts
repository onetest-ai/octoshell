import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { collectFiles } from "./walk.js";
import { parseFrontmatter } from "./frontmatter.js";
import { firstHeadingOrLine } from "./text.js";
import type { CustomizationItem, ProviderReader, ReaderContext } from "./types.js";

const PROVIDER = "claude-acp";

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function id(scope: string, kind: string, name: string, location: string): string {
  return `${PROVIDER}:${kind}:${scope}:${name}:${location}`;
}

const norm = (p: string): string => p.replace(/\\/g, "/");
const isAgent = (rel: string): boolean => /(^|\/)\.claude\/agents\/.+\.md$/i.test(norm(rel));
const isSkill = (rel: string): boolean => /(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/.test(norm(rel));
const isRule = (rel: string): boolean => /(^|\/)\.claude\/rules\/[^/]+\.md$/.test(norm(rel));
const isClaudeMd = (_rel: string, name: string): boolean => name === "CLAUDE.md";
const isSettings = (rel: string): boolean =>
  /(^|\/)\.claude\/(settings\.json|settings\.local\.json)$/.test(norm(rel));
const isProjectMcp = (rel: string): boolean => norm(rel) === ".mcp.json";

// Glob-ish exclude supporting the `**/x/**` patterns claudeMdExcludes uses, matched against the
// absolute path (or any path suffix).
function matchesAnyGlob(absPath: string, globs: string[]): boolean {
  const p = norm(absPath);
  return globs.some((g) => {
    const re = new RegExp(
      "^" +
        norm(g)
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, " ")
          .replace(/\*/g, "[^/]*")
          .replace(/ /g, ".*") +
        "$",
    );
    return re.test(p) || re.test("/" + p) || re.test(p.replace(/^[^/]*/, ""));
  });
}

function locationOf(projectDir: string, absFile: string): string {
  let rel = norm(relative(projectDir, dirname(absFile)));
  // A config under `.claude/...` belongs to the folder that *owns* that `.claude` dir, so
  // collapse the location to everything before `/.claude` (e.g. `packages/api/.claude/agents`
  // → `packages/api`, and a top-level `.claude/...` → `` the project root).
  const parts = rel.split("/");
  const idx = parts.indexOf(".claude");
  if (idx >= 0) rel = parts.slice(0, idx).join("/");
  return rel === "." || rel === "" ? "" : rel;
}

function mkFile(
  kind: CustomizationItem["kind"],
  scope: "project" | "user",
  name: string,
  description: string | undefined,
  location: string,
  path: string,
  format: CustomizationItem["file"]["format"],
  editable: boolean,
  paths?: string,
): CustomizationItem {
  return {
    id: id(scope, kind, name, location),
    kind, provider: PROVIDER, scope, name, description,
    location: scope === "project" ? location : undefined,
    file: { path, format }, editable, paths,
  };
}

function readHooks(text: string, scope: "project" | "user", path: string, location: string, editable: boolean): CustomizationItem[] {
  let cfg: { hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]> };
  try {
    cfg = JSON.parse(text);
  } catch {
    return [];
  }
  const out: CustomizationItem[] = [];
  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const g of groups ?? []) {
      for (const h of g.hooks ?? []) {
        const name = g.matcher ? `${event} (${g.matcher})` : event;
        out.push({
          id: id(scope, "hook", `${basename(path)}:${name}:${h.command ?? ""}`, location),
          kind: "hook", provider: PROVIDER, scope, name, description: h.command,
          location: scope === "project" ? location : undefined,
          file: { path, format: "json" }, locator: { key: event }, editable,
        });
      }
    }
  }
  return out;
}

function readMcp(text: string, scope: "project" | "user", path: string, location: string, editable: boolean): CustomizationItem[] {
  let cfg: { mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }> };
  try {
    cfg = JSON.parse(text);
  } catch {
    return [];
  }
  return Object.entries(cfg.mcpServers ?? {}).map(([key, s]) => ({
    id: id(scope, "mcp", key, location),
    kind: "mcp" as const, provider: PROVIDER, scope, name: key,
    description: s.url ?? ([s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || undefined),
    location: scope === "project" ? location : undefined,
    file: { path, format: "json" as const }, locator: { key }, editable,
  }));
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function readUserDir(ctx: ReaderContext): CustomizationItem[] {
  const root = ctx.claudeConfigDir;
  const out: CustomizationItem[] = [];
  // user agents: any .md under ~/.claude/agents (recursive), identified by frontmatter name
  for (const f of collectFiles(join(root, "agents"), ctx, (rel) => /\.md$/i.test(rel))) {
    const fm = parseFrontmatter(read(f.abs));
    if (!fm.name) continue;
    out.push(mkFile("agent", "user", fm.name, fm.description, "", f.abs, "md", false, fm.paths));
  }
  const skillsRoot = join(root, "skills");
  try {
    for (const name of readdirSync(skillsRoot)) {
      const sp = join(skillsRoot, name, "SKILL.md");
      if (existsSync(sp)) {
        const fm = parseFrontmatter(read(sp));
        out.push(mkFile("skill", "user", fm.name ?? name, fm.description, "", sp, "md", false, fm.paths));
      }
    }
  } catch {
    /* none */
  }
  const userClaudeMd = join(root, "CLAUDE.md");
  if (existsSync(userClaudeMd)) {
    const text = read(userClaudeMd);
    out.push(mkFile("instruction", "user", "~/.claude/CLAUDE.md", firstHeadingOrLine(stripFrontmatter(text)), "", userClaudeMd, "md", false));
  }
  const userSettings = join(root, "settings.json");
  if (existsSync(userSettings)) out.push(...readHooks(read(userSettings), "user", userSettings, "", false));
  // The global config JSON is inside CLAUDE_CONFIG_DIR when that's in use, else a sibling of $HOME.
  // claudeConfigDir is `${homeDir}/.claude` only in the default case; otherwise it's CLAUDE_CONFIG_DIR.
  const defaultClaudeDir = join(ctx.homeDir, ".claude");
  const globalJson = ctx.claudeConfigDir === defaultClaudeDir
    ? join(ctx.homeDir, ".claude.json")
    : join(ctx.claudeConfigDir, ".claude.json");
  if (existsSync(globalJson)) out.push(...readMcp(read(globalJson), "user", globalJson, "", false));
  return out;
}

export const claudeCodeReader: ProviderReader = {
  id: PROVIDER,
  read(ctx: ReaderContext): CustomizationItem[] {
    const items: CustomizationItem[] = [];
    const matched = collectFiles(ctx.projectDir, ctx, (rel, name) =>
      isAgent(rel) || isSkill(rel) || isRule(rel) || isClaudeMd(rel, name) || isSettings(rel) || isProjectMcp(rel),
    );

    const excludeGlobs: string[] = [];
    for (const f of matched.filter((m) => isSettings(m.rel))) {
      try {
        const s = JSON.parse(read(f.abs)) as { claudeMdExcludes?: string[] };
        if (Array.isArray(s.claudeMdExcludes)) excludeGlobs.push(...s.claudeMdExcludes);
      } catch {
        /* skip malformed */
      }
    }

    for (const f of matched) {
      const loc = locationOf(ctx.projectDir, f.abs);
      if (isAgent(f.rel)) {
        const fm = parseFrontmatter(read(f.abs));
        if (!fm.name) continue; // not a subagent (e.g. SOUL.md / README); CC identifies by `name`
        items.push(mkFile("agent", "project", fm.name, fm.description, loc, f.abs, "md", true, fm.paths));
      } else if (isSkill(f.rel)) {
        const fm = parseFrontmatter(read(f.abs));
        items.push(mkFile("skill", "project", fm.name ?? basename(dirname(f.abs)), fm.description, loc, f.abs, "md", true, fm.paths));
      } else if (isRule(f.rel)) {
        const text = read(f.abs);
        const fm = parseFrontmatter(text);
        items.push(mkFile("instruction", "project", norm(f.rel), firstHeadingOrLine(stripFrontmatter(text)), loc, f.abs, "md", true, fm.paths));
      } else if (isClaudeMd(f.rel, basename(f.abs))) {
        if (matchesAnyGlob(f.abs, excludeGlobs)) continue;
        const text = read(f.abs);
        items.push(mkFile("instruction", "project", norm(f.rel), firstHeadingOrLine(stripFrontmatter(text)), loc, f.abs, "md", true));
      } else if (isSettings(f.rel)) {
        items.push(...readHooks(read(f.abs), "project", f.abs, loc, true));
      } else if (isProjectMcp(f.rel)) {
        items.push(...readMcp(read(f.abs), "project", f.abs, loc, true));
      }
    }

    items.push(...readUserDir(ctx));
    return items;
  },
};
