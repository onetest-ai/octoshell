import { describe, it, expect } from "vitest";
import { AppearanceStore, type Appearance } from "../src/host/appearance-store.js";
import { FakeMemento } from "./helpers.js";

describe("AppearanceStore", () => {
  it("round-trips appearance settings", () => {
    const memento = new FakeMemento();
    const store = new AppearanceStore(memento);

    const appearance: Appearance = {
      theme: "light",
      richToolOutput: false,
      stickyLastMessage: false,
      notifications: true,
    };

    store.set(appearance);
    const result = store.get();

    expect(result).toEqual(appearance);
  });
});
