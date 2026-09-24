import { Component, createContext, useContext, type ErrorInfo, type ReactNode } from "react";
import { useMessenger, useTranslate } from "../../hooks/context";
import { BackIcon, CloseIcon } from "../icons";
import { initials } from "../util";

/** True when the Messenger is rendered inline (a /help page): there's nothing to close. */
export const InlineContext = createContext(false);

export function Header({ title, subtitle, avatar }: { title: ReactNode; subtitle?: ReactNode; avatar?: ReactNode }) {
  const messenger = useMessenger();
  const t = useTranslate();
  return (
    <div className="lc-header">
      {messenger.canGoBack && (
        <button type="button" className="lc-icon-btn" onClick={messenger.back} aria-label={t("common.back")}>
          <BackIcon />
        </button>
      )}
      {avatar}
      <div className="lc-header-title">
        {/* Focus target after navigation, so keyboard/screen-reader users land on the new screen. */}
        <strong data-screen-title tabIndex={-1}>
          {title}
        </strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <CloseButton />
    </div>
  );
}

export function CloseButton() {
  const messenger = useMessenger();
  const t = useTranslate();
  if (useContext(InlineContext)) return null;
  return (
    <button type="button" className="lc-icon-btn" onClick={messenger.close} aria-label={t("common.close")}>
      <CloseIcon />
    </button>
  );
}

export function Avatar({ name, url, brand }: { name: string | null | undefined; url?: string | null; brand?: boolean }) {
  return <span className={`lc-avatar${brand ? " lc-brand" : ""}`}>{url ? <img src={url} alt="" /> : initials(name)}</span>;
}

export function Loading() {
  const t = useTranslate();
  return (
    <div className="lc-loading" role="status" aria-label={t("common.loading")}>
      <div className="lc-spinner" />
    </div>
  );
}

export function ErrorState({ onRetry, onBack }: { onRetry?: () => void; onBack?: () => void }) {
  const t = useTranslate();
  return (
    <div className="lc-error-state" role="alert">
      <div>{t("common.error")}</div>
      <div className="lc-error-actions">
        {onBack && <button type="button" onClick={onBack}>{t("common.back")}</button>}
        {onRetry && <button type="button" onClick={onRetry}>{t("common.retry")}</button>}
      </div>
    </div>
  );
}

/**
 * Keeps a render error inside the messenger: it renders server/agent-supplied content, and a
 * crash must not unmount the host app's React tree.
 */
export class MessengerErrorBoundary extends Component<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[livechat] render error", error, info.componentStack);
  }

  override render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}
