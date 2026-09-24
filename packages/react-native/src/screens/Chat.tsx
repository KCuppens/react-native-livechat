import { LiveChatApiError, MAX_ATTACHMENT_BYTES, type Attachment, type ChatMessage } from "@kobecuppens/livechat-core";
import {
  useArticleSuggestions,
  useConversation,
  useLiveChatClient,
  useMessenger,
  useTranslate,
  useWorkspaceConfig,
} from "@kobecuppens/livechat-react/hooks";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Image, Linking, Pressable, Text, TextInput, View } from "react-native";
import { Markdown } from "../Markdown";
import { usePickAttachment } from "../provider";
import { useTheme } from "../theme";
import { Avatar, ErrorState, Glyph, Header, IconButton, Loading, PrimaryButton } from "./shared";

type Item = { kind: "message"; message: ChatMessage; first: boolean; lastOfGroup: boolean } | { kind: "typing" };

const CSAT_FACES = ["😞", "🙁", "😐", "🙂", "😍"];

function Csat({ score, onSubmit }: { score: number | null; onSubmit: (score: number, comment?: string) => Promise<void> }) {
  const theme = useTheme();
  const t = useTranslate();
  const [selected, setSelected] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (score !== null) return <Text style={{ color: theme.muted, textAlign: "center", fontSize: 12, marginVertical: 12 }}>{t("csat.thanks")}</Text>;
  return (
    <View style={{ backgroundColor: theme.surface, borderRadius: 14, padding: 16, marginVertical: 12, alignItems: "center" }}>
      <Text style={{ color: theme.text, fontWeight: "600" }}>{t("csat.question")}</Text>
      <View style={{ flexDirection: "row", gap: 8, marginVertical: 12 }} accessibilityRole="radiogroup" accessibilityLabel={t("csat.question")}>
        {CSAT_FACES.map((face, i) => (
          <Pressable
            key={face}
            onPress={() => setSelected(i + 1)}
            accessibilityRole="radio"
            accessibilityLabel={t("csat.score", { score: i + 1 })}
            accessibilityState={{ checked: selected === i + 1 }}
            style={{ width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: theme.bg, borderWidth: 1, borderColor: selected === i + 1 ? theme.primary : theme.border }}
          >
            <Text style={{ fontSize: 22 }}>{face}</Text>
          </Pressable>
        ))}
      </View>
      {selected !== null && (
        <View style={{ alignSelf: "stretch", gap: 10 }}>
          <TextInput
            value={comment}
            onChangeText={setComment}
            placeholder={t("csat.commentPlaceholder")}
            placeholderTextColor={theme.muted}
            multiline
            maxLength={2000}
            style={{ minHeight: 60, borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: 10, color: theme.text, backgroundColor: theme.bg, textAlignVertical: "top" }}
          />
          <PrimaryButton
            title={busy ? t("chat.sending") : t("csat.submit")}
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              setFailed(false);
              try {
                await onSubmit(selected, comment.trim() || undefined);
              } catch {
                // Tell the customer; otherwise they'd assume the rating was sent.
                setFailed(true);
              } finally {
                setBusy(false);
              }
            }}
          />
          {failed && (
            <Text accessibilityRole="alert" style={{ color: theme.danger, fontSize: 12, textAlign: "center" }}>
              {t("common.error")}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function Attachments({ items, mine }: { items: Attachment[]; mine: boolean }) {
  const theme = useTheme();
  if (items.length === 0) return null;
  return (
    <View style={{ gap: 6, marginTop: 4, alignItems: mine ? "flex-end" : "flex-start" }}>
      {items.map((a) =>
        a.contentType.startsWith("image/") && a.url ? (
          <Pressable key={a.id} onPress={() => void Linking.openURL(a.url!)} accessibilityRole="imagebutton" accessibilityLabel={a.name}>
            <Image
              source={{ uri: a.url }}
              style={{ width: 200, height: a.width && a.height ? Math.min(260, (200 * a.height) / a.width) : 150, borderRadius: 12, backgroundColor: theme.surface2 }}
              resizeMode="cover"
            />
          </Pressable>
        ) : (
          <Pressable key={a.id} onPress={() => a.url && void Linking.openURL(a.url)} accessibilityRole="link" style={{ padding: 10, borderRadius: 12, backgroundColor: theme.surface2 }}>
            <Text style={{ color: theme.text }}>📄 {a.name}</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

export function ChatScreen({ conversationId, onClose }: { conversationId: string | null; onClose?: () => void }) {
  const theme = useTheme();
  const t = useTranslate();
  const client = useLiveChatClient();
  const messenger = useMessenger();
  const config = useWorkspaceConfig();
  const pickAttachment = usePickAttachment();
  const onCreated = useCallback((id: string) => messenger.replace({ name: "conversation", id }), [messenger]);
  const { thread, conversation, send, retry, loadOlder, setTyping, submitCsat } = useConversation(conversationId, onCreated);
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<{ key: string; name: string; attachment?: Attachment; error?: string }[]>([]);
  const suggestions = useArticleSuggestions(conversationId ? "" : draft);

  const messages = thread.messages;
  const lastMine = [...messages].reverse().find((m) => m.authorType === "contact" && m.status === "sent");
  const seen = !!lastMine && thread.agentLastReadAt >= lastMine.createdAt;

  // Inverted list: newest first.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = messages.map((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const same = (a?: ChatMessage) => !!a && a.authorType === m.authorType && a.author?.id === m.author?.id;
      return { kind: "message", message: m, first: !same(prev), lastOfGroup: !same(next) };
    });
    if (thread.typing) out.push({ kind: "typing" });
    return out.reverse();
  }, [messages, thread.typing]);

  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const ready = uploads.filter((u) => u.attachment).map((u) => u.attachment!);
  const canSend = !uploading && (draft.trim().length > 0 || ready.length > 0);
  const agentName = conversation?.assignee?.name ?? config?.branding.name ?? t("chat.support");

  const submit = () => {
    if (!canSend) return;
    void send(draft.trim(), ready.map((a) => a.id), ready);
    setDraft("");
    setUploads([]);
  };

  const attach = async () => {
    if (!pickAttachment) return;
    const file = await pickAttachment();
    if (!file) return;
    const key = `${file.uri}-${Date.now()}`;
    setUploads((u) => [...u, { key, name: file.name }]);
    try {
      const body = await (await fetch(file.uri)).blob();
      const attachment = await client.uploadAttachment({ body, name: file.name, type: file.type, size: file.size, width: file.width, height: file.height });
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, attachment } : x)));
    } catch (err) {
      const error =
        err instanceof LiveChatApiError && err.code === "too_large"
          ? t("chat.attachmentTooLarge", { mb: MAX_ATTACHMENT_BYTES / 1024 / 1024 })
          : err instanceof LiveChatApiError && err.code === "unsupported_type"
            ? t("chat.attachmentType")
            : t("common.error");
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, error } : x)));
    }
  };

  const typing = thread.typing;
  const csatScore = conversation?.csatScore ?? null;
  const lastMineId = lastMine?.id;
  // Stable across keystrokes (draft isn't a dependency), so typing doesn't re-render every cell.
  const renderItem = useCallback(({ item }: { item: Item }) => {
    if (item.kind === "typing") {
      return (
        <View
          style={{ flexDirection: "row", gap: 8, alignItems: "flex-end", marginTop: 10 }}
          // `accessible` makes the label the announced text instead of "bullet bullet bullet".
          accessible
          accessibilityLabel={typing?.name ? t("chat.typing", { name: typing.name }) : t("chat.someoneTyping")}
        >
          <Avatar name={typing?.name ?? agentName} size={28} />
          <View style={{ backgroundColor: theme.surface, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 }} importantForAccessibility="no-hide-descendants">
            <Text style={{ color: theme.muted, fontSize: 18, lineHeight: 18 }}>•••</Text>
          </View>
        </View>
      );
    }
    const m = item.message;
    if (m.authorType === "system") {
      if (m.systemEvent === "csat_request") return <Csat score={csatScore} onSubmit={submitCsat} />;
      const text =
        m.systemEvent === "resolved" ? t("chat.resolved") : m.systemEvent === "reopened" ? t("chat.reopened") : m.systemEvent === "assigned" ? t("chat.assigned", { name: m.body }) : m.body;
      const auto = m.systemEvent === "auto_reply";
      return (
        <Text style={{ alignSelf: "center", textAlign: "center", marginVertical: 12, color: auto ? theme.text : theme.muted, fontSize: auto ? 13 : 12, backgroundColor: auto ? theme.surface : "transparent", padding: auto ? 10 : 0, borderRadius: 12, overflow: "hidden", maxWidth: "85%" }}>
          {text}
        </Text>
      );
    }
    const mine = m.authorType === "contact";
    return (
      <View style={{ flexDirection: mine ? "row-reverse" : "row", gap: 8, alignItems: "flex-end", marginTop: item.first ? 10 : 2, maxWidth: "85%", alignSelf: mine ? "flex-end" : "flex-start" }}>
        {!mine && <View style={{ width: 28 }}>{item.lastOfGroup && <Avatar name={m.author?.name} url={m.author?.avatarUrl} size={28} />}</View>}
        <View style={{ flexShrink: 1, alignItems: mine ? "flex-end" : "flex-start" }}>
          {!mine && item.first && <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 3, marginLeft: 4 }}>{m.author?.name ?? t("chat.support")}</Text>}
          {!!m.body && (
            <View
              style={{
                backgroundColor: m.status === "failed" ? "transparent" : mine ? theme.primary : theme.surface,
                borderWidth: m.status === "failed" ? 1 : 0,
                borderColor: theme.danger,
                opacity: m.status === "sending" ? 0.6 : 1,
                borderRadius: 18,
                paddingHorizontal: 13,
                paddingVertical: 9,
              }}
            >
              <Markdown source={m.body} color={mine && m.status !== "failed" ? theme.onPrimary : theme.text} />
            </View>
          )}
          <Attachments items={m.attachments} mine={mine} />
          {m.status === "failed" && (
            <Pressable onPress={() => void retry(m.clientId!)} accessibilityRole="button">
              <Text style={{ color: theme.danger, fontSize: 12, marginTop: 3 }}>{t("chat.failed")}</Text>
            </Pressable>
          )}
          {m.status === "sending" && <Text style={{ color: theme.muted, fontSize: 12, marginTop: 3 }}>{t("chat.sending")}</Text>}
          {m.id === lastMineId && seen && <Text style={{ color: theme.muted, fontSize: 12, marginTop: 3 }}>{t("chat.seen")}</Text>}
        </View>
      </View>
    );
  }, [theme, t, typing, agentName, csatScore, submitCsat, retry, lastMineId, seen]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header
        title={conversationId ? agentName : t("chat.newConversation")}
        subtitle={config?.online ? (config.typicalReplyMinutes ? t("status.replyTime", { minutes: config.typicalReplyMinutes }) : t("status.online")) : t("status.offline")}
        avatar={<Avatar name={agentName} url={conversation?.assignee?.avatarUrl} brand={!conversation?.assignee} size={32} />}
        onClose={onClose}
      />
      {conversationId && thread.loaded && thread.connection === "connecting" && (
        <Text style={{ textAlign: "center", padding: 6, fontSize: 12, color: theme.muted, backgroundColor: theme.surface }}>{t("common.offline")}</Text>
      )}
      {conversationId && !thread.loaded && thread.error ? (
        <ErrorState onRetry={() => void client.retryLoad(conversationId)} />
      ) : conversationId && !thread.loaded ? (
        <Loading />
      ) : (
        <FlatList
          inverted
          data={items}
          keyExtractor={(item) => (item.kind === "typing" ? "typing" : item.message.id)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12 }}
          keyboardShouldPersistTaps="handled"
          onEndReached={() => thread.hasOlder && void loadOlder()}
          onEndReachedThreshold={0.2}
          ListFooterComponent={thread.loading && thread.loaded ? <Loading /> : undefined}
        />
      )}

      {!conversationId && suggestions.length > 0 && (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.border, paddingVertical: 6 }}>
          <Text style={{ color: theme.muted, fontSize: 12, fontWeight: "600", paddingHorizontal: 16, paddingVertical: 4, textTransform: "uppercase" }}>{t("chat.suggestedArticles")}</Text>
          {suggestions.map((a) => (
            <Pressable key={a.id} onPress={() => messenger.navigate({ name: "article", slug: a.slug })} accessibilityRole="link" style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
              <Text style={{ color: theme.primary, fontWeight: "500" }}>{a.title}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={{ borderTopWidth: 1, borderTopColor: theme.border, padding: 10, gap: 8 }}>
        {uploads.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {uploads.map((u) => (
              <Pressable
                key={u.key}
                onPress={() => setUploads((all) => all.filter((x) => x.key !== u.key))}
                accessibilityLabel={`${t("common.close")} ${u.name}`}
                style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: u.error ? "transparent" : theme.surface, borderWidth: u.error ? 1 : 0, borderColor: theme.danger, opacity: u.attachment || u.error ? 1 : 0.6 }}
              >
                <Text style={{ color: theme.text, fontSize: 13, maxWidth: 180 }} numberOfLines={1}>
                  {u.error ? `${u.name} — ${u.error}` : u.name}
                </Text>
                <Text style={{ color: theme.muted }}>✕</Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
          {pickAttachment && (
            <IconButton onPress={() => void attach()} label={t("chat.attach")} disabled={uploads.length >= 5}>
              <Glyph name="attach" color={theme.muted} />
            </IconButton>
          )}
          <TextInput
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              setTyping(text.length > 0);
            }}
            placeholder={t("chat.placeholder")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("chat.placeholder")}
            multiline
            maxLength={5000}
            style={{ flex: 1, minHeight: 42, maxHeight: 140, borderWidth: 1, borderColor: theme.border, borderRadius: 14, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, color: theme.text, fontSize: 15, textAlignVertical: "top" }}
          />
          <Pressable
            onPress={submit}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={t("chat.send")}
            style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", opacity: canSend ? 1 : 0.4 }}
          >
            <Glyph name="send" color={theme.onPrimary} size={18} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
