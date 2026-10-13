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
