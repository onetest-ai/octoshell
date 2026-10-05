/**
 * Pack-update staging: the `.octobots/pack-updates/pending.json` record of skills staged for an
 * agent to reconcile. T7.3 owns this module (staging, the record's shape and its parser); until it
 * lands only the seam `packStatus` reads exists, and nothing is ever pending.
 */

/** Skills with a pending reconcile in `repoRoot`'s `.octobots/pack-updates/pending.json`. */
export function pendingReconcile(_repoRoot: string): string[] {
  return [];
}
