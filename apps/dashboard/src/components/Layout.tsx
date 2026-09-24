import type { AgentMe } from "@kobecuppens/livechat-protocol";
import type { ReactNode } from "react";
import { api } from "../api";
import { Link, useRouter } from "../router";
import { Avatar, BookIcon, ChartIcon, GearIcon, InboxIcon } from "./ui";

export function Layout({ me, workspaceId, unread, children }: { me: AgentMe; workspaceId: string; unread: number; children: ReactNode }) {
  const { path, navigate } = useRouter();
  const base = `/w/${workspaceId}`;
  const nav = [
    { to: `${base}/inbox`, label: "Inbox", icon: <InboxIcon />, count: unread },
    { to: `${base}/faq`, label: "Help center", icon: <BookIcon /> },
    { to: `${base}/reports`, label: "Reports", icon: <ChartIcon /> },
    { to: `${base}/settings`, label: "Settings", icon: <GearIcon /> },
  ];
  return (
    <div className="shell">
      <aside className="sidebar">
        <select
          className="select"
          value={workspaceId}
          aria-label="Workspace"
          onChange={(e) => (e.target.value === "__new" ? navigate("/new-workspace") : navigate(`/w/${e.target.value}/inbox`))}
        >
          {me.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          {me.superAdmin && <option value="__new">+ New workspace</option>}
        </select>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={`nav-link${path.startsWith(n.to) ? " active" : ""}`}>
            {n.icon}
            {n.label}
            {!!n.count && <span className="nav-count">{n.count > 99 ? "99+" : n.count}</span>}
          </Link>
        ))}
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
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
