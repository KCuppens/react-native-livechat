# react-native-livechat

A reusable help center (FAQ / knowledge base) and live chat for mobile and web apps, with human agents answering from one shared inbox.

- **React Native** (Expo and bare): `@kobecuppens/livechat-react-native`
- **React web**: `@kobecuppens/livechat-react`
- **Any website** (one `<script>` tag): `@kobecuppens/livechat-widget`
- **Backend + agent dashboard**: a single Cloudflare Worker with D1, R2, Durable Objects, Queues and Email Service. It's multi-tenant: one deployment serves every app, and each app is a *workspace*.

```
packages/
  protocol/      zod schemas + wire types (shared by everything)
  core/          headless client: session, REST, realtime, outbox, i18n, markdown AST
  react/         hooks (/hooks entry is DOM-free) + web Messenger UI
  react-native/  native UI on top of the same hooks
  widget/        IIFE bundle (Preact, Shadow DOM) for plain websites
apps/
  worker/        API (/v1 public, /agent dashboard), DOs, queue consumer; serves the dashboard
  dashboard/     agent inbox, help-center editor, settings, reports (React SPA)
examples/
  web/           React app + plain HTML page using the script widget
  expo/          Expo app with push + attachments (standalone install)
```

## What customers get

- A help home with a greeting, office-hours status ("typically replies in 5 min" or "we're away"), search-as-you-type over the FAQ, popular articles, categories and recent conversations.
- Articles in markdown, with "Was this helpful?" feedback and "Still need help? Chat with us".
- Before a chat starts, articles matching what the customer is typing are suggested (deflection).
- Chat with optimistic sending and retry, image/PDF attachments, typing indicators, read receipts ("Seen"), an unread badge, an auto-reply outside office hours, and a rating card when the conversation is resolved.
- Push (FCM/APNs) when the app isn't showing the conversation, and an email digest if a reply is still unread after 10 minutes (verified users only, since anonymous visitors can type any address).
- UI in English, German, Spanish, French, Japanese, Korean and Dutch. It follows the device language when the workspace supports it; articles fall back to the workspace's default language.
- The agent dashboard comes in the same seven languages. It starts in the browser's language, and each agent can switch it from the sidebar or the sign-in page.

## What agents get

- Magic-link sign-in and a workspace switcher.
- A realtime inbox filtered by open/pending/resolved and all/mine/unassigned, with browser notifications.
- Conversation view: typing, read receipts, attachments, saved replies (`/shortcut`, with `{{name}}`/`{{agent}}`), assign, snooze and resolve.
- Help-center editor with a per-language tab, live preview, publish toggles, categories, and view/helpfulness stats.
- Settings: branding, languages, greeting, office hours and away messages, allowed origins, keys (identity secret rotation), FCM/APNs credentials, team invites, and CSAT on/off.
- Reports: volume, resolved count, median first reply time, CSAT distribution and recent comments.

## Deploy the backend

```bash
pnpm install && pnpm build
cd apps/worker
npx wrangler d1 create livechat                  # put the id into wrangler.jsonc
npx wrangler r2 bucket create livechat-attachments
npx wrangler queues create livechat-notifications
npx wrangler queues create livechat-notifications-dlq  # failed notification jobs land here
npx wrangler secret put CONTACT_JWT_SECRET       # long random string
npx wrangler secret put ENCRYPTION_KEY           # 32 random bytes, base64
npx wrangler secret put ATTACHMENT_SIGNING_KEY   # long random string
npx wrangler secret put PUBLIC_URL               # the Worker's https URL
npx wrangler secret put EMAIL_FROM               # sender on your onboarded email domain
npx wrangler secret put SUPER_ADMIN_EMAILS       # comma-separated, may create workspaces
npx wrangler d1 migrations apply livechat --remote
npx wrangler deploy
```

`PUBLIC_URL`, `EMAIL_FROM` and `SUPER_ADMIN_EMAILS` are deliberately **not** in `wrangler.jsonc` (it sets `keep_vars`), so a deploy, including one from CI, can't reset them to dev values. Set them once as shown above (or as dashboard variables). The Worker answers every request with `500 misconfigured` if a required secret is missing, `PUBLIC_URL` isn't https, or `DEV_EMAIL_LOG` is on in a deployed environment. For real email, onboard the sender domain (`npx wrangler email sending enable yourdomain.com`) and add `"send_email": [{ "name": "EMAIL" }]`. Without that binding, sending fails with an error; email bodies are never logged in production, because sign-in links are credentials. `GET /health` checks D1 and returns 503 if the database is missing or unmigrated.

Next, sign in at `PUBLIC_URL` with a super-admin email and create a workspace. Copy the **publishable key** (it goes in your apps) and the **identity secret** (it stays on your server).

Local development: copy `.dev.vars.example` to `.dev.vars`, run `pnpm --filter @livechat/worker db:migrate:local`, then start `wrangler dev` together with `pnpm --filter @livechat/dashboard dev`. Vite proxies the API to port 8787. With `DEV_EMAIL_LOG=true` (dev only), magic links are printed in the wrangler console.

## Add it to an app

### React Native

```bash
npm i @kobecuppens/livechat-react-native @react-native-async-storage/async-storage react-native-get-random-values
```

```tsx
import "react-native-get-random-values"; // first import in index.js
import { LiveChat, LiveChatProvider, SupportModal } from "@kobecuppens/livechat-react-native";

<LiveChatProvider
  apiUrl="https://support.example.com"
  workspaceKey="pk_…"
  locale={deviceLocale}
  user={user ? { id: user.id, hash: user.livechatHash, email: user.email, name: user.name } : null}
  pickAttachment={pickWithExpoImagePicker} // optional, see examples/expo
>
  <App />
  <SupportModal />
</LiveChatProvider>;

LiveChat.open();                     // help home
LiveChat.open({ name: "new" });      // straight to a new message
```

To use a navigator screen instead of the modal, render `<SupportScreen onClose={navigation.goBack} />`. `useUnreadCount()` gives you a badge.

**Push.** Upload FCM (service account JSON) and APNs (.p8 key) credentials in *Settings → Push notifications*. Register the device's **native** token, then route notification taps:

```ts
const { data: token } = await Notifications.getDevicePushTokenAsync();
await LiveChat.registerPushToken({ platform: Platform.OS, token, appId: "com.example.app", sandbox: __DEV__ });
Notifications.addNotificationResponseReceivedListener((r) => LiveChat.handleNotification(r.notification.request.content.data));
```

See `examples/expo/App.tsx` for the complete version, including cold starts and raw APNs payloads.

### React (web)

```tsx
import { LiveChatProvider, LiveChatWidget, Messenger } from "@kobecuppens/livechat-react";

<LiveChatProvider apiUrl="https://support.example.com" workspaceKey="pk_…" user={user && { id: user.id, hash: user.livechatHash }}>
  <App />
  <LiveChatWidget />          {/* launcher + floating panel */}
  {/* or <Messenger inline /> on a /help page */}
</LiveChatProvider>
```

Control it with `useMessenger().open({ name: "new" })`. Theme it with `primaryColor` / `theme="dark"`, or override strings: `strings={{ en: { "home.greeting": "Hey!" } }}`.

### Any website

```html
<script>window.LiveChat = window.LiveChat || function(){(LiveChat.q = LiveChat.q || []).push(arguments)};</script>
<script src="https://cdn.jsdelivr.net/npm/@kobecuppens/livechat-widget/dist/widget.js"
        data-api-url="https://support.example.com" data-workspace-key="pk_…" async></script>
<script>
  LiveChat("identify", { id: "42", hash: "<server-computed>" });
  LiveChat("onUnreadChange", (n) => console.log(n));
</script>
```

Commands: `open [route]`, `close`, `toggle`, `identify`, `logout`, `setLocale`, `showLauncher`, `hideLauncher`, `onUnreadChange`. Optional attributes: `data-locale`, `data-color`, `data-theme`, `data-hide-launcher`. Add the site's origin under *Settings → Install → Allowed websites*.

## Identity

Visitors are anonymous by default: each device gets a random 128-bit id stored locally. When the user logs in, pass `user={{ id, hash }}`, where

```
hash = hex(HMAC-SHA256(identitySecret, userId))   // computed on YOUR server
```

The SDK then upgrades the session. Anything the visitor wrote while anonymous is merged into the verified user. The server only merges when the client proves it holds the anonymous session token, so a guessed device id can't claim someone else's history. Logging out (`user={null}`) switches to a fresh anonymous identity.

## Security notes

- Contacts get 30-day JWTs scoped to one workspace and contact. Agents use HttpOnly SameSite=Lax session cookies. Dashboard mutations require an `X-Livechat-Dashboard` header (CSRF).
- The public API checks `Origin` against each workspace's allow-list. Native apps send no Origin and are allowed.
- Markdown is parsed into an AST and rendered natively, so raw HTML is never interpreted. Only `http(s)`, `mailto` and `tel` links are rendered.
- Uploads are limited to 10 MB of images/PDF, with magic-byte sniffing. They're served from signed URLs that expire weekly, with `nosniff` and a sandbox CSP.
- Identity secrets and push credentials are AES-GCM encrypted at rest (`ENCRYPTION_KEY`). Magic links and session tokens are stored only as SHA-256 hashes.
- Sessions, messages and uploads are rate limited.

## Known limitations

- **APNs over HTTP/2:** APNs requires HTTP/2 and hasn't been verified against Apple from a deployed Worker yet. If iOS pushes fail, the fallback is to send iOS through FCM (upload the APNs key to Firebase). The Android/FCM path is unaffected.
- The launcher badge refreshes on focus and every 60s. Only an open conversation has a live socket.
- Anonymous sessions are created lazily: a new visitor gets a server contact only on first use of the messenger, so the unread badge covers returning visitors and logged-in users.
- Rotating a workspace's identity secret also revokes every contact token and closes open chat sockets (close code 4401); the SDKs get a new session and reconnect automatically. Logged-in users need hashes made with the new secret. Settings changes take up to 30 seconds to reach other Worker isolates. Sessions are always signed from a fresh read, and a token newer than an isolate's cached copy makes that isolate refresh, so rotation never revokes new sessions by mistake.
- Offline sends are kept in memory with retry, but aren't persisted across app restarts.

## CI/CD

- **CI** (`.github/workflows/ci.yml`) runs on PRs and `main`: build, `pnpm lint` (Biome), typecheck, tests, `pnpm audit --prod` and a `wrangler deploy --dry-run`. Actions are pinned to commit SHAs.
- **Release** (`release.yml`) runs only after CI passed on `main`. Changesets opens a "Version packages" PR and publishes to npm when it's merged (secret `NPM_TOKEN`). Only the tip of `main` is released: a run for an older commit is skipped (shown as a notice) because the newer commit's own CI run releases it. So a commit pushed with `[skip ci]` is not released or deployed until the next commit. GitHub does not run workflows for PRs opened with the default `GITHUB_TOKEN`, so CI will not start on the "Version packages" PR by itself: close and reopen it, push an empty commit to its branch, or give the action a fine-grained PAT / GitHub App token instead.
- **Worker deploy** is off until you set the repository variable `DEPLOY_WORKER=true`. It runs in the GitHub environment `production` (add protection rules there) with the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, refuses to deploy the placeholder D1 id, applies migrations, then deploys.
- **Load test:** `apps/worker/load/chat.k6.js` (`pnpm --filter @livechat/worker load` with `-e BASE_URL=… -e KEY=…`). Run it against staging only.

## Development

```bash
pnpm build && pnpm typecheck && pnpm test   # everything, via turbo
pnpm changeset                              # describe a change to published packages
```

Tests use vitest (protocol, core, react, widget, dashboard), `@cloudflare/vitest-pool-workers` for the Worker (real D1/R2/DO/Queue bindings in workerd), and jest + RNTL for React Native.
