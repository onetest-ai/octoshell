// Shared by the PostToolUse(Bash) hooks mission-gate.mjs and work-log.mjs: recognise the
// `set-status.js <parent-dir|entity.yaml> "<title>" <state>` calls in a Bash command, and confirm
// that the board now holds the state each call asked for.
//
// WHY CONFIRM: a PostToolUse hook fires for the command, not for its effect. `set-status.js … "M9 -
// no such mission" done; echo` exits 0 overall (the `; echo` wins) although set-status.js found no
// entity and wrote nothing. Acting on the command text alone would launch a completion gate for a
// mission that never flipped, or attribute a session to a mission that was never started.
//
// HOW: re-read the target's YAML. The target is resolved by `resolveStatusTarget` from
// mission-planner's entity-io.mjs — the very function set-status.js writes through — so there is one
// title-matching rule and a hook can never disagree with the script about which entity a title names.
//
// WHERE FROM: entity-io.mjs is loaded ONLY from the installed pack,
// `<project>/.claude/skills/mission-planner/scripts/`. Never from the directory of the set-status.js
// path in the command: the command text is not trusted, and `echo /tmp/x/set-status.js d "M1" done`
// would otherwise make this hook — which runs outside any Bash sandbox — import `/tmp/x/entity-io.mjs`
// although the shell itself executed nothing.
//
// FAIL CLOSED: if the helper cannot be loaded or anything throws, the answer is "not confirmed" and
// the hook stays silent. A missed directive or log line is cheaper than a false one.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Where installPack puts mission-planner's scripts, relative to the project root. */
export const ENTITY_IO = join(".claude", "skills", "mission-planner", "scripts", "entity-io.mjs");

/**
 * Split a shell command into simple commands, each a list of words with quotes and escapes removed.
 * Separators (`;` `&&` `||` `|` `&` newline, parentheses) only count outside quotes; redirections
 * (`>out`, `2>&1`, `< in`) are dropped with their target. Not a full shell — no expansion — but enough
 * that a quoted title containing `;`, `&&`, `"` or `'`, or a path with spaces, stays one word.
 */
export function shellWords(cmd) {
  const cmds = [];
  let words = [];
  let cur = null; // the word being built; null when between words
  let dropNext = false; // the next word is a redirection target
  const push = () => {
    if (cur !== null) {
      if (dropNext) dropNext = false;
      else words.push(cur);
    }
    cur = null;
  };
  const end = () => {
    push();
    dropNext = false;
    if (words.length) cmds.push(words);
    words = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const stop = j === -1 ? cmd.length : j;
      cur = (cur ?? "") + cmd.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      let s = "";
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) {
          s += cmd[i + 1];
          i += 2;
        } else s += cmd[i++];
      }
      i++;
      cur = (cur ?? "") + s;
    } else if (c === "\\") {
      if (i + 1 < cmd.length && cmd[i + 1] !== "\n") cur = (cur ?? "") + cmd[i + 1];
      i += 2;
    } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      end();
      i++;
    } else if (/\s/.test(c)) {
      push();
      i++;
    } else if (c === ">" || c === "<") {
      if (cur !== null && /^\d+$/.test(cur)) cur = null; // the fd of `2>`
      else push();
      i++;
      while (cmd[i] === ">" || cmd[i] === "<") i++;
      if (cmd[i] === "&") {
        i++;
        while (i < cmd.length && /[\d-]/.test(cmd[i])) i++; // `>&1`, `>&-`
      } else dropNext = true;
    } else {
      cur = (cur ?? "") + c;
      i++;
    }
  }
  end();
  return cmds;
}

/**
 * Every `set-status.js <parent> <title> <state…>` call in a (possibly chained) command, in order,
 * as `{ parent, title, state }`. Positional arguments are read the way set-status.js reads its argv
 * (parent, title, then the rest joined as the state); `-`-prefixed flags such as `--force=…` are
 * skipped. A call with fewer than three positionals is ignored.
 */
export function parseSetStatusAll(command) {
  const calls = [];
  for (const words of shellWords(command)) {
    const idx = words.findIndex((w) => /(^|[/\\])set-status\.js$/.test(w));
    if (idx === -1) continue;
    const args = words.slice(idx + 1).filter((w) => !w.startsWith("-"));
    if (args.length < 3) continue;
    calls.push({ parent: args[0], title: args[1].trim(), state: args.slice(2).join(" ").trim() });
  }
  return calls;
}

/**
 * True when the entity set-status.js resolves for `parsed` now has the status `parsed.state` maps to.
 * `cwd` is the Bash tool's working directory (relative paths in the command resolve against it);
 * `projectDir` is the project root whose installed pack supplies the resolver.
 */
export async function statusNowEquals(parsed, cwd, projectDir) {
  try {
    const helper = join(resolve(projectDir), ENTITY_IO);
    if (!existsSync(helper)) return false;
    const io = await import(pathToFileURL(helper).href);
    const wanted = io.mapBoardStatus(parsed.state);
    const parent = resolve(cwd, parsed.parent);
    if (!wanted || !existsSync(parent)) return false;
    const target = io.resolveStatusTarget(parent, parsed.title);
    if (!target) return false;
    const entity = io.resolveEntityFile(target.dir, [target.kind]);
    return !!entity && io.readEntity(entity.file, entity.format).status === wanted;
  } catch {
    return false;
  }
}
