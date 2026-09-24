import { useConversations, useHelpHome, useHelpSearch, useLiveChatState, useMessenger, useTranslate, useWorkspaceConfig } from "@kobecuppens/livechat-react/hooks";
import { useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useTheme } from "../theme";
import { Avatar, Card, ErrorState, Glyph, IconButton, Loading, Row, SectionTitle } from "./shared";

export function HomeScreen({ onClose }: { onClose?: () => void }) {
  const theme = useTheme();
  const t = useTranslate();
  const messenger = useMessenger();
  const config = useWorkspaceConfig();
  const locale = useLiveChatState((s) => s.locale);
  const [query, setQuery] = useState("");
  const home = useHelpHome();
  const search = useHelpSearch(query);
  const { conversations } = useConversations();
  const searching = query.trim().length >= 2;
  const status = config?.online
    ? config.typicalReplyMinutes
      ? t("status.replyTime", { minutes: config.typicalReplyMinutes })
      : t("status.online")
    : t("status.offline");

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.surface }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ backgroundColor: theme.primary, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 56 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 18, minHeight: 40 }}>
          {config?.branding.logoUrl ? (
            <Image source={{ uri: config.branding.logoUrl }} style={{ height: 28, width: 140 }} resizeMode="contain" accessibilityLabel={config.branding.name} />
          ) : (
            <Text style={{ color: theme.onPrimary, fontWeight: "700", fontSize: 16 }}>{config?.branding.name}</Text>
          )}
          {onClose && (
            <IconButton onPress={onClose} label={t("common.close")}>
              <Glyph name="close" color={theme.onPrimary} size={18} />
            </IconButton>
          )}
        </View>
        <Text style={{ color: theme.onPrimary, fontSize: 26, fontWeight: "700", lineHeight: 32 }} accessibilityRole="header">
          {config?.branding.greeting[locale] ?? t("home.greeting")}
        </Text>
      </View>

      <View style={{ marginTop: -40, paddingHorizontal: 16, gap: 12 }}>
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 8 }}>
            <Glyph name="search" color={theme.muted} size={18} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("home.searchPlaceholder")}
              placeholderTextColor={theme.muted}
              accessibilityLabel={t("home.searchPlaceholder")}
              returnKeyType="search"
              autoCorrect={false}
              style={{ flex: 1, height: 48, color: theme.text, fontSize: 15 }}
            />
          </View>
          {searching &&
            (search.error && !search.pending ? (
              // A failed search is not "no results".
              <ErrorState onRetry={search.reload} />
            ) : search.pending && !search.data ? (
              <Loading />
            ) : search.data && search.data.length > 0 ? (
              search.data.map((a) => <Row key={a.id} title={a.title} subtitle={a.excerpt} onPress={() => messenger.navigate({ name: "article", slug: a.slug })} />)
            ) : (
              <Text style={{ color: theme.muted, padding: 20, textAlign: "center" }}>{t("faq.noResults", { query: query.trim() })}</Text>
            ))}
        </Card>

        {!searching && (
          <>
            <Card>
              <Pressable onPress={() => messenger.navigate({ name: "new" })} accessibilityRole="button" style={({ pressed }) => ({ padding: 16, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? theme.surface : "transparent" })}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: "600", fontSize: 15 }}>{t("home.startChat")}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: config?.online ? theme.success : theme.muted }} />
                    <Text style={{ color: theme.muted, fontSize: 13, flexShrink: 1 }}>{status}</Text>
                  </View>
                </View>
                <Glyph name="send" color={theme.primary} />
              </Pressable>
            </Card>

            {conversations.length > 0 && (
              <Card>
                <SectionTitle>{t("home.recentConversations")}</SectionTitle>
                {conversations.slice(0, 3).map((c, i) => (
                  <Row
                    key={c.id}
                    first={i === 0}
                    title={c.assignee?.name ?? config?.branding.name ?? ""}
                    subtitle={c.lastMessage?.body || "📎"}
                    left={<Avatar name={c.assignee?.name ?? config?.branding.name} url={c.assignee?.avatarUrl} brand={!c.assignee} />}
                    right={c.unreadCount > 0 ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: theme.danger }} accessible accessibilityLabel={t("chat.unread")} /> : undefined}
                    onPress={() => messenger.navigate({ name: "conversation", id: c.id })}
                  />
                ))}
                {conversations.length > 3 && <Row title={t("home.recentConversations")} onPress={() => messenger.navigate({ name: "conversations" })} />}
              </Card>
            )}

            {home.error && !home.data ? (
              <ErrorState onRetry={home.reload} />
            ) : home.loading && !home.data ? (
              <Loading />
            ) : (
              <>
                {!!home.data?.popular.length && (
                  <Card>
                    <SectionTitle>{t("home.popularArticles")}</SectionTitle>
                    {home.data.popular.map((a, i) => (
                      <Row key={a.id} first={i === 0} title={a.title} onPress={() => messenger.navigate({ name: "article", slug: a.slug })} />
                    ))}
                  </Card>
                )}
                {!!home.data?.categories.length && (
                  <Card>
                    <SectionTitle>{t("home.categories")}</SectionTitle>
                    {home.data.categories.map((c, i) => (
                      <Row
                        key={c.id}
                        first={i === 0}
                        title={c.title}
                        subtitle={c.description ?? t("faq.articlesCount", { count: c.articleCount })}
                        onPress={() => messenger.navigate({ name: "category", id: c.id, title: c.title })}
                      />
                    ))}
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
