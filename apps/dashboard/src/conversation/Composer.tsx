import type { Attachment, CannedReply } from "@kobecuppens/livechat-protocol";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api";
import { toast } from "../components/ui";

/**
 * Reply box: draft, saved replies ("/" + arrows + Enter/Tab), attachments (button, file
 * picker, paste) and Enter-to-send.
 */
export function Composer({
  workspaceId,
  contactLabel,
  fillTemplate,
  onSend,
  onTyping,
}: {
  workspaceId: string;
  contactLabel: string;
  /** Replaces {{name}} / {{agent}} in a saved reply. */
  fillTemplate: (body: string) => string;
  onSend: (body: string, attachments: Attachment[]) => void;
  onTyping: (typing: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [canned, setCanned] = useState<CannedReply[]>([]);
  const [cannedIndex, setCannedIndex] = useState(0);
  // Escape closes the saved-replies menu until the draft changes, so "/..." can be sent as text.
  const [cannedDismissed, setCannedDismissed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuId = useId();

  useEffect(() => {
    api.canned(workspaceId).then(setCanned, () => {});
  }, [workspaceId]);

  const canSend = !uploading && (draft.trim().length > 0 || uploads.length > 0);
  const send = () => {
    if (!canSend) return;
    onSend(draft.trim(), uploads);
    setDraft("");
    setUploads([]);
    onTyping(false);
  };

  const cannedQuery = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).toLowerCase() : null;
  const cannedMatches = cannedQuery === null || cannedDismissed ? [] : canned.filter((c) => c.shortcut.includes(cannedQuery) || c.title.toLowerCase().includes(cannedQuery)).slice(0, 8);
  const applyCanned = (c: CannedReply) => {
    setDraft(fillTemplate(c.body));
    setCannedIndex(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (cannedMatches.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setCannedDismissed(true);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCannedIndex((i) => (i + (e.key === "ArrowDown" ? 1 : cannedMatches.length - 1)) % cannedMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyCanned(cannedMatches[Math.min(cannedIndex, cannedMatches.length - 1)]!);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of [...files].slice(0, 5 - uploads.length)) {
        const att = await api.upload(workspaceId, f);
        setUploads((u) => [...u, att]);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="composer">
      {cannedMatches.length > 0 && (
        <div className="canned-menu" role="listbox" id={menuId} aria-label="Saved replies">
          {cannedMatches.map((c, i) => (
            <button
              type="button"
              key={c.id}
              id={`${menuId}-${c.id}`}
              tabIndex={-1}
              role="option"
              aria-selected={i === cannedIndex}
              className={i === cannedIndex ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                applyCanned(c);
              }}
            >
              <strong>/{c.shortcut}</strong> {c.title}
              <small>{c.body}</small>
            </button>
          ))}
        </div>
      )}
      <textarea
        value={draft}
        placeholder={`Reply to ${contactLabel}… (type / for saved replies)`}
        aria-label="Reply"
        // Combobox semantics so screen readers announce the saved-replies list and the
        // highlighted reply that Enter/Tab will insert.
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={cannedMatches.length > 0}
        aria-controls={cannedMatches.length > 0 ? menuId : undefined}
        aria-activedescendant={cannedMatches.length > 0 ? `${menuId}-${cannedMatches[Math.min(cannedIndex, cannedMatches.length - 1)]!.id}` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setCannedIndex(0);
          setCannedDismissed(false);
          onTyping(e.target.value.length > 0 && !e.target.value.startsWith("/"));
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void upload(e.clipboardData.files);
          }
        }}
      />
      <div className="composer-actions">
        <div className="row">
          {/* A real button: a <label> around a hidden input can't be reached with the keyboard. */}
          <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
            📎 Attach
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept="image/*,application/pdf"
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
          {uploading && <span className="muted">Uploading…</span>}
          {uploads.map((u) => (
            <span key={u.id} className="file-chip">
              {u.name}
              <button
                type="button"
                className="btn-ghost"
                style={{ border: 0, background: "none" }}
                aria-label={`Remove ${u.name}`}
                onClick={() => setUploads((all) => all.filter((x) => x.id !== u.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <button type="button" className="btn btn-primary" onClick={send} disabled={!canSend}>
          Send
        </button>
      </div>
    </div>
  );
}
