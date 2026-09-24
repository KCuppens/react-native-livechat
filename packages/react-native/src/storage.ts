import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StorageAdapter } from "@kobecuppens/livechat-core";

export const asyncStorageAdapter: StorageAdapter = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};
