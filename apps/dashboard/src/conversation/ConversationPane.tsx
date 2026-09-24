import type { AgentConversation, AgentMe, Attachment, Message } from "@kobecuppens/livechat-protocol";
import { Markdown } from "@kobecuppens/livechat-react";
import { memo, useLayoutEffect, useRef } from "react";
import type { Member } from "../api";
import { Avatar, Spinner } from "../components/ui";
import { Composer } from "./Composer";
import { contactName } from "./format";
import { useConversationThread } from "./useConversationThread";
import { useTypingSender } from "./useTypingSender";

const SYSTEM_TEXT: Record<string, (m: Message) => string> = {
  resolved: () => "Marked as resolved",
  reopened: () => "Reopened",
  assigned: (m) => `Assigned to ${m.body}`,
  csat_request: () => "Rating requested",
  auto_reply: (m) => `Auto-reply: ${m.body}`,
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

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
    <section className="thread" aria-label="Conversation">
      <header className="thread-header">
        <Avatar name={contact} />
        <div className="title">
          <div>
            <strong>{contact}</strong> {conversation && <span className={`badge badge-${conversation.status}`}>{conversation.status}</span>}
          </div>
          <div>{conversation?.contact.email ?? (conversation?.contact.verified ? "Verified user" : "Anonymous visitor")}</div>
        </div>
        <select
          className="select"
          style={{ width: 170 }}
          aria-label="Assignee"
          value={conversation?.assignee?.id ?? ""}
          onChange={(e) => void update({ assigneeId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === me.agent.id ? `${m.name} (you)` : m.name}
              {online.includes(m.id) ? " ●" : ""}
            </option>
          ))}
        </select>
        {conversation?.status === "resolved" ? (
          <button type="button" className="btn" onClick={() => void update({ status: "open" })}>
            Reopen
          </button>
        ) : (
          <>
            {conversation?.status !== "pending" && (
              <button type="button" className="btn" onClick={() => void update({ status: "pending" })} title="Waiting on the customer">
                Snooze
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={() => void update({ status: "resolved" })}>
              Resolve
            </button>
          </>
        )}
      </header>

      {thread.liveStopped && (
        <div className="live-banner" role="status">
          Live updates stopped for this conversation.
          <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
            Reload
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
            Couldn't load this conversation.{" "}
            <button type="button" className="btn btn-sm" onClick={thread.retryLoad}>
              Retry
            </button>
          </div>
        ) : messages === null ? (
          <Spinner />
        ) : (
          <>
            {thread.older && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: "center" }} disabled={thread.loadingOlder} onClick={() => void thread.loadOlder()}>
                {thread.loadingOlder ? "Loading…" : "Load earlier"}
              </button>
            )}
            <ThreadMessages messages={messages} contact={contact} seenId={seen ? lastAgent?.id : undefined} />
            {pending.map((p) => (
              <div key={p.clientId} className="msg agent pending">
                {p.body && <div className="msg-bubble">{p.body}</div>}
                <MessageAttachments items={p.attachments} />
                {p.failed ? (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => thread.retrySend(p)}>
                    Failed — retry
                  </button>
                ) : (
                  <div className="msg-meta">Sending…</div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="typing" aria-live="polite">
        {contactTyping ? `${contact} is typing…` : ""}
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
      {messages.map((m) =>
        m.authorType === "system" ? (
          <div key={m.id} className="sys">
            {SYSTEM_TEXT[m.systemEvent ?? ""]?.(m) ?? m.systemEvent}
          </div>
        ) : (
          <div key={m.id} className={`msg ${m.authorType}`}>
            {m.body && (
              <div className="msg-bubble">
                <Markdown source={m.body} />
              </div>
            )}
            <MessageAttachments items={m.attachments} />
            <div className="msg-meta">
              {m.authorType === "agent" ? m.author?.name : contact} · {timeFormat.format(m.createdAt)}
              {m.id === seenId && " · Seen"}
            </div>
          </div>
        ),
      )}
    </>
  );
});

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
