import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { LanguageSelect, useI18n } from "../i18n";
import { useRouter } from "../router";

export function LoginPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  return (
    <div className="auth">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("sending");
          try {
            await api.requestMagicLink(email.trim());
            setState("sent");
          } catch {
            setState("error");
          }
        }}
      >
        <h1>{t("login.title")}</h1>
        {state === "sent" ? (
          <p>{t("login.sent", { email })}</p>
        ) : (
          <>
            <p>{t("login.intro")}</p>
            <label className="field">
              <span>{t("login.email")}</span>
              <input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            {state === "error" && <p className="error-text">{t("login.sendFailed")}</p>}
            <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={state === "sending"}>
              {state === "sending" ? t("common.sending") : t("login.submit")}
            </button>
          </>
        )}
        <LanguageSelect className="select auth-language" />
      </form>
    </div>
  );
}

export function VerifyPage({ onSignedIn }: { onSignedIn: () => void }) {
  const { navigate } = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: t only picks the error's language; the link must not be verified twice
  useEffect(() => {
    // Magic links are single-use: never verify twice (StrictMode runs effects twice in dev).
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    history.replaceState(null, "", location.pathname); // drop the token from the address bar
    if (!token) {
      setError(t("verify.incomplete"));
      return;
    }
    api.verify(token).then(
      () => {
        onSignedIn();
        navigate("/", true);
      },
      (err) => setError(err instanceof ApiError ? err.message : t("verify.failed")),
    );
  }, [navigate, onSignedIn]);
  return (
    <div className="auth">
      <div className="auth-card">
        <h1>{error ? t("verify.expired") : t("verify.signingIn")}</h1>
        {error && (
          <>
            <p>{error}</p>
            <a className="btn btn-primary" href="/login">{t("verify.newLink")}</a>
          </>
        )}
      </div>
    </div>
  );
}
