/**
 * "Notes" panel — the entity's free-form appended prose (recorded decisions, rationale, product
 * sign-offs), authored as markdown and stored verbatim in the entity's `notes` field.
 *
 * Rendered as markdown rather than shown raw: notes are read far more often than written, and a
 * decision record is only useful if its headings and lists are legible at a glance. Editing is an
 * explicit mode — notes are long-form and often the only copy of a decision, so a stray focus must
 * never overwrite them the way an autosave-on-blur field would.
 *
 * Embedded HTML is stripped (`rehype-sanitize`): notes are written by agents as often as by people,
 * and this panel must not become a way for generated text to inject markup into the webview.
 *
 * Read-only (no `onSave`) renders nothing when empty. Editable renders even when empty, so a person
 * can start a decision record that no agent has written yet.
 */
import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown.js";

export function NotesBlock(
  { notes, onSave }: { notes?: string; onSave?: (v: string) => void },
): JSX.Element | null {
  const text = notes?.trim() ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  // Re-sync from disk only while not editing, so a board reload can't clobber an open edit.
  const editingRef = useRef(false);
  // The notes the editor was opened on: the baseline for "changed underneath" at Save time.
  const baseRef = useRef(text);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (!editingRef.current) setDraft(text);
  }, [text]);

  if (!text && !onSave) return null;

  const open = (): void => {
    editingRef.current = true;
    baseRef.current = text;
    setDraft(text);
    setConflict(false);
    setEditing(true);
  };
  const close = (): void => { editingRef.current = false; setConflict(false); setEditing(false); };
  const write = (): void => { onSave?.(draft); close(); };
  // Save never silently drops a newer value. Compared by value at Save time, so a same-value echo
  // (our own earlier save, a no-op reload) is not a conflict.
  const save = (): void => {
    if (text === baseRef.current) return write();
    if (draft === baseRef.current) return close(); // untouched draft: the view shows the newer notes
    setConflict(true);
  };
  const cancel = (): void => { setDraft(text); close(); };
  // Reload closes the editor onto the newer notes (draft discarded) instead of loading them into the
  // textarea: one unambiguous outcome, and the person can reopen to edit from the current text.
  const reload = (): void => { setDraft(text); close(); };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm uppercase text-fg-muted">Notes</h2>
        {onSave && !editing && (
          <button
            onClick={open}
            aria-label={text ? "Edit notes" : "Add notes"}
            title={text ? "Edit notes" : "Add notes"}
            className="text-fg-muted hover:text-fg px-1"
          >
            <span className={`codicon codicon-${text ? "edit" : "add"}`} aria-hidden="true" />
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            id="notes-editor"
            aria-label="Notes"
            className="w-full bg-input text-fg-input p-2 font-mono text-sm"
            rows={16}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") cancel(); }}
          />
          {conflict && (
            <div role="alert" className="flex items-center gap-2 text-sm text-status-error">
              <span>Notes changed on disk since you opened the editor.</span>
              <button
                onClick={write}
                className="bg-btn-secondary hover:bg-btn-secondary-hover px-2 py-0.5 rounded-sm"
              >
                Overwrite
              </button>
              <button
                onClick={reload}
                className="bg-btn-secondary hover:bg-btn-secondary-hover px-2 py-0.5 rounded-sm"
              >
                Reload
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              className="bg-btn-primary hover:bg-btn-primary-hover px-3 py-1 rounded-sm text-sm"
            >
              Save
            </button>
            <button
              onClick={cancel}
              className="bg-btn-secondary hover:bg-btn-secondary-hover px-3 py-1 rounded-sm text-sm"
            >
              Cancel
            </button>
            <span className="text-xs text-fg-muted">Markdown — Esc to cancel</span>
          </div>
        </div>
      ) : text ? (
        <div className="border border-border rounded px-3 py-2 text-sm break-words">
          <Markdown>{text}</Markdown>
        </div>
      ) : (
        <div className="text-sm text-fg-muted italic">No notes yet.</div>
      )}
    </section>
  );
}
