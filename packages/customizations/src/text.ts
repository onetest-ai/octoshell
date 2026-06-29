/** First non-blank line of `text`, with a leading markdown heading marker stripped, capped at 140 chars. */
export function firstHeadingOrLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    const stripped = line.replace(/^#+\s*/, "");
    return stripped.length > 140 ? `${stripped.slice(0, 139)}…` : stripped;
  }
  return undefined;
}
