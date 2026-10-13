import test from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
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

test("Better Auth sets persistent or browser-session cookies according to Remember me", async () => {
  const auth = betterAuth({
    appName: "BREAK DISH test",
    baseURL: "https://api.break-dish.com",
    secret: "local-test-only-secret-with-more-than-32-characters",
    trustedOrigins: ["https://break-dish.com"],
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      disableSessionRefresh: true
    },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    advanced: { useSecureCookies: true }
  });
  const email = `remember-me-${crypto.randomUUID()}@example.test`;
  const headers = { origin: "https://break-dish.com", "content-type": "application/json" };
  const post = (route, body) => auth.handler(new Request(`https://api.break-dish.com/api/auth/${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }));

  const registration = await post("sign-up/email", {
    name: "Cookie Test",
    email,
    password: "correct-horse-battery-staple"
  });
  assert.equal(registration.status, 200, "The isolated in-memory test account should register.");

  const getSessionCookie = (response) => {
    const setCookie = response.headers.getSetCookie().find((line) =>
      /^__Secure-better-auth\.session_token=/i.test(line)
    );
    assert.ok(setCookie, "Better Auth should issue its secure session cookie.");
    return setCookie.slice(setCookie.indexOf(";") + 1).split(";").map((part) => part.trim());
  };
  const assertSecureCookieAttributes = (attributes) => {
    assert.ok(attributes.some((part) => /^path=\/$/i.test(part)), "The cookie path should cover API routes.");
    assert.ok(attributes.some((part) => /^httponly$/i.test(part)), "The session cookie must remain HttpOnly.");
    assert.ok(attributes.some((part) => /^secure$/i.test(part)), "The production session cookie must remain Secure.");
    assert.ok(attributes.some((part) => /^samesite=lax$/i.test(part)), "The cookie should retain Better Auth's same-site protection.");
    assert.ok(!attributes.some((part) => /^domain=/i.test(part)), "The API session cookie should remain host-only.");
  };

  const browserSession = await post("sign-in/email", {
    email,
    password: "correct-horse-battery-staple",
    rememberMe: false
  });
  assert.equal(browserSession.status, 200, "Login with Remember me unchecked should succeed.");
  const browserAttributes = getSessionCookie(browserSession);
  assertSecureCookieAttributes(browserAttributes);
  assert.ok(!browserAttributes.some((part) => /^(?:max-age|expires)=/i.test(part)),
    "Unchecked Remember me must not persist the session cookie across browser restarts.");

  const rememberedSession = await post("sign-in/email", {
    email,
    password: "correct-horse-battery-staple",
    rememberMe: true
  });
  assert.equal(rememberedSession.status, 200, "Login with Remember me checked should succeed.");
  const rememberedAttributes = getSessionCookie(rememberedSession);
  assertSecureCookieAttributes(rememberedAttributes);
  const maxAge = rememberedAttributes.find((part) => /^max-age=/i.test(part));
  assert.equal(maxAge, "Max-Age=1209600", "Remembered sessions should persist for the configured 14-day maximum.");
  assert.ok(!rememberedAttributes.some((part) => /^expires=/i.test(part)) ||
    Date.parse(rememberedAttributes.find((part) => /^expires=/i.test(part)).slice("Expires=".length)) <= Date.now() + 14 * 24 * 60 * 60 * 1000 + 5_000,
  "Any persistent Expires value must not exceed the configured 14-day maximum.");
});
