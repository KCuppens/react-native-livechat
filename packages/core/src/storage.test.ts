import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, createWebStorage } from "./storage";

function fakeLocalStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: vi.fn((k: string) => map.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void map.set(k, v)),
    removeItem: vi.fn((k: string) => void map.delete(k)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMemoryStorage", () => {
  it("stores, reads and removes values", async () => {
    const s = createMemoryStorage();
    expect(await s.getItem("a")).toBeNull();
    await s.setItem("a", "1");
    expect(await s.getItem("a")).toBe("1");
    await s.removeItem("a");
    expect(await s.getItem("a")).toBeNull();
  });

  it("keeps separate instances isolated", async () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    await a.setItem("k", "v");
    expect(await b.getItem("k")).toBeNull();
  });
});

describe("createWebStorage", () => {
  it("delegates get/set/remove to localStorage", async () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const s = createWebStorage();

    // The availability probe is written and removed again.
    expect(ls.setItem).toHaveBeenCalledWith("__livechat_probe__", "1");
    expect(ls.removeItem).toHaveBeenCalledWith("__livechat_probe__");
    expect(ls.map.has("__livechat_probe__")).toBe(false);

    await s.setItem("token", "abc");
    expect(ls.setItem).toHaveBeenLastCalledWith("token", "abc");
    expect(ls.map.get("token")).toBe("abc");
    expect(await s.getItem("token")).toBe("abc");
    expect(await s.getItem("missing")).toBeNull();
    await s.removeItem("token");
    expect(ls.removeItem).toHaveBeenLastCalledWith("token");
    expect(ls.map.has("token")).toBe(false);
  });

  it("falls back to memory storage when setItem throws (private mode)", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.stubGlobal("localStorage", ls);
    const s = createWebStorage();

    await s.setItem("k", "v");
    expect(await s.getItem("k")).toBe("v");
    await s.removeItem("k");
    expect(await s.getItem("k")).toBeNull();
    // Only the probe hit localStorage; nothing afterwards.
    expect(ls.setItem).toHaveBeenCalledTimes(1);
    expect(ls.getItem).not.toHaveBeenCalled();
  });

  it("falls back to memory storage when localStorage is undefined (SSR)", async () => {
    vi.stubGlobal("localStorage", undefined);
    const s = createWebStorage();
    await s.setItem("k", "v");
    expect(await s.getItem("k")).toBe("v");
    await s.removeItem("k");
    expect(await s.getItem("k")).toBeNull();
  });
});
