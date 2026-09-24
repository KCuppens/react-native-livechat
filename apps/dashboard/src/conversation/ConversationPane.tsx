import type { AgentConversation, AgentMe, Attachment, Message } from "@kobecuppens/livechat-protocol";
import { Markdown } from "@kobecuppens/livechat-react";
import { memo, useLayoutEffect, useRef } from "react";
import type { Member } from "../api";
import { Avatar, Spinner } from "../components/ui";
import { useI18n, type DashKey, type Vars } from "../i18n";
import { Composer } from "./Composer";
import { contactName } from "./format";
import { useConversationThread } from "./useConversationThread";
import { useTypingSender } from "./useTypingSender";

const SYSTEM_TEXT: Record<string, (m: Message) => [DashKey, Vars?]> = {
  resolved: () => ["sys.resolved"],
  reopened: () => ["sys.reopened"],
  assigned: (m) => ["sys.assigned", { name: m.body }],
  csat_request: () => ["sys.csat_request"],
  auto_reply: (m) => ["sys.auto_reply", { body: m.body }],
};

// Memoized: the inbox list re-renders on every workspace event; the open thread shouldn't.
export const ConversationPane = memo(function ConversationPane({
  me,
  workspaceId,
  conversationId,
  summary,
  members,
  online,
  onAccessLost,
}: {
  me: AgentMe;
  workspaceId: string;
  conversationId: string;
  summary: AgentConversation | null;
  members: Member[];
  online: string[];
  onAccessLost: () => void;
}) {
  const { t } = useI18n();
  const thread = useConversationThread(me, workspaceId, conversationId, summary, onAccessLost);
  const { conversation, messages, pending, contactTyping, update } = thread;
  const sendTyping = useTypingSender(thread.socketRef);
  const listRef = useRef<HTMLDivElement>(null);

  // Scrolling: new messages at the bottom follow the thread only while the agent is at the
  // bottom (or sent one themselves); "Load earlier" keeps the viewport where it was.
  const nearBottom = useRef(true);
  const prev = useRef({ firstId: undefined as string | undefined, lastId: undefined as string | undefined, pending: 0, height: 0 });
  const firstId = messages?.[0]?.id;
  const lastId = messages?.[messages.length - 1]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the thread's ends, pending sends or typing change
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const p = prev.current;
    if (p.firstId && firstId !== p.firstId && lastId === p.lastId) {
      el.scrollTop += el.scrollHeight - p.height; // older page prepended
    } else if (nearBottom.current || pending.length > p.pending || !p.lastId) {
      el.scrollTop = el.scrollHeight;
    }
    prev.current = { firstId, lastId, pending: pending.length, height: el.scrollHeight };
  }, [firstId, lastId, pending.length, contactTyping]);

  const contact = conversation ? contactName(conversation) : "";
  // Replacer functions, not strings: a name like "$&" must not be expanded as a replace pattern.
  const fillTemplate = (body: string) =>
    body.replace(/\{\{\s*name\s*\}\}/g, () => conversation?.contact.name?.split(" ")[0] ?? "").replace(/\{\{\s*agent\s*\}\}/g, () => me.agent.name);

  const lastAgent = [...(messages ?? [])].reverse().find((m) => m.authorType === "agent");
  const seen = lastAgent && conversation && conversation.contactLastReadAt >= lastAgent.createdAt;

  return (
    <section className="thread" aria-label={t("thread.aria")}>
      <header className="thread-header">
        <Avatar name={contact} />
        <div className="title">
          <div>
            <strong>{contact}</strong> {conversation && <span className={`badge badge-${conversation.status}`}>{t(`status.${conversation.status}`)}</span>}
          </div>
          <div>{conversation?.contact.email ?? (conversation?.contact.verified ? t("thread.verified") : t("contact.anonymous"))}</div>
        </div>
        <select
          className="select"
          style={{ width: 170 }}
          aria-label={t("inbox.assignee")}
          value={conversation?.assignee?.id ?? ""}
          onChange={(e) => void update({ assigneeId: e.target.value || null })}
        >
          <option value="">{t("inbox.unassigned")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === me.agent.id ? t("thread.you", { name: m.name }) : m.name}
              {online.includes(m.id) ? " ●" : ""}
            </option>
          ))}
        </select>
        {conversation?.status === "resolved" ? (
          <button type="button" className="btn" onClick={() => void update({ status: "open" })}>
            {t("thread.reopen")}
          </button>
        ) : (
          <>
            {conversation?.status !== "pending" && (
              <button type="button" className="btn" onClick={() => void update({ status: "pending" })} title={t("thread.snoozeTitle")}>
                {t("thread.snooze")}
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={() => void update({ status: "resolved" })}>
              {t("thread.resolve")}
            </button>
          </>
        )}
      </header>

      {thread.liveStopped && (
        <div className="live-banner" role="status">
          {t("thread.liveStopped")}
          <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
            {t("common.reload")}
          </button>
        </div>
      )}
      <div
        className="thread-messages"
        ref={listRef}
        role="log"
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages === null && thread.loadFailed ? (
          <div className="empty">
            {t("thread.loadFailed")}{" "}
            <button type="button" className="btn btn-sm" onClick={thread.retryLoad}>
              {t("common.retry")}
            </button>
          </div>
        ) : messages === null ? (
          <Spinner />
        ) : (
          <>
            {thread.older && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: "center" }} disabled={thread.loadingOlder} onClick={() => void thread.loadOlder()}>
                {thread.loadingOlder ? t("common.loadingMore") : t("thread.loadEarlier")}
              </button>
            )}
            <ThreadMessages messages={messages} contact={contact} seenId={seen ? lastAgent?.id : undefined} />
            {pending.map((p) => (
              <div key={p.clientId} className="msg agent pending">
                {p.body && <div className="msg-bubble">{p.body}</div>}
                <MessageAttachments items={p.attachments} />
                {p.failed ? (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => thread.retrySend(p)}>
                    {t("thread.failedRetry")}
                  </button>
                ) : (
                  <div className="msg-meta">{t("common.sending")}</div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="typing" aria-live="polite">
        {contactTyping ? t("thread.typing", { name: contact }) : ""}
      </div>

      <Composer workspaceId={workspaceId} contactLabel={contact} fillTemplate={fillTemplate} onSend={thread.send} onTyping={sendTyping} />
    </section>
  );
});

/**
 * Memoized: typing, presence, read receipts and inbox summaries re-render the pane often; the
 * (possibly long, markdown-heavy) message list only changes with its messages.
 */
const ThreadMessages = memo(function ThreadMessages({ messages, contact, seenId }: { messages: Message[]; contact: string; seenId?: string }) {
  return (
    <>
      {messages.map((m) => (
        <ThreadMessage key={m.id} m={m} contact={contact} seen={m.id === seenId} />
      ))}
    </>
  );
});

/** Per row too: merged messages keep their identity, so a new message renders one row, not all. */
const ThreadMessage = memo(function ThreadMessage({ m, contact, seen }: { m: Message; contact: string; seen: boolean }) {
  const { t, locale } = useI18n();
  if (m.authorType === "system") {
    const text = SYSTEM_TEXT[m.systemEvent ?? ""]?.(m);
    return <div className="sys">{text ? t(...text) : m.systemEvent}</div>;
  }
  return (
    <div className={`msg ${m.authorType}`}>
      {m.body && (
        <div className="msg-bubble">
          <Markdown source={m.body} />
        </div>
      )}
      <MessageAttachments items={m.attachments} />
      <div className="msg-meta">
        {m.authorType === "agent" ? m.author?.name : contact} · {timeFormat(locale).format(m.createdAt)}
        {seen && ` · ${t("thread.seen")}`}
      </div>
    </div>
  );
});

const timeFormats = new Map<string, Intl.DateTimeFormat>();
/** One formatter per language: long threads format many timestamps. */
function timeFormat(locale: string): Intl.DateTimeFormat {
  let format = timeFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
    timeFormats.set(locale, format);
  }
  return format;
}

function MessageAttachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null;
  return (
    <div className="msg-attachments">
      {items.map((a) =>
        a.contentType.startsWith("image/") && a.url ? (
          <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
            <img src={a.url} alt={a.name} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} className="file-chip" href={a.url} target="_blank" rel="noopener noreferrer">
            📄 {a.name}
          </a>
        ),
      )}
    </div>
  );
}
