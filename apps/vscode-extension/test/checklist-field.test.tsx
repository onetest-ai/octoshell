import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChecklistField } from "../src/webview/checklist-field.js";

const A = "- [ ] a";
const B = "- [ ] b";

function setup(saved: string[]) {
  const ui = (value: string): JSX.Element => (
    <ChecklistField label="Criteria" value={value} onSave={(v) => saved.push(v)} />
  );
  const r = render(ui(A));
  const ta = screen.getByPlaceholderText(/acceptance criterion/i) as HTMLTextAreaElement;
  return { ta, rerender: (v: string) => r.rerender(ui(v)) };
}

describe("ChecklistField stale-save guard", () => {
  it("untouched focused item adopts the newer value on blur and saves nothing", () => {
    const saved: string[] = [];
    const { ta, rerender } = setup(saved);
    fireEvent.focus(ta);
    rerender(B);
    fireEvent.blur(ta);
    expect(saved).toEqual([]);
    expect((screen.getByPlaceholderText(/acceptance criterion/i) as HTMLTextAreaElement).value).toBe("b");
  });

  it("an edited item still saves the user's text on blur", () => {
    const saved: string[] = [];
    const { ta, rerender } = setup(saved);
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "mine" } });
    rerender(B);
    fireEvent.blur(ta);
    expect(saved).toEqual(["- [ ] mine"]);
  });

  it("an edit reverted to the focus-time text counts as untouched", () => {
    const saved: string[] = [];
    const { ta, rerender } = setup(saved);
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "mine" } });
    fireEvent.change(ta, { target: { value: "a" } });
    rerender(B);
    fireEvent.blur(ta);
    expect(saved).toEqual([]);
    expect((screen.getByPlaceholderText(/acceptance criterion/i) as HTMLTextAreaElement).value).toBe("b");
  });

  it("ticking a criterion saves immediately, without any focus", () => {
    const saved: string[] = [];
    setup(saved);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(saved).toEqual(["- [x] a"]);
  });

  it("an item edit survives focusing another item before the save echoes back, and a tick keeps it", () => {
    const saved: string[] = [];
    render(<ChecklistField label="C" value={"- [ ] a\n- [ ] b"} onSave={(v) => saved.push(v)} />);
    const [t1, t2] = screen.getAllByPlaceholderText(/acceptance criterion/i) as HTMLTextAreaElement[];
    fireEvent.focus(t1!);
    fireEvent.change(t1!, { target: { value: "a2" } });
    fireEvent.blur(t1!);
    // The host has not echoed the save yet: `value` still holds the pre-save text.
    fireEvent.focus(t2!);
    fireEvent.blur(t2!);
    expect(t1!.value).toBe("a2");
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect(saved).toEqual(["- [ ] a2\n- [ ] b", "- [ ] a2\n- [x] b"]);
  });

  it("each focus cycle snapshots afresh: an external change between cycles is adopted, a later one too", () => {
    const saved: string[] = [];
    const { ta, rerender } = setup(saved);
    fireEvent.focus(ta);
    rerender(B);
    fireEvent.blur(ta);
    fireEvent.focus(ta);
    rerender("- [ ] c");
    fireEvent.blur(ta);
    expect(saved).toEqual([]);
    expect(ta.value).toBe("c");
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "mine" } });
    fireEvent.blur(ta);
    expect(saved).toEqual(["- [ ] mine"]);
  });
});
