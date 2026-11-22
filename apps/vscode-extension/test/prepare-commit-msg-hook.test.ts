import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, hookRepo, trailers } from "./fixtures/hook-repo.js";

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
  });

  it("the script delegates attribution to the CLI and carries no board mapping", () => {
    const r = hookRepo();
    const source = readFileSync(join(r.root, ".octobots", "hooks", "prepare-commit-msg.mjs"), "utf8");
    expect(source).toMatch(/attribute\.mjs/);
    expect(source).not.toMatch(/resolveAttribution|loadBoard|runs\.json|segment_attributions/);
  });
});
