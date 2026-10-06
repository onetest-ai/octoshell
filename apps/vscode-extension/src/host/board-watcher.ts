import * as vscode from "vscode";
import { isGitQuiescent } from "./git-quiescence.js";
import type { BoardHost } from "./board-host.js";

export const BOARD_DEBOUNCE_MS = 350;
export const BOARD_QUIESCENCE_RETRY_MS = 400;

/**
 * Coalesce a burst of board-file events into ONE settled action, deferred while git is mid-operation.
 * Pure (no vscode dependency) so the debounce + quiescence-gate behavior is unit-testable.
 *
 * `trigger()` (re)arms a debounce timer. When it fires, if `isQuiescent()` is false the action is
 * deferred (re-armed at `retryMs`) until git settles; once quiescent, `onSettle()` runs exactly once
 * for the whole burst.
 */
export function createQuiescentDebouncer(opts: {
  debounceMs: number;
  retryMs: number;
  isQuiescent: () => boolean;
  onSettle: () => void;
}): { trigger: () => void; dispose: () => void } {
  const { debounceMs, retryMs, isQuiescent, onSettle } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    timer = undefined;
    if (!isQuiescent()) { arm(retryMs); return; } // git mid-op → defer until it settles
    onSettle();
  };
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, ms);
  };
  return {
    trigger: () => arm(debounceMs),
    dispose: () => { if (timer) { clearTimeout(timer); timer = undefined; } },
  };
}

/**
 * True for a file under a campaign's `tests/**\/runs/` or `tests/**\/evidence/`: run reports and
 * screenshots that QA writes while a mission is verified. They hold no board entity, so a write there
 * must not cost a rebuild. A TC file or README directly under `tests/m<n>/` is NOT ignored: it still
 * triggers the normal debounced rebuild (M6 shows TC status changes through it).
 * A path check, because a `RelativePattern` glob cannot negate. Only the part below the LAST
 * `.octobots/campaigns/` is judged: the workspace's own ancestors (a repo checked out under some
 * `campaigns/x/tests/y/runs/` folder) must never silence the board.
 */
export function isTestsRunOrEvidencePath(fsPath: string): boolean {
  const anchors = [...fsPath.matchAll(/[\\/]\.octobots[\\/]campaigns[\\/]/g)];
  const last = anchors[anchors.length - 1];
  if (!last) return false;
  const inBoard = fsPath.slice(last.index + last[0].length);
  return /^[^\\/]+[\\/]tests[\\/](?:[^\\/]+[\\/])*(?:runs|evidence)[\\/]/.test(inBoard);
}

/**
 * Watch the whole `.octobots` board tree; after it settles AND git is quiescent, do ONE disk
 * re-parse. Disk is the single source of truth, so every create/edit/delete — including bulk git
 * operations (checkout, stash/pop, rebase) — is handled by one debounced rebuild rather than a
 * per-file reactive sync that could mutate state against a half-torn mid-operation tree. The
 * git-quiescence gate defers the rebuild until any in-flight git op finishes.
 *
 * `board.reconcile()` rebuilds the disk model and emits `entities:changed`, driving open panels.
 */
export function registerBoardWatcher(opts: {
  folder: vscode.WorkspaceFolder;
  board: BoardHost;
  repoRoot: string;
  onSettled?: () => void;
}): vscode.Disposable {
  const { folder, board, repoRoot, onSettled } = opts;
  const watcher = vscode.workspace.createFileSystemWatcher(
    // Entities are now YAML (`<kind>.yaml`); `.md` is still watched for legacy boards mid-migration
    // and for doc files attached in a campaign/mission folder.
    new vscode.RelativePattern(folder, ".octobots/campaigns/**/*.{md,yaml}"),
  );
  const gate = createQuiescentDebouncer({
    debounceMs: BOARD_DEBOUNCE_MS,
    retryMs: BOARD_QUIESCENCE_RETRY_MS,
    isQuiescent: () => isGitQuiescent(repoRoot),
    onSettle: () => {
      board.reconcile(); // disk rebuild; emits entities:changed → drives open panels
      onSettled?.();
    },
  });
  const onEvent = (uri: vscode.Uri): void => {
    if (!isTestsRunOrEvidencePath(uri.fsPath)) gate.trigger();
  };
  watcher.onDidChange(onEvent);
  watcher.onDidCreate(onEvent);
  watcher.onDidDelete(onEvent);
  return { dispose: () => { gate.dispose(); watcher.dispose(); } };
}
