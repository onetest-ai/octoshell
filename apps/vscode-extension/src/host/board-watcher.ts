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
    new vscode.RelativePattern(folder, ".octobots/campaigns/**/*.md"),
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
  watcher.onDidChange(() => gate.trigger());
  watcher.onDidCreate(() => gate.trigger());
  watcher.onDidDelete(() => gate.trigger());
  return { dispose: () => { gate.dispose(); watcher.dispose(); } };
}
