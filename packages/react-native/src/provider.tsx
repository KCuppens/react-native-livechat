import type { PushDeviceRequest } from "@kobecuppens/livechat-core";
import {
  LiveChatProvider as BaseProvider,
  useLiveChatClient,
  useMessenger,
  type LiveChatProviderProps as BaseProps,
  type MessengerControls,
  type MessengerRoute,
} from "@kobecuppens/livechat-react/hooks";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { AppState } from "react-native";
import { asyncStorageAdapter } from "./storage";

/** A file picked by the host app's picker (expo-image-picker, react-native-image-picker, document picker…). */
export interface PickedFile {
  uri: string;
  name: string;
  /** MIME type, e.g. "image/jpeg". */
  type: string;
  size: number;
  width?: number;
  height?: number;
}

export interface LiveChatProviderProps extends Omit<BaseProps, "storage" | "children"> {
  /**
   * Opens a picker and resolves with the chosen file (or null if cancelled). When omitted the
   * attach button is hidden. See README for expo-image-picker / document-picker recipes.
   */
  pickAttachment?: () => Promise<PickedFile | null>;
  storage?: BaseProps["storage"];
  children: ReactNode;
}

const PickerContext = createContext<LiveChatProviderProps["pickAttachment"]>(undefined);
export const usePickAttachment = () => useContext(PickerContext);

// ------------------------------------------------------------ imperative API

let controls: MessengerControls | null = null;
let registerPush: ((d: PushDeviceRequest) => Promise<void>) | null = null;
const pendingPush: PushDeviceRequest[] = [];

/** Notification payloads created by the livechat backend carry these fields. */
export interface LiveChatNotificationData {
  type?: string;
  conversationId?: string;
  [key: string]: unknown;
}

export const LiveChat = {
  /** Opens the support modal (<SupportModal/> must be mounted), optionally at a screen. */
  open(route?: MessengerRoute) {
    controls?.open(route);
  },
  close() {
    controls?.close();
  },
  /** Opens the conversation from a push notification tap. Returns true if it was a livechat notification. */
  handleNotification(data: LiveChatNotificationData | undefined | null): boolean {
    if (data?.type !== "livechat" || typeof data.conversationId !== "string") return false;
    controls?.open({ name: "conversation", id: data.conversationId });
    return true;
  },
  /**
   * Registers this device's native push token (FCM on Android, APNs on iOS; e.g. from
   * `Notifications.getDevicePushTokenAsync()`). Safe to call before the provider is ready.
   */
  async registerPushToken(device: PushDeviceRequest): Promise<void> {
    if (registerPush) return registerPush(device);
    pendingPush.push(device);
  },
};

function Bridge() {
  const client = useLiveChatClient();
  const messenger = useMessenger();
  controls = messenger;

  useEffect(() => {
    registerPush = async (device) => {
      await client.init();
      await client.registerPushDevice(device);
    };
    for (const device of pendingPush.splice(0)) {
      registerPush(device).catch((err: unknown) => console.warn("[livechat] push registration failed", err));
    }
    return () => {
      registerPush = null;
    };
  }, [client]);

  // Reconnect realtime and refresh the badge when the app returns to the foreground.
  const last = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (/inactive|background/.test(last.current ?? "") && next === "active") client.resume();
      last.current = next;
    });
    return () => sub.remove();
  }, [client]);

  useEffect(() => () => {
    if (controls === messenger) controls = null;
  }, [messenger]);
  return null;
}

export function LiveChatProvider({ pickAttachment, storage, children, ...props }: LiveChatProviderProps) {
  return (
    <BaseProvider {...props} storage={storage ?? asyncStorageAdapter}>
      <PickerContext.Provider value={pickAttachment}>
        <Bridge />
        {children}
      </PickerContext.Provider>
    </BaseProvider>
  );
}
