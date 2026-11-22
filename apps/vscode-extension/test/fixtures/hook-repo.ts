import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCampaign, createMission } from "@octoshell/board";
import { mkdtempClean } from "./tmpdir.js";
import { installPlannerScripts } from "./status-flip-board.js";

export const PACK = join(__dirname, "..", "..", "resources", "octobots-pack");

/** The shim texts the task specifies, written out here so the tests do not read them from the code under test. */
export const PREPARE_SHIM = `#!/bin/sh\nnode "$(git rev-parse --show-toplevel)/.octobots/hooks/prepare-commit-msg.mjs" "$@"; exit 0\n`;
export const COMMIT_SHIM = `#!/bin/sh\nnode "$(git rev-parse --show-toplevel)/.octobots/hooks/prepare-commit-msg.mjs" --after-edit "$@"; exit 0\n`;

/** A git environment that ignores the developer's and any enclosing hook's repository variables. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(key)) delete env[key];
  }
  delete env.OCTOBOTS_CODEX_MODEL;
  delete env.CLAUDE_CODE_SESSION_ID;
  return { ...env, ...extra };
}

export interface HookRepo {
  root: string;
  /** The campaign's folder name, which is the slug a branch must carry. */
  slug: string;
  /** Absolute path of M1's mission.yaml. */
  m1Yaml: string;
  git: (...args: string[]) => string;
  commit: (branch: string, opts?: { args?: string[]; env?: Record<string, string>; amend?: boolean }) => SpawnSyncReturns<string>;
  body: () => string;
}

export interface HookRepoOptions {
  /** Install the shims at `core.hooksPath` (default true). */
  shims?: boolean;
}

export const trailers = (body: string): string[] => body.split("\n").filter((l) => /^Octobots-(Mission|Campaign):/.test(l));

/**
 * A git repo with a real board (campaign "Demo Factory", missions M1 and M2), the pack's hooks and
 * tokenomics copied where installPack puts them, its own pre-commit and pre-push in `.githooks`, and
 * the two committed shims.
 */
export function hookRepo(prefix = "hook-repo-", opts: HookRepoOptions = {}): HookRepo {
  const root = mkdtempClean(prefix);
  const env = gitEnv();
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "scratch/x");
  git("config", "user.name", "Hook Test");
  git("config", "user.email", "hook@example.invalid");
  installPlannerScripts(root);
  cpSync(join(PACK, "tokenomics"), join(root, ".octobots", "tokenomics"), { recursive: true });
  cpSync(join(PACK, "hooks"), join(root, ".octobots", "hooks"), { recursive: true });
  const boardRoot = join(root, ".octobots");
  const c = createCampaign(boardRoot, { name: "Demo Factory" });
  const m1 = createMission(boardRoot, c.id, { title: "M1 - First", acceptanceCriteria: "- [ ] a" });
  createMission(boardRoot, c.id, { title: "M2 - Second", acceptanceCriteria: "- [ ] a" });
  const hooks = join(root, ".githooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\n# the repo's own pre-commit\nexit 0\n");
  writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\n# the repo's own pre-push\nexit 0\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  chmodSync(join(hooks, "pre-push"), 0o755);
  git("config", "core.hooksPath", ".githooks");
  if (opts.shims !== false) {
    writeFileSync(join(hooks, "prepare-commit-msg"), PREPARE_SHIM);
    writeFileSync(join(hooks, "commit-msg"), COMMIT_SHIM);
    chmodSync(join(hooks, "prepare-commit-msg"), 0o755);
    chmodSync(join(hooks, "commit-msg"), 0o755);
  }
  const commit = (branch: string, o: { args?: string[]; env?: Record<string, string>; amend?: boolean } = {}) => {
    git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
    const args = o.amend ? ["--amend", "--no-edit"] : (o.args ?? ["-m", "Hook probe"]);
    return spawnSync("git", ["commit", "-q", "--allow-empty", ...args], { cwd: root, encoding: "utf8", env: gitEnv(o.env ?? {}) });
  };
  return { root, slug: c.folderPath.split("/").pop()!, m1Yaml: join(boardRoot, m1.folderPath, "mission.yaml"), git, commit, body: () => git("log", "-1", "--format=%B") };
}

/** sha-free snapshot of a directory's regular files: name -> content. */
export function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), "utf8");
  return out;
}
