/** In-memory fake VS Code Memento for use in tests without real VS Code. */
export class FakeMemento {
  private store: Record<string, unknown> = {};
  get<T>(key: string): T | undefined { return this.store[key] as T | undefined; }
  update(key: string, value: unknown): Promise<void> {
    this.store[key] = value;
    return Promise.resolve();
  }
}
