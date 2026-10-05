import { useRef, useState } from "react";

export function Field(
  { label, value, onSave }: { label: string; value: string; onSave: (v: string) => void },
): JSX.Element {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(value);
  // The text at the moment of focus. Blur saves only if the user changed it since: an untouched
  // field must adopt the newest prop (an external edit that arrived while focused), not save its
  // stale text over it. An edit reverted to this value counts as untouched.
  const focusText = useRef(value);
  // Autosave on blur (below). While the field is focused, ignore background reloads (spine events)
  // so they don't clobber an in-progress edit; re-sync from the server only when not editing.
  // The sync happens during render (React's "adjust state when a prop changes" pattern) rather than
  // in an effect: an effect leaves one committed frame where the new prop is in the DOM everywhere
  // else but this textarea is still empty.
  if (value !== seen) {
    setSeen(value);
    if (!editing) setV(value);
  }
  const id = `field-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm uppercase text-fg-muted">{label}</label>
      <textarea
        id={id}
        className="w-full bg-input text-fg-input p-2"
        rows={2}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onFocus={() => { focusText.current = v; setEditing(true); }}
        onBlur={() => {
          setEditing(false);
          if (v === focusText.current) setV(value);
          else if (v !== value) onSave(v);
        }}
      />
    </div>
  );
}
