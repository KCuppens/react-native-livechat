import type { StorageAdapter } from "@kobecuppens/livechat-core";

type AsyncStorageLike = {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
};

let asyncStorage: AsyncStorageLike | null | undefined;

/**
 * AsyncStorage, loaded on first use. Required lexically inside try/catch (not through a helper) so
 * Metro can bundle apps that don't install it and pass their own `storage` to the provider.
 */
function load(): AsyncStorageLike {
  if (asyncStorage === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("@react-native-async-storage/async-storage");
      asyncStorage = (mod.default ?? mod) as AsyncStorageLike;
    } catch {
      asyncStorage = null;
    }
  }
  if (!asyncStorage) {
    throw new Error("[livechat] Install @react-native-async-storage/async-storage or pass `storage` to <LiveChatProvider>.");
  }
  return asyncStorage;
}

export const asyncStorageAdapter: StorageAdapter = {
  getItem: (k) => load().getItem(k),
  setItem: (k, v) => load().setItem(k, v),
  removeItem: (k) => load().removeItem(k),
};
