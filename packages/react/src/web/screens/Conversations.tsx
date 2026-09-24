import { useLiveChatState, useMessenger, useTranslate } from "../../hooks/context";
import { useConversations, useWorkspaceConfig } from "../../hooks/data";
import { relativeTime } from "../util";
import { Avatar, ErrorState, Header, Loading } from "./shared";

export function ConversationsScreen() {
  const t = useTranslate();
  const messenger = useMessenger();
  const config = useWorkspaceConfig();
  const locale = useLiveChatState((s) => s.locale);
  const { conversations, loaded, error, refresh } = useConversations();
  return (
    <>
      <Header title={t("home.recentConversations")} />
      <div className="lc-body">
        {!loaded ? (
          error ? <ErrorState onRetry={refresh} /> : <Loading />
        ) : conversations.length === 0 ? (
          <div className="lc-empty">{t("chat.empty")}</div>
        ) : (
          conversations.map((c) => (
            <button type="button" key={c.id} className="lc-row" onClick={() => messenger.navigate({ name: "conversation", id: c.id })}>
              <Avatar name={c.assignee?.name ?? config?.branding.name} url={c.assignee?.avatarUrl} brand={!c.assignee} />
              <div className="lc-row-main">
                <strong>{c.assignee?.name ?? config?.branding.name}</strong>
                <span>{c.lastMessage?.body || "📎"}</span>
              </div>
              {c.unreadCount > 0 && (
                <>
                  <i className="lc-dot" aria-hidden="true" />
                  <span className="lc-sr">{t("chat.unread")}</span>
                </>
              )}
              <span className="lc-row-meta">{relativeTime(c.lastMessageAt, locale)}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}
