import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses a leading --- block into key/value", () => {
    const text = `---\nname: code-reviewer\ndescription: Reviews code for bugs.\n---\n\n# body`;
    expect(parseFrontmatter(text)).toEqual({ name: "code-reviewer", description: "Reviews code for bugs." });
  });
  it("strips surrounding quotes", () => {
    expect(parseFrontmatter(`---\nname: "x"\npaths: '**/migrations/**'\n---`)).toEqual({ name: "x", paths: "**/migrations/**" });
  });
  it("returns {} when there is no frontmatter", () => {
    expect(parseFrontmatter("# just a heading\n")).toEqual({});
  });
  it("handles CRLF and ignores malformed lines", () => {
    expect(parseFrontmatter("---\r\nname: y\r\n: bad\r\n---\r\n")).toEqual({ name: "y" });
  });
  it("parses a folded (>) block scalar into a single spaced line", () => {
    const text = `---\nname: qa\ndescription: >\n  Sage — meticulous QA engineer who treats every passing test\n  with healthy suspicion.\nmodel: sonnet\n---`;
    expect(parseFrontmatter(text)).toMatchObject({
      name: "qa",
      description: "Sage — meticulous QA engineer who treats every passing test with healthy suspicion.",
      model: "sonnet",
    });
  });
  it("parses a literal (|) block scalar keeping newlines", () => {
    const text = `---\ndescription: |\n  line one\n  line two\n---`;
    expect(parseFrontmatter(text).description).toBe("line one\nline two");
  });
});
