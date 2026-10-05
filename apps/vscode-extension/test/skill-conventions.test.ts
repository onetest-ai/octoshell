import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");
const skill = (name: string): string => readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");

/** Body of the `### Dispatch rules` section: up to the next heading of the same or a higher level. */
function dispatchRulesSection(text: string): string {
  const start = text.search(/^###\s+Dispatch rules\b.*$/m);
  expect(start, "mission-execution has a '### Dispatch rules' section").toBeGreaterThanOrEqual(0);
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const next = rest.search(/^#{1,3}\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("mission-execution: direct sub-agent dispatch", () => {
  const text = skill("mission-execution");
  const rules = (): string => dispatchRulesSection(text);

  it("§ Dispatch rules are numbered 1..n with no duplicates or gaps", () => {
    const numbers = [...rules().matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThanOrEqual(9);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  // One entry per dispatch rule (or the loop section that carries it): the keyword that rule needs.
  const keywords: Array<[string, RegExp]> = [
    ["Agent tool", /`Agent` tool|Agent\(/],
    ["foreground", /foreground/i],
    ["explicit model:", /`model:`|model: (opus|sonnet)/],
    ["fenced JSON verdict", /fenced JSON/],
    ["missing verdict is BLOCKED", /BLOCKED/],
    ["relay questions instead of nested spawning", /relay/i],
    ["resume from board + git", /board[^.]*\bgit\b|\bgit log\b/i],
    ["fast lane", /\bfast\b[^.\n]*\blane\b/i],
    ["coverage lane", /\bcoverage\b[^.\n]*\blane\b/i],
  ];
  it.each(keywords)("carries the rule keyword: %s", (_label, pattern) => {
    expect(text).toMatch(pattern);
  });

  it("the rule keywords sit in § Dispatch rules, not only elsewhere in the file", () => {
    for (const [, pattern] of keywords.filter(([l]) => /Agent tool|model|JSON|BLOCKED|relay|resume|lane|foreground/.test(l))) {
      expect(rules()).toMatch(pattern);
    }
  });

  const forbidden: Array<[string, RegExp]> = [
    ["Workflow( tool call", /Workflow\(/],
    ["Workflow script path", /scriptPath/],
    ["workflow resume id", /resumeFromRunId/],
    ["workflow run logging / meta scripts", /add-run\.js|sync-meta\.js/],
    ["retired workflow-designer skill", /workflow-designer/],
    ["a backticked make command", /`make\s/],
    ["make ci / make <x>-test", /\bmake\s+(ci|coverage|[\w-]*-test[\w-]*)\b/],
    ["edgeserver", /edgeserver/],
    ["uv run", /uv run/],
  ];
  it.each(forbidden)("does not contain %s", (_label, pattern) => {
    expect(text).not.toMatch(pattern);
  });

  it("never instructs running a workflow.js: any paragraph naming it is the historical-reference note", () => {
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.includes("workflow.js") && !/^#{1,6}\s/.test(p));
    expect(paragraphs.length).toBeGreaterThan(0); // the legacy paragraph is kept
    for (const p of paragraphs) expect(p.replace(/[*\s]+/g, " ")).toMatch(/historical reference only/);
  });

  it("stays at the shared pack version", () => {
    expect(text).toMatch(/^version: 57$/m);
  });

  it("rule 10 (dead agent) indents its continuation lines by 4 spaces like every other rule", () => {
    const rule10 = rules().split(/^10\. /m)[1] ?? "";
    const continuation = rule10.split("\n").slice(1).filter((l) => l.trim() !== "");
    expect(continuation.length).toBeGreaterThan(0);
    for (const line of continuation) expect(line).toMatch(/^ {4}\S/);
  });

  it("the Fixing loop sends a bug fix through review, then QA + land, before merge", () => {
    const fixing = text.split(/^- \*\*Fixing\*\*/m)[1]?.split(/\n\n/)[0] ?? "";
    expect(fixing).toMatch(/review/i);
    expect(fixing).toMatch(/QA \+ land/);
    expect(fixing).toMatch(/before (it )?merg/i);
  });

  it("§ The mission gate speaks direct dispatch: base branch goes in the briefs, no workflow-era names", () => {
    const section = text.split(/^## The mission gate\b.*$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/baseBranch|MISSION_TASKS_MERGED|`args`|\bargs\b/);
    expect(section).toMatch(/base branch[^.]*\b(briefs?|dispatch)/i);
  });
});

describe("mission-completion-gate: orchestrator-dispatched phases", () => {
  const text = skill("mission-completion-gate");
  const gate = (): string => text.split(/^## The gate\b.*$/m)[1]?.split(/^## /m)[0] ?? "";

  it("states the 5 phases as orchestrator dispatches with the Agent tool, in the foreground", () => {
    const phases = [...gate().matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]}:${m[2]}`);
    expect(phases).toEqual([
      "1:Tests + coverage",
      "2:QA, black-box (Sage)",
      "3:Critical review (Rio)",
      "4:Tokenomics capture (non-blocking)",
      "5:Merge / complete",
    ]);
    expect(gate()).toMatch(/`Agent` tool/);
    expect(gate()).toMatch(/foreground/);
    expect(gate()).toMatch(/model:/);
    expect(gate()).toMatch(/BLOCKED/);
  });

  it("relays the Sage-Alex and Rio-devs exchanges through the orchestrator", () => {
    expect(gate()).toMatch(/relay/i);
    expect(gate()).toMatch(/questions_for_ba/);
    expect(gate()).toMatch(/questions_for_devs/);
    expect(text).not.toMatch(/calls Py[^.]*directly/i);
  });

  it("defines blocking: an AC demonstrably unmet, a reproducible defect, or a security exposure with a PoC", () => {
    expect(text).toMatch(/AC demonstrably unmet[\s\S]{0,40}reproducible defect[\s\S]{0,40}security exposure with a PoC/);
  });

  it("allows one review round plus one fix round, residue filed as board bugs; blocks on stillOpen only", () => {
    expect(gate()).toMatch(/one review round and one fix round/i);
    expect(gate()).toMatch(/[Rr]esidue[^.]*filed as board bugs/);
    expect(gate()).toMatch(/Block on `stillOpen` only/);
  });

  it("defines green: 0 failed, 0 xfailed or todo, no skip without an environmental reason", () => {
    expect(gate()).toMatch(/0 failed, 0 xfailed or todo/);
    expect(gate()).toMatch(/no skip without a stated environmental reason/);
  });

  it("runs coverage on the coverage lane only, and names no project-specific command", () => {
    expect(gate()).toMatch(/coverage lane/);
    expect(gate()).toMatch(/fast lane/);
    expect(text).toMatch(/AGENTS\.md § Test lanes/);
    expect(text).not.toMatch(/`make\s|\bmake\s+(ci|coverage|[\w-]*-test[\w-]*)\b|edgeserver|uv run|-n auto/);
  });

  it("words the test lanes exactly as mission-execution does (one phrasing in both skills)", () => {
    const flat = (t: string): string => t.replace(/\s+/g, " ");
    const shared = [
      "Read the project's declared test lanes",
      "(`AGENTS.md § Test lanes`; where a project has not declared them yet, use the project's documented commands in its `CLAUDE.md` / `AGENTS.md`)",
      "Brief the agents with those commands by name, never with a command of your own",
    ];
    for (const phrase of shared) {
      expect(flat(skill("mission-execution"))).toContain(phrase);
      expect(flat(gate())).toContain(phrase);
    }
  });

  it("is free of the retired Workflow-tool template and its names", () => {
    expect(text).not.toMatch(/Workflow\(|export const meta|workflow-designer|baseBranch|TESTS_SCHEMA|agentType:/);
    expect(text).toMatch(/Do not use the `Workflow` tool/);
  });

  it("describes the real transcript roots, not only .claude/projects/", () => {
    expect(text).toMatch(/~\/\.claude\/projects\/<slug>/);
    expect(text).toMatch(/\$CLAUDE_CONFIG_DIR\/projects/);
    expect(text).not.toMatch(/transcripts live in `\.claude\/projects\/`/);
  });

  it("keeps the campaign rows in the runs.json description and the shared pack version", () => {
    expect(text).toMatch(/work_item_level: "campaign"/);
    expect(text).toMatch(/^version: 57$/m);
  });
});

/** The paragraph(s) of `text` under the heading matching `heading`, up to the next heading of any level. */
function sectionUnder(text: string, heading: RegExp): string {
  const start = text.search(heading);
  if (start === -1) return "";
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const next = rest.search(/^#{1,6}\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("octobots-doctor: the rules of M7-AC7", () => {
  const text = skill("octobots-doctor");
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const flat = body.replace(/\s+/g, " ");

  it("is a v57 pack skill whose description says when to use it", () => {
    expect(text).toMatch(/^name: octobots-doctor$/m);
    expect(text).toMatch(/^version: 57$/m);
    const description = /^description: (.+)$/m.exec(text)?.[1] ?? "";
    expect(description).toMatch(/^Use when /);
    for (const trigger of [/pending pack reconcile|pack reconcile/i, /SessionStart|Octobots health/, /doctor\.js/, /validate\.js/]) expect(description).toMatch(trigger);
  });

  it("runs doctor.js --json and validate.js and acts on their findings", () => {
    expect(body).toMatch(/node \.claude\/skills\/mission-planner\/scripts\/doctor\.js --json/);
    expect(body).toMatch(/node \.claude\/skills\/mission-planner\/scripts\/validate\.js /);
    expect(flat).toMatch(/[Aa]ct on their findings/);
  });

  it("acts only on the folders pending.json names; carried-over questions come from RECONCILE.md; other ESCALATED entries are history", () => {
    expect(flat).toMatch(/[Aa]ct only on the staging folders (that )?`?pending\.json`? names/);
    expect(flat).toContain("Carried over from v<old>:");
    expect(flat).toMatch(/RECONCILE\.md/);
    expect(flat).toMatch(/folder no pending entry names is history[^.]*never asked again/);
    // T7.6 review: a carried-over question must become an open entry of THIS DECISIONS.md, or done
    // would clear the reconcile without the user ever answering it.
    expect(flat).toMatch(/Carried over from v<old>:`; copy each one, verbatim, as an open `- ESCALATED:` entry under Conflicts in this folder's DECISIONS\.md/);
  });

  it("classifies every change four ways", () => {
    const rows = [...body.matchAll(/^\s*\|\s*(local only|upstream only|both, the same|both, different)\s*\|\s*(\w+)/gm)].map((m) => `${m[1]}=${m[2]}`);
    expect(rows).toEqual(["local only=keep", "upstream only=take", "both, the same=take", "both, different=conflict"]);
  });

  it("making an upstream generic rule concrete for this project is not a conflict, and keeps both", () => {
    expect(flat).toMatch(/concrete for this project[^.]*is not a conflict/);
    expect(flat).toMatch(/[Tt]ake upstream's generic rule and keep local's concrete [^.]*as this project's instance/);
  });

  it("states the full policy-conflict list and 'when unsure, escalate'", () => {
    for (const item of [
      "model or role",
      "review or fix round limits",
      "coverage threshold",
      "what blocks a merge",
      "who may merge or approve, and into which branch",
      "actions that need the user's OK first (deleting, pushing, migrating or seeding a database, anything with an external effect)",
      "a safety guard",
    ]) expect(flat, item).toContain(item);
    expect(flat).toMatch(/When unsure whether a difference is policy, escalate\./);
  });

  it("a local restatement of a base value is local's position", () => {
    expect(flat).toMatch(/local restates a base value and upstream changes that value, the restatement is local's position/);
  });

  it("escalates a policy conflict with the WHOLE live file untouched, and encodes no side in merged.md", () => {
    expect(flat).toMatch(/ESCALATE every policy conflict/);
    expect(flat).toMatch(/whole live SKILL\.md stays untouched[^.]*until every escalation of this skill is answered/);
    expect(body).toContain("<!-- ESCALATED: <rule>: awaiting the user's answer, see DECISIONS.md -->");
    expect(flat).toMatch(/neither side's text/);
    // T7.6 review: `<rule>` in the placeholder is a name, so a side's wording cannot ride in on it.
    expect(flat).toMatch(/`<rule>` is a short name for the rule \(e\.g\. `what counts as green`\), never its wording/);
  });

  it("never merges by lines", () => {
    expect(flat).toMatch(/Never merge by lines/);
    expect(flat).toMatch(/git merge-file/);
  });

  it("defines merged.md, DECISIONS.md's three sections, both entry forms and the no-upstream-change line", () => {
    expect(flat).toMatch(/merged\.md/);
    const template = body.match(/```markdown\n(# <skill>[\s\S]*?)```/)?.[1] ?? "";
    expect([...template.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(["Kept local", "Taken from upstream", "Conflicts"]);
    expect(template).toContain("- RESOLVED: <rule>: <reason>");
    expect(template).toContain("- ESCALATED: <rule>: local <...>; upstream <...>; question <...>");
    expect(body).toContain("No upstream change since the base apart from the version marker; local kept as is.");
  });

  it("UPSTREAM-CANDIDATES.md lists `- <rule>: <why it generalises>`, Kept local rules only", () => {
    expect(body).toContain("- <rule>: <why it generalises>");
    expect(flat).toMatch(/UPSTREAM-CANDIDATES\.md[^.]*only rules from Kept local/);
  });

  it("installs with `version: <N>+local` and `reconciled-from:`, only when nothing is escalated, then runs done", () => {
    expect(flat).toContain("`version: <N>+local`");
    expect(flat).toContain("`reconciled-from: <sha256>`");
    expect(flat).toMatch(/copy merged\.md byte for byte to `\.claude\/skills\/<skill>\/SKILL\.md`/);
    expect(body).toMatch(/node \.claude\/skills\/octobots-doctor\/scripts\/pack-reconcile\.mjs done <skill>/);
    expect(flat).toMatch(/plain `<N>`[^.]*overwrite/);
    expect(flat).toMatch(/replace the `version:` line with `version: <N>\+local` and add the line `reconciled-from: <sha256>` below it/);
  });

  it("writes nothing outside the skill, its staging folder and doctor-acks.json", () => {
    expect(flat).toMatch(/[Ww]rite nothing outside `\.claude\/skills\/<skill>\/`, its staging folder and `\.octobots\/doctor-acks\.json`/);
    expect(flat).toMatch(/CLAUDE\.md, AGENTS\.md/);
  });

  it("always escalates a retired skill", () => {
    expect(flat).toMatch(/[Aa]lways escalate a retired skill/);
  });

  it("moves a kept retired skill to a name that is not, and never was, a pack skill (gate Q2)", () => {
    // A retired name stays retired: a copy kept under one would be treated as that retired skill by
    // the next install. Phrased generically, so no retired skill is named here.
    expect(flat).toContain("`<skill>-local-<YYYY-MM-DD>` unless the user picks another");
    expect(flat).toMatch(/never a name that is, or ever was, a pack skill/);
    expect(flat).toMatch(/a retired name stays retired/);
    expect(flat).toMatch(/next install would treat that directory as the retired skill again/);
    expect(flat).not.toMatch(/a name no pack skill uses/); // the old wording let a retired name through
  });

  it("says done refuses a live file that still holds an ESCALATED placeholder line", () => {
    expect(flat).toMatch(/done also refuses a live file that still holds an `<!-- ESCALATED: \.\.\. -->` line/);
  });

  it("an answer is recorded as `- RESOLVED (user, <YYYY-MM-DD>)`; an unanswered escalation is asked again without re-merging", () => {
    expect(body).toContain("- RESOLVED (user, <YYYY-MM-DD>): <rule>: <answer>");
    expect(flat).toMatch(/ask its question again, verbatim, and change nothing[^.]*do not merge again/);
  });

  it("the reply names the reconciled skills, each DECISIONS.md path and every ESCALATED question verbatim", () => {
    const reply = sectionUnder(body, /^## \d+\. Your reply/m);
    expect(reply).toMatch(/Reconciled:/);
    expect(reply).toMatch(/DECISIONS\.md/);
    expect(reply.replace(/\s+/g, " ")).toMatch(/every open ESCALATED entry, verbatim/);
  });

  it("deletes a workflows/ folder only on a per-folder yes", () => {
    const legacy = sectionUnder(body, /^## \d+\. Leftover `workflows\/` folders/m).replace(/\s+/g, " ");
    expect(legacy).toMatch(/only after the user says yes to that folder/);
    expect(legacy).toMatch(/A yes for one folder is not a yes for another/);
  });

  it("gives the config-dir advice: ~/.claude/projects is the default, never CLAUDE_CONFIG_DIR=<repo>/.claude", () => {
    const cfg = sectionUnder(body, /^## \d+\. `CLAUDE_CONFIG_DIR`/m).replace(/\s+/g, " ");
    expect(cfg).toContain("~/.claude/projects/<slug>");
    expect(cfg).toMatch(/[Nn]ever set (or recommend )?`CLAUDE_CONFIG_DIR=<repo>\/\.claude`/);
  });

  it("records declined findings in .octobots/doctor-acks.json exactly as T7.5's primer reads them", () => {
    const acks = sectionUnder(body, /^## \d+\. Declined findings/m);
    const json = acks.match(/```json\n([\s\S]*?)```/)?.[1] ?? "";
    expect(JSON.parse(json)).toEqual({
      acknowledged: [
        { finding: "workflows", path: "campaigns/<c>/workflows", date: "<YYYY-MM-DD>" },
        { finding: "workflows", path: "campaigns/<c>/missions/<m>/workflows", date: "<YYYY-MM-DD>" },
        { finding: "config-dir", path: ".claude", date: "<YYYY-MM-DD>" },
      ],
    });
    const prose = acks.replace(/\s+/g, " ");
    expect(prose).toMatch(/relative to `\.octobots\/`/);
    expect(prose).toMatch(/`\/`-separated/);
    expect(prose).toMatch(/the `workflows\/` folder itself, never a `workflows\/<slug>` path/);
    expect(prose).toMatch(/pending reconcile is never acknowledged/);
  });

  it("names no retired skill outside its legacy-folder paragraph", () => {
    const legacy = sectionUnder(body, /^## \d+\. Leftover `workflows\/` folders/m);
    const outside = body.replace(legacy, "");
    expect(outside).not.toMatch(/workflow-designer/);
    expect(outside).not.toMatch(/(?<![.\w/-])octobots(?![\w-])/); // the retired v18 skill; `.octobots/` is the board
    expect(outside).not.toMatch(/skills\/octobots\//);
  });
});

describe("mission-planner: the legacy-folder paragraph (decision 13(d))", () => {
  const legacy = sectionUnder(skill("mission-planner"), /^## Legacy `workflows\/` folders/m).replace(/\s+/g, " ");

  it("says the installer and tooling never change a legacy workflows/ folder", () => {
    expect(legacy).toMatch(/never changed by the installer or any tooling/);
  });

  it("says only octobots-doctor may delete one, with the user's explicit OK per folder", () => {
    expect(legacy).toMatch(/only \*\*octobots-doctor\*\* may delete one, with the user's explicit OK for that folder/);
    expect(legacy).not.toMatch(/never edit, move or delete those folders/);
  });
});

describe("mission-planner: tests are authored with the mission (M4-AC4)", () => {
  const planner = skill("mission-planner");
  const chat = sectionUnder(planner, /^### Mission chat — planner/m).replace(/\s+/g, " ");

  it("says tests are authored with the mission, before build, by running add-tests.js", () => {
    expect(chat).toMatch(/Author the tests with the mission, before build/);
    expect(chat).toMatch(/add-tests\.js <mission-dir>/);
  });

  it("documents the README and its sections, and one or more TC files per AC", () => {
    for (const s of ["AC map", "Shared preconditions", "Pre-existing records", "Assumptions to confirm"]) {
      expect(chat).toContain(s);
    }
    expect(chat).toMatch(/TC-NNN_<slug>\.md/);
    expect(chat).toMatch(/templates\/TC-template\.md/);
    expect(chat).toMatch(/one or more per (acceptance criterion|AC)/);
  });

  it("documents the TC frontmatter fields and their allowed values", () => {
    for (const f of ["`id`", "`title`", "`mission`", "`covers`", "`kind`", "`status`", "`last_run`"]) {
      expect(chat).toContain(f);
    }
    expect(chat).toContain("api | ui | cli | unit");
    expect(chat).toContain("draft | ready | pass | fail | blocked | unknown");
    expect(chat).toMatch(/\^TC-\\d\{3,\}\$/);
  });

  it("requires the Steps and Expected Final State sections", () => {
    expect(chat).toContain("## Steps");
    expect(chat).toContain("## Expected Final State");
  });

  it("maps PASS/FAIL/BLOCKED/UNREACHABLE to a status, UNREACHABLE being blocked with the reason in the RUN file", () => {
    expect(chat).toMatch(/PASS (->|→) pass/);
    expect(chat).toMatch(/FAIL (->|→) fail/);
    expect(chat).toMatch(/BLOCKED (->|→) blocked/);
    expect(chat).toMatch(/UNREACHABLE (->|→) blocked[^.]*reason in the RUN file/);
  });

  it("forbids a hard-coded host or port: {{base_url}}, a variable named in the README", () => {
    expect(chat).toContain("{{base_url}}");
    expect(chat).toMatch(/never hard-code a host or port/i);
    expect(chat).toMatch(/variable named in the README/);
  });

  it("names the execution modes: API/CLI calls, and Playwright MCP for UI", () => {
    expect(chat).toMatch(/API\/CLI calls/);
    expect(chat).toMatch(/Playwright MCP/);
  });

  it("requires a pre-existing record per case and says UNREACHABLE rather than fabricate", () => {
    expect(chat).toMatch(/a pre-existing record per case/i);
    expect(chat).toMatch(/say UNREACHABLE rather than fabricate/i);
  });

  it("lists add-tests.js among the scripts and says validate.js warns on pairing gaps (warning only)", () => {
    const scripts = planner.split("\n").filter((l) => l.startsWith("- `node .claude/skills/mission-planner/scripts/add-tests.js"));
    expect(scripts).toHaveLength(1);
    expect(chat).toMatch(/`validate\.js` warns \(warning only[^)]*\) on a missing README[^.]*an AC no TC covers/);
  });
});

describe("octobots-doctor: the tests-pairing paragraph (M4-AC4)", () => {
  const doctor = skill("octobots-doctor");
  const para = sectionUnder(doctor, /^## \d+\. Tests pairing/m).replace(/\s+/g, " ");

  it("acts on validate.js output and says a tests-pairing warning is not a primer finding", () => {
    expect(para).toMatch(/validate\.js/);
    expect(para).toMatch(/not a primer finding/);
  });

  it("resolves it by running add-tests.js and authoring the missing TCs with the mission's owner", () => {
    expect(para).toMatch(/add-tests\.js/);
    expect(para).toMatch(/author(ing)? the missing TCs with the mission's owner/);
  });

  it("never resolves it by deleting an AC, a TC or a README row", () => {
    expect(para).toMatch(/never[^.]*deleting an AC, a TC or a README row/i);
  });

  it("is reachable: §1 routes tests-pairing warnings to it, and it comes before the closing reply", () => {
    const n = /^## (\d+)\. Tests pairing/m.exec(doctor)?.[1];
    const reply = /^## (\d+)\. Your reply/m.exec(doctor)?.[1];
    expect(n).toBeDefined();
    expect(Number(n)).toBeLessThan(Number(reply));
    const find = sectionUnder(doctor, /^## 1\. Find what to act on/m).replace(/\s+/g, " ");
    expect(find).toContain(`tests-pairing warnings (§${n})`);
  });
});

describe("QA runs the test cases on real data (M4-AC5): the gate and the last task carry the same terms", () => {
  const qaGate = sectionUnder(skill("mission-completion-gate"), /^### QA on the test cases\b/m).replace(/\s+/g, " ");
  const qaExec = sectionUnder(skill("mission-execution"), /^### Mission QA: run the test cases live\b/m).replace(/\s+/g, " ");

  const terms: Array<[string, RegExp]> = [
    ["runs every TC in tests/m<n>/", /run(s)? every TC in `tests\/m<n>\/`/i],
    ["writes runs/RUN-YYYY-MM-DD-NNN.md", /`runs\/RUN-YYYY-MM-DD-NNN\.md`/],
    ["records PASS, FAIL, BLOCKED or UNREACHABLE", /PASS, FAIL, BLOCKED or UNREACHABLE/],
    ["UNREACHABLE is status blocked, reason in the RUN file", /UNREACHABLE[^.]*status `blocked`[^.]*reason in the RUN file/],
    ["names the pre-existing record per criterion", /pre-existing record per criterion/i],
    ["a criterion proved only on QA-created data is not passed", /only on (QA-created|data QA created)[^.]*is not (passed|a pass)/i],
    ["writes ## QA verification into task and mission notes via entity-io.mjs", /`## QA verification`[^.]*task and mission `notes`[^.]*`entity-io\.mjs`/],
    ["ticks exactly the criteria with evidence", /tick(s)? exactly the criteria (that have|with) evidence/i],
    ["could not drive the browser / log in is BLOCKED", /could not drive the browser[^.]*log in[^.]*BLOCKED/i],
    ["notes a manual (F5/human) execution as manual in the RUN file", /manual[^.]*\(F5[^.]*\)[^.]*noted as manual in the RUN file|noted as manual in the RUN file/i],
    ["edits the TC frontmatter status by hand for now", /frontmatter `status`[^.]*by hand/],
  ];

  for (const [label, re] of terms) {
    it(`gate: ${label}`, () => {
      expect(qaGate).not.toBe("");
      expect(qaGate).toMatch(re);
    });
    it(`mission-execution: ${label}`, () => {
      expect(qaExec).not.toBe("");
      expect(qaExec).toMatch(re);
    });
  }

  it("gate phase 2 points at the block, and mission-execution names the last-task convention and the gate", () => {
    const phase2 = skill("mission-completion-gate").split(/^## The gate\b.*$/m)[1] ?? "";
    expect(phase2).toMatch(/### QA on the test cases/);
    expect(qaExec).toMatch(/Mission QA: run tests\/m<n> live/);
    expect(qaExec).toMatch(/owned by QA/);
    expect(qaExec).toMatch(/whole suite/);
    expect(qaExec).toMatch(/mission-completion-gate/);
  });

  it("mission-planner names the same last task", () => {
    expect(skill("mission-planner").replace(/\s+/g, " ")).toMatch(/Mission QA: run tests\/m<n> live/);
  });
});

describe("T4.3 reviewer nits", () => {
  const planner = skill("mission-planner").replace(/\s+/g, " ");
  it("mission-planner: the TC id equals the filename prefix before the first `_`", () => {
    expect(planner).toMatch(/filename prefix before the first `_`/);
  });
  it("mission-planner: `mission` allows a letter suffix (^M\\d+[a-z]*$, m3b -> M3b)", () => {
    expect(planner).toContain("^M\\d+[a-z]*$");
    expect(planner).toMatch(/m3b` -> `M3b/);
  });
  it("octobots-doctor: the frontmatter description lists tests-pairing", () => {
    const fm = skill("octobots-doctor").split("---")[1] ?? "";
    expect(fm).toMatch(/description:[^\n]*tests-pairing/);
  });
});
