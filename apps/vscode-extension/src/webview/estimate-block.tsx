/**
 * Read-only "Estimate" panel — renders the authored planning `tokenomics` map
 * (size, effort_days, complexity_score, maturity, and any other keys) as a
 * key/value list. Renders nothing when the map is absent or empty.
 */
export function EstimateBlock(
  { tokenomics }: { tokenomics?: Record<string, string | number | boolean> },
): JSX.Element | null {
  const entries = tokenomics ? Object.entries(tokenomics) : [];
  if (entries.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm uppercase text-fg-muted mb-2">Estimate</h2>
      <dl className="border border-border rounded overflow-hidden">
        {entries.map(([key, value]) => (
          <div
            key={key}
            className="flex items-center justify-between gap-3 px-2 py-1.5 border-t border-border first:border-t-0"
          >
            <dt className="text-fg-muted text-xs uppercase tracking-wide">{key.replace(/_/g, " ")}</dt>
            <dd className="text-sm">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
