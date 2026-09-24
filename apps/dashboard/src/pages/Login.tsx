import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useRouter } from "../router";

export function LoginPage() {
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
        <h1>Sign in to Support</h1>
        {state === "sent" ? (
          <p>If {email} has access, a sign-in link is on its way. It expires in 15 minutes.</p>
        ) : (
          <>
            <p>We'll email you a one-time sign-in link.</p>
            <label className="field">
              <span>Work email</span>
              <input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            {state === "error" && <p className="error-text">Couldn't send the link. Try again in a minute.</p>}
            <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Email me a link"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

export function VerifyPage({ onSignedIn }: { onSignedIn: () => void }) {
  const { navigate } = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    // Magic links are single-use: never verify twice (StrictMode runs effects twice in dev).
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    history.replaceState(null, "", location.pathname); // drop the token from the address bar
    if (!token) {
      setError("This link is incomplete.");
      return;
    }
    api.verify(token).then(
      () => {
        onSignedIn();
        navigate("/", true);
      },
      (err) => setError(err instanceof ApiError ? err.message : "Sign-in failed."),
    );
  }, [navigate, onSignedIn]);
  return (
    <div className="auth">
      <div className="auth-card">
        <h1>{error ? "Link expired" : "Signing you in…"}</h1>
        {error && (
          <>
            <p>{error}</p>
            <a className="btn btn-primary" href="/login">Request a new link</a>
          </>
        )}
      </div>
    </div>
  );
}
