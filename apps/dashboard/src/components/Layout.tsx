import type { AgentMe } from "@kobecuppens/livechat-protocol";
import type { ReactNode } from "react";
import { api } from "../api";
import { LanguageSelect, useI18n } from "../i18n";
import { Link, useRouter } from "../router";
import { Avatar, BookIcon, ChartIcon, GearIcon, InboxIcon } from "./ui";

export function Layout({ me, workspaceId, unread, children }: { me: AgentMe; workspaceId: string; unread: number; children: ReactNode }) {
  const { path, navigate } = useRouter();
  const { t } = useI18n();
  const base = `/w/${workspaceId}`;
  const nav = [
    { to: `${base}/inbox`, label: t("nav.inbox"), icon: <InboxIcon />, count: unread },
    { to: `${base}/faq`, label: t("nav.faq"), icon: <BookIcon /> },
    { to: `${base}/reports`, label: t("nav.reports"), icon: <ChartIcon /> },
    { to: `${base}/settings`, label: t("nav.settings"), icon: <GearIcon /> },
  ];
  return (
    <div className="shell">
      <aside className="sidebar">
        <select
          className="select"
          value={workspaceId}
          aria-label={t("layout.workspace")}
          onChange={(e) => (e.target.value === "__new" ? navigate("/new-workspace") : navigate(`/w/${e.target.value}/inbox`))}
        >
          {me.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          {me.superAdmin && <option value="__new">{t("layout.newWorkspace")}</option>}
        </select>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={`nav-link${path.startsWith(n.to) ? " active" : ""}`}>
            {n.icon}
            {n.label}
            {!!n.count && <span className="nav-count">{n.count > 99 ? "99+" : n.count}</span>}
          </Link>
        ))}
        <LanguageSelect className="select sidebar-language" />
        <div className="sidebar-footer">
          <Avatar name={me.agent.name} url={me.agent.avatarUrl} />
          <div className="who">
            <div>{me.agent.name}</div>
            <div className="muted">{me.agent.email}</div>
          </div>
          <button type="button"
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              await api.logout().catch(() => {});
              location.href = "/login";
            }}
          >
            {t("layout.signOut")}
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
