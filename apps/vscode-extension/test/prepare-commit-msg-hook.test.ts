import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, hookRepo, trailers } from "./fixtures/hook-repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { PACK } from "./fixtures/hook-repo.js";
import { pathToFileURL } from "node:url";

const warnings = (stderr: string): string[] => stderr.split("\n").filter((l) => /warning/i.test(l));

describe("prepare-commit-msg trailer hook (pack port of solo's M2 hook)", () => {
  it("adds exactly one Octobots-Mission trailer on a mission branch, and no duplicate on amend", () => {
    const r = hookRepo();
    const branch = `feat/${r.slug}-m1-t2`;
    const first = r.commit(branch);
    expect(first.status, first.stderr).toBe(0);
    expect(trailers(r.body())).toEqual([`Octobots-Mission: ${r.slug}/M1`]);
    expect(r.commit(branch, { amend: true }).status).toBe(0);
    expect(trailers(r.body())).toEqual([`Octobots-Mission: ${r.slug}/M1`]);
  });

  it("adds Octobots-Campaign on a campaign-level branch", () => {
    const r = hookRepo();
    expect(r.commit(`board/${r.slug}-notes`).status).toBe(0);
    expect(trailers(r.body())).toEqual([`Octobots-Campaign: ${r.slug}`]);
  });

  it("an unattributed branch commits, gains no trailer, and prints exactly one warning naming the branch and the skill", () => {
    const r = hookRepo();
    const res = r.commit("scratch/x");
    expect(res.status, res.stderr).toBe(0);
    expect(trailers(r.body())).toEqual([]);
    const w = warnings(res.stderr);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("scratch/x");
    expect(w[0]).toContain("mission-execution");
    expect(w[0]).not.toContain("AGENTS.md");
  });

  it("a board that fails to parse (attribute CLI exits non-zero) warns once and still commits", () => {
    const r = hookRepo();
    writeFileSync(r.m1Yaml, "name: [unclosed\n");
    const res = r.commit(`feat/${r.slug}-m1`);
    expect(res.status, res.stderr).toBe(0);
    expect(trailers(r.body())).toEqual([]);
    const w = warnings(res.stderr);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`feat/${r.slug}-m1`);
    expect(w[0]).toContain("mission-execution");
  });

  it("a merge commit is not special-cased: it gets the same trailer as any commit on the branch", () => {
    const r = hookRepo();
    const branch = `feat/${r.slug}-m1`;
    expect(r.commit(branch).status).toBe(0);
    r.git("checkout", "-q", "-b", "side");
    expect(r.commit("side").status).toBe(0);
    r.git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
    r.git("reset", "-q", "--soft", "HEAD");
    const merged = spawnSync("git", ["merge", "--no-ff", "--no-edit", "side"], { cwd: r.root, encoding: "utf8", env: gitEnv() });
    expect(merged.status, merged.stderr).toBe(0);
    expect(r.git("rev-list", "--parents", "-n1", "HEAD").trim().split(" ")).toHaveLength(3);
    expect(trailers(r.body())).toEqual([`Octobots-Mission: ${r.slug}/M1`]);
  });

  it("adds the optional Codex Co-Authored-By line once, and not again on amend", () => {
    const r = hookRepo();
    const branch = `feat/${r.slug}-m1`;
    const env = { OCTOBOTS_CODEX_MODEL: "gpt-x" };
    expect(r.commit(branch, { env }).status).toBe(0);
    const codex = () => r.body().split("\n").filter((l) => /^Co-Authored-By: Codex/i.test(l));
    expect(codex()).toEqual(["Co-Authored-By: Codex (gpt-x) <noreply@openai.com>"]);
    expect(r.commit(branch, { env, amend: true }).status).toBe(0);
    expect(codex()).toHaveLength(1);
  });

  describe("empty messages still abort (commit-msg runs after the editor)", () => {
    for (const [name, args, env] of [
      ["editor left empty", [], { GIT_EDITOR: "/usr/bin/true" }],
      ['-m ""', ["-m", ""], {}],
      ["editor left empty with a Codex model set", [], { GIT_EDITOR: "/usr/bin/true", OCTOBOTS_CODEX_MODEL: "gpt-x" }],
    ] as const) {
      it(name, () => {
        const r = hookRepo();
        const branch = `feat/${r.slug}-m1`;
        expect(r.commit(branch).status).toBe(0);
        const before = r.git("rev-parse", "HEAD");
        const res = r.commit(branch, { args: [...args], env: { ...env } });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/Aborting commit due to empty commit message/);
        expect(r.git("rev-parse", "HEAD")).toBe(before);
        expect(existsSync(join(r.root, ".git", "OCTOBOTS_TRAILER_AFTER_EDIT"))).toBe(false);
      });
    }
  });

  it("an editor commit keeps the typed subject and puts the trailer in the trailer block", () => {
    const r = hookRepo();
    const editor = join(r.root, "editor.sh");
    writeFileSync(editor, `#!/bin/sh\nprintf 'Typed subject\\n' | cat - "$1" > "$1.new" && mv "$1.new" "$1"\n`);
    chmodSync(editor, 0o755);
    const res = r.commit(`feat/${r.slug}-m1`, { args: [], env: { GIT_EDITOR: editor } });
    expect(res.status, res.stderr).toBe(0);
    expect(r.git("log", "-1", "--format=%s").trim()).toBe("Typed subject");
    expect(r.git("log", "-1", "--format=%(trailers:only,unfold)").trim()).toBe(`Octobots-Mission: ${r.slug}/M1`);
  });

  describe("core.commentChar other than #", () => {
    it("an untouched message still aborts", () => {
      const r = hookRepo();
      r.git("config", "core.commentChar", ";");
      const res = r.commit(`feat/${r.slug}-m1`, { args: [], env: { GIT_EDITOR: "/usr/bin/true" } });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/Aborting commit due to empty commit message/);
    });

    it("a verbose commit keeps the typed subject and gains one trailer", () => {
      const r = hookRepo();
      r.git("config", "core.commentChar", ";");
      writeFileSync(join(r.root, "change.txt"), "staged\n");
      r.git("add", "change.txt");
      const editor = join(r.root, "editor.sh");
      writeFileSync(editor, `#!/bin/sh\nprintf 'Typed subject\\n' | cat - "$1" > "$1.new" && mv "$1.new" "$1"\n`);
      chmodSync(editor, 0o755);
      const res = r.commit(`feat/${r.slug}-m1`, { args: ["-v"], env: { GIT_EDITOR: editor } });
      expect(res.status, res.stderr).toBe(0);
      expect(r.git("log", "-1", "--format=%s").trim()).toBe("Typed subject");
      expect(trailers(r.body())).toEqual([`Octobots-Mission: ${r.slug}/M1`]);
    });
  });

  describe("a message whose lines start with the comment character (review round 1)", () => {
    it("-m '#123 fix crash' keeps its subject (git keeps it without an editor) and gains one trailer", () => {
      const r = hookRepo();
      const res = r.commit(`feat/${r.slug}-m1`, { args: ["-m", "#123 fix crash"] });
      expect(res.status, res.stderr).toBe(0);
      expect(r.git("log", "-1", "--format=%s").trim()).toBe("#123 fix crash");
      expect(trailers(r.body())).toEqual([`Octobots-Mission: ${r.slug}/M1`]);
    });

    it("-F with a '#'-led message on an unattributed branch commits and warns exactly once", () => {
      const r = hookRepo();
      const msg = join(r.root, "msg.txt");
      writeFileSync(msg, "#7 tidy\n");
      const res = r.commit("scratch/x", { args: ["-F", msg] });
      expect(res.status, res.stderr).toBe(0);
      expect(r.git("log", "-1", "--format=%s").trim()).toBe("#7 tidy");
      expect(warnings(res.stderr)).toHaveLength(1);
    });

    it("-m '#123' -e left untouched still aborts (the editor strips it)", () => {
      const r = hookRepo();
      expect(r.commit(`feat/${r.slug}-m1`).status).toBe(0);
      const before = r.git("rev-parse", "HEAD");
      const res = r.commit(`feat/${r.slug}-m1`, { args: ["-m", "#123", "-e"], env: { GIT_EDITOR: "/usr/bin/true" } });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/Aborting commit due to empty commit message/);
      expect(r.git("rev-parse", "HEAD")).toBe(before);
    });

    it("core.commentChar=auto with a '#'-led template: clearing the template still aborts", () => {
      const r = hookRepo();
      expect(r.commit(`feat/${r.slug}-m1`).status).toBe(0);
      const before = r.git("rev-parse", "HEAD");
      writeFileSync(join(r.root, "tpl.txt"), "# heading\nsubject\n");
      r.git("config", "core.commentChar", "auto");
      r.git("config", "commit.template", join(r.root, "tpl.txt"));
      // Keep only git's own comment lines, which it wrote with ';' (the first free candidate).
      const editor = join(r.root, "keep-comments.sh");
      writeFileSync(editor, `#!/bin/sh\ngrep '^;' "$1" > "$1.new"; mv "$1.new" "$1"\n`);
      chmodSync(editor, 0o755);
      const res = r.commit(`feat/${r.slug}-m1`, { args: [], env: { GIT_EDITOR: editor } });
      expect(res.status).not.toBe(0);
      expect(r.git("rev-parse", "HEAD")).toBe(before);
    });
  });

  describe("attribute.mjs timeout", () => {
    const slow = (r: ReturnType<typeof hookRepo>) =>
      writeFileSync(
        join(r.root, ".octobots", "tokenomics", "attribute.mjs"),
        `await new Promise((r) => setTimeout(r, 1500));\nconsole.log(JSON.stringify({ kind: "mission", campaign: "${r.slug}", mission: "M1", step: 2 }));\n`,
      );

    it("tolerates a CLI that is slower than the old 5 s ceiling would allow under load, when the limit is raised", () => {
      const r = hookRepo();
      slow(r);
      const res = r.commit(`feat/${r.slug}-m1`, { env: { OCTOBOTS_ATTRIBUTE_TIMEOUT_MS: "20000" } });
      expect(res.status, res.stderr).toBe(0);
      expect(trailers(r.body())).toEqual([`Octobots-Mission: ${r.slug}/M1`]);
    });

    it("a CLI past the limit warns once and never blocks", () => {
      const r = hookRepo();
      slow(r);
      const res = r.commit(`feat/${r.slug}-m1`, { env: { OCTOBOTS_ATTRIBUTE_TIMEOUT_MS: "300" } });
      expect(res.status, res.stderr).toBe(0);
      expect(trailers(r.body())).toEqual([]);
      expect(warnings(res.stderr)).toHaveLength(1);
    });
  });

  it("the shim exits 0 and the commit goes through when the pack script is not installed", () => {
    const r = hookRepo();
    rmSync(join(r.root, ".octobots", "hooks", "prepare-commit-msg.mjs"));
    const res = r.commit(`feat/${r.slug}-m1`);
    expect(res.status, res.stderr).toBe(0);
    expect(trailers(r.body())).toEqual([]);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).toMatch(/prepare-commit-msg: warning: .*prepare-commit-msg\.mjs not found/);
    expect(res.stderr).not.toMatch(/Error|node:internal|at .*\(/);
  });

  it("the shims print one warning and exit 0 when node is not on PATH", () => {
    const r = hookRepo();
    const bin = mkdtempClean("no-node-bin-");
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    const env = { ...gitEnv(), PATH: bin };
    for (const [name, args] of [["prepare-commit-msg", [join(r.root, "msg"), "message"]], ["commit-msg", [join(r.root, "msg")]]] as const) {
      writeFileSync(join(r.root, "msg"), "subject\n");
      const res = spawnSync("/bin/sh", [join(r.root, ".githooks", name), ...args], { cwd: r.root, encoding: "utf8", env });
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stderr.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(1);
      if (name === "prepare-commit-msg") expect(lines).toEqual(["prepare-commit-msg: warning: node not found, no mission trailer added"]);
      expect(readFileSync(join(r.root, "msg"), "utf8")).toBe("subject\n");
    }
  });

  describe("a trailer in another case counts as present", () => {
    it("a lower-case campaign trailer on a mission branch gains no second trailer", () => {
      const r = hookRepo();
      const res = r.commit(`feat/${r.slug}-m1`, { args: ["-m", "Hook probe", "-m", "octobots-campaign: x"] });
      expect(res.status, res.stderr).toBe(0);
      expect(r.body().match(/^octobots-(?:mission|campaign):.*$/gim)).toEqual(["octobots-campaign: x"]);
    });

    it("a lower-case mission trailer on an unattributed branch prints no warning", () => {
      const r = hookRepo();
      const res = r.commit("scratch/x", { args: ["-m", "Hook probe", "-m", "octobots-mission: x/M9"] });
      expect(res.status, res.stderr).toBe(0);
      expect(warnings(res.stderr)).toEqual([]);
    });
  });

  describe("a newline in the attribution result cannot add a line", () => {
    const answer = (r: ReturnType<typeof hookRepo>, result: Record<string, string>) =>
      writeFileSync(join(r.root, ".octobots", "tokenomics", "attribute.mjs"), `console.log(${JSON.stringify(JSON.stringify(result))});\n`);

    it("a mission result becomes one trailer line", () => {
      const r = hookRepo();
      answer(r, { kind: "mission", campaign: "a\nEvil: 1", mission: "M1\r\nEvil: 2" });
      const res = r.commit(`feat/${r.slug}-m1`);
      expect(res.status, res.stderr).toBe(0);
      expect(r.body()).not.toMatch(/^Evil:/m);
      expect(trailers(r.body())).toEqual(["Octobots-Mission: a Evil: 1/M1  Evil: 2"]);
    });

    it("a campaign result becomes one trailer line", () => {
      const r = hookRepo();
      answer(r, { kind: "campaign", campaign: "a\nEvil: 1" });
      const res = r.commit(`feat/${r.slug}-m1`);
      expect(res.status, res.stderr).toBe(0);
      expect(r.body()).not.toMatch(/^Evil:/m);
      expect(trailers(r.body())).toEqual(["Octobots-Campaign: a Evil: 1"]);
    });

    it("a name that is only line breaks is unattributed: no trailer, one warning", () => {
      const r = hookRepo();
      answer(r, { kind: "mission", campaign: "a", mission: "\r\n" });
      const res = r.commit(`feat/${r.slug}-m1`);
      expect(res.status, res.stderr).toBe(0);
      expect(trailers(r.body())).toEqual([]);
      expect(warnings(res.stderr)).toHaveLength(1);
      expect(res.stderr).toContain("unattributed");
    });
  });

  it("the script delegates attribution to the CLI and carries no board mapping", () => {
    const r = hookRepo();
    const source = readFileSync(join(r.root, ".octobots", "hooks", "prepare-commit-msg.mjs"), "utf8");
    expect(source).toMatch(/attribute\.mjs/);
    expect(source).not.toMatch(/resolveAttribution|loadBoard|runs\.json|segment_attributions/);
  });
});

describe("prepare-commit-msg timeouts and shim guards", () => {
  const shim = async (): Promise<string> => {
    const mod = await import(/* @vite-ignore */ pathToFileURL(join(PACK, "hooks", "hooks-doctor.mjs")).href);
    return mod.SHIMS["prepare-commit-msg"];
  };
  const runShim = async (cwd: string, root?: string) => {
    const f = join(mkdtempClean("shim-file-"), "prepare-commit-msg");
    writeFileSync(f, await shim());
    chmodSync(f, 0o755);
    void root;
    return spawnSync("sh", [f, join(cwd, "msgfile")], { cwd, encoding: "utf8", env: gitEnv() });
  };

  it("no 2-second timeout is left: git and interpret-trailers use the attribution budget", () => {
    const src = readFileSync(join(PACK, "hooks", "prepare-commit-msg.mjs"), "utf8");
    expect(src).not.toMatch(/timeout = 2000/);
    expect(src).not.toMatch(/timeout: 2000/);
    expect(src.match(/OCTOBOTS_ATTRIBUTE_TIMEOUT_MS/g)).toHaveLength(1);
  });

  it("the prepare-commit-msg shim exits 0 silently outside a git repository", async () => {
    const res = await runShim(mkdtempClean("no-git-"));
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("a crashing helper prints exactly one warning line", async () => {
    const r = hookRepo();
    writeFileSync(join(r.root, ".octobots", "hooks", "prepare-commit-msg.mjs"), 'throw new Error("boom");\n');
    const res = await runShim(r.root);
    expect(res.status).toBe(0);
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: r.root, encoding: "utf8", env: gitEnv() }).trim();
    expect(res.stderr.trim()).toBe(`prepare-commit-msg: warning: ${root}/.octobots/hooks/prepare-commit-msg.mjs failed, no mission trailer added`);
  });

  it("a helper's own warning still reaches stderr", async () => {
    const r = hookRepo();
    writeFileSync(join(r.root, ".octobots", "hooks", "prepare-commit-msg.mjs"), 'console.error("prepare-commit-msg: warning: x");\n');
    const res = await runShim(r.root);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("prepare-commit-msg: warning: x");
  });
});
