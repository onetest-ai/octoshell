import { useEffect, useRef, useState } from "react";

export function Field(
  { label, value, onSave }: { label: string; value: string; onSave: (v: string) => void },
): JSX.Element {
  const [v, setV] = useState(value);
  const editing = useRef(false);
  // Autosave on blur (below). While the field is focused, ignore background reloads (spine events)
  // so they don't clobber an in-progress edit; re-sync from the server only when not editing.
  useEffect(() => { if (!editing.current) setV(value); }, [value]);
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
        onFocus={() => { editing.current = true; }}
        onBlur={() => { editing.current = false; if (v !== value) onSave(v); }}
      />
    </div>
  );
}
