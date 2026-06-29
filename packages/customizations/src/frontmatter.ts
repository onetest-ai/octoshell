/** Minimal YAML-frontmatter: the leading `---`…`---` block. Handles `key: value` plus
 *  block scalars (`key: >` / `key: |` and bare `key:` followed by indented lines). */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m || m[1] === undefined) return {};
  const lines = m[1].split("\n").map((l) => l.replace(/\r$/, ""));
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv || !kv[1]) continue;
    const key = kv[1];
    let value = (kv[2] ?? "").trim();
    if (value === "" || value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        if (next.trim() === "") { block.push(""); continue; }
        if (/^\s/.test(next)) { block.push(next.trim()); } else { break; }
      }
      // Trim trailing blank lines from the gathered block.
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      if (block.length > 0) {
        value = value.startsWith("|") ? block.join("\n") : block.filter((b) => b !== "").join(" ");
        i = j - 1;
      }
    }
    out[key] = value.replace(/^["']|["']$/g, "");
  }
  return out;
}
