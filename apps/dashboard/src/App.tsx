import type { AgentMe } from "@kobecuppens/livechat-protocol";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, onUnauthorized } from "./api";
import { Layout } from "./components/Layout";
import { Spinner, Toaster } from "./components/ui";
import { useI18n } from "./i18n";
import { FaqPage } from "./pages/Faq";
import { InboxPage } from "./pages/Inbox";
import { LoginPage, VerifyPage } from "./pages/Login";
import { NewWorkspacePage } from "./pages/NewWorkspace";
import { ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";
import { match, useRouter } from "./router";

export function App() {
  const { path, navigate } = useRouter();
  const { t } = useI18n();
  const [me, setMe] = useState<AgentMe | null | undefined>(undefined);
  const [unread, setUnread] = useState(0);
  const [meFailed, setMeFailed] = useState(false);

  const loadMe = useCallback(() => {
    setMeFailed(false);
    api.me().then(setMe, (err) => {
      // Only a 401 means signed out; a network blip or 5xx must not bounce the agent to /login.
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setMeFailed(true);
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount; the path at mount decides whether to load the session
  useEffect(() => {
    if (!path.startsWith("/login")) loadMe();
    const onAuth = () => setMe(null);
    onUnauthorized.addEventListener("unauthorized", onAuth);
    return () => onUnauthorized.removeEventListener("unauthorized", onAuth);
  }, [loadMe]);

  useEffect(() => {
    if (me === null && !path.startsWith("/login")) navigate("/login", true);
  }, [me, path, navigate]);

  if (path === "/login/verify") return <VerifyPage onSignedIn={loadMe} />;
  if (path.startsWith("/login")) return <LoginPage />;
  if (!me) {
    return meFailed ? (
      <div className="auth">
        <div className="auth-card">
          <h1>{t("app.unreachable.title")}</h1>
          <p>{t("app.unreachable.body")}</p>
          <button type="button" className="btn btn-primary" onClick={loadMe}>
            {t("common.retry")}
          </button>
        </div>
      </div>
    ) : (
      <Spinner />
    );
  }

  if (path === "/new-workspace") return <NewWorkspacePage me={me} onCreated={loadMe} />;

  const ws = match("/w/:ws/:section?/:id?", path);
  const workspace = ws && me.workspaces.find((w) => w.id === ws.ws);
  if (!workspace) {
    const first = me.workspaces[0];
    if (first) {
      queueMicrotask(() => navigate(`/w/${first.id}/inbox`, true));
      return <Spinner />;
    }
    if (me.superAdmin) {
      // Route (not inline render) so the one-time secret screen survives the post-create refresh.
      queueMicrotask(() => navigate("/new-workspace", true));
      return <Spinner />;
    }
    return (
      <div className="auth">
        <div className="auth-card">
          <h1>{t("app.noWorkspaces.title")}</h1>
          <p>{t("app.noWorkspaces.body")}</p>
        </div>
      </div>
    );
  }

  const section = ws.section ?? "inbox";
  const isAdmin = workspace.role === "admin";
  return (
    <>
      <Layout me={me} workspaceId={workspace.id} unread={unread}>
        {section === "inbox" && <InboxPage key={workspace.id} me={me} workspaceId={workspace.id} conversationId={ws.id ?? null} onUnread={setUnread} onAccessLost={loadMe} />}
        {section === "faq" && <FaqPage key={workspace.id} workspaceId={workspace.id} articleId={ws.id ?? null} />}
        {section === "reports" && <ReportsPage key={workspace.id} workspaceId={workspace.id} />}
        {section === "settings" && <SettingsPage key={workspace.id} me={me} workspaceId={workspace.id} isAdmin={isAdmin} tab={ws.id ?? "general"} />}
      </Layout>
      <Toaster />
    </>
  );
}
