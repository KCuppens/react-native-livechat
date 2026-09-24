# Expo example

Standalone app (not part of the pnpm workspace, so installing the monorepo stays light).

```bash
pnpm --filter @kobecuppens/livechat-react-native... build   # from the repo root
cd examples/expo
pnpm install --ignore-workspace
npx expo prebuild && npx expo run:ios   # or run:android (push needs a dev build, not Expo Go)
```

Set `extra.livechatApiUrl` / `extra.livechatKey` in `app.json`. On a device, `localhost` is the phone, so
use your machine's LAN IP (or a `wrangler dev --remote`/deployed URL).
