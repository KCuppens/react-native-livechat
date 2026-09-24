import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            CONTACT_JWT_SECRET: "test-contact-jwt-secret",
            ATTACHMENT_SIGNING_KEY: "test-attachment-signing-key",
            ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            SUPER_ADMIN_EMAILS: "owner@acme.com",
            PUBLIC_URL: "http://localhost:8787",
            EMAIL_FROM: "support@example.com",
            DEV_EMAIL_LOG: "true",
          },
        },
      }),
    ],
    // Fail a stuck realtime test (e.g. a socket event that never arrives) instead of hanging CI.
    test: { setupFiles: ["./test/apply-migrations.ts"], testTimeout: 20_000 },
  };
});
