/** Minimal external store compatible with React's useSyncExternalStore. */
export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private state: T) {}

  getSnapshot = (): T => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(update: Partial<T> | ((prev: T) => Partial<T>)): void {
    const patch = typeof update === "function" ? update(this.state) : update;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
