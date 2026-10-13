import test from "node:test";
import assert from "node:assert/strict";
import { createAuth } from "./auth-factory.js";

const database = {};
const baseEnv = {
  BETTER_AUTH_SECRET: "development-secret-value-with-more-than-32-characters",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALLOWED_ORIGINS: "http://localhost:5500",
  NODE_ENV: "development"
};

test("authentication requires a database, a strong secret and a configured base URL", () => {
  assert.throws(() => createAuth({ env: baseEnv }), /DATABASE_URL/);
  assert.throws(() => createAuth({ env: { ...baseEnv, BETTER_AUTH_SECRET: "short" }, database }), /32 characters/);
  assert.throws(() => createAuth({ env: { ...baseEnv, BETTER_AUTH_URL: "" }, database }), /BETTER_AUTH_URL/);
  assert.throws(() => createAuth({ env: { ...baseEnv, BETTER_AUTH_URL: "https://user:password@example.test" }, database }), /valid absolute URL/);
  assert.throws(() => createAuth({ env: { ...baseEnv, ALLOWED_ORIGINS: "https://example.test/path" }, database }), /exact website origins/);
});

test("production authentication requires email delivery for verification and recovery", () => {
  assert.throws(() => createAuth({ env: { ...baseEnv, NODE_ENV: "production", BETTER_AUTH_URL: "https://api.example.test" }, database }), /email delivery/);
  assert.throws(() => createAuth({ env: { ...baseEnv, NODE_ENV: "production", BETTER_AUTH_URL: "http://api.example.test" }, database }), /HTTPS/);
});

test("production authentication uses a fixed 14-day session and secure cookies", async () => {
  const auth = createAuth({
    env: {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "https://api.break-dish.com",
      ALLOWED_ORIGINS: "https://break-dish.com",
      RESEND_API_KEY: "test-key",
      CONTACT_FROM_EMAIL: "noreply@break-dish.com"
    },
    database: {},
    resendClient: { emails: { async send() { return { data: { id: "test" }, error: null }; } } }
  });

  assert.equal(auth.options.session.expiresIn, 60 * 60 * 24 * 14);
  assert.equal(auth.options.session.disableSessionRefresh, true);
  assert.equal(auth.options.advanced.useSecureCookies, true,
    "Remember me must preserve Better Auth's secure production-cookie configuration.");
  await auth.$context.catch(() => null);
});
