/**
 * Every terminal-lifecycle event registrar VS Code exposes on `vscode.window` — the ONE list, read
 * by both halves of the thin-launcher gate:
 *
 *  - `test/octograph-command.test.ts` installs each one on the stub as a function that throws by
 *    name, so a launcher that REGISTERS one fails behaviourally.
 *  - `test/octograph-e2e.test.ts` (T6.5/Step 4) turns each one into a source-text pattern, so a
 *    launcher that registers one fails the grep too.
 *
 * It lives here because both files are in the same package and CAN import it: the two suites were
 * previously two hand-typed spellings of the same rule, and a registrar added to one only would
 * have left the other silently blind. There is no "extension cannot import that" excuse for this
 * pair (unlike `octograph.ts`'s `insideWorkspace`, whose twin genuinely lives across a package
 * boundary the extension must not depend on) — so it is one list, imported twice.
 */
export const TERMINAL_EVENTS = [
  "onDidCloseTerminal",
  "onDidOpenTerminal",
  "onDidChangeActiveTerminal",
  "onDidChangeTerminalState",
  "onDidChangeTerminalShellIntegration",
  "onDidStartTerminalShellExecution",
  "onDidEndTerminalShellExecution",
  "onDidWriteTerminalData",
] as const;
