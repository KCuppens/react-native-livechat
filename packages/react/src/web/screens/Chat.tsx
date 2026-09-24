import {
  ALLOWED_ATTACHMENT_TYPES,
  LiveChatApiError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type ChatMessage,
} from "@kobecuppens/livechat-core";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useLiveChatClient, useLiveChatState, useMessenger, useTranslate } from "../../hooks/context";
import { useArticleSuggestions, useConversation, useWorkspaceConfig } from "../../hooks/data";
import { CloseIcon, FileIcon, PaperclipIcon, SendIcon } from "../icons";
import { Markdown } from "../markdown";
import { clockTime } from "../util";
import { Avatar, ErrorState, Header, Loading } from "./shared";

interface PendingUpload {
  key: string;
  name: string;
  state: "uploading" | "done" | "error";
  error?: string;
  attachment?: Attachment;
}

function imageSize(file: File): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith("image/") || typeof Image === "undefined") return Promise.resolve({});
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({});
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function Attachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null;
  return (
    <div className="lc-attachments">
      {items.map((a) =>
        a.contentType.startsWith("image/") && a.url ? (
          <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
            <img className="lc-attachment-img" src={a.url} alt={a.name} width={a.width} height={a.height} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} className="lc-attachment-file" href={a.url} target="_blank" rel="noopener noreferrer">
            <FileIcon />
            {a.name}
          </a>
        ),
      )}
    </div>
  );
}

const CSAT_FACES = ["😞", "🙁", "😐", "🙂", "😍"];

function CsatCard({ score, onSubmit }: { score: number | null; onSubmit: (score: number, comment?: string) => Promise<void> }) {
  const t = useTranslate();
  const [selected, setSelected] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (score !== null) return <div className="lc-system">{t("csat.thanks")}</div>;
  return (
    <div className="lc-csat">
      <strong>{t("csat.question")}</strong>
      {/* ARIA radio pattern: one Tab stop (roving tabindex), arrow keys move the selection. */}
      <div
        className="lc-csat-scores"
        role="radiogroup"
        aria-label={t("csat.question")}
        onKeyDown={(e) => {
          const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const n = CSAT_FACES.length;
          const current = selected ?? (step > 0 ? n : 1); // from nothing: Right → first, Left → last
          const next = ((current - 1 + step + n) % n) + 1;
          setSelected(next);
          (e.currentTarget.children[next - 1] as HTMLElement | undefined)?.focus();
        }}
      >
        {CSAT_FACES.map((face, i) => (
          // biome-ignore lint/a11y/useSemanticElements: ARIA radio pattern on buttons (emoji faces can't be styled as native radios)
          <button
            type="button"
            key={face}
            role="radio"
            tabIndex={(selected ?? 1) === i + 1 ? 0 : -1}
            aria-checked={selected === i + 1}
            aria-label={t("csat.score", { score: i + 1 })}
            onClick={() => setSelected(i + 1)}
          >
            {face}
          </button>
        ))}
      </div>
      {selected !== null && (
        <>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("csat.commentPlaceholder")} maxLength={2000} />
          <button type="button"
            className="lc-btn"
            disabled={busy}
            onClick={async () => {
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
          >
            {busy ? t("chat.sending") : t("csat.submit")}
          </button>
          {failed && (
            <div className="lc-meta lc-danger" role="alert">
              {t("common.error")}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SystemMessage({ message }: { message: ChatMessage }) {
  const t = useTranslate();
  switch (message.systemEvent) {
    case "resolved":
      return <div className="lc-system">{t("chat.resolved")}</div>;
    case "reopened":
      return <div className="lc-system">{t("chat.reopened")}</div>;
    case "assigned":
      return <div className="lc-system">{t("chat.assigned", { name: message.body })}</div>;
    case "auto_reply":
      return <div className="lc-system lc-auto">{message.body}</div>;
    default:
      return null;
  }
}

/**
 * The thread's messages. Memoized: the composer's draft lives in ChatScreen, and without this
 * every keystroke re-rendered every bubble (and its markdown) in a long conversation.
 */
const MessageList = memo(function MessageList({
  messages,
  csatScore,
  agentLastReadAt,
  locale,
  onRetry,
  onCsat,
}: {
  messages: ChatMessage[];
  csatScore: number | null;
  agentLastReadAt: number;
  locale: string;
  onRetry: (clientId: string) => Promise<unknown>;
  onCsat: (score: number, comment?: string) => Promise<void>;
}) {
  let lastMine: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0 && !lastMine; i--) {
    const m = messages[i]!;
    if (m.authorType === "contact" && m.status === "sent") lastMine = m;
  }
  const seen = lastMine && agentLastReadAt >= lastMine.createdAt;
  return (
    <>
      {messages.map((m, i) => {
        if (m.authorType === "system") {
          if (m.systemEvent === "csat_request") {
            return <CsatCard key={m.id} score={csatScore} onSubmit={onCsat} />;
          }
          return <SystemMessage key={m.id} message={m} />;
        }
        const prev = messages[i - 1];
        const next = messages[i + 1];
        return (
          <MessageRow
            key={m.id}
            m={m}
            first={!prev || prev.authorType !== m.authorType || prev.author?.id !== m.author?.id}
            lastOfGroup={!next || next.authorType !== m.authorType || next.author?.id !== m.author?.id}
            seen={m === lastMine && !!seen}
            locale={locale}
            onRetry={onRetry}
          />
        );
      })}
    </>
  );
});

/**
 * One bubble. Memoized per row: the merge keeps unchanged messages' identity, so a new message
 * re-renders (and re-parses markdown for) only the rows whose grouping or state changed.
 */
const MessageRow = memo(function MessageRow({
  m,
  first,
  lastOfGroup,
  seen,
  locale,
  onRetry,
}: {
  m: ChatMessage;
  first: boolean;
  lastOfGroup: boolean;
  seen: boolean;
  locale: string;
  onRetry: (clientId: string) => Promise<unknown>;
}) {
  const t = useTranslate();
  const mine = m.authorType === "contact";
  return (
    <div className={`lc-msg${mine ? " lc-mine" : ""}${first ? " lc-first" : ""}`}>
      {!mine && (
        <span className={lastOfGroup ? "" : "lc-avatar lc-hidden"}>
          {lastOfGroup && <Avatar name={m.author?.name} url={m.author?.avatarUrl} />}
        </span>
      )}
      <div className="lc-bubble-wrap">
        {!mine && first && <div className="lc-author">{m.author?.name ?? t("chat.support")}</div>}
        {m.body && (
          <div
            className={`lc-bubble${m.status === "sending" ? " lc-pending" : ""}${m.status === "failed" ? " lc-failed" : ""}`}
            title={clockTime(m.createdAt, locale)}
          >
            <Markdown source={m.body} />
          </div>
        )}
        <Attachments items={m.attachments} />
        {m.status === "failed" && (
          <button type="button" className="lc-meta lc-danger" onClick={() => void onRetry(m.clientId!)}>
            {t("chat.failed")}
          </button>
        )}
        {m.status === "sending" && <div className="lc-meta">{t("chat.sending")}</div>}
        {seen && <div className="lc-meta">{t("chat.seen")}</div>}
      </div>
    </div>
  );
});

export function ChatScreen({ conversationId }: { conversationId: string | null }) {
  const t = useTranslate();
  const client = useLiveChatClient();
  const messenger = useMessenger();
  const config = useWorkspaceConfig();
  const locale = useLiveChatState((s) => s.locale);
  const onCreated = useCallback((id: string) => messenger.replace({ name: "conversation", id }), [messenger]);
  const { thread, conversation, send, retry, loadOlder, setTyping, submitCsat } = useConversation(conversationId, onCreated);

  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const suggestions = useArticleSuggestions(conversationId ? "" : draft);

  const messages = thread.messages;
  // "Load older" prepends: keep the viewport on what the user was reading. New messages at the
  // bottom are followed while the user is at the bottom, or when they sent one themselves.
  const prevEnds = useRef({ first: undefined as string | undefined, last: undefined as string | undefined, height: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-evaluate scrolling when the typing indicator appears
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = messages[0]?.id;
    const lastMsg = messages[messages.length - 1];
    const p = prevEnds.current;
    if (p.first && first !== p.first && lastMsg?.id === p.last) {
      el.scrollTop += el.scrollHeight - p.height;
    } else if (stickToBottom.current || (lastMsg?.id !== p.last && lastMsg?.authorType === "contact")) {
      el.scrollTop = el.scrollHeight;
    }
    prevEnds.current = { first, last: lastMsg?.id, height: el.scrollHeight };
  }, [messages, thread.typing]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the composer when switching conversations
  useEffect(() => {
    textarea.current?.focus();
  }, [conversationId]);

  const uploading = uploads.some((u) => u.state === "uploading");
  const ready = uploads.filter((u) => u.state === "done");
  const canSend = !uploading && (draft.trim().length > 0 || ready.length > 0);

  const submit = () => {
    if (!canSend) return;
    const attachments = ready.map((u) => u.attachment!);
    void send(draft.trim(), attachments.map((a) => a.id), attachments);
    setDraft("");
    setUploads([]);
    stickToBottom.current = true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - uploads.length;
    for (const file of [...files].slice(0, Math.max(0, room))) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const fail = (error: string) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "error", error } : x)));
      setUploads((u) => [...u, { key, name: file.name, state: "uploading" }]);
      if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
        fail(t("chat.attachmentType"));
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        fail(t("chat.attachmentTooLarge", { mb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }));
        continue;
      }
      try {
        const attachment = await client.uploadAttachment({ body: file, name: file.name, type: file.type, size: file.size, ...(await imageSize(file)) });
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "done", attachment } : x)));
      } catch (err) {
        fail(err instanceof LiveChatApiError && err.code === "too_large" ? t("chat.attachmentTooLarge", { mb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }) : t("common.error"));
      }
    }
  };

  const agentName = conversation?.assignee?.name ?? config?.branding.name ?? t("chat.support");

  return (
    <>
      <Header
        title={conversationId ? agentName : t("chat.newConversation")}
        subtitle={
          config?.online
            ? config.typicalReplyMinutes
              ? t("status.replyTime", { minutes: config.typicalReplyMinutes })
              : t("status.online")
            : t("status.offline")
        }
        avatar={<Avatar name={agentName} url={conversation?.assignee?.avatarUrl} brand={!conversation?.assignee} />}
      />
      {conversationId && thread.loaded && thread.connection === "connecting" && <div className="lc-banner">{t("common.offline")}</div>}
      <div
        className="lc-body"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {conversationId && !thread.loaded && thread.error ? (
          <ErrorState onRetry={() => void client.retryLoad(conversationId)} />
        ) : conversationId && !thread.loaded ? (
          <Loading />
        ) : (
          <div className="lc-thread" role="log" aria-live="polite">
            {thread.hasOlder && (
              <button type="button" className="lc-older" onClick={() => void loadOlder()} disabled={thread.loading}>
                {t("chat.loadOlder")}
              </button>
            )}
            <MessageList
              messages={messages}
              csatScore={conversation?.csatScore ?? null}
              agentLastReadAt={thread.agentLastReadAt}
              locale={locale}
              onRetry={retry}
              onCsat={submitCsat}
            />
            {thread.typing && (
              <div className="lc-msg lc-first">
                {/* aria-label on a plain div isn't announced; real (visually hidden) text is. */}
                <span className="lc-sr">{thread.typing.name ? t("chat.typing", { name: thread.typing.name }) : t("chat.someoneTyping")}</span>
                <Avatar name={thread.typing.name ?? agentName} />
                <div className="lc-typing" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {!conversationId && suggestions.length > 0 && (
        <div className="lc-suggest">
          <div className="lc-card-title">{t("chat.suggestedArticles")}</div>
          {suggestions.map((a) => (
            <button type="button" key={a.id} className="lc-row" onClick={() => messenger.navigate({ name: "article", slug: a.slug })}>
              <div className="lc-row-main">
                <strong>{a.title}</strong>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="lc-composer">
        {uploads.length > 0 && (
          <div className="lc-chips" aria-live="polite">
            {uploads.map((u) => (
              <div key={u.key} className={`lc-chip${u.state === "uploading" ? " lc-uploading" : ""}${u.state === "error" ? " lc-chip-error" : ""}`} title={u.error}>
                <span>{u.state === "error" ? `${u.name} — ${u.error}` : u.name}</span>
                <button type="button" aria-label={t("chat.removeAttachment", { name: u.name })} onClick={() => setUploads((all) => all.filter((x) => x.key !== u.key))}>
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="lc-composer-row">
          <button type="button" className="lc-icon-btn" onClick={() => fileInput.current?.click()} aria-label={t("chat.attach")} disabled={uploads.length >= MAX_ATTACHMENTS_PER_MESSAGE}>
            <PaperclipIcon />
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept={ALLOWED_ATTACHMENT_TYPES.join(",")}
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textarea}
            rows={1}
            value={draft}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            onKeyDown={onKeyDown}
            onChange={(e) => {
              setDraft(e.target.value);
              setTyping(e.target.value.length > 0);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) {
                e.preventDefault();
                void addFiles(e.clipboardData.files);
              }
            }}
          />
          <button type="button" className="lc-send" onClick={submit} disabled={!canSend} aria-label={t("chat.send")}>
            <SendIcon />
          </button>
        </div>
      </div>
    </>
  );
}
