/**
 * The one markdown renderer of the webview: react-markdown + remark-gfm + rehype-sanitize, with theme-token classes.
 * Shared by the notes panel and the test-case panel, so there is a single place where generated text is made safe:
 * embedded HTML is stripped (`rehype-sanitize`), never injected into the webview.
 */
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

export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={MD_COMPONENTS as never}>
      {children}
    </ReactMarkdown>
  );
}
