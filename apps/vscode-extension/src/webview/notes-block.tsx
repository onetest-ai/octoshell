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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

/**
 * Tailwind's reset strips heading/list styling, and this webview has no typography plugin, so each
 * element carries its own classes. Colors come from VS Code theme tokens only — never hardcoded.
 *
 * `md()` drops react-markdown's internal `node` prop before spreading: forwarding it lands an
 * invalid `node="[object Object]"` attribute on every element it renders.
 */
type MdProps = { node?: unknown } & Record<string, unknown>;
const md =
  (Tag: keyof JSX.IntrinsicElements, className: string) =>
  ({ node: _node, ...rest }: MdProps): JSX.Element =>
    <Tag className={className} {...(rest as object)} />;

const MD_COMPONENTS = {
  // `##` maps to h3, not h2: the panel's own "NOTES" label is the h2, so the note's own headings
  // sit one level below it and the document outline stays truthful.
  h1: md("h3", "text-base font-semibold mt-3 mb-1 first:mt-0"),
  h2: md("h3", "text-sm font-semibold uppercase tracking-wide mt-3 mb-1 first:mt-0"),
  h3: md("h4", "text-sm font-semibold mt-2 mb-1 first:mt-0"),
  h4: md("h5", "text-sm font-semibold mt-2 mb-1 first:mt-0"),
  p: md("p", "my-1.5 leading-relaxed"),
  ul: md("ul", "list-disc pl-5 my-1.5 space-y-0.5"),
  ol: md("ol", "list-decimal pl-5 my-1.5 space-y-0.5"),
  li: md("li", "leading-relaxed"),
  a: md("a", "text-fg-link underline"),
  code: md("code", "bg-codeblock rounded px-1 py-0.5 text-[0.9em]"),
  pre: md("pre", "bg-codeblock rounded p-2 my-2 overflow-x-auto text-[0.9em]"),
  blockquote: md("blockquote", "border-l-2 border-border pl-3 my-2 text-fg-muted"),
  hr: md("hr", "border-border my-3"),
  // Wide tables scroll inside the panel rather than widening it.
  table: ({ node: _node, ...rest }: MdProps): JSX.Element => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse text-left" {...(rest as object)} />
    </div>
  ),
  th: md("th", "border border-border px-2 py-1 font-semibold"),
  td: md("td", "border border-border px-2 py-1"),
  strong: md("strong", "font-semibold"),
};

export function NotesBlock(
  { notes, onSave }: { notes?: string; onSave?: (v: string) => void },
): JSX.Element | null {
  const text = notes?.trim() ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  // Re-sync from disk only while not editing, so a board reload can't clobber an open edit.
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) setDraft(text);
  }, [text]);

  if (!text && !onSave) return null;

  const open = (): void => { editingRef.current = true; setDraft(text); setEditing(true); };
  const close = (): void => { editingRef.current = false; setEditing(false); };
  const save = (): void => { onSave?.(draft); close(); };
  const cancel = (): void => { setDraft(text); close(); };

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
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={MD_COMPONENTS as never}
          >
            {text}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="text-sm text-fg-muted italic">No notes yet.</div>
      )}
    </section>
  );
}
