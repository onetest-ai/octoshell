// The canonical entity status values, replicated here with friendly labels for the Status
// dropdowns on the bug / task / mission detail panels. The webview bundle does not import the
// host package, so keep this list in sync with the board's status rules in
// packages/board/src/validate.ts.
export const ENTITY_STATUS_OPTIONS = [
  { value: "draft", label: "draft" },
  { value: "executing", label: "executing" },
  { value: "awaitingApproval", label: "awaiting approval" },
  { value: "done", label: "done" },
  { value: "failed", label: "failed" },
  { value: "cancelled", label: "cancelled" },
] as const;
