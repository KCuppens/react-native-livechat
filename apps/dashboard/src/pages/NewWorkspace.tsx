import type { AgentMe } from "@kobecuppens/livechat-protocol";
import { useState } from "react";
import { api, ApiError } from "../api";
import { Field } from "../components/ui";
import { useI18n } from "../i18n";
import { useRouter } from "../router";

export function NewWorkspacePage({ me, onCreated }: { me: AgentMe; onCreated: () => void }) {
  const { navigate } = useRouter();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ id: string; publishableKey: string; identitySecret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!me.superAdmin) return <div className="empty">{t("newWs.superAdminOnly")}</div>;
  return (
    <div className="auth">
      <div className="auth-card" style={{ maxWidth: 480 }}>
        {created ? (
          <>
            <h1>{t("newWs.created")}</h1>
            <p>{t("newWs.copySecret")}</p>
            <Field label={t("install.publishableKey")}>
              <input className="input" readOnly value={created.publishableKey} onFocus={(e) => e.target.select()} />
            </Field>
            <Field label={t("newWs.secretLabel")}>
              <input className="input" readOnly value={created.identitySecret} onFocus={(e) => e.target.select()} />
            </Field>
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/w/${created.id}/settings/install`)}>
              {t("newWs.continue")}
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
                setError(err instanceof ApiError ? err.message : t("newWs.createFailed"));
              }
            }}
          >
            <h1>{t("newWs.title")}</h1>
            <p>{t("newWs.intro")}</p>
            <Field label={t("common.name")}>
              <input className="input" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="1% Better" />
            </Field>
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
              {t("newWs.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
