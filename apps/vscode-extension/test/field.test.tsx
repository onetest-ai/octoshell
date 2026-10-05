import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { Field } from "../src/webview/field.js";

// Records the textarea's value at every commit (layout effects run in the commit, before any
// passive effect) so a one-commit lag between the `value` prop and the textarea is observable
// deterministically, without depending on timers or load.
function Probe({ value, seen }: { value: string; seen: string[] }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { seen.push(box.current!.querySelector("textarea")!.value); });
  return <div ref={box}><Field label="Target" value={value} onSave={() => {}} /></div>;
}

describe("Field", () => {
  it("shows a new value in the same commit that delivers the prop (no empty frame)", () => {
    const seen: string[] = [];
    const { rerender } = render(<Probe value="" seen={seen} />);
    seen.length = 0;
    rerender(<Probe value="cut triage 30%" seen={seen} />);
    // every commit that carries the new prop already shows it
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe("cut triage 30%");
  });

  it("keeps an in-progress edit when the prop changes while focused, and saves it on blur", () => {
    const saved: string[] = [];
    const { rerender } = render(<Field label="Target" value="a" onSave={(v) => saved.push(v)} />);
    const ta = screen.getByLabelText(/target/i) as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "mine" } });
    rerender(<Field label="Target" value="b" onSave={(v) => saved.push(v)} />);
    expect(ta.value).toBe("mine");
    fireEvent.blur(ta);
    expect(saved).toEqual(["mine"]);
  });

  it("re-syncs from the prop when not editing", () => {
    const { rerender } = render(<Field label="Target" value="a" onSave={() => {}} />);
    rerender(<Field label="Target" value="b" onSave={() => {}} />);
    expect((screen.getByLabelText(/target/i) as HTMLTextAreaElement).value).toBe("b");
  });
  it("an untouched focused field adopts the newer prop on blur and saves nothing", () => {
    const saved: string[] = [];
    const { rerender } = render(<Field label="Target" value="a" onSave={(v) => saved.push(v)} />);
    const ta = screen.getByLabelText(/target/i) as HTMLTextAreaElement;
    fireEvent.focus(ta);
    rerender(<Field label="Target" value="b" onSave={(v) => saved.push(v)} />);
    fireEvent.blur(ta);
    expect(saved).toEqual([]);
    expect(ta.value).toBe("b");
  });

  it("an edited field keeps the user's text over a newer prop on blur", () => {
    const saved: string[] = [];
    const { rerender } = render(<Field label="Target" value="a" onSave={(v) => saved.push(v)} />);
    const ta = screen.getByLabelText(/target/i) as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "mine" } });
    rerender(<Field label="Target" value="b" onSave={(v) => saved.push(v)} />);
    fireEvent.blur(ta);
    expect(saved).toEqual(["mine"]);
  });

  it("an edit reverted to the focus-time value counts as untouched: newer prop wins", () => {
    const saved: string[] = [];
    const { rerender } = render(<Field label="Target" value="a" onSave={(v) => saved.push(v)} />);
    const ta = screen.getByLabelText(/target/i) as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "mine" } });
    fireEvent.change(ta, { target: { value: "a" } });
    rerender(<Field label="Target" value="b" onSave={(v) => saved.push(v)} />);
    fireEvent.blur(ta);
    expect(saved).toEqual([]);
    expect(ta.value).toBe("b");
  });
});
