/** Async key-value storage. AsyncStorage (React Native) and localStorage both fit behind this. */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
}

/** localStorage-backed storage; falls back to memory when unavailable (private mode, SSR). */
export function createWebStorage(): StorageAdapter {
  try {
    const ls = globalThis.localStorage;
    const probe = "__livechat_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return {
      getItem: async (k) => ls.getItem(k),
      setItem: async (k, v) => ls.setItem(k, v),
      removeItem: async (k) => ls.removeItem(k),
    };
  } catch {
    return createMemoryStorage();
  }
}
