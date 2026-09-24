import { ReconnectingSocket } from "@kobecuppens/livechat-core";
import type { AgentConversation, AgentMe, Attachment, ConversationStatus, Message, ServerEvent } from "@kobecuppens/livechat-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { attempt, toast } from "../components/ui";
import { mergeById } from "./format";

export interface PendingMsg {
  clientId: string;
  body: string;
  attachments: Attachment[];
  failed: boolean;
}

/**
 * One conversation's data for the agent: initial load + reconnect backfill, the live socket
 * (messages, contact typing, read receipts, status), pagination and optimistic sending.
 */
export function useConversationThread(
  me: AgentMe,
  workspaceId: string,
  conversationId: string,
  summary: AgentConversation | null,
  /** The socket was closed for good (access revoked, signed out): re-check who we are. */
  onAccessLost: () => void,
) {
  const [conversation, setConversation] = useState<AgentConversation | null>(summary);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [older, setOlder] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const [contactTyping, setContactTyping] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const socketRef = useRef<ReconnectingSocket<ServerEvent> | null>(null);
  // Through a ref: a new callback identity must not reconnect the socket.
  const accessLost = useRef(onAccessLost);
  accessLost.current = onAccessLost;
  const loadedOnce = useRef(false);
  // Contact messages that arrived while the tab was hidden: read once the agent comes back.
  const unreadWhileHidden = useRef(false);
  const [liveStopped, setLiveStopped] = useState(false);

  useEffect(() => {
    if (summary) setConversation(summary);
  }, [summary]);

  const load = useCallback(async () => {
    const [conv, page] = await Promise.all([api.conversation(workspaceId, conversationId), api.messages(workspaceId, conversationId)]);
    setConversation(conv);
    setMessages((prev) => mergeById(prev, page.items));
    setLoadFailed(false);
    // Reconnect backfills only merge the newest page; keep the pagination cursor from the first load.
    if (!loadedOnce.current) setOlder(page.nextCursor);
    loadedOnce.current = true;
    // Only a visible thread counts as read (a background reconnect backfill must not say "Seen").
    if (document.hidden) unreadWhileHidden.current = true;
    else api.markRead(workspaceId, conversationId).catch(() => {});
  }, [workspaceId, conversationId]);

  useEffect(() => {
    load().catch(() => setLoadFailed(true));
    let typingTimeout: ReturnType<typeof setTimeout> | undefined;
    // One read receipt per burst of contact messages: each one fans out to every agent's inbox.
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRead = () => {
      clearTimeout(readTimer);
      readTimer = setTimeout(() => api.markRead(workspaceId, conversationId).catch(() => {}), 1000);
    };
    const onVisible = () => {
      if (document.hidden || !unreadWhileHidden.current) return;
      unreadWhileHidden.current = false;
      scheduleRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    const socket = new ReconnectingSocket<ServerEvent>({
      url: async () => api.socketUrl(`/agent/w/${workspaceId}/conversations/${conversationId}/ws`),
      onStateChange: () => {},
      // Closed for good (access revoked, signed out): re-check the session, and say that this
      // thread no longer updates live (if access remains, a reload reconnects it).
      onTerminalClose: () => {
        setLiveStopped(true);
        accessLost.current();
      },
      onReconnect: () => void load().catch(() => {}),
      onEvent: (event) => {
        if (event.type === "message.created") {
          const m = event.message;
          setMessages((prev) => (prev ? mergeById(prev, [m]) : prev));
          if (m.clientId) setPending((p) => p.filter((x) => x.clientId !== m.clientId));
          if (m.authorType === "contact") {
            setContactTyping(false);
            if (document.hidden) unreadWhileHidden.current = true;
            else scheduleRead();
          }
        } else if (event.type === "typing" && event.authorType === "contact") {
          setContactTyping(event.typing);
          clearTimeout(typingTimeout);
          if (event.typing) typingTimeout = setTimeout(() => setContactTyping(false), 6000);
        } else if (event.type === "read" && event.authorType === "contact") {
          setConversation((c) => (c ? { ...c, contactLastReadAt: event.at } : c));
        } else if (event.type === "status.changed") {
          setConversation((c) => (c ? { ...c, status: event.status } : c));
        }
      },
    });
    socketRef.current = socket;
    socket.start();
    return () => {
      clearTimeout(typingTimeout);
      clearTimeout(readTimer);
      document.removeEventListener("visibilitychange", onVisible);
      socket.stop();
    };
  }, [workspaceId, conversationId, load]);

  const retryLoad = () => void load().catch(() => setLoadFailed(true));

  const loadOlder = async () => {
    if (!older) return;
    setLoadingOlder(true);
    await attempt(async () => {
      const page = await api.messages(workspaceId, conversationId, older);
      setMessages((prev) => mergeById(prev, page.items));
      setOlder(page.nextCursor);
    }, "Couldn't load earlier messages");
    setLoadingOlder(false);
  };

  const deliver = async (msg: PendingMsg) => {
    try {
      const saved = await api.reply(workspaceId, conversationId, { clientId: msg.clientId, body: msg.body, attachmentIds: msg.attachments.map((a) => a.id) });
      setMessages((prev) => (prev ? mergeById(prev, [saved]) : prev));
      setPending((p) => p.filter((x) => x.clientId !== msg.clientId));
      setConversation((c) => (c && !c.assignee ? { ...c, assignee: { id: me.agent.id, name: me.agent.name, avatarUrl: me.agent.avatarUrl } } : c));
    } catch {
      setPending((p) => p.map((x) => (x.clientId === msg.clientId ? { ...x, failed: true } : x)));
    }
  };

  const send = (body: string, attachments: Attachment[]) => {
    const msg: PendingMsg = { clientId: `a_${crypto.randomUUID()}`, body, attachments, failed: false };
    setPending((p) => [...p, msg]);
    void deliver(msg);
  };

  const retrySend = (p: PendingMsg) => {
    setPending((all) => all.map((x) => (x.clientId === p.clientId ? { ...x, failed: false } : x)));
    void deliver({ ...p, failed: false });
  };

  const update = async (body: { status?: ConversationStatus; assigneeId?: string | null }) => {
    try {
      setConversation(await api.updateConversation(workspaceId, conversationId, body));
    } catch {
      toast("Update failed");
    }
  };

  return { conversation, messages, older, pending, contactTyping, loadFailed, loadingOlder, liveStopped, socketRef, retryLoad, loadOlder, send, retrySend, update };
}
