import type { AgentMe, CannedReply, WorkspaceSettings } from "@kobecuppens/livechat-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../api";
import { Toaster } from "../components/ui";
import { match, Router, useRouter } from "../router";
import { SettingsPage } from "./Settings";

// ---------------------------------------------------------------- fakes

type Reply = { status?: number; body?: unknown } | Error;
type Handler = (init: RequestInit) => Reply | Promise<Reply>;

interface Call {
  method: string;
  url: string;
  init: RequestInit;
}

/** Fake backend keyed by "METHOD /path"; anything unrouted answers 404. */
function stubApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, init });
      const handler = routes[`${method} ${url}`];
      const r: Reply = handler ? await handler(init) : { status: 404, body: { error: { code: "not_found", message: `unrouted ${method} ${url}` } } };
      if (r instanceof Error) throw r;
      const status = r.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status });
    }),
  );
  const find = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);
  const bodies = (method: string, url: string) => find(method, url).map((c) => JSON.parse(c.init.body as string));
  return { calls, find, bodies };
}

// ---------------------------------------------------------------- fixtures

const W = "/agent/w/ws_1";
const SETTINGS = `${W}/settings`;
const MEMBERS = "/agent/workspaces/ws_1/members";
const CANNED = `${W}/canned-replies`;

const me: AgentMe = {
  agent: { id: "ag_me", email: "alex@acme.test", name: "Alex Agent", avatarUrl: null },
  superAdmin: false,
  workspaces: [{ id: "ws_1", name: "Acme", role: "admin" }],
};

function makeSettings(over: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return {
    id: "ws_1",
    name: "Acme",
    primaryColor: "#112233",
    logoUrl: "https://acme.test/logo.png",
    greeting: { en: "Hi there", nl: "Hallo", fr: "Salut" },
    defaultLocale: "en",
    locales: ["en", "nl"],
    officeHours: { enabled: false, timezone: "Europe/Brussels", windows: [{ day: 1, open: "08:00", close: "16:00" }] },
    autoReply: { en: "We're away" },
    typicalReplyMinutes: 15,
    allowedOrigins: ["https://a.test"],
    csatEnabled: true,
    publishableKey: "pk_live_abc",
    push: { fcmUpdatedAt: null, apnsUpdatedAt: null },
    ...over,
  };
}

const members: Member[] = [
  { id: "ag_me", email: "alex@acme.test", name: "Alex Agent", avatarUrl: null, role: "admin", online: true },
  { id: "ag_bo", email: "bo@acme.test", name: "Bo Other", avatarUrl: "https://img.test/bo.png", role: "agent", online: false },
];

/** Settings route that echoes PATCHes back so the page reflects the server's answer. */
function settingsRoutes(initial = makeSettings(), over: Record<string, Handler> = {}) {
  const state = { settings: initial };
  const routes: Record<string, Handler> = {
    [`GET ${SETTINGS}`]: () => ({ body: state.settings }),
    [`PATCH ${SETTINGS}`]: (init) => {
      state.settings = { ...state.settings, ...JSON.parse(init.body as string) };
      return { body: state.settings };
    },
    ...over,
  };
  return { state, routes };
}

function Harness({ isAdmin }: { isAdmin: boolean }) {
  const { path } = useRouter();
  const m = match("/w/:ws/settings/:tab", path);
  return (
    <>
      <SettingsPage me={me} workspaceId="ws_1" isAdmin={isAdmin} tab={m?.tab ?? "general"} />
      <Toaster />
    </>
  );
}

async function renderSettings(tab: string, isAdmin = true) {
  history.replaceState(null, "", `/w/ws_1/settings/${tab}`);
  const utils = render(
    <Router>
      <Harness isAdmin={isAdmin} />
    </Router>,
  );
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading" })).toBeNull());
  return utils;
}

const card = (title: string) => screen.getByRole("heading", { name: title, level: 2 }).closest(".card") as HTMLElement;
const button = (name: string, scope: HTMLElement = document.body) => within(scope).getByRole("button", { name }) as HTMLButtonElement;

let confirmMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

// ---------------------------------------------------------------- shell

describe("SettingsPage shell", () => {
  it("renders the tabs, marks the active one and navigates between them", async () => {
    const api = stubApi(settingsRoutes().routes);
    await renderSettings("general");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["General", "Office hours", "Install", "Push notifications", "Team", "Saved replies"]);
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Branding" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Office hours" }));
    expect(location.pathname).toBe("/w/ws_1/settings/hours");
    expect(screen.getByRole("tab", { name: "Office hours" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("heading", { name: "Office hours", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Branding" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Install" }));
    expect(location.pathname).toBe("/w/ws_1/settings/install");
    expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
    // Settings are fetched once, not per tab.
    expect(api.find("GET", SETTINGS)).toHaveLength(1);
  });

  it("shows a read-only notice and disables the form for non-admins", async () => {
    stubApi(settingsRoutes().routes);
    const { container } = await renderSettings("general", false);

    expect(screen.getByText("Only workspace admins can change these settings.")).toBeTruthy();
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
  });

  it("lets non-admins manage saved replies", async () => {
    stubApi({ ...settingsRoutes().routes, [`GET ${CANNED}`]: () => ({ body: [] }) });
    const { container } = await renderSettings("canned", false);

    expect(screen.queryByText("Only workspace admins can change these settings.")).toBeNull();
    expect(container.querySelector("fieldset")!.disabled).toBe(false);
    expect(await screen.findByRole("button", { name: "New saved reply" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------- general

describe("SettingsPage general tab", () => {
  it("PATCHes branding, languages, greetings and CSAT", async () => {
    const { routes } = settingsRoutes();
    const api = stubApi(routes);
    await renderSettings("general");

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Acme");
    fireEvent.change(name, { target: { value: "Acme Support" } });

    const colorText = screen.getAllByDisplayValue("#112233").find((i) => (i as HTMLInputElement).type === "text")!;
    fireEvent.change(colorText, { target: { value: "#abcdef" } });
    expect((screen.getByLabelText("Brand color picker") as HTMLInputElement).value).toBe("#abcdef");

    const logo = screen.getByLabelText(/^Logo URL/) as HTMLInputElement;
    expect(logo.value).toBe("https://acme.test/logo.png");
    fireEvent.change(logo, { target: { value: "   " } });

    // Enable French, disable Dutch; the default-language options and greeting fields follow.
    expect((screen.getByLabelText("English") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Français") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText("Français"));
    fireEvent.click(screen.getByLabelText("Nederlands"));
    const defaultLocale = screen.getByLabelText("Default language") as HTMLSelectElement;
    expect([...defaultLocale.options].map((o) => o.textContent)).toEqual(["English", "Français"]);
    fireEvent.change(defaultLocale, { target: { value: "fr" } });
    expect(screen.queryByLabelText(/^Greeting \(nl\)/)).toBeNull();

    expect((screen.getByLabelText(/^Greeting \(fr\)/) as HTMLInputElement).value).toBe("Salut");
    fireEvent.change(screen.getByLabelText(/^Greeting \(fr\)/), { target: { value: "Bonjour" } });
    fireEvent.change(screen.getByLabelText(/^Greeting \(en\)/), { target: { value: "   " } });

    const csat = screen.getByLabelText(/^Ask customers to rate/) as HTMLInputElement;
    expect(csat.checked).toBe(true);
    fireEvent.click(csat);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.bodies("PATCH", SETTINGS)).toEqual([
      {
        name: "Acme Support",
        primaryColor: "#abcdef",
        logoUrl: null,
        locales: ["en", "fr"],
        defaultLocale: "fr",
        // Only enabled locales with a non-empty greeting are sent.
        greeting: { fr: "Bonjour" },
        csatEnabled: false,
      },
    ]);
  });

  it("keeps a non-empty logo URL and toasts the API error message on failure", async () => {
    const { routes } = settingsRoutes(makeSettings(), {
      [`PATCH ${SETTINGS}`]: () => ({ status: 400, body: { error: { code: "invalid_request", message: "logoUrl must be https" } } }),
    });
    const api = stubApi(routes);
    await renderSettings("general");

    fireEvent.change(screen.getByLabelText(/^Logo URL/), { target: { value: "  http://x.test/l.png " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("logoUrl must be https")).toBeTruthy();
    expect(api.bodies("PATCH", SETTINGS)[0].logoUrl).toBe("http://x.test/l.png");
  });

  it("toasts a generic message when the request fails without an API error", async () => {
    const { routes } = settingsRoutes(makeSettings(), { [`PATCH ${SETTINGS}`]: () => new TypeError("offline") });
    stubApi(routes);
    await renderSettings("general");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Save failed")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- hours

describe("SettingsPage office hours tab", () => {
  const row = (container: HTMLElement, day: string) =>
    [...container.querySelectorAll(".hours-grid")].find((r) => r.querySelector("span")?.textContent === day) as HTMLElement;

  it("edits office hours, reply time and away messages and PATCHes them", async () => {
    const api = stubApi(settingsRoutes().routes);
    const { container } = await renderSettings("hours");

    const enabled = screen.getByLabelText(/^Use office hours/) as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    fireEvent.click(enabled);

    const tz = screen.getByLabelText("Timezone") as HTMLSelectElement;
    expect(tz.value).toBe("Europe/Brussels");
    // Every browser zone, plus UTC (the default, which V8 doesn't list).
    expect(tz.options.length).toBe(new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]).size);
    expect([...tz.options].some((o) => o.value === "UTC")).toBe(true);
    fireEvent.change(tz, { target: { value: "America/New_York" } });

    // Monday is open from the fixture; the rest are closed.
    expect((screen.getByLabelText("Monday opens") as HTMLInputElement).value).toBe("08:00");
    expect(within(row(container, "Sunday")).getByText("Closed")).toBeTruthy();

    // Opening a day defaults it to 09:00–17:00.
    fireEvent.click(within(row(container, "Wednesday")).getByLabelText("Open"));
    fireEvent.click(within(row(container, "Tuesday")).getByLabelText("Open"));
    expect((screen.getByLabelText("Tuesday opens") as HTMLInputElement).value).toBe("09:00");
    expect((screen.getByLabelText("Tuesday closes") as HTMLInputElement).value).toBe("17:00");
    fireEvent.change(screen.getByLabelText("Tuesday opens"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Tuesday closes"), { target: { value: "18:30" } });

    // Closing Monday removes its window.
    fireEvent.click(within(row(container, "Monday")).getByLabelText("Open"));
    expect(screen.queryByLabelText("Monday opens")).toBeNull();
    expect(within(row(container, "Monday")).getByText("Closed")).toBeTruthy();

    const typical = screen.getByLabelText(/^Typical reply time/) as HTMLInputElement;
    expect(typical.value).toBe("15");
    fireEvent.change(typical, { target: { value: "30" } });

    expect((screen.getByLabelText(/^Away message \(en\)/) as HTMLTextAreaElement).value).toBe("We're away");
    fireEvent.change(screen.getByLabelText(/^Away message \(en\)/), { target: { value: "  " } });
    fireEvent.change(screen.getByLabelText(/^Away message \(nl\)/), { target: { value: "We zijn weg" } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.bodies("PATCH", SETTINGS)).toEqual([
      {
        officeHours: {
          enabled: true,
          timezone: "America/New_York",
          windows: [
            { day: 2, open: "10:00", close: "18:30" },
            { day: 3, open: "09:00", close: "17:00" },
          ],
        },
        autoReply: { nl: "We zijn weg" },
        typicalReplyMinutes: 30,
      },
    ]);
  });

  it("sends a null typical reply time when cleared", async () => {
    const api = stubApi(settingsRoutes().routes);
    await renderSettings("hours");

    fireEvent.change(screen.getByLabelText(/^Typical reply time/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.find("PATCH", SETTINGS)).toHaveLength(1));
    expect(api.bodies("PATCH", SETTINGS)[0].typicalReplyMinutes).toBeNull();
  });
});

// ---------------------------------------------------------------- install

describe("SettingsPage install tab", () => {
  it("shows the publishable key and install snippets for this origin", async () => {
    stubApi(settingsRoutes().routes);
    const { container } = await renderSettings("install");

    expect((screen.getByLabelText(/^Publishable key/) as HTMLInputElement).value).toBe("pk_live_abc");
    const snippets = [...container.querySelectorAll(".code")].map((c) => c.textContent!);
    expect(snippets).toHaveLength(4);
    expect(snippets[0]).toContain(`<LiveChatProvider apiUrl="${location.origin}" workspaceKey="pk_live_abc"`);
    expect(snippets[1]).toContain(`<LiveChatProvider apiUrl="${location.origin}" workspaceKey="pk_live_abc">`);
    expect(snippets[2]).toContain(`data-api-url="${location.origin}" data-workspace-key="pk_live_abc"`);
    expect(snippets[3]).toContain("createHmac");
  });

  it("rotates the identity secret only after confirmation and reveals the new one", async () => {
    const api = stubApi({ ...settingsRoutes().routes, [`POST ${SETTINGS}/rotate-identity-secret`]: () => ({ body: { identitySecret: "sk_new_789" } }) });
    await renderSettings("install");

    const rotate = () => screen.getByRole("button", { name: "Rotate secret" });
    confirmMock.mockReturnValueOnce(false);
    fireEvent.click(rotate());
    expect(confirmMock).toHaveBeenCalledWith("Rotate the identity secret? Your server must switch to the new secret right away.");
    expect(api.find("POST", `${SETTINGS}/rotate-identity-secret`)).toHaveLength(0);
    expect(screen.getByText(/^Hidden\./)).toBeTruthy();

    fireEvent.click(rotate());
    expect(await screen.findByDisplayValue("sk_new_789")).toBeTruthy();
    expect(api.find("POST", `${SETTINGS}/rotate-identity-secret`)).toHaveLength(1);
    expect(screen.queryByText("Rotate secret")).toBeNull();
    expect(screen.queryByText(/^Hidden\./)).toBeNull();
  });

  it("saves allowed origins split on whitespace", async () => {
    const api = stubApi(settingsRoutes().routes);
    await renderSettings("install");

    const origins = screen.getByPlaceholderText("https://app.example.com") as HTMLTextAreaElement;
    expect(origins.value).toBe("https://a.test");
    fireEvent.change(origins, { target: { value: "https://a.test\n  https://b.test:8080   *\n\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save origins" }));

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.bodies("PATCH", SETTINGS)).toEqual([{ allowedOrigins: ["https://a.test", "https://b.test:8080", "*"] }]);
  });
});

// ---------------------------------------------------------------- push

describe("SettingsPage push tab", () => {
  const FCM_CARD = "Android (Firebase Cloud Messaging)";
  const APNS_CARD = "iOS (Apple Push Notification service)";
  const CONFIGURED_AT = new Date("2026-05-01T12:00:00Z").getTime();

  it("shows configuration status and only offers Remove for configured providers", async () => {
    stubApi(settingsRoutes(makeSettings({ push: { fcmUpdatedAt: null, apnsUpdatedAt: CONFIGURED_AT } })).routes);
    await renderSettings("push");

    expect(within(card(FCM_CARD)).getByText("Not configured")).toBeTruthy();
    expect(within(card(FCM_CARD)).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(card(APNS_CARD)).getByText(`Configured ${new Date(CONFIGURED_AT).toLocaleDateString()}`).className).toBe("badge badge-open");
    expect(within(card(APNS_CARD)).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("uploads the FCM service account JSON, saves it and reloads the status", async () => {
    const { state, routes } = settingsRoutes();
    const api = stubApi({
      ...routes,
      [`PUT ${SETTINGS}/push/fcm`]: () => {
        state.settings = { ...state.settings, push: { ...state.settings.push, fcmUpdatedAt: CONFIGURED_AT } };
        return { status: 204 };
      },
    });
    await renderSettings("push");
    const fcm = card(FCM_CARD);
    expect(button("Save FCM credentials", fcm).disabled).toBe(true);

    const json = '{"type":"service_account","project_id":"acme"}';
    fireEvent.change(fcm.querySelector("input[type=file]")!, { target: { files: [new File([json], "sa.json", { type: "application/json" })] } });
    await waitFor(() => expect(button("Save FCM credentials", fcm).disabled).toBe(false));
    fireEvent.click(button("Save FCM credentials", fcm));

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.bodies("PUT", `${SETTINGS}/push/fcm`)).toEqual([{ serviceAccountJson: json }]);
    await waitFor(() => expect(within(card(FCM_CARD)).getByText(/^Configured /)).toBeTruthy());
    expect(api.find("GET", SETTINGS)).toHaveLength(2);
  });

  it("ignores an empty file selection", async () => {
    stubApi(settingsRoutes().routes);
    await renderSettings("push");
    const fcm = card(FCM_CARD);
    fireEvent.change(fcm.querySelector("input[type=file]")!, { target: { files: [] } });
    expect(button("Save FCM credentials", fcm).disabled).toBe(true);
  });

  it("requires the .p8 key, key id and team id before saving APNs credentials", async () => {
    const api = stubApi({ ...settingsRoutes().routes, [`PUT ${SETTINGS}/push/apns`]: () => ({ status: 204 }) });
    await renderSettings("push");
    const apns = card(APNS_CARD);
    const save = () => button("Save APNs credentials", apns);

    const p8 = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    fireEvent.change(within(apns).getByLabelText(".p8 key file"), { target: { files: [new File([p8], "AuthKey.p8")] } });
    fireEvent.change(within(apns).getByLabelText("Key ID"), { target: { value: " ABC123DEFG " } });
    await waitFor(() => expect((within(apns).getByLabelText("Key ID") as HTMLInputElement).value).toBe("ABC123DEFG"));
    expect(save().disabled).toBe(true);
    fireEvent.change(within(apns).getByLabelText("Team ID"), { target: { value: "TEAM123456" } });
    await waitFor(() => expect(save().disabled).toBe(false));

    fireEvent.click(save());
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.bodies("PUT", `${SETTINGS}/push/apns`)).toEqual([{ keyP8: p8, keyId: "ABC123DEFG", teamId: "TEAM123456" }]);
  });

  it("removes configured credentials", async () => {
    const api = stubApi({
      ...settingsRoutes(makeSettings({ push: { fcmUpdatedAt: CONFIGURED_AT, apnsUpdatedAt: CONFIGURED_AT } })).routes,
      [`DELETE ${SETTINGS}/push/fcm`]: () => ({ status: 204 }),
      [`DELETE ${SETTINGS}/push/apns`]: () => ({ status: 204 }),
    });
    await renderSettings("push");

    fireEvent.click(button("Remove", card(FCM_CARD)));
    await waitFor(() => expect(api.find("DELETE", `${SETTINGS}/push/fcm`)).toHaveLength(1));
    fireEvent.click(button("Remove", card(APNS_CARD)));
    await waitFor(() => expect(api.find("DELETE", `${SETTINGS}/push/apns`)).toHaveLength(1));
    await waitFor(() => expect(api.find("GET", SETTINGS)).toHaveLength(3));
  });

  it("toasts the error when saving credentials fails", async () => {
    stubApi({
      ...settingsRoutes().routes,
      [`PUT ${SETTINGS}/push/fcm`]: () => ({ status: 400, body: { error: { code: "invalid_request", message: "Not a service account" } } }),
    });
    await renderSettings("push");
    const fcm = card(FCM_CARD);

    fireEvent.change(fcm.querySelector("input[type=file]")!, { target: { files: [new File(["{}  not json"], "bad.json")] } });
    await waitFor(() => expect(button("Save FCM credentials", fcm).disabled).toBe(false));
    fireEvent.click(button("Save FCM credentials", fcm));

    expect(await screen.findByText("Not a service account")).toBeTruthy();
  });

  it("toasts a generic message for non-API failures", async () => {
    stubApi({ ...settingsRoutes(makeSettings({ push: { fcmUpdatedAt: CONFIGURED_AT, apnsUpdatedAt: null } })).routes, [`DELETE ${SETTINGS}/push/fcm`]: () => new TypeError("offline") });
    await renderSettings("push");
    fireEvent.click(button("Remove", card(FCM_CARD)));
    expect(await screen.findByText("Failed")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- team

describe("SettingsPage team tab", () => {
  it("lists members with online badges and no Remove on my own row", async () => {
    stubApi({ ...settingsRoutes().routes, [`GET ${MEMBERS}`]: () => ({ body: members }) });
    await renderSettings("team");

    const mine = (await screen.findByText("Alex Agent")).closest("tr")!;
    const bo = screen.getByText("Bo Other").closest("tr")!;
    expect(within(mine).getByText("online")).toBeTruthy();
    expect(within(mine).getByText("alex@acme.test")).toBeTruthy();
    expect(within(mine).getByText("admin")).toBeTruthy();
    expect(within(mine).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(mine.querySelector(".avatar")!.textContent).toBe("AA");

    expect(within(bo).queryByText("online")).toBeNull();
    expect(within(bo).getByText("agent")).toBeTruthy();
    expect((bo.querySelector(".avatar img") as HTMLImageElement).src).toBe("https://img.test/bo.png");
    expect(within(bo).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("invites teammates, trimming input and omitting a blank name", async () => {
    const api = stubApi({
      ...settingsRoutes().routes,
      [`GET ${MEMBERS}`]: () => ({ body: members }),
      [`POST ${MEMBERS}`]: (init) => ({ body: { id: "ag_new", ...JSON.parse(init.body as string), avatarUrl: null, online: false, inviteEmailSent: true } }),
    });
    await renderSettings("team");
    await screen.findByText("Bo Other");

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(email, { target: { value: " cy@acme.test " } });
    fireEvent.change(name, { target: { value: "  Cy New " } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByText("Invite sent")).toBeTruthy();
    expect(email.value).toBe("");
    expect(name.value).toBe("");
    await waitFor(() => expect(api.find("GET", MEMBERS)).toHaveLength(2));

    fireEvent.change(email, { target: { value: "dee@acme.test" } });
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(api.find("POST", MEMBERS)).toHaveLength(2));
    expect(api.bodies("POST", MEMBERS)).toEqual([
      { email: "cy@acme.test", name: "Cy New", role: "agent" },
      { email: "dee@acme.test", role: "admin" },
    ]);
  });

  it("toasts the error when an invite fails", async () => {
    stubApi({
      ...settingsRoutes().routes,
      [`GET ${MEMBERS}`]: () => ({ body: members }),
      [`POST ${MEMBERS}`]: () => ({ status: 409, body: { error: { code: "conflict", message: "Already a member" } } }),
    });
    await renderSettings("team");
    await screen.findByText("Bo Other");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "bo@acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByText("Already a member")).toBeTruthy();
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("bo@acme.test");
  });

  it("removes a member after confirmation and reloads the list", async () => {
    let list = members;
    const api = stubApi({
      ...settingsRoutes().routes,
      [`GET ${MEMBERS}`]: () => ({ body: list }),
      [`DELETE ${MEMBERS}/ag_bo`]: () => {
        list = [members[0]!];
        return { status: 204 };
      },
    });
    await renderSettings("team");
    await screen.findByText("Bo Other");

    confirmMock.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(confirmMock).toHaveBeenCalledWith("Remove Bo Other? Their conversations become unassigned.");
    expect(api.find("DELETE", `${MEMBERS}/ag_bo`)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Bo Other")).toBeNull());
    expect(api.find("DELETE", `${MEMBERS}/ag_bo`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- canned replies

describe("SettingsPage saved replies tab", () => {
  const greet: CannedReply = { id: "c1", shortcut: "greet", title: "Greeting", body: "Hi {{name}}!" };

  function cannedRoutes(over: Record<string, Handler> = {}) {
    const db = { items: [greet] };
    const routes: Record<string, Handler> = {
      ...settingsRoutes().routes,
      [`GET ${CANNED}`]: () => ({ body: db.items }),
      [`POST ${CANNED}`]: (init) => {
        const c = { id: "c2", ...JSON.parse(init.body as string) };
        db.items = [...db.items, c];
        return { body: c };
      },
      [`PUT ${CANNED}/c1`]: (init) => {
        const c = { id: "c1", ...JSON.parse(init.body as string) };
        db.items = db.items.map((x) => (x.id === "c1" ? c : x));
        return { body: c };
      },
      [`DELETE ${CANNED}/c1`]: () => {
        db.items = db.items.filter((x) => x.id !== "c1");
        return { status: 204 };
      },
      ...over,
    };
    return routes;
  }

  it("lists saved replies", async () => {
    stubApi(cannedRoutes());
    await renderSettings("canned");

    const row = (await screen.findByText("/greet")).closest("tr")!;
    expect(within(row).getByText("Greeting")).toBeTruthy();
    expect(within(row).getByText("Hi {{name}}!")).toBeTruthy();
  });

  it("creates a saved reply from the form", async () => {
    const api = stubApi(cannedRoutes());
    await renderSettings("canned");
    await screen.findByText("/greet");

    fireEvent.click(screen.getByRole("button", { name: "New saved reply" }));
    const shortcut = screen.getByLabelText(/^Shortcut/) as HTMLInputElement;
    expect(shortcut.value).toBe("");
    fireEvent.change(shortcut, { target: { value: "Thanks" } });
    expect(shortcut.value).toBe("thanks");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Thank you" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Thanks {{name}}!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("/thanks")).toBeTruthy();
    expect(api.bodies("POST", CANNED)).toEqual([{ shortcut: "thanks", title: "Thank you", body: "Thanks {{name}}!" }]);
    expect(screen.queryByLabelText(/^Shortcut/)).toBeNull();
  });

  it("edits an existing saved reply with PUT", async () => {
    const api = stubApi(cannedRoutes());
    await renderSettings("canned");
    await screen.findByText("/greet");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText(/^Shortcut/) as HTMLInputElement).value).toBe("greet");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Greeting");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Hi {{name}}!");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Warm greeting" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Warm greeting")).toBeTruthy();
    expect(api.bodies("PUT", `${CANNED}/c1`)).toEqual([{ shortcut: "greet", title: "Warm greeting", body: "Hi {{name}}!" }]);
    expect(api.find("POST", CANNED)).toHaveLength(0);
  });

  it("deletes a saved reply", async () => {
    const api = stubApi(cannedRoutes());
    await renderSettings("canned");
    await screen.findByText("/greet");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("/greet")).toBeNull());
    expect(api.find("DELETE", `${CANNED}/c1`)).toHaveLength(1);
  });

  it("toasts a conflict and keeps the form open", async () => {
    const api = stubApi(cannedRoutes({ [`POST ${CANNED}`]: () => ({ status: 409, body: { error: { code: "conflict", message: "Shortcut already exists" } } }) }));
    await renderSettings("canned");
    await screen.findByText("/greet");

    fireEvent.click(screen.getByRole("button", { name: "New saved reply" }));
    fireEvent.change(screen.getByLabelText(/^Shortcut/), { target: { value: "greet" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Dup" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Dup body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Shortcut already exists")).toBeTruthy();
    expect((screen.getByLabelText(/^Shortcut/) as HTMLInputElement).value).toBe("greet");
    expect(api.find("GET", CANNED)).toHaveLength(1);
  });

  it("cancels editing without saving", async () => {
    const api = stubApi(cannedRoutes());
    await renderSettings("canned");
    await screen.findByText("/greet");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Greeting")).toBeTruthy();
    expect(screen.queryByLabelText(/^Shortcut/)).toBeNull();
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- regressions (review of testproof findings)

describe("SettingsPage regressions", () => {
  it("clicking the identity secret label or hint does not trigger rotation", async () => {
    const api = stubApi({ ...settingsRoutes().routes, [`POST ${SETTINGS}/rotate-identity-secret`]: () => ({ body: { identitySecret: "sk_x" } }) });
    await renderSettings("install");
    // Before the fix the button sat inside a <label>, so clicks on the label text activated it.
    fireEvent.click(screen.getByText("Identity secret"));
    fireEvent.click(screen.getByText(/^Keep this on your server/));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(api.find("POST", `${SETTINGS}/rotate-identity-secret`)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Rotate secret" })).toBeTruthy();
  });

  it("toasts instead of throwing when rotating the secret fails", async () => {
    stubApi({ ...settingsRoutes().routes, [`POST ${SETTINGS}/rotate-identity-secret`]: () => ({ status: 403, body: { error: { code: "forbidden", message: "Admin role required" } } }) });
    await renderSettings("install");
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    expect(await screen.findByText("Admin role required")).toBeTruthy();
    expect(screen.getByText(/^Hidden\./)).toBeTruthy();
  });

  it("asks before deleting a saved reply and keeps it when cancelled", async () => {
    const api = stubApi({
      ...settingsRoutes().routes,
      [`GET ${CANNED}`]: () => ({ body: [{ id: "c1", shortcut: "greet", title: "Greeting", body: "Hi" }] }),
      [`DELETE ${CANNED}/c1`]: () => ({ status: 204 }),
    });
    await renderSettings("canned");
    await screen.findByText("/greet");
    confirmMock.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmMock).toHaveBeenCalledWith("Delete the saved reply /greet?");
    expect(api.find("DELETE", `${CANNED}/c1`)).toHaveLength(0);
  });

  it("toasts when removing a member or deleting a saved reply fails", async () => {
    stubApi({
      ...settingsRoutes().routes,
      [`GET ${MEMBERS}`]: () => ({ body: members }),
      [`DELETE ${MEMBERS}/ag_bo`]: () => ({ status: 500, body: { error: { code: "internal_error", message: "Server exploded" } } }),
    });
    await renderSettings("team");
    await screen.findByText("Bo Other");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Server exploded")).toBeTruthy();
    expect(screen.getByText("Bo Other")).toBeTruthy();
  });

  it("shows an error instead of an endless spinner when settings fail to load", async () => {
    stubApi({ [`GET ${SETTINGS}`]: () => ({ status: 500, body: { error: { code: "internal_error", message: "x" } } }) });
    history.replaceState(null, "", "/w/ws_1/settings/general");
    render(
      <Router>
        <Harness isAdmin />
      </Router>,
    );
    expect(await screen.findByText(/Couldn't load settings/)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });
});
