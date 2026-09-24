import { useConversations, useMessenger, useTranslate, useWorkspaceConfig } from "@kobecuppens/livechat-react/hooks";
import { FlatList, Text, View } from "react-native";
import { useTheme } from "../theme";
import { Avatar, ErrorState, Header, Loading, Row } from "./shared";

export function ConversationsScreen({ onClose }: { onClose?: () => void }) {
  const theme = useTheme();
  const t = useTranslate();
  const messenger = useMessenger();
  const config = useWorkspaceConfig();
  const { conversations, loaded, error, refresh } = useConversations();
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header title={t("home.recentConversations")} onClose={onClose} />
      {!loaded ? (
        error ? <ErrorState onRetry={refresh} /> : <Loading />
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c.id}
          onRefresh={refresh}
          refreshing={false}
          ListEmptyComponent={<Text style={{ color: theme.muted, textAlign: "center", padding: 32 }}>{t("chat.empty")}</Text>}
          renderItem={({ item: c, index }) => (
            <Row
              first={index === 0}
              title={c.assignee?.name ?? config?.branding.name ?? ""}
              subtitle={c.lastMessage?.body || "📎"}
              left={<Avatar name={c.assignee?.name ?? config?.branding.name} url={c.assignee?.avatarUrl} brand={!c.assignee} />}
              right={c.unreadCount > 0 ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: theme.danger }} accessible accessibilityLabel={t("chat.unread")} /> : undefined}
              onPress={() => messenger.navigate({ name: "conversation", id: c.id })}
            />
          )}
        />
      )}
    </View>
  );
}
