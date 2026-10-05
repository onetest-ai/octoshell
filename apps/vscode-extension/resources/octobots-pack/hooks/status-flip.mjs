// Shared by the PostToolUse(Bash) hooks mission-gate.mjs and work-log.mjs: recognise a
// `set-status.js <parent-dir|entity.yaml> "<title>" <state>` call in a Bash command, and confirm
// that the board now holds the state the command asked for.
//
// WHY CONFIRM: a PostToolUse hook fires for the command, not for its effect. `set-status.js … "M9 -
// no such mission" done; echo` exits 0 overall (the `; echo` wins) although set-status.js found no
// entity and wrote nothing. Acting on the command text alone would launch a completion gate for a
// mission that never flipped, or attribute a session to a mission that was never started.
//
// HOW: re-read the target's YAML. The target is resolved by `resolveStatusTarget` from
// mission-planner's entity-io.mjs — the very function set-status.js writes through — loaded from the
// directory of the set-status.js the command ran, so there is one title-matching rule and a hook can
// never disagree with the script about which entity a title names.
//
// FAIL CLOSED: if the helper cannot be loaded or anything throws, the answer is "not confirmed" and
// the hook stays silent. A missed directive or log line is cheaper than a false one.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Tokenize a shell command respecting single/double quotes. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Find a `set-status.js <parent> <title> <state>` call in a (possibly chained) command. Returns
 * `{ script, parent, title, state }` (script = the path as typed) or null. Segments are scanned
 * across `&&`, `;` and `||`.
 */
export function parseSetStatus(command) {
  for (const seg of command.split(/&&|;|\|\|/)) {
    const toks = tokenize(seg.trim());
    const idx = toks.findIndex((t) => t.endsWith("set-status.js"));
    if (idx === -1) continue;
    const args = toks.slice(idx + 1).filter((t) => !t.startsWith("-"));
    if (args.length < 3) continue;
    return { script: toks[idx], parent: args[0], title: args[args.length - 2], state: args[args.length - 1] };
  }
  return null;
}

/**
 * True when the entity `set-status.js` resolves for `parsed` now has the status `parsed.state` maps
 * to. `cwd` is the Bash tool's working directory (relative paths in the command resolve against it).
 */
export async function statusNowEquals(parsed, cwd) {
  try {
    const scriptsDir = dirname(resolve(cwd, parsed.script));
    const helper = join(scriptsDir, "entity-io.mjs");
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
