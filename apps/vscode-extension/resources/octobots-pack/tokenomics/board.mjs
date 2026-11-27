// Board reader extracted from rollup.mjs. Importing performs no I/O.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadBoard(projectDir = process.cwd(), log = console.error, { strict = false, tasks: withTasks = true } = {}) {
  const PROJECT_DIR = projectDir;
  const CAMPAIGNS_DIR = join(projectDir, ".octobots/campaigns");
  if (strict && !existsSync(CAMPAIGNS_DIR)) throw new Error("missing .octobots/campaigns");
  let yamlLoad = null;
  for (const spec of [
    pathToFileURL(
      join(PROJECT_DIR, ".claude", "skills", "mission-planner", "scripts", "vendor", "js-yaml.mjs")
    ).href,
    "js-yaml"
  ]) {
    try {
      const mod = await import(spec);
      yamlLoad = mod.load ?? mod.default?.load ?? null;
      if (typeof yamlLoad === "function") break;
      yamlLoad = null;
    } catch {
      // Try the next candidate; absence is reported by loadBoard(), not here.
    }
  }
  if (strict && !yamlLoad) throw new Error("no YAML parser found; install the Octobots pack");

  // A `## Tokenomics` block on any board file:
  //   effort_days: 3
  //   size_tshirt: M
  //   complexity_score: 18
  function parseTokenomicsBlock(text, END) {
    const out = {};
    const block = text.match(new RegExp(`^##\\s+Tokenomics\\s*\\n([\\s\\S]*?)${END}`, "m"))?.[1];
    if (!block) return out;
    for (const line of block.split("\n")) {
      const m = line.match(/^\s*[-*]?\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
      if (m) out[m[1].toLowerCase()] = m[2];
    }
    return out;
  }

  // An authored map — YAML `tokenomics:` or a legacy `## Tokenomics` block — folded
  // to flat lowercase strings. Every downstream consumer already coerces with
  // `Number(...)`, `?? null` or `=== "true"`, so normalising HERE lets both board
  // formats flow through the row builders unchanged. A YAML list (`branches: [a, b]`)
  // re-joins to the comma string `declaredBranches` splits.
  function normaliseAuthored(map) {
    const out = {};
    if (!map || typeof map !== "object") return out;
    for (const [k, v] of Object.entries(map)) {
      if (v === null || v === undefined) continue;
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    return out;
  }

  function readYamlEntity(file) {
    if (!existsSync(file) || !yamlLoad) return null;
    try {
      const doc = yamlLoad(readFileSync(file, "utf8"));
      return doc && typeof doc === "object" ? doc : {};
    } catch (e) {
      log(`tokenomics: WARN could not parse ${file}: ${e.message}`);
      return null;
    }
  }

  // A mission id is `M<n>` or `M<n><letter>` (M6b); a task id is `T<n>.<k>` or `T<n><letter>.<k>`.
  // Missions are matched by their FULL key ("6", "6b"), never by the bare number: M6 and M6b are
  // different missions. `missionNumOf` is the numeric part, used only to sort (6 < 6b < 7).
  const missionKeyOf = (id) => String(id).replace(/^M/i, "").toLowerCase();
  const missionNumOf = (id) => parseInt(missionKeyOf(id), 10);
  const missionIdFromSlug = (dir) => {
    const m = dir.match(/^m(\d+[a-z]?)(?![a-z\d])/i);
    return m ? `M${m[1].toLowerCase()}` : dir;
  };

  // `M1 - Name` / `T2.3 - Name`. The `<id> - <name>` title is a board contract, and
  // on a YAML entity the id lives nowhere else — the folder slug is only a fallback.
  function splitTitle(title, fallbackId) {
    const m = /^\s*([MT]\d+[a-z]?(?:\.\d+)?)\s*[-–—:]\s*(.+)$/.exec(String(title ?? ""));
    if (m) return { id: m[1], name: m[2].trim() };
    return { id: fallbackId, name: String(title ?? "").trim() || fallbackId };
  }

  function taskIdFromSlug(dir) {
    const m = dir.match(/^t(\d+[a-z]?)-(\d+)/i);
    return m ? `T${m[1].toLowerCase()}.${m[2]}` : null;
  }

  // Per-task estimates live in each `tasks/<slug>/task.yaml` (`tokenomics:`), or in
  // the planner-owned `## Tokenomics` block of a legacy `task.md`. Estimating at
  // PLANNING time is the point: effort is the rubric's sizing key and cannot be
  // recovered afterwards.
  //
  // On a YAML board the task LIST is folder-derived too — a parent never projects
  // its children — so this returns both the tasks and their estimates.
  function loadTasks(missionPath, END) {
    const est = new Map();
    const tasks = [];
    if (!withTasks) return { tasks, est };
    const tasksDir = join(missionPath, "tasks");
    if (!existsSync(tasksDir)) return { tasks, est };

    for (const dir of readdirSync(tasksDir).sort()) {
      const slugId = taskIdFromSlug(dir);
      const y = readYamlEntity(join(tasksDir, dir, "task.yaml"));
      if (y) {
        const { id, name } = splitTitle(y.name, slugId);
        if (!id) continue;
        tasks.push({
          id,
          name,
          role: y.role ?? null,
          status: y.status ?? null,
          num: Number(id.split(".")[1])
        });
        const a = normaliseAuthored(y.tokenomics);
        if (Object.keys(a).length) est.set(id, a);
        continue;
      }
      // Legacy: the task list comes from the mission's `## Tasks` section, so only
      // the estimate is harvested here.
      const f = join(tasksDir, dir, "task.md");
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      const id = text.match(/^#\s+(T\d+[a-z]?\.\d+)\b/m)?.[1] ?? slugId;
      if (!id) continue;
      const a = normaliseAuthored(parseTokenomicsBlock(text, END));
      if (Object.keys(a).length) est.set(id, a);
    }
    return { tasks, est };
  }

  function parseMissionYaml(campaignSlug, missionDir, missionPath, doc) {
    const { id, name } = splitTitle(doc.name, missionIdFromSlug(missionDir));

    const desc = String(doc.description ?? "");
    const brief = desc.trim().replace(/\s+/g, " ").slice(0, 400);
    const tracker = `${desc}\n${doc.notes ?? ""}`.match(/Tracker:\s*(\S+#\d+)/)?.[1] ?? null;

    const criteria = Array.isArray(doc.acceptance_criteria) ? doc.acceptance_criteria : [];
    const authored = normaliseAuthored(doc.tokenomics);
    const { tasks, est: taskEstimates } = loadTasks(missionPath, null);

    return {
      id,
      name,
      campaign: campaignSlug,
      dir: missionDir,
      brief,
      tracker,
      tasks,
      taskEstimates,
      criteria_total: criteria.length,
      criteria_done: criteria.filter((c) => c && c.done === true).length,
      authored,
      declaredBranches: (authored.branches ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      missionNum: missionNumOf(id),
      missionKey: missionKeyOf(id)
    };
  }

  function parseMission(campaignSlug, missionDir, missionPath) {
    const path = join(missionPath, "mission.md");
    const text = readFileSync(path, "utf8");
    const titleMatch = text.match(/^#\s+(M\d+[a-z]?)\s*[-–]\s*(.+)$/m);
    const id = titleMatch?.[1] ?? missionIdFromSlug(missionDir);
    const name = titleMatch?.[2]?.trim() ?? missionDir;

    // Description = the `## Description` body, collapsed to a brief.
    // NOTE: the terminating `$` must be end-of-INPUT, not end-of-line — under the
    // `/m` flag needed for `^##`, a bare `$` makes the lazy body match stop at the
    // first newline and silently truncate the block to one line.
    const END = "(?=\\n##\\s|\\n<!--|$(?![\\s\\S]))";
    const desc =
      text.match(new RegExp(`^##\\s+Description\\s*\\n([\\s\\S]*?)${END}`, "m"))?.[1] ?? "";
    const brief = desc.trim().replace(/\s+/g, " ").slice(0, 400);

    const criteria = [...text.matchAll(/^-\s+\[( |x)\]\s+(.+)$/gm)].map((m) => ({
      done: m[1] === "x",
      text: m[2]
    }));
    const tracker = text.match(/Tracker:\s*(\S+#\d+)/)?.[1] ?? null;

    // Authored (non-derivable) fields live in an optional `## Tokenomics` block:
    //   effort_days: 3
    //   complexity_score: 18
    //   self_size: M
    //   maturity: production
    //   branches: feat/a, feat/b
    const authored = normaliseAuthored(parseTokenomicsBlock(text, END));
    const { est: taskEstimates } = loadTasks(missionPath, END);

    const declaredBranches = (authored.branches ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // The agent-owned `## Tasks` section, e.g.
    //   - [role:python-dev] [status:done] T11.3 - Port OIDC IdP (Authlib): …
    // Role and status are optional and may appear in either order.
    const tasks = [];
    // NOTE: terminate only on the next `## ` heading — NOT on `<!--`. The Tasks
    // section routinely carries inline HTML comments (e.g. "T11.2 moved to
    // another campaign"), and stopping at the first one silently truncates the
    // list to whatever preceded it.
    const TASKS_END = "(?=\\n##\\s|$(?![\\s\\S]))";
    const tasksBlock =
      text.match(new RegExp(`^##\\s+Tasks\\s*\\n([\\s\\S]*?)${TASKS_END}`, "m"))?.[1] ?? "";
    for (const line of tasksBlock.split("\n")) {
      const m = line.match(/^\s*-\s*(.*?)(T\d+[a-z]?\.\d+)\s*[-–]\s*(.+?)\s*$/);
      if (!m) continue;
      const [, tags, id, name] = m;
      tasks.push({
        id,
        name,
        role: tags.match(/\[role:([^\]]+)\]/)?.[1] ?? null,
        status: tags.match(/\[status:([^\]]+)\]/)?.[1] ?? null,
        num: Number(id.split(".")[1])
      });
    }

    return {
      id,
      name,
      campaign: campaignSlug,
      dir: missionDir,
      brief,
      tracker,
      tasks,
      taskEstimates,
      criteria_total: criteria.length,
      criteria_done: criteria.filter((c) => c.done).length,
      authored,
      declaredBranches,
      missionNum: missionNumOf(id),
      missionKey: missionKeyOf(id)
    };
  }

  // A campaign's own `tokenomics.branches` (campaign.yaml, or a legacy campaign.md `## Tokenomics`
  // block) declares branches that are campaign-level work - its planning branch, a hand-off branch.
  function parseCampaign(slug, campaignPath) {
    const doc = readYamlEntity(join(campaignPath, "campaign.yaml"));
    let authored = {};
    let name = slug;
    let brief = "";
    if (doc) {
      authored = normaliseAuthored(doc.tokenomics);
      name = String(doc.name ?? "").trim() || slug;
      brief = String(doc.description ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 400);
    } else if (existsSync(join(campaignPath, "campaign.md"))) {
      const text = readFileSync(join(campaignPath, "campaign.md"), "utf8");
      authored = normaliseAuthored(
        parseTokenomicsBlock(text, "(?=\\n##\\s|\\n<!--|$(?![\\s\\S]))")
      );
      name = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
    }
    return {
      slug,
      name,
      brief,
      authored,
      declaredBranches: (authored.branches ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    };
  }

  function readBoard() {
    const missions = [];
    const campaigns = [];
    if (!existsSync(CAMPAIGNS_DIR)) return { missions, campaigns };

    let skippedYaml = 0;
    for (const campaign of readdirSync(CAMPAIGNS_DIR).sort()) {
      const campaignPath = join(CAMPAIGNS_DIR, campaign);
      if (!statSync(campaignPath).isDirectory()) continue;
      // A directory is a campaign only when it holds campaign.yaml or campaign.md - the rule BoardModel
      // applies, so the extension's rollup.ts sees the same board. A bare directory (a leftover, an
      // archive) owns no slug and its missions belong to no campaign. Every real campaign counts, even
      // one with no missions: it still owns its slug.
      if (
        !existsSync(join(campaignPath, "campaign.yaml")) &&
        !existsSync(join(campaignPath, "campaign.md"))
      )
        continue;
      campaigns.push(parseCampaign(campaign, campaignPath));
      const mdir = join(campaignPath, "missions");
      if (!existsSync(mdir)) continue;
      for (const m of readdirSync(mdir).sort()) {
        const missionPath = join(mdir, m);
        const yamlPath = join(missionPath, "mission.yaml");
        if (existsSync(yamlPath)) {
          const doc = readYamlEntity(yamlPath);
          if (doc) missions.push(parseMissionYaml(campaign, m, missionPath, doc));
          else skippedYaml++;
          continue;
        }
        if (existsSync(join(missionPath, "mission.md")))
          missions.push(parseMission(campaign, m, missionPath));
      }
    }

    // A board that exists but yields no missions means the join is broken, not that
    // there is no work — and every dollar would silently land in `unattributed`.
    // Say it out loud.
    if (skippedYaml) {
      log(
        `tokenomics: ERROR ${skippedYaml} mission.yaml file(s) could not be read` +
          (yamlLoad
            ? ""
            : " — no YAML parser found (install the Octobots pack, or `npm i js-yaml`)")
      );
    }
    if (!missions.length && readdirSync(CAMPAIGNS_DIR).length) {
      log(
        "tokenomics: ERROR the board has campaigns but no readable missions — every segment will report as unattributed"
      );
    }
    return { missions, campaigns };
  }

  return readBoard();
}
