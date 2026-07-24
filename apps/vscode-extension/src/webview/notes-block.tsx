/**
 * Read-only "Notes" panel — renders the entity's free-form appended prose
 * (recorded decisions, rationale, product sign-offs) preserved from the board
 * verbatim. Markdown is shown as-is in a monospace-free, wrapped block rather
 * than rendered, so headings like `## Decision` stay legible without a parser.
 * Renders nothing when there are no notes.
 */
export function NotesBlock({ notes }: { notes?: string }): JSX.Element | null {
  const text = notes?.trim();
  if (!text) return null;
  return (
    <section>
      <h2 className="text-sm uppercase text-fg-muted mb-2">Notes</h2>
      <div className="border border-border rounded px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {text}
      </div>
    </section>
  );
}
