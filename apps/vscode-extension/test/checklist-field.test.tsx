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
});
