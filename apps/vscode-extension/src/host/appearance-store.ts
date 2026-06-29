/**
 * AppearanceStore — appearance settings persisted in VS Code globalState.
 */

/** User-facing display preferences. */
export interface Appearance {
  theme: "dark" | "light" | "system";
  richToolOutput: boolean;
  stickyLastMessage: boolean;
  notifications: boolean;
}

const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  richToolOutput: true,
  stickyLastMessage: true,
  notifications: false,
};

const STORE_KEY = "octoshell.appearance";

/** Minimal interface so this class is testable without real VS Code. */
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class AppearanceStore {
  private readonly memento: Memento;

  constructor(memento: Memento) {
    this.memento = memento;
  }

  get(): Appearance {
    const raw = this.memento.get<Appearance>(STORE_KEY);
    return raw ? { ...DEFAULT_APPEARANCE, ...raw } : { ...DEFAULT_APPEARANCE };
  }

  set(value: Appearance): void {
    void this.memento.update(STORE_KEY, value);
  }
}
