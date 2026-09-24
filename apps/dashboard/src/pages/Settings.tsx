import type { AgentMe, CannedReply, OfficeHours, UpdateWorkspaceSettingsRequest, WorkspaceSettings } from "@kobecuppens/livechat-protocol";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Member } from "../api";
import { attempt, Avatar, Field, Spinner, toast, useBusy } from "../components/ui";
import { useRouter } from "../router";

const TABS = [
  ["general", "General"],
  ["hours", "Office hours"],
  ["install", "Install"],
  ["push", "Push notifications"],
  ["team", "Team"],
  ["canned", "Saved replies"],
] as const;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** ~420 zones; computed once, not on every keystroke in the office-hours form. */
const TIMEZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];

const LANGUAGES: Record<string, string> = { en: "English", nl: "Nederlands", fr: "Français", de: "Deutsch", es: "Español", it: "Italiano", pt: "Português" };

export function SettingsPage({ me, workspaceId, isAdmin, tab }: { me: AgentMe; workspaceId: string; isAdmin: boolean; tab: string }) {
  const { navigate } = useRouter();
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
      toast("Saved");
    }, "Save failed");
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button type="button" key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => navigate(`/w/${workspaceId}/settings/${id}`)}>
            {label}
          </button>
        ))}
      </div>
      {!isAdmin && tab !== "canned" && <p className="muted">Only workspace admins can change these settings.</p>}
      {!settings ? (
        loadFailed ? (
          <div className="empty">
            Couldn't load settings.{" "}
            <button type="button" className="btn btn-sm" onClick={() => setReloadNonce((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : (
          <Spinner />
        )
      ) : (
        <fieldset disabled={!isAdmin && tab !== "canned"} style={{ border: 0, padding: 0, margin: 0, maxWidth: 820 }}>
          {tab === "general" && <GeneralTab settings={settings} save={save} />}
          {tab === "hours" && <HoursTab settings={settings} save={save} />}
          {tab === "install" && <InstallTab settings={settings} save={save} workspaceId={workspaceId} />}
          {tab === "push" && <PushTab settings={settings} workspaceId={workspaceId} reload={() => void attempt(async () => setSettings(await api.settings(workspaceId)), "Couldn't reload settings")} />}
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
  return (
    <>
      <Card title="Branding" description="How the help center and chat look inside your app.">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Brand color">
          <div className="row">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Brand color picker" />
            <input className="input" aria-label="Brand color hex" value={color} onChange={(e) => setColor(e.target.value)} style={{ maxWidth: 120 }} />
          </div>
        </Field>
        <Field label="Logo URL" hint="HTTPS image shown at the top of the help center.">
          <input className="input" value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…" />
        </Field>
      </Card>
      <Card title="Languages" description="The UI follows the device language when it's enabled here; articles fall back to the default language.">
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
        <Field label="Default language">
          <select className="select" value={defaultLocale} onChange={(e) => setDefaultLocale(e.target.value)} style={{ maxWidth: 240 }}>
            {locales.map((l) => (
              <option key={l} value={l}>
                {LANGUAGES[l] ?? l}
              </option>
            ))}
          </select>
        </Field>
        {locales.map((l) => (
          <Field key={l} label={`Greeting (${l})`} hint="Leave empty to use the built-in greeting.">
            <input className="input" value={greeting[l] ?? ""} onChange={(e) => setGreeting({ ...greeting, [l]: e.target.value })} />
          </Field>
        ))}
      </Card>
      <Card title="Satisfaction ratings">
        <label className="row">
          <input type="checkbox" checked={csat} onChange={(e) => setCsat(e.target.checked)} />
          Ask customers to rate the conversation when it's resolved
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
        {saving ? "Saving…" : "Save changes"}
      </button>
    </>
  );
}

function HoursTab({ settings, save }: { settings: WorkspaceSettings; save: (p: UpdateWorkspaceSettingsRequest) => Promise<void> }) {
  const [hours, setHours] = useState<OfficeHours>(settings.officeHours);
  const [autoReply, setAutoReply] = useState(settings.autoReply);
  const [typical, setTypical] = useState(settings.typicalReplyMinutes?.toString() ?? "");
  const [saving, run] = useBusy();
  const timezoneOptions = useMemo(() => TIMEZONES.map((tz) => <option key={tz}>{tz}</option>), []);
  const windowFor = (day: number) => hours.windows.find((w) => w.day === day);
  const setDay = (day: number, w: { open: string; close: string } | null) =>
    setHours({ ...hours, windows: [...hours.windows.filter((x) => x.day !== day), ...(w ? [{ day, ...w }] : [])].sort((a, b) => a.day - b.day) });

  return (
    <>
      <Card title="Office hours" description="Outside these hours customers see that you're away and get your auto-reply.">
        <label className="row" style={{ marginBottom: 14 }}>
          <input type="checkbox" checked={hours.enabled} onChange={(e) => setHours({ ...hours, enabled: e.target.checked })} />
          Use office hours (otherwise you always show as online)
        </label>
        <Field label="Timezone">
          <select className="select" value={hours.timezone} onChange={(e) => setHours({ ...hours, timezone: e.target.value })} style={{ maxWidth: 320 }}>
            {timezoneOptions}
          </select>
        </Field>
        {DAYS.map((label, day) => {
          const w = windowFor(day);
          return (
            <div className="hours-grid" key={label}>
              <span>{label}</span>
              <label className="row">
                <input type="checkbox" checked={!!w} onChange={(e) => setDay(day, e.target.checked ? { open: "09:00", close: "17:00" } : null)} />
                Open
              </label>
              {w ? (
                <div className="row">
                  <input className="input" type="time" value={w.open} onChange={(e) => setDay(day, { ...w, open: e.target.value })} aria-label={`${label} opens`} />
                  –
                  <input className="input" type="time" value={w.close} onChange={(e) => setDay(day, { ...w, close: e.target.value })} aria-label={`${label} closes`} />
                </div>
              ) : (
                <span className="muted">Closed</span>
              )}
            </div>
          );
        })}
      </Card>
      <Card title="Reply time & auto-reply">
        <Field label="Typical reply time (minutes)" hint="Shown to customers while you're online. Leave empty to hide.">
          <input className="input" type="number" min={1} value={typical} onChange={(e) => setTypical(e.target.value)} style={{ maxWidth: 120 }} />
        </Field>
        {settings.locales.map((l) => (
          <Field key={l} label={`Away message (${l})`} hint="Sent automatically when someone writes outside office hours (at most once per 12h per conversation).">
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
        {saving ? "Saving…" : "Save changes"}
      </button>
    </>
  );
}

function InstallTab({ settings, save, workspaceId }: { settings: WorkspaceSettings; save: (p: UpdateWorkspaceSettingsRequest) => Promise<void>; workspaceId: string }) {
  const [origins, setOrigins] = useState(settings.allowedOrigins.join("\n"));
  const [secret, setSecret] = useState<string | null>(null);
  const [saving, run] = useBusy();
  const apiUrl = location.origin;
  return (
    <>
      <Card title="Keys">
        <Field label="Publishable key" hint="Safe to ship in your app and website.">
          <input className="input" readOnly value={settings.publishableKey} onFocus={(e) => e.target.select()} />
        </Field>
        {secret ? (
          <Field label="Identity secret" hint="Keep this on your server. Use it to sign user ids so chats are tied to logged-in users.">
            <input className="input" readOnly value={secret} onFocus={(e) => e.target.select()} />
          </Field>
        ) : (
          // Not a <Field>: a button inside a <label> becomes the label's control, so clicking
          // the label text would trigger the rotate prompt.
          // biome-ignore lint/a11y/useSemanticElements: a <fieldset> would bring its own border/legend styling into this form row
          <div className="field" role="group" aria-labelledby="identity-secret-label">
            <span id="identity-secret-label">Identity secret</span>
            <div className="row">
              <span className="muted">Hidden. Rotating it immediately invalidates existing user hashes.</span>
              <button type="button"
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  if (!confirm("Rotate the identity secret? Your server must switch to the new secret right away.")) return;
                  await attempt(async () => setSecret((await api.rotateIdentitySecret(workspaceId)).identitySecret), "Couldn't rotate the secret");
                }}
              >
                Rotate secret
              </button>
            </div>
            <small>Keep this on your server. Use it to sign user ids so chats are tied to logged-in users.</small>
          </div>
        )}
      </Card>
      <Card title="Allowed websites" description="Origins allowed to use the web widget (one per line, e.g. https://app.example.com). Use * to allow any. Mobile apps don't need this.">
        <textarea className="textarea" aria-label="Allowed websites" value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://app.example.com" />
        <button
          type="button"
          className="btn"
          style={{ marginTop: 8 }}
          disabled={saving}
          onClick={() => void run(() => save({ allowedOrigins: origins.split(/\s+/).filter(Boolean) }))}
        >
          {saving ? "Saving…" : "Save origins"}
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
      <Card title="React (web)">
        <div className="code">{`npm i @kobecuppens/livechat-react

import { LiveChatProvider, LiveChatWidget } from "@kobecuppens/livechat-react";

<LiveChatProvider apiUrl="${apiUrl}" workspaceKey="${settings.publishableKey}">
  <App />
  <LiveChatWidget />
</LiveChatProvider>`}</div>
      </Card>
      <Card title="Any website">
        <div className="code">{`<script src="https://cdn.jsdelivr.net/npm/@kobecuppens/livechat-widget/dist/widget.js"
  data-api-url="${apiUrl}" data-workspace-key="${settings.publishableKey}" async></script>`}</div>
      </Card>
      <Card title="Verify users (server-side)" description="Compute the user hash on your server and pass it with the user id.">
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
  const readFile = (file: File | undefined, set: (text: string) => void) => file?.text().then(set);
  const run = async (fn: () => Promise<void>) => {
    await attempt(async () => {
      await fn();
      toast("Saved");
      reload();
    }, "Failed");
  };
  const status = (at: number | null) => (at ? <span className="badge badge-open">Configured {new Date(at).toLocaleDateString()}</span> : <span className="badge">Not configured</span>);
  return (
    <>
      <Card title="Android (Firebase Cloud Messaging)" description={<>Upload a Firebase service account JSON with the Cloud Messaging permission. {status(settings.push.fcmUpdatedAt)}</>}>
        <input type="file" aria-label="Firebase service account JSON" accept="application/json,.json" onChange={(e) => void readFile(e.target.files?.[0], setFcm)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary" disabled={!fcm} onClick={() => void run(() => api.saveFcm(workspaceId, fcm))}>
            Save FCM credentials
          </button>
          {settings.push.fcmUpdatedAt && (
            <button type="button" className="btn btn-danger" onClick={() => void run(() => api.deletePush(workspaceId, "fcm"))}>
              Remove
            </button>
          )}
        </div>
      </Card>
      <Card title="iOS (Apple Push Notification service)" description={<>Create an APNs auth key (.p8) in your Apple developer account. {status(settings.push.apnsUpdatedAt)}</>}>
        <Field label=".p8 key file">
          <input type="file" accept=".p8" onChange={(e) => void readFile(e.target.files?.[0], (keyP8) => setApns((a) => ({ ...a, keyP8 })))} />
        </Field>
        <div className="row">
          <Field label="Key ID">
            <input className="input" value={apns.keyId} onChange={(e) => setApns({ ...apns, keyId: e.target.value.trim() })} placeholder="ABC123DEFG" />
          </Field>
          <Field label="Team ID">
            <input className="input" value={apns.teamId} onChange={(e) => setApns({ ...apns, teamId: e.target.value.trim() })} placeholder="TEAM123456" />
          </Field>
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={!apns.keyP8 || !apns.keyId || !apns.teamId} onClick={() => void run(() => api.saveApns(workspaceId, apns))}>
            Save APNs credentials
          </button>
          {settings.push.apnsUpdatedAt && (
            <button type="button" className="btn btn-danger" onClick={() => void run(() => api.deletePush(workspaceId, "apns"))}>
              Remove
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
  const reload = useCallback(async () => {
    setLoadFailed(false);
    if (!(await attempt(async () => setMembers(await api.members(workspaceId)), "Couldn't load members"))) setLoadFailed(true);
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <>
      <Card title="Invite a teammate" description="They'll get an email with a sign-in link.">
        <form
          className="row"
          style={{ alignItems: "flex-end", flexWrap: "wrap" }}
          onSubmit={async (e) => {
            e.preventDefault();
            await run(() =>
              attempt(async () => {
                await api.invite(workspaceId, { email: email.trim(), name: name.trim() || undefined, role });
                setEmail("");
                setName("");
                toast("Invite sent");
                void reload();
              }, "Invite failed"),
            );
          }}
        >
          <Field label="Email">
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role">
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as "agent" | "admin")}>
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <button type="submit" className="btn btn-primary" style={{ marginBottom: 14 }} disabled={inviting}>
            {inviting ? "Sending…" : "Send invite"}
          </button>
        </form>
      </Card>
      <Card title="Members">
        {!members && loadFailed ? (
          <LoadFailed what="members" onRetry={() => void reload()} />
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
                    <strong>{m.name}</strong> {m.online && <span className="badge badge-open">online</span>}
                    <div className="muted">{m.email}</div>
                  </td>
                  <td>{m.role}</td>
                  <td style={{ textAlign: "right" }}>
                    {m.id !== me.agent.id && (
                      <button type="button"
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          if (!confirm(`Remove ${m.name}? Their conversations become unassigned.`)) return;
                          if (await attempt(() => api.removeMember(workspaceId, m.id), "Couldn't remove member")) void reload();
                        }}
                      >
                        Remove
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
  const reload = useCallback(async () => {
    setLoadFailed(false);
    if (!(await attempt(async () => setItems(await api.canned(workspaceId)), "Couldn't load saved replies"))) setLoadFailed(true);
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <Card title="Saved replies" description={<>Type <code>/shortcut</code> in the composer to insert one. Use <code>{"{{name}}"}</code> for the customer's first name and <code>{"{{agent}}"}</code> for yours.</>}>
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await run(() =>
              attempt(async () => {
                await api.saveCanned(workspaceId, editing.id, { shortcut: editing.shortcut, title: editing.title, body: editing.body });
                setEditing(null);
                void reload();
              }, "Save failed"),
            );
          }}
        >
          <div className="row">
            <Field label="Shortcut" hint="lowercase letters, numbers, dashes">
              <input className="input" required pattern="[a-z0-9-]{1,32}" value={editing.shortcut} onChange={(e) => setEditing({ ...editing, shortcut: e.target.value.toLowerCase() })} />
            </Field>
            <Field label="Title">
              <input className="input" required value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </Field>
          </div>
          <Field label="Message">
            <textarea className="textarea" required value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </Field>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {!items && loadFailed ? (
            <LoadFailed what="saved replies" onRetry={() => void reload()} />
          ) : !items ? (
            <Spinner />
          ) : items.length === 0 ? (
            <div className="empty">No saved replies yet. Create one, then type its /shortcut in the reply box to insert it.</div>
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
                        Edit
                      </button>{" "}
                      <button type="button"
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          if (!confirm(`Delete the saved reply /${c.shortcut}?`)) return;
                          if (await attempt(() => api.deleteCanned(workspaceId, c.id), "Couldn't delete saved reply")) void reload();
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setEditing({ id: null, shortcut: "", title: "", body: "" })}>
            New saved reply
          </button>
        </>
      )}
    </Card>
  );
}

function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="empty">
      Couldn't load {what}.{" "}
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
