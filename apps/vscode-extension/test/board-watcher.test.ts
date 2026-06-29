import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQuiescentDebouncer } from "../src/host/board-watcher.js";

describe("createQuiescentDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of triggers into ONE settle after the debounce window", () => {
    const onSettle = vi.fn();
    const gate = createQuiescentDebouncer({ debounceMs: 350, retryMs: 400, isQuiescent: () => true, onSettle });
    gate.trigger();
    gate.trigger();
    gate.trigger();
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1); // the whole burst → a single rebuild
  });

  it("defers the settle while git is non-quiescent, then runs exactly once after it settles", () => {
    let quiescent = false;
    const onSettle = vi.fn();
    const gate = createQuiescentDebouncer({ debounceMs: 350, retryMs: 400, isQuiescent: () => quiescent, onSettle });
    gate.trigger();
    vi.advanceTimersByTime(350);
    expect(onSettle).not.toHaveBeenCalled(); // git mid-operation → deferred, no rebuild
    vi.advanceTimersByTime(400);
    expect(onSettle).not.toHaveBeenCalled(); // still mid-operation → still deferred
    quiescent = true;
    vi.advanceTimersByTime(400);
    expect(onSettle).toHaveBeenCalledTimes(1); // git settled → exactly one rebuild
  });

  it("dispose cancels a pending settle", () => {
    const onSettle = vi.fn();
    const gate = createQuiescentDebouncer({ debounceMs: 350, retryMs: 400, isQuiescent: () => true, onSettle });
    gate.trigger();
    gate.dispose();
    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();
  });
});
