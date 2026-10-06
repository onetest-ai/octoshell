/**
 * Notes carry the entity's decision record — the prose an agent or a person left to explain why the
 * work is what it is. It is authored as markdown, so it must READ as markdown (headings, lists,
 * code) rather than as a wall of raw syntax, and a person must be able to correct it in place.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotesBlock } from "../src/webview/notes-block.js";

const MARKDOWN = [
  "## Amendment (Alex) — SQUAD_TOO_SMALL",
  "",
  "Two reason codes added to the closed set after T1.1's review.",
  "",
  "- floor tested at 6-vs-7 players",
  "- duplicate check counted across both teams",
  "",
  "`_validate_caps` (matches.py:398) already rejects duplicates.",
].join("\n");

describe("NotesBlock rendering", () => {
  it("renders a markdown heading as a heading, not as literal '##'", () => {
    render(<NotesBlock notes={MARKDOWN} />);
    const heading = screen.getByRole("heading", { name: /Amendment \(Alex\)/ });
    expect(heading).toBeTruthy();
    expect(heading.textContent).not.toContain("##");
  });

  it("renders a markdown list as list items", () => {
    render(<NotesBlock notes={MARKDOWN} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "floor tested at 6-vs-7 players",
      "duplicate check counted across both teams",
    ]);
  });

  it("renders inline code as <code>", () => {
    const { container } = render(<NotesBlock notes={MARKDOWN} />);
    const codes = [...container.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes).toContain("_validate_caps");
  });

  it("renders GitHub-flavoured tables", () => {
    render(<NotesBlock notes={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />);
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("strips embedded HTML rather than injecting it", () => {
    const { container } = render(
      <NotesBlock notes={'Before <img src="x" onerror="alert(1)"> after'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("does not leak react-markdown's internal `node` prop into the DOM", () => {
    // Spreading the component props straight onto the element forwards react-markdown's `node`,
    // which lands as an invalid node="[object Object]" attribute on every rendered element.
    const { container } = render(<NotesBlock notes={MARKDOWN} />);
    expect(container.querySelector("[node]")).toBeNull();
    expect(container.innerHTML).not.toContain("[object Object]");
  });

  it("renders nothing when there are no notes and it is read-only", () => {
    const { container } = render(<NotesBlock notes="" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("NotesBlock editing", () => {
  it("shows no edit control when no onSave is given", () => {
    render(<NotesBlock notes={MARKDOWN} />);
    expect(screen.queryByRole("button", { name: /edit notes/i })).toBeNull();
  });

  it("opens a textarea carrying the RAW markdown, not the rendered text", () => {
    render(<NotesBlock notes={MARKDOWN} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));
    const ta = screen.getByLabelText(/notes/i) as HTMLTextAreaElement;
    expect(ta.value).toBe(MARKDOWN);
    expect(ta.value).toContain("## Amendment");
  });

  it("saves the edited markdown and returns to the rendered view", async () => {
    const onSave = vi.fn();
    render(<NotesBlock notes={MARKDOWN} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: "## New\nrewritten" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onSave).toHaveBeenCalledWith("## New\nrewritten");
    // The editor closes — query the textarea itself, since "Edit notes" also matches /notes/i.
    await waitFor(() => expect(document.querySelector("textarea")).toBeNull());
  });

  it("discards the edit on cancel and leaves the original intact", async () => {
    const onSave = vi.fn();
    render(<NotesBlock notes={MARKDOWN} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: "throw this away" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("heading", { name: /Amendment/ })).toBeTruthy());
  });

  it("reopens the editor with the original text after a cancel", () => {
    render(<NotesBlock notes={MARKDOWN} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: "scratch" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));

    expect((screen.getByLabelText(/notes/i) as HTMLTextAreaElement).value).toBe(MARKDOWN);
  });

  it("offers a way to add notes to an entity that has none", () => {
    const onSave = vi.fn();
    render(<NotesBlock notes="" onSave={onSave} />);
    // An empty but editable entity must still expose the affordance, or notes could only ever be
    // added by an agent — never by the person reading the panel.
    fireEvent.click(screen.getByRole("button", { name: /add notes/i }));
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: "first note" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("first note");
  });

  it("picks up notes changed on disk while not editing", () => {
    const { rerender } = render(<NotesBlock notes="first" onSave={vi.fn()} />);
    rerender(<NotesBlock notes="second" onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));
    expect((screen.getByLabelText(/notes/i) as HTMLTextAreaElement).value).toBe("second");
  });
});

describe("NotesBlock save vs. notes that changed while the editor was open (M3 B2)", () => {
  const edit = (): void => { fireEvent.click(screen.getByRole("button", { name: /edit notes/i })); };
  const save = (): void => { fireEvent.click(screen.getByRole("button", { name: /^save$/i })); };
  const typeInto = (v: string): void => {
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: v } });
  };

  it("(a) unchanged draft + notes changed underneath: writes nothing, closes, shows the newer notes", async () => {
    const onSave = vi.fn();
    const { rerender } = render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    rerender(<NotesBlock notes="B" onSave={onSave} />);
    save();
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector("textarea")).toBeNull());
    expect(screen.getByText("B")).toBeTruthy();
  });

  it("(b) edited draft + notes changed underneath: no write, shows a conflict with two actions", () => {
    const onSave = vi.fn();
    const { rerender } = render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    typeInto("A prime");
    rerender(<NotesBlock notes="B" onSave={onSave} />);
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/changed on disk/i);
    expect(screen.getByRole("button", { name: /overwrite/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
    // The draft is still there; nothing was dropped.
    expect((screen.getByLabelText(/notes/i) as HTMLTextAreaElement).value).toBe("A prime");
  });

  it("(b) Overwrite saves the edited draft and closes", async () => {
    const onSave = vi.fn();
    const { rerender } = render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    typeInto("A prime");
    rerender(<NotesBlock notes="B" onSave={onSave} />);
    save();
    fireEvent.click(screen.getByRole("button", { name: /overwrite/i }));
    expect(onSave.mock.calls).toEqual([["A prime"]]);
    await waitFor(() => expect(document.querySelector("textarea")).toBeNull());
  });

  it("(b) Reload discards the draft, writes nothing and shows the newer notes", async () => {
    const onSave = vi.fn();
    const { rerender } = render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    typeInto("A prime");
    rerender(<NotesBlock notes="B" onSave={onSave} />);
    save();
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector("textarea")).toBeNull());
    expect(screen.getByText("B")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("(c) edited draft + notes unchanged: saves as before, no conflict", () => {
    const onSave = vi.fn();
    render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    typeInto("A prime");
    save();
    expect(onSave.mock.calls).toEqual([["A prime"]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("(d) Cancel still discards, including from a conflict", () => {
    const onSave = vi.fn();
    const { rerender } = render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    typeInto("A prime");
    rerender(<NotesBlock notes="B" onSave={onSave} />);
    save();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("(e) the notes prop echoing the SAME value while open is not a conflict", () => {
    const onSave = vi.fn();
    const { rerender } = render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    typeInto("A prime");
    rerender(<NotesBlock notes="A" onSave={onSave} />);
    save();
    expect(onSave.mock.calls).toEqual([["A prime"]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("our own save echoing back (A -> A prime) does not raise a conflict on the next edit", () => {
    const onSave = vi.fn();
    const { rerender } = render(<NotesBlock notes="A" onSave={onSave} />);
    edit();
    typeInto("A prime");
    save();
    rerender(<NotesBlock notes="A prime" onSave={onSave} />);
    edit();
    typeInto("A second");
    save();
    expect(onSave).toHaveBeenLastCalledWith("A second");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
