// The ONE reader of AGENTS.md's `## Test lanes` declaration on the pack side (mission M5 AC7).
// doctor.js imports it. The SessionStart primer (hooks/primer.mjs) runs on its own, without the
// scripts folder, so it carries a twin of `parseTestLanes`; the extension's
// test/octobots-primer.test.ts drives every case of test/fixtures/lanes-cases.json through both and
// asserts the same verdict. Dependency-free on purpose, like the rest of scripts/.
//
// The declaration, in the form octobots-doctor proposes:
//
//   ## Test lanes
//
//   - fast: `pnpm --filter <pkg> test`
//   - coverage: `pnpm coverage`
//
// The rules:
//   - The section starts at a column-0 `## Test lanes` line (any case, trailing blanks allowed; not
//     `###`, not indented, not `## Test lanes:`) and ends at the next column-0 `# ` or `## ` line,
//     or the end of the file. A heading inside a fenced code block (``` or ~~~) is not a heading.
//   - Inside the section a declaration is a line `fast: <command>` or `coverage: <command>`: key in
//     any case, optional list marker (`-`, `*`, `+`) and leading blanks, optional bold around the
//     key (`**fast:**`, `**fast**:`), blanks allowed before the colon. A `<command>` is the rest of
//     the line with surrounding blanks and backticks removed, and must not be empty. A declaration
//     inside a fenced block in the section counts. The first non-empty one per key wins.
//   - The lanes are declared when the section holds both.

const HEADING = /^##[ \t]+Test lanes[ \t]*$/i;
const LEVEL_1_2 = /^#{1,2}[ \t]/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const DECLARATION = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?(fast|coverage)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(.*)$/i;

/** `{section, fast, coverage}`: whether the section exists, and each lane's command or null. */
export function parseTestLanes(text) {
  const result = { section: false, fast: null, coverage: null };
  let inFence = null; // the fence character while inside a fenced block
  let inSection = false;
  for (const line of String(text).split(/\r?\n/)) {
    const fence = FENCE.exec(line);
    if (fence) {
      const ch = fence[1][0];
      if (inFence === null) inFence = ch;
      else if (inFence === ch) inFence = null;
    } else if (inFence === null) {
      if (inSection && LEVEL_1_2.test(line)) inSection = false;
      if (HEADING.test(line)) { inSection = true; result.section = true; continue; }
    }
    if (!inSection || fence) continue;
    const m = DECLARATION.exec(line);
    if (!m) continue;
    const command = m[2].replace(/^[\s`]+|[\s`]+$/g, "");
    const key = m[1].toLowerCase();
    if (command !== "" && result[key] === null) result[key] = command;
  }
  return result;
}
