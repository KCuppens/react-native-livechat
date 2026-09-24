import type { AgentMe } from "@kobecuppens/livechat-protocol";
import { useState } from "react";
import { api, ApiError } from "../api";
import { Field } from "../components/ui";
import { useRouter } from "../router";

export function NewWorkspacePage({ me, onCreated }: { me: AgentMe; onCreated: () => void }) {
  const { navigate } = useRouter();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ id: string; publishableKey: string; identitySecret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!me.superAdmin) return <div className="empty">Only super admins can create workspaces.</div>;
  return (
    <div className="auth">
      <div className="auth-card" style={{ maxWidth: 480 }}>
        {created ? (
          <>
            <h1>Workspace created</h1>
            <p>Copy the identity secret now. It's shown only once (you can rotate it later).</p>
            <Field label="Publishable key">
              <input className="input" readOnly value={created.publishableKey} onFocus={(e) => e.target.select()} />
            </Field>
            <Field label="Identity secret (server only)">
              <input className="input" readOnly value={created.identitySecret} onFocus={(e) => e.target.select()} />
            </Field>
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/w/${created.id}/settings/install`)}>
              Continue to setup
            </button>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const ws = await api.createWorkspace({ name: name.trim() });
                setCreated(ws);
                onCreated();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Couldn't create workspace");
              }
            }}
          >
            <h1>New workspace</h1>
            <p>One workspace per app or product. Each has its own help center, inbox and keys.</p>
            <Field label="Name">
              <input className="input" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="1% Better" />
            </Field>
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
              Create workspace
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
