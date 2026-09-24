import { LiveChat, LiveChatProvider, SupportModal, useUnreadCount, type PickedFile } from "@kobecuppens/livechat-react-native";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Button, Platform, Text, View } from "react-native";

const { livechatApiUrl, livechatKey } = Constants.expoConfig?.extra as { livechatApiUrl: string; livechatKey: string };
const appId = Platform.OS === "ios" ? Constants.expoConfig?.ios?.bundleIdentifier : Constants.expoConfig?.android?.package;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

async function pickAttachment(): Promise<PickedFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
  const asset = result.assets?.[0];
  if (result.canceled || !asset) return null;
  return {
    uri: asset.uri,
    name: asset.fileName ?? "photo.jpg",
    type: asset.mimeType ?? "image/jpeg",
    size: asset.fileSize ?? 0,
    width: asset.width,
    height: asset.height,
  };
}

/** Raw APNs custom keys arrive in trigger.payload; FCM data arrives in content.data. */
function livechatData(n: Notifications.Notification) {
  const trigger = n.request.trigger as { payload?: Record<string, unknown> } | null;
  return (n.request.content.data?.type === "livechat" ? n.request.content.data : trigger?.payload) as Record<string, unknown> | undefined;
}

async function registerForPush() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("livechat", { name: "Support messages", importance: Notifications.AndroidImportance.HIGH });
  }
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted || !appId) return;
  // Native FCM/APNs token (not an Expo push token): the livechat backend talks to FCM/APNs directly.
  const { data: token } = await Notifications.getDevicePushTokenAsync();
  await LiveChat.registerPushToken({ platform: Platform.OS === "ios" ? "ios" : "android", token, appId, sandbox: __DEV__ });
}

function Home() {
  const unread = useUnreadCount();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>Example app</Text>
      <Button title={`Help & support${unread ? ` (${unread})` : ""}`} onPress={() => LiveChat.open()} />
      <Button title="Message us" onPress={() => LiveChat.open({ name: "new" })} />
    </View>
  );
}

export default function App() {
  // Replace with your auth: the hash is HMAC-SHA256(identitySecret, user.id) computed on YOUR server.
  const [user] = useState<{ id: string; hash: string } | null>(null);

  useEffect(() => {
    void registerForPush().catch(console.warn);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => LiveChat.handleNotification(livechatData(r.notification)));
    // Cold start from a notification tap.
    void Notifications.getLastNotificationResponseAsync().then((r) => r && LiveChat.handleNotification(livechatData(r.notification)));
    return () => sub.remove();
  }, []);

  return (
    <LiveChatProvider apiUrl={livechatApiUrl} workspaceKey={livechatKey} user={user} locale={Intl.DateTimeFormat().resolvedOptions().locale} pickAttachment={pickAttachment}>
      <StatusBar style="auto" />
      <Home />
      <SupportModal />
    </LiveChatProvider>
  );
}
