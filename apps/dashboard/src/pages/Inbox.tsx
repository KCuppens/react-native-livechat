import { ReconnectingSocket } from "@kobecuppens/livechat-core";
import type { AgentConversation, AgentMe, ConversationStatus, InboxEvent, } from "@kobecuppens/livechat-protocol";
import { useEffect, useMemo, useRef, useState, } from "react";
import { api, type Member } from "../api";
import { attempt, Avatar, Spinner, timeAgo, } from "../components/ui";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Link, useRouter } from "../router";
import { ConversationPane } from "../conversation/ConversationPane";
import { contactName } from "../conversation/format";

type AssigneeFilter = "all" | "me" | "unassigned";

const NOTIFY_DISMISSED_KEY = "lc-notify-dismissed";

function matchesFilter(c: AgentConversation, status: ConversationStatus, assignee: AssigneeFilter, meId: string) {
  if (c.status !== status) return false;
  if (assignee === "me") return c.assignee?.id === meId;
  if (assignee === "unassigned") return !c.assignee;
  return true;
}


function notify(title: string, body: string, onClick: () => void) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const n = new Notification(title, { body, tag: title });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

export function InboxPage({
  me,
  workspaceId,
  conversationId,
  onUnread,
  onAccessLost,
}: {
  me: AgentMe;
  workspaceId: string;
  conversationId: string | null;
  onUnread: (n: number) => void;
  /**
   * A live socket was closed for good (removed from this workspace, or signed out). App reloads
   * `me`, which drops a workspace the agent lost and routes to another one (or to /login).
   */
  onAccessLost: () => void;
}) {
  const accessLost = useRef(onAccessLost);
  accessLost.current = onAccessLost;
  const { navigate } = useRouter();
  const [status, setStatus] = useState<ConversationStatus>("open");
  const [assignee, setAssignee] = useState<AssigneeFilter>("all");
  const [items, setItems] = useState<AgentConversation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const filterRef = useRef({ status, assignee });
  filterRef.current = { status, assignee };
  const selectedRef = useRef(conversationId);
  selectedRef.current = conversationId;

  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is the Retry trigger
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setLoadFailed(false);
    api.inbox(workspaceId, { status, assignee }).then(
      (page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      },
      () => !cancelled && setLoadFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, status, assignee, reloadNonce]);

  useEffect(() => {
    api.members(workspaceId).then(setMembers, () => {});
  }, [workspaceId]);

  // Browsers ignore (or quietly block) permission prompts that aren't from a click, so ask from a button.
  const [notifyPermission, setNotifyPermission] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  const [notifyDismissed, setNotifyDismissed] = useState(() => {
    try {
      return localStorage.getItem(NOTIFY_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [liveStopped, setLiveStopped] = useState(false);

  // Live inbox: upsert/remove conversations as they change.
  useEffect(() => {
    const socket = new ReconnectingSocket<InboxEvent>({
      url: async () => api.socketUrl(`/agent/w/${workspaceId}/inbox/ws`),
      onStateChange: () => {},
      // Access revoked (4003) or session gone: let the auth check route elsewhere if needed, and
      // say the list no longer updates live (if access remains, a reload reconnects it).
      onTerminalClose: () => {
        setLiveStopped(true);
        accessLost.current();
      },
      onReconnect: () => {
        // Backfill page 1 and reset the cursor with it; drop the result if the filter changed meanwhile.
        const f = filterRef.current;
        api.inbox(workspaceId, { status: f.status, assignee: f.assignee }).then(
          (p) => {
            if (filterRef.current.status !== f.status || filterRef.current.assignee !== f.assignee) return;
            setItems(p.items);
            setCursor(p.nextCursor);
          },
          () => {},
        );
      },
      onEvent: (event) => {
        if (event.type === "presence") setOnline(event.onlineAgentIds);
        if (event.type !== "conversation.updated") return;
        const c = event.conversation;
        const f = filterRef.current;
        setItems((prev) => {
          if (!prev) return prev;
          const rest = prev.filter((x) => x.id !== c.id);
          if (!matchesFilter(c, f.status, f.assignee, me.agent.id)) return rest;
          return [c, ...rest].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        });
        const fromContact = c.lastMessage?.authorType === "contact" && c.unreadCount > 0;
        if (fromContact && (document.hidden || selectedRef.current !== c.id)) {
          notify(contactName(c), c.lastMessage?.body || "📎 Attachment", () => navigate(`/w/${workspaceId}/inbox/${c.id}`));
        }
      },
    });
    socket.start();
    return () => socket.stop();
  }, [workspaceId, me.agent.id, navigate]);

  const unread = useMemo(() => (items ?? []).reduce((n, c) => n + (c.unreadCount > 0 ? 1 : 0), 0), [items]);
  useEffect(() => {
    if (status === "open" && assignee === "all") onUnread(unread);
    document.title = unread > 0 ? `(${unread}) Support Inbox` : "Support Inbox";
  }, [unread, status, assignee, onUnread]);

  const selected = items?.find((c) => c.id === conversationId) ?? null;

  return (
    <div className="inbox">
      <section className="inbox-list" aria-label="Conversations">
        {liveStopped && (
          <div className="live-banner" role="status">
            Live updates stopped.
            <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        )}
        {notifyPermission === "default" && !notifyDismissed && (
          <div className="live-banner">
            Get a desktop alert for new messages.
            <span className="row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void Notification.requestPermission().then(setNotifyPermission, () => {})}
              >
                Enable notifications
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setNotifyDismissed(true);
                  try {
                    localStorage.setItem(NOTIFY_DISMISSED_KEY, "1");
                  } catch {
                    // Storage blocked: hidden for this visit only.
                  }
                }}
              >
                Not now
              </button>
            </span>
          </div>
        )}
        <div className="inbox-filters">
          <div className="segmented" role="tablist" aria-label="Status">
            {(["open", "pending", "resolved"] as const).map((s) => (
              <button type="button" key={s} role="tab" aria-selected={status === s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <div className="segmented" role="tablist" aria-label="Assignee">
            {(
              [
                ["all", "All"],
                ["me", "Mine"],
                ["unassigned", "Unassigned"],
              ] as const
            ).map(([value, label]) => (
              <button type="button" key={value} role="tab" aria-selected={assignee === value} className={assignee === value ? "active" : ""} onClick={() => setAssignee(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="conv-items">
          {items === null && loadFailed ? (
            <div className="empty">
              Couldn't load conversations.{" "}
              <button type="button" className="btn btn-sm" onClick={() => setReloadNonce((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : items === null ? (
            <Spinner />
          ) : items.length === 0 ? (
            <div className="empty">No {status} conversations 🎉</div>
          ) : (
            <>
              {items.map((c) => (
                <Link
                  key={c.id}
                  to={`/w/${workspaceId}/inbox/${c.id}`}
                  className={`conv-item${c.id === conversationId ? " active" : ""}${c.unreadCount > 0 ? " unread" : ""}`}
                >
                  <Avatar name={contactName(c)} />
                  <div className="conv-item-main">
                    <div className="conv-item-top">
                      <strong>{contactName(c)}</strong>
                      <time dateTime={new Date(c.lastMessageAt).toISOString()}>{timeAgo(c.lastMessageAt)}</time>
                    </div>
                    <div className="conv-item-preview">
                      {c.lastMessage?.authorType === "agent" && (c.lastMessage.author?.id === me.agent.id ? "You: " : `${c.lastMessage.author?.name ?? "Agent"}: `)}
                      {c.lastMessage?.systemEvent ? `— ${c.lastMessage.systemEvent.replace("_", " ")}` : c.lastMessage?.body || "📎 Attachment"}
                    </div>
                  </div>
                  {c.unreadCount > 0 && (
                    <>
                      <i className="unread-dot" aria-hidden="true" />
                      <span className="sr-only">{c.unreadCount} unread</span>
                    </>
                  )}
                </Link>
              ))}
              {cursor && (
                <div style={{ padding: 12, textAlign: "center" }}>
                  <button type="button"
                    className="btn btn-sm"
                    disabled={loadingMore}
                    onClick={async () => {
                      const f = { status, assignee };
                      setLoadingMore(true);
                      await attempt(async () => {
                        const page = await api.inbox(workspaceId, { ...f, cursor });
                        // A filter switch while loading makes this page stale.
                        if (filterRef.current.status !== f.status || filterRef.current.assignee !== f.assignee) return;
                        setItems((prev) => [...(prev ?? []), ...page.items.filter((i) => !prev?.some((p) => p.id === i.id))]);
                        setCursor(page.nextCursor);
                      }, "Couldn't load more conversations");
                      setLoadingMore(false);
                    }}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {conversationId ? (
        // One bad conversation (e.g. unexpected payload) must not take down the inbox list.
        <ErrorBoundary key={conversationId} variant="pane">
        <ConversationPane
          key={conversationId}
          me={me}
          workspaceId={workspaceId}
          conversationId={conversationId}
          summary={selected}
          members={members}
          online={online}
          onAccessLost={onAccessLost}
        />
        </ErrorBoundary>
      ) : (
        <div className="empty" style={{ alignSelf: "center" }}>
          Select a conversation
        </div>
      )}
      {conversationId && selected && <ContactPane conversation={selected} />}
    </div>
  );
}

function ContactPane({ conversation: c }: { conversation: AgentConversation }) {
  return (
    <aside className="contact-pane" aria-label="Contact">
      <div className="row">
        <Avatar name={contactName(c)} />
        <div>
          <strong>{contactName(c)}</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            {c.contact.verified ? "✓ Verified user" : "Anonymous visitor"}
          </div>
        </div>
      </div>
      <dl>
        {c.contact.email && (
          <>
            <dt>Email</dt>
            <dd>
              <a href={`mailto:${c.contact.email}`}>{c.contact.email}</a>
            </dd>
          </>
        )}
        {c.contact.externalId && (
          <>
            <dt>User ID</dt>
            <dd>{c.contact.externalId}</dd>
          </>
        )}
        <dt>Language</dt>
        <dd>{c.contact.locale ?? "—"}</dd>
        <dt>Last seen</dt>
        <dd>{timeAgo(c.contact.lastSeenAt)} ago</dd>
        <dt>Started</dt>
        <dd>{new Date(c.createdAt).toLocaleString()}</dd>
        {c.csatScore !== null && (
          <>
            <dt>Rating</dt>
            <dd>
              {"★".repeat(c.csatScore)}
              {"☆".repeat(5 - c.csatScore)}
              {c.csatComment && <div className="muted">“{c.csatComment}”</div>}
            </dd>
          </>
        )}
      </dl>
    </aside>
  );
}
