import {
  DRAFT_CONVERSATION,
  EMPTY_THREAD,
  type FaqArticle,
  type FaqArticleSummary,
  type FaqCategory,
  type LiveChatState,
} from "@kobecuppens/livechat-core";
import { useCallback, useEffect, useState } from "react";
import { useLiveChatClient, useLiveChatState } from "./context";


/**
 * A conversation screen's data + actions. Pass null for a new conversation: messages
 * show under the draft thread until the first send creates it (see `onCreated`).
 */
export function useConversation(conversationId: string | null, onCreated?: (id: string) => void) {
  const client = useLiveChatClient();
  const ready = useLiveChatState((s) => s.status === "ready");
  const threadId = conversationId ?? DRAFT_CONVERSATION;
  const thread = useLiveChatState(useCallback((s: LiveChatState) => s.threads[threadId] ?? EMPTY_THREAD, [threadId]));
  const conversation = useLiveChatState(
    useCallback((s: LiveChatState) => (conversationId ? s.conversations.find((c) => c.id === conversationId) ?? null : null), [conversationId]),
  );

  // Login/logout drops every open conversation's socket and messages: reopen for the new identity.
  const identity = useLiveChatState((s) => s.identity);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity is the reopen trigger
  useEffect(() => {
    if (!conversationId || !ready) return;
    return client.openConversation(conversationId);
  }, [client, conversationId, ready, identity]);

  const send = useCallback(
    async (body: string, attachmentIds?: string[], attachments?: Parameters<typeof client.sendMessage>[1]["attachments"]) => {
      const id = await client.sendMessage(conversationId, { body, attachmentIds, attachments });
      if (!conversationId && id) onCreated?.(id);
      return id;
    },
    [client, conversationId, onCreated],
  );

  return {
    thread,
    conversation,
    send,
    retry: useCallback((clientId: string) => client.retry(clientId), [client]),
    discard: useCallback((clientId: string) => client.discard(clientId), [client]),
    loadOlder: useCallback(() => (conversationId ? client.loadOlder(conversationId) : Promise.resolve()), [client, conversationId]),
    setTyping: useCallback((typing: boolean) => conversationId && client.setTyping(conversationId, typing), [client, conversationId]),
    submitCsat: useCallback(
      (score: number, comment?: string) => (conversationId ? client.submitCsat(conversationId, { score, comment }) : Promise.resolve()),
      [client, conversationId],
    ),
  };
}

export function useConversations() {
  const client = useLiveChatClient();
  const ready = useLiveChatState((s) => s.status === "ready");
  const conversations = useLiveChatState((s) => s.conversations);
  const loaded = useLiveChatState((s) => s.conversationsLoaded);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    return client.refreshConversations().catch((e: Error) => setError(e.message));
  }, [client]);

  const identity = useLiveChatState((s) => s.identity);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity is the refetch trigger (login/logout clears the list)
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh, identity]);

  return { conversations, loaded, error, refresh };
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Runs `load` whenever deps change; pass null to skip. Ignores responses from stale runs. */
function useAsync<T>(load: (() => Promise<T>) | null, deps: unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: !!load, error: null });
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is a fresh closure every render; callers pass the values it depends on as deps, and nonce is the reload trigger
  useEffect(() => {
    if (!load) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => !cancelled && setState({ data, loading: false, error: null }),
      (e: Error) => !cancelled && setState({ data: null, loading: false, error: e.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** Categories + popular articles for the help home screen. */
export function useHelpHome() {
  const client = useLiveChatClient();
  const locale = useLiveChatState((s) => s.locale);
  const ready = useLiveChatState((s) => s.status === "ready");
  return useAsync<{ categories: FaqCategory[]; popular: FaqArticleSummary[] }>(
    ready
      ? async () => {
          const [categories, popular] = await Promise.all([
            client.http.listFaqCategories(locale),
            client.http.listFaqArticles({ locale, sort: "popular", limit: 5 }),
          ]);
          return { categories, popular };
        }
      : null,
    [client, locale, ready],
  );
}

export function useCategoryArticles(categoryId: string) {
  const client = useLiveChatClient();
  const locale = useLiveChatState((s) => s.locale);
  return useAsync(() => client.http.listFaqArticles({ locale, category: categoryId }), [client, locale, categoryId]);
}

export function useArticle(slug: string) {
  const client = useLiveChatClient();
  const locale = useLiveChatState((s) => s.locale);
  const result = useAsync<FaqArticle>(() => client.http.getFaqArticle(slug, locale), [client, slug, locale]);
  const [feedback, setFeedback] = useState<boolean | null>(null);
  const sendFeedback = useCallback(
    (helpful: boolean) => {
      if (!result.data || feedback !== null) return;
      setFeedback(helpful);
      void client.http.sendFaqFeedback(result.data.id, helpful).catch(() => {});
    },
    [client, result.data, feedback],
  );
  return { ...result, feedback, sendFeedback };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Search-as-you-type over the help center (debounced, latest query wins). */
export function useHelpSearch(query: string, { debounceMs = 200, mode = "all" as "all" | "any", limit = 8 } = {}) {
  const client = useLiveChatClient();
  const locale = useLiveChatState((s) => s.locale);
  const q = useDebounced(query.trim(), debounceMs);
  const minLength = mode === "any" ? 8 : 2;
  const result = useAsync<FaqArticleSummary[]>(
    q.length >= minLength ? () => client.http.searchFaq(q, { locale, mode, limit }) : null,
    [client, q, locale, mode, limit],
  );
  return { ...result, query: q, pending: query.trim() !== q || result.loading };
}

/** Articles that might answer a message being typed in a new conversation (deflection). */
export function useArticleSuggestions(draft: string) {
  const { data } = useHelpSearch(draft, { debounceMs: 500, mode: "any", limit: 3 });
  return data ?? [];
}

export function useWorkspaceConfig() {
  return useLiveChatState((s) => s.config);
}
