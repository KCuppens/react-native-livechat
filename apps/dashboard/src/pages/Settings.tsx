import type { AgentMe, CannedReply, OfficeHours, UpdateWorkspaceSettingsRequest, WorkspaceSettings } from "@kobecuppens/livechat-protocol";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Member } from "../api";
import { attempt, Avatar, Field, Spinner, toast, useBusy } from "../components/ui";
import { formatDate, t as translateNow, useI18n, withNodes, type DashKey } from "../i18n";
import { useRouter } from "../router";

const TABS = ["general", "hours", "install", "push", "team", "canned"] as const;

/** Weekday names in the dashboard language, Sunday first (day 0, as office hours store it). 2023-01-01 was a Sunday. */
const dayNames = (locale: string) => Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + day)));
/**
 * ~420 zones; computed once, not on every keystroke in the office-hours form. "UTC" (the
 * default) isn't in V8's list, so it's added explicitly.
 */
const TIMEZONES = [...new Set(["UTC", ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [])])];

const LANGUAGES: Record<string, string> = { en: "English", nl: "Nederlands", fr: "Français", de: "Deutsch", es: "Español", it: "Italiano", pt: "Português", ja: "日本語", ko: "한국어" };

export function SettingsPage({ me, workspaceId, isAdmin, tab }: { me: AgentMe; workspaceId: string; isAdmin: boolean; tab: string }) {
  const { navigate } = useRouter();
  const { t } = useI18n();
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is the Retry trigger
  useEffect(() => {
    setLoadFailed(false);
    api.settings(workspaceId).then(setSettings, () => setLoadFailed(true));
  }, [workspaceId, reloadNonce]);

  const save = async (patch: UpdateWorkspaceSettingsRequest) => {
    await attempt(async () => {
      setSettings(await api.updateSettings(workspaceId, patch));
      toast(translateNow("common.saved"));
    }, translateNow("common.saveFailed"));
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t("nav.settings")}</h1>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((id) => (
          <button type="button" key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => navigate(`/w/${workspaceId}/settings/${id}`)}>
            {t(`settings.tab.${id}`)}
          </button>
        ))}
      </div>
      {!isAdmin && tab !== "canned" && <p className="muted">{t("settings.adminOnly")}</p>}
      {!settings ? (
        loadFailed ? <LoadFailed message={t("settings.loadFailed")} onRetry={() => setReloadNonce((n) => n + 1)} /> : <Spinner />
      ) : (
        <fieldset disabled={!isAdmin && tab !== "canned"} style={{ border: 0, padding: 0, margin: 0, maxWidth: 820 }}>
          {tab === "general" && <GeneralTab settings={settings} save={save} />}
          {tab === "hours" && <HoursTab settings={settings} save={save} />}
          {tab === "install" && <InstallTab settings={settings} save={save} workspaceId={workspaceId} />}
          {tab === "push" && <PushTab settings={settings} workspaceId={workspaceId} reload={() => void attempt(async () => setSettings(await api.settings(workspaceId)), t("settings.reloadFailed"))} />}
          {tab === "team" && <TeamTab workspaceId={workspaceId} me={me} />}
          {tab === "canned" && <CannedTab workspaceId={workspaceId} />}
        </fieldset>
      )}
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {children}
    </div>
  );
}

function GeneralTab({ settings, save }: { settings: WorkspaceSettings; save: (p: UpdateWorkspaceSettingsRequest) => Promise<void> }) {
  const [name, setName] = useState(settings.name);
  const [saving, run] = useBusy();
  const [color, setColor] = useState(settings.primaryColor);
  const [logo, setLogo] = useState(settings.logoUrl ?? "");
  const [locales, setLocales] = useState(settings.locales);
  const [defaultLocale, setDefaultLocale] = useState(settings.defaultLocale);
  const [greeting, setGreeting] = useState(settings.greeting);
  const [csat, setCsat] = useState(settings.csatEnabled);
  const { t } = useI18n();
  return (
    <>
      <Card title={t("general.branding")} description={t("general.brandingIntro")}>
        <Field label={t("common.name")}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("general.brandColor")}>
          <div className="row">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={t("general.brandColorPicker")} />
            <input className="input" aria-label={t("general.brandColorHex")} value={color} onChange={(e) => setColor(e.target.value)} style={{ maxWidth: 120 }} />
          </div>
        </Field>
        <Field label={t("general.logoUrl")} hint={t("general.logoHint")}>
          <input className="input" value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…" />
        </Field>
      </Card>
      <Card title={t("general.languages")} description={t("general.languagesIntro")}>
        <div className="row" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          {Object.entries(LANGUAGES).map(([code, label]) => (
            <label key={code} className="row" style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={locales.includes(code)}
                // The last language can't be turned off; turning off the default moves it to the next one.
                disabled={locales.length === 1 && locales.includes(code)}
                onChange={(e) => {
                  const next = e.target.checked ? [...locales, code] : locales.filter((l) => l !== code);
                  setLocales(next);
                  if (!next.includes(defaultLocale) && next[0]) setDefaultLocale(next[0]);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <Field label={t("general.defaultLanguage")}>
          <select className="select" value={defaultLocale} onChange={(e) => setDefaultLocale(e.target.value)} style={{ maxWidth: 240 }}>
            {locales.map((l) => (
              <option key={l} value={l}>
                {LANGUAGES[l] ?? l}
              </option>
            ))}
          </select>
        </Field>
        {locales.map((l) => (
          <Field key={l} label={t("general.greeting", { locale: l })} hint={t("general.greetingHint")}>
            <input className="input" value={greeting[l] ?? ""} onChange={(e) => setGreeting({ ...greeting, [l]: e.target.value })} />
          </Field>
        ))}
      </Card>
      <Card title={t("general.csatTitle")}>
        <label className="row">
          <input type="checkbox" checked={csat} onChange={(e) => setCsat(e.target.checked)} />
          {t("general.csatAsk")}
        </label>
      </Card>
      <button type="button"
        className="btn btn-primary"
        disabled={saving}
        onClick={() =>
          void run(() => save({
            name,
            primaryColor: color,
            logoUrl: logo.trim() || null,
            locales,
            defaultLocale,
            greeting: Object.fromEntries(Object.entries(greeting).filter(([l, v]) => locales.includes(l) && v.trim())),
            csatEnabled: csat,
          }))
        }
      >
        {saving ? t("common.saving") : t("common.saveChanges")}
      </button>
    </>
  );
}

function HoursTab({ settings, save }: { settings: WorkspaceSettings; save: (p: UpdateWorkspaceSettingsRequest) => Promise<void> }) {
  const [hours, setHours] = useState<OfficeHours>(settings.officeHours);
  const [autoReply, setAutoReply] = useState(settings.autoReply);
  const [typical, setTypical] = useState(settings.typicalReplyMinutes?.toString() ?? "");
  const [saving, run] = useBusy();
  const { t, locale } = useI18n();
  const days = useMemo(() => dayNames(locale), [locale]);
  // A saved zone the browser doesn't list must still show as selected (not silently the first one).
  const timezoneOptions = useMemo(
    () => (TIMEZONES.includes(settings.officeHours.timezone) ? TIMEZONES : [settings.officeHours.timezone, ...TIMEZONES]).map((tz) => <option key={tz}>{tz}</option>),
    [settings.officeHours.timezone],
  );
  const windowFor = (day: number) => hours.windows.find((w) => w.day === day);
  const setDay = (day: number, w: { open: string; close: string } | null) =>
    setHours({ ...hours, windows: [...hours.windows.filter((x) => x.day !== day), ...(w ? [{ day, ...w }] : [])].sort((a, b) => a.day - b.day) });

  return (
    <>
      <Card title={t("settings.tab.hours")} description={t("hours.intro")}>
        <label className="row" style={{ marginBottom: 14 }}>
          <input type="checkbox" checked={hours.enabled} onChange={(e) => setHours({ ...hours, enabled: e.target.checked })} />
          {t("hours.enable")}
        </label>
        <Field label={t("hours.timezone")}>
          <select className="select" value={hours.timezone} onChange={(e) => setHours({ ...hours, timezone: e.target.value })} style={{ maxWidth: 320 }}>
            {timezoneOptions}
          </select>
        </Field>
        {days.map((label, day) => {
          const w = windowFor(day);
          return (
            <div className="hours-grid" key={label}>
              <span>{label}</span>
              <label className="row">
                <input type="checkbox" checked={!!w} onChange={(e) => setDay(day, e.target.checked ? { open: "09:00", close: "17:00" } : null)} />
                {t("hours.open")}
              </label>
              {w ? (
                <div className="row">
                  <input className="input" type="time" value={w.open} onChange={(e) => setDay(day, { ...w, open: e.target.value })} aria-label={t("hours.opens", { day: label })} />
                  –
                  <input className="input" type="time" value={w.close} onChange={(e) => setDay(day, { ...w, close: e.target.value })} aria-label={t("hours.closes", { day: label })} />
                </div>
              ) : (
                <span className="muted">{t("hours.closed")}</span>
              )}
            </div>
          );
        })}
      </Card>
      <Card title={t("hours.replyTitle")}>
        <Field label={t("hours.typical")} hint={t("hours.typicalHint")}>
          <input className="input" type="number" min={1} value={typical} onChange={(e) => setTypical(e.target.value)} style={{ maxWidth: 120 }} />
        </Field>
        {settings.locales.map((l) => (
          <Field key={l} label={t("hours.away", { locale: l })} hint={t("hours.awayHint")}>
            <textarea className="textarea" value={autoReply[l] ?? ""} onChange={(e) => setAutoReply({ ...autoReply, [l]: e.target.value })} />
          </Field>
        ))}
      </Card>
      <button type="button"
        className="btn btn-primary"
        disabled={saving}
        onClick={() =>
          void run(() => save({
            officeHours: hours,
            autoReply: Object.fromEntries(Object.entries(autoReply).filter(([, v]) => v.trim())),
            typicalReplyMinutes: typical ? Number(typical) : null,
          }))
        }
      >
        {saving ? t("common.saving") : t("common.saveChanges")}
      </button>
    </>
  );
}

function InstallTab({ settings, save, workspaceId }: { settings: WorkspaceSettings; save: (p: UpdateWorkspaceSettingsRequest) => Promise<void>; workspaceId: string }) {
  const [origins, setOrigins] = useState(settings.allowedOrigins.join("\n"));
  const [secret, setSecret] = useState<string | null>(null);
  const [saving, run] = useBusy();
  const apiUrl = location.origin;
  const { t } = useI18n();
  return (
    <>
      <Card title={t("install.keys")}>
        <Field label={t("install.publishableKey")} hint={t("install.publishableHint")}>
          <input className="input" readOnly value={settings.publishableKey} onFocus={(e) => e.target.select()} />
        </Field>
        {secret ? (
          <Field label={t("install.identitySecret")} hint={t("install.secretHint")}>
            <input className="input" readOnly value={secret} onFocus={(e) => e.target.select()} />
          </Field>
        ) : (
          // Not a <Field>: a button inside a <label> becomes the label's control, so clicking
          // the label text would trigger the rotate prompt.
          // biome-ignore lint/a11y/useSemanticElements: a <fieldset> would bring its own border/legend styling into this form row
          <div className="field" role="group" aria-labelledby="identity-secret-label">
            <span id="identity-secret-label">{t("install.identitySecret")}</span>
            <div className="row">
              <span className="muted">{t("install.secretHidden")}</span>
              <button type="button"
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  if (!confirm(t("install.rotateConfirm"))) return;
                  await attempt(async () => setSecret((await api.rotateIdentitySecret(workspaceId)).identitySecret), t("install.rotateFailed"));
                }}
              >
                {t("install.rotate")}
              </button>
            </div>
            <small>{t("install.secretHint")}</small>
          </div>
        )}
      </Card>
      <Card title={t("install.origins")} description={t("install.originsIntro")}>
        <textarea className="textarea" aria-label={t("install.origins")} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://app.example.com" />
        <button
          type="button"
          className="btn"
          style={{ marginTop: 8 }}
          disabled={saving}
          onClick={() => void run(() => save({ allowedOrigins: origins.split(/\s+/).filter(Boolean) }))}
        >
          {saving ? t("common.saving") : t("install.saveOrigins")}
        </button>
      </Card>
      <Card title="React Native">
        <div className="code">{`npm i @kobecuppens/livechat-react-native @react-native-async-storage/async-storage react-native-get-random-values

import "react-native-get-random-values";
import { LiveChatProvider, SupportScreen } from "@kobecuppens/livechat-react-native";

<LiveChatProvider apiUrl="${apiUrl}" workspaceKey="${settings.publishableKey}" user={user && { id: user.id, hash: user.livechatHash }}>
  <App />
</LiveChatProvider>`}</div>
      </Card>
      <Card title={t("install.reactWeb")}>
        <div className="code">{`npm i @kobecuppens/livechat-react

import { LiveChatProvider, LiveChatWidget } from "@kobecuppens/livechat-react";

<LiveChatProvider apiUrl="${apiUrl}" workspaceKey="${settings.publishableKey}">
  <App />
  <LiveChatWidget />
</LiveChatProvider>`}</div>
      </Card>
      <Card title={t("install.anyWebsite")}>
        <div className="code">{`<script src="https://cdn.jsdelivr.net/npm/@kobecuppens/livechat-widget/dist/widget.js"
  data-api-url="${apiUrl}" data-workspace-key="${settings.publishableKey}" async></script>`}</div>
      </Card>
      <Card title={t("install.verifyUsers")} description={t("install.verifyIntro")}>
        <div className="code">{`// Node
crypto.createHmac("sha256", process.env.LIVECHAT_IDENTITY_SECRET).update(user.id).digest("hex")

# Python
hmac.new(secret.encode(), user_id.encode(), hashlib.sha256).hexdigest()

// PHP
hash_hmac('sha256', $userId, $secret)`}</div>
      </Card>
    </>
  );
}

function PushTab({ settings, workspaceId, reload }: { settings: WorkspaceSettings; workspaceId: string; reload: () => void }) {
  const [fcm, setFcm] = useState("");
  const [apns, setApns] = useState({ keyP8: "", keyId: "", teamId: "" });
  const { t } = useI18n();
  const readFile = (file: File | undefined, set: (text: string) => void) => file?.text().then(set);
  const run = async (fn: () => Promise<void>) => {
    await attempt(async () => {
      await fn();
      toast(t("common.saved"));
      reload();
    }, t("common.failed"));
  };
  const status = (at: number | null) =>
    at ? <span className="badge badge-open">{t("push.configured", { date: formatDate(at) })}</span> : <span className="badge">{t("push.notConfigured")}</span>;
  return (
    <>
      <Card title={t("push.fcmTitle")} description={<>{t("push.fcmIntro")} {status(settings.push.fcmUpdatedAt)}</>}>
        <input type="file" aria-label={t("push.fcmFile")} accept="application/json,.json" onChange={(e) => void readFile(e.target.files?.[0], setFcm)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary" disabled={!fcm} onClick={() => void run(() => api.saveFcm(workspaceId, fcm))}>
            {t("push.saveFcm")}
          </button>
          {settings.push.fcmUpdatedAt && (
            <button type="button" className="btn btn-danger" onClick={() => void run(() => api.deletePush(workspaceId, "fcm"))}>
              {t("common.remove")}
            </button>
          )}
        </div>
      </Card>
      <Card title={t("push.apnsTitle")} description={<>{t("push.apnsIntro")} {status(settings.push.apnsUpdatedAt)}</>}>
        <Field label={t("push.p8File")}>
          <input type="file" accept=".p8" onChange={(e) => void readFile(e.target.files?.[0], (keyP8) => setApns((a) => ({ ...a, keyP8 })))} />
        </Field>
        <div className="row">
          <Field label={t("push.keyId")}>
            <input className="input" value={apns.keyId} onChange={(e) => setApns({ ...apns, keyId: e.target.value.trim() })} placeholder="ABC123DEFG" />
          </Field>
          <Field label={t("push.teamId")}>
            <input className="input" value={apns.teamId} onChange={(e) => setApns({ ...apns, teamId: e.target.value.trim() })} placeholder="TEAM123456" />
          </Field>
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={!apns.keyP8 || !apns.keyId || !apns.teamId} onClick={() => void run(() => api.saveApns(workspaceId, apns))}>
            {t("push.saveApns")}
          </button>
          {settings.push.apnsUpdatedAt && (
            <button type="button" className="btn btn-danger" onClick={() => void run(() => api.deletePush(workspaceId, "apns"))}>
              {t("common.remove")}
            </button>
          )}
        </div>
      </Card>
    </>
  );
}

function TeamTab({ workspaceId, me }: { workspaceId: string; me: AgentMe }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"agent" | "admin">("agent");
  const [loadFailed, setLoadFailed] = useState(false);
  const [inviting, run] = useBusy();
  const { t } = useI18n();
  const reload = useCallback(async () => {
    setLoadFailed(false);
    if (!(await attempt(async () => setMembers(await api.members(workspaceId)), translateNow("team.loadFailedToast")))) setLoadFailed(true);
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <>
      <Card title={t("team.invite")} description={t("team.inviteIntro")}>
        <form
          className="row"
          style={{ alignItems: "flex-end", flexWrap: "wrap" }}
          onSubmit={async (e) => {
            e.preventDefault();
            await run(() =>
              attempt(async () => {
                const added = await api.invite(workspaceId, { email: email.trim(), name: name.trim() || undefined, role });
                setEmail("");
                setName("");
                toast(added.inviteEmailSent ? t("team.inviteSent") : t("team.inviteNoEmail"));
                void reload();
              }, t("team.inviteFailed")),
            );
          }}
        >
          <Field label={t("common.email")}>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t("common.name")}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("team.role")}>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as "agent" | "admin")}>
              <option value="agent">{t("team.role.agent")}</option>
              <option value="admin">{t("team.role.admin")}</option>
            </select>
          </Field>
          <button type="submit" className="btn btn-primary" style={{ marginBottom: 14 }} disabled={inviting}>
            {inviting ? t("common.sending") : t("team.sendInvite")}
          </button>
        </form>
      </Card>
      <Card title={t("team.members")}>
        {!members && loadFailed ? (
          <LoadFailed message={t("team.loadFailed")} onRetry={() => void reload()} />
        ) : !members ? (
          <Spinner />
        ) : (
          <table className="table">
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td style={{ width: 40 }}>
                    <Avatar name={m.name} url={m.avatarUrl} />
                  </td>
                  <td>
                    <strong>{m.name}</strong> {m.online && <span className="badge badge-open">{t("team.online")}</span>}
                    <div className="muted">{m.email}</div>
                  </td>
                  <td>{t(`team.role.${m.role}` as DashKey)}</td>
                  <td style={{ textAlign: "right" }}>
                    {m.id !== me.agent.id && (
                      <button type="button"
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          if (!confirm(t("team.removeConfirm", { name: m.name }))) return;
                          if (await attempt(() => api.removeMember(workspaceId, m.id), t("team.removeFailed"))) void reload();
                        }}
                      >
                        {t("common.remove")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function CannedTab({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<CannedReply[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; shortcut: string; title: string; body: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, run] = useBusy();
  const { t } = useI18n();
  const reload = useCallback(async () => {
    setLoadFailed(false);
    if (!(await attempt(async () => setItems(await api.canned(workspaceId)), translateNow("canned.loadFailedToast")))) setLoadFailed(true);
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <Card
      title={t("settings.tab.canned")}
      description={withNodes(t("canned.intro"), { shortcut: <code>/shortcut</code>, name: <code>{"{{name}}"}</code>, agent: <code>{"{{agent}}"}</code> })}
    >
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await run(() =>
              attempt(async () => {
                await api.saveCanned(workspaceId, editing.id, { shortcut: editing.shortcut, title: editing.title, body: editing.body });
                setEditing(null);
                void reload();
              }, t("common.saveFailed")),
            );
          }}
        >
          <div className="row">
            <Field label={t("canned.shortcut")} hint={t("canned.shortcutHint")}>
              <input className="input" required pattern="[a-z0-9-]{1,32}" value={editing.shortcut} onChange={(e) => setEditing({ ...editing, shortcut: e.target.value.toLowerCase() })} />
            </Field>
            <Field label={t("common.title")}>
              <input className="input" required value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </Field>
          </div>
          <Field label={t("canned.message")}>
            <textarea className="textarea" required value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </Field>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <>
          {!items && loadFailed ? (
            <LoadFailed message={t("canned.loadFailed")} onRetry={() => void reload()} />
          ) : !items ? (
            <Spinner />
          ) : items.length === 0 ? (
            <div className="empty">{t("canned.empty")}</div>
          ) : (
            <table className="table">
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td style={{ width: 140 }}>
                      <code>/{c.shortcut}</code>
                    </td>
                    <td>
                      <strong>{c.title}</strong>
                      <div className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 420 }}>
                        {c.body}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing({ ...c })}>
                        {t("common.edit")}
                      </button>{" "}
                      <button type="button"
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          if (!confirm(t("canned.deleteConfirm", { shortcut: c.shortcut }))) return;
                          if (await attempt(() => api.deleteCanned(workspaceId, c.id), t("canned.deleteFailed"))) void reload();
                        }}
                      >
                        {t("common.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setEditing({ id: null, shortcut: "", title: "", body: "" })}>
            {t("canned.new")}
          </button>
        </>
      )}
    </Card>
  );
}

function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      {message}{" "}
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}
