import { betterAuth } from "better-auth";
import { Resend } from "resend";
import { isValidEmailAddress } from "./validation.js";

function parseTrustedOrigins(env) {
  const origins = (env.ALLOWED_ORIGINS || "http://localhost:5500,http://127.0.0.1:5500")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.map((origin) => {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("ALLOWED_ORIGINS must contain valid website origins.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error("ALLOWED_ORIGINS must contain exact website origins without paths.");
    }
    if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error("ALLOWED_ORIGINS must use HTTPS in production.");
    }
    return parsed.origin;
  });
}

function createAuthEmailSender(env, resendClient) {
  const apiKey = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
  const from = typeof env.CONTACT_FROM_EMAIL === "string" ? env.CONTACT_FROM_EMAIL.trim() : "";
  if (!apiKey || !isValidEmailAddress(from)) return null;

  const resend = resendClient || new Resend(apiKey);
  return async ({ to, subject, text }) => {
    try {
      const { data, error } = await resend.emails.send({ from, to: [to], subject, text });
      if (error || !data?.id) throw new Error("Provider did not accept email.");
    } catch {
      console.error("BREAK DISH authentication email delivery failed.");
      throw new Error("The authentication email could not be sent.");
    }
  };
}

export function createAuth({ env = process.env, database, resendClient } = {}) {
  const secret = typeof env.BETTER_AUTH_SECRET === "string" ? env.BETTER_AUTH_SECRET : "";
  const baseURL = typeof env.BETTER_AUTH_URL === "string" ? env.BETTER_AUTH_URL.trim() : "";
  const emailSender = createAuthEmailSender(env, resendClient);

  if (!database) throw new Error("DATABASE_URL is required for account services.");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  let authUrl;
  try {
    authUrl = new URL(baseURL);
  } catch {
    throw new Error("BETTER_AUTH_URL must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(authUrl.protocol) || authUrl.username || authUrl.password ||
    authUrl.pathname !== "/" || authUrl.search || authUrl.hash) {
    throw new Error("BETTER_AUTH_URL must be a valid absolute URL.");
  }
  if (env.NODE_ENV === "production" && authUrl.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use HTTPS in production.");
  }
  if (env.NODE_ENV === "production" && !emailSender) {
    throw new Error("Authentication email delivery must be configured in production.");
  }

  const dispatchAuthEmail = (message) => {
    void emailSender(message).catch(() => {});
  };

  return betterAuth({
    appName: "BREAK DISH",
    baseURL,
    secret,
    trustedOrigins: parseTrustedOrigins(env),
    database,
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      disableSessionRefresh: true
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: Boolean(emailSender),
      ...(emailSender ? {
        sendResetPassword: async ({ user, url }) => dispatchAuthEmail({
          to: user.email,
          subject: "Reset your BREAK DISH password",
          text: `Use this link to reset your password. It expires shortly.\n\n${url}\n\nIf you did not request this, you can ignore this email.`
        })
      } : {})
    },
    ...(emailSender ? {
      emailVerification: {
        sendOnSignUp: true,
        expiresIn: 60 * 60,
        sendVerificationEmail: async ({ user, url }) => dispatchAuthEmail({
          to: user.email,
          subject: "Verify your BREAK DISH account",
          text: `Use this link to verify your email address. It expires in one hour.\n\n${url}\n\nIf you did not create this account, you can ignore this email.`
        })
      }
    } : {}),
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-up/email": { window: 60 * 60, max: 5 },
        "/sign-in/email": { window: 60, max: 8 },
        "/request-password-reset": { window: 60 * 60, max: 5 }
      }
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === "production"
    }
  });
}
