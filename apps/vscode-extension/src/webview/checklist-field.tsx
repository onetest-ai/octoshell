import { useEffect, useRef, useState } from "react";

interface Item {
  checked: boolean;
  text: string;
}

// Each non-empty line is one criterion. `- [x] …` (or `[x] …`) starts checked; bullets/numbering are
// stripped. This maps directly to the `- [ ]` lines the planner writes into mission/task briefs.
function parse(value: string): Item[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const cb = line.match(/^[-*]?\s*\[([ xX])\]\s*(.*)$/);
      if (cb) return { checked: (cb[1] ?? " ").toLowerCase() === "x", text: (cb[2] ?? "").trim() };
      const text = line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
      return { checked: false, text };
    });
}

function serialize(items: Item[]): string {
  return items
    .filter((i) => i.text.trim().length > 0)
    .map((i) => `- [${i.checked ? "x" : " "}] ${i.text.trim()}`)
    .join("\n");
}

/** A textarea that grows to fit its content so long criteria are fully readable (no horizontal clip). */
function AutoTextarea(
  props: { value: string; checked: boolean; onChange: (v: string) => void; onCommit: () => void; onFocus: () => void },
): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = (): void => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(resize, [props.value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={`flex-1 resize-none bg-input text-fg-input px-2 py-1 rounded-sm leading-snug overflow-hidden ${props.checked ? "line-through text-fg-muted" : ""}`}
      value={props.value}
      placeholder="Acceptance criterion…"
      onFocus={props.onFocus}
      onChange={(e) => { props.onChange(e.target.value); resize(); }}
      onBlur={props.onCommit}
    />
  );
}

/** An editable checklist backed by a single markdown string (no schema change). Toggling, editing,
 *  adding, and removing items all reserialize to `- [ ]`/`- [x]` lines and autosave. */
export function ChecklistField(
  { label, value, onSave }: { label: string; value: string; onSave: (v: string) => void },
): JSX.Element {
  const [items, setItems] = useState<Item[]>(() => parse(value));
  const editing = useRef(false);

  // Re-sync from the source string when it changes externally and we're not mid-edit.
  useEffect(() => {
    if (!editing.current) setItems(parse(value));
  }, [value]);

  const commit = (next: Item[]): void => {
    setItems(next);
    const serialized = serialize(next);
    if (serialized !== value) onSave(serialized);
  };

  const addItem = (): void => {
    editing.current = true;
    setItems((cur) => [...cur, { checked: false, text: "" }]);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm text-fg-muted">{label}</label>
        <button onClick={addItem} aria-label="Add criterion" title="Add criterion" className="text-fg-muted hover:text-fg">
          <span className="codicon codicon-add" aria-hidden="true" />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-fg-muted">No criteria yet.</div>
      ) : (
        <ul className="space-y-1">
          {items.map((it, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1.5 shrink-0"
                checked={it.checked}
                onChange={() => commit(items.map((x, i) => (i === idx ? { ...x, checked: !x.checked } : x)))}
                aria-label={it.checked ? "Mark incomplete" : "Mark complete"}
              />
              <AutoTextarea
                value={it.text}
                checked={it.checked}
                onFocus={() => { editing.current = true; }}
                onChange={(v) => setItems((cur) => cur.map((x, i) => (i === idx ? { ...x, text: v } : x)))}
                onCommit={() => { editing.current = false; commit(items); }}
              />
              <button onClick={() => commit(items.filter((_, i) => i !== idx))} aria-label="Remove criterion" className="mt-1 shrink-0 text-fg-muted hover:text-fg">
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
