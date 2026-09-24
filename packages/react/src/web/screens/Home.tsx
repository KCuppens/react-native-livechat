import { useState } from "react";
import { useLiveChatState, useMessenger, useTranslate } from "../../hooks/context";
import { useConversations, useHelpHome, useHelpSearch, useWorkspaceConfig } from "../../hooks/data";
import { ArticleIcon, ChevronIcon, SearchIcon, SendIcon } from "../icons";
import { relativeTime } from "../util";
import { CloseButton, ErrorState, Loading } from "./shared";
import { ArticleRows } from "./Articles";

export function HomeScreen() {
  const t = useTranslate();
  const messenger = useMessenger();
  const config = useWorkspaceConfig();
  const locale = useLiveChatState((s) => s.locale);
  const [query, setQuery] = useState("");
  const home = useHelpHome();
  const search = useHelpSearch(query);
  const { conversations } = useConversations();
  const recent = conversations.slice(0, 3);
  const greeting = config?.branding.greeting[locale] ?? t("home.greeting");
  const searching = query.trim().length >= 2;

  return (
    <div className="lc-body">
      <div className="lc-hero">
        <div className="lc-hero-top">
          {config?.branding.logoUrl ? <img src={config.branding.logoUrl} alt={config.branding.name} /> : <strong>{config?.branding.name}</strong>}
          <CloseButton />
        </div>
        <h1 data-screen-title tabIndex={-1}>
          {greeting}
        </h1>
      </div>

      <div className="lc-home-cards">
        <div className="lc-card">
          <label className="lc-search">
            <SearchIcon />
            <span className="lc-sr">{t("home.searchPlaceholder")}</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("home.searchPlaceholder")}
              autoComplete="off"
            />
          </label>
          {searching &&
            (search.error && !search.pending ? (
              // A failed search is not "no results": say so and offer a retry.
              <ErrorState onRetry={search.reload} />
            ) : search.pending && !search.data ? (
              <Loading />
            ) : search.data && search.data.length > 0 ? (
              <ArticleRows articles={search.data} />
            ) : (
              <div className="lc-empty">{t("faq.noResults", { query: query.trim() })}</div>
            ))}
        </div>

        {!searching && (
          <>
            <div className="lc-card">
              <button type="button" className="lc-cta" onClick={() => messenger.navigate({ name: "new" })}>
                <div className="lc-cta-main">
                  <strong>{t("home.startChat")}</strong>
                  <span>
                    <i className={`lc-status-dot${config?.online ? " lc-online" : ""}`} />
                    {config?.online
                      ? config.typicalReplyMinutes
                        ? t("status.replyTime", { minutes: config.typicalReplyMinutes })
                        : t("status.online")
                      : t("status.offline")}
                  </span>
                </div>
                <SendIcon />
              </button>
            </div>

            {recent.length > 0 && (
              <div className="lc-card">
                <div className="lc-card-title">{t("home.recentConversations")}</div>
                {recent.map((c) => (
                  <button type="button" key={c.id} className="lc-row" onClick={() => messenger.navigate({ name: "conversation", id: c.id })}>
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
                ))}
                {conversations.length > 3 && (
                  <button type="button" className="lc-row" onClick={() => messenger.navigate({ name: "conversations" })}>
                    <div className="lc-row-main">
                      <strong>{t("home.recentConversations")}</strong>
                    </div>
                    <ChevronIcon />
                  </button>
                )}
              </div>
            )}

            {home.error && !home.data ? (
              <ErrorState onRetry={home.reload} />
            ) : home.loading && !home.data ? (
              <Loading />
            ) : (
              <>
                {home.data && home.data.popular.length > 0 && (
                  <div className="lc-card">
                    <div className="lc-card-title">{t("home.popularArticles")}</div>
                    <ArticleRows articles={home.data.popular} />
                  </div>
                )}
                {home.data && home.data.categories.length > 0 && (
                  <div className="lc-card">
                    <div className="lc-card-title">{t("home.categories")}</div>
                    {home.data.categories.map((c) => (
                      <button type="button" key={c.id} className="lc-row" onClick={() => messenger.navigate({ name: "category", id: c.id, title: c.title })}>
                        <ArticleIcon />
                        <div className="lc-row-main">
                          <strong>{c.title}</strong>
                          <span>{c.description ?? t("faq.articlesCount", { count: c.articleCount })}</span>
                        </div>
                        <ChevronIcon />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
