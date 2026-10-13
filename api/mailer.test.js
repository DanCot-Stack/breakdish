import test from "node:test";
import assert from "node:assert/strict";
import { createEmailSender, readEmailConfiguration } from "./mailer.js";

const env = {
  RESEND_API_KEY: "re_test_key",
  CONTACT_TO_EMAIL: "owner@example.com",
  CONTACT_FROM_EMAIL: "breakdish@example.com"
};

test("requires safe fixed sender and recipient addresses", () => {
  assert.deepEqual(readEmailConfiguration(env), {
    apiKey: "re_test_key",
    toEmail: "owner@example.com",
    fromEmail: "breakdish@example.com"
  });
  assert.throws(() => readEmailConfiguration({ ...env, CONTACT_TO_EMAIL: "Owner <owner@example.com>" }), /CONTACT_TO_EMAIL/);
  assert.throws(() => readEmailConfiguration({ ...env, CONTACT_FROM_EMAIL: "breakdish@example.com\r\nBcc:bad@example.com" }), /CONTACT_FROM_EMAIL/);
  assert.throws(() => readEmailConfiguration({ ...env, RESEND_API_KEY: " " }), /RESEND_API_KEY/);
});

test("uses the configured recipient and sender and puts the validated visitor in reply-to", async () => {
  let emailPayload;
  const sender = createEmailSender({
    env,
    client: {
      emails: {
        async send(payload) {
          emailPayload = payload;
          return { data: { id: "resend-message-id" }, error: null };
        }
      }
    }
  });

  await sender.sendContactEmail({
    name: "Alex Player",
    email: "alex@example.net",
    subject: "General enquiry",
    message: "Hello from the site."
  });

  assert.equal(emailPayload.from, "breakdish@example.com");
  assert.deepEqual(emailPayload.to, ["owner@example.com"]);
  assert.equal(emailPayload.replyTo, "alex@example.net");
  assert.equal(emailPayload.subject, "BREAK DISH enquiry: General enquiry");
  assert.match(emailPayload.text, /Name: Alex Player/);
  assert.match(emailPayload.text, /Email: alex@example.net/);
  assert.match(emailPayload.text, /Topic: General enquiry/);
  assert.match(emailPayload.text, /Hello from the site\./);
});

test("treats provider errors and responses without an email ID as unaccepted", async () => {
  const sender = createEmailSender({
    env,
    client: { emails: { async send() { return { data: null, error: { message: "private provider response" } }; } } }
  });

  await assert.rejects(
    sender.sendContactEmail({ email: "alex@example.net", name: "Alex", subject: "General enquiry", message: "Hi" }),
    /did not accept/
  );

  const missingIdSender = createEmailSender({
    env,
    client: { emails: { async send() { return { data: {}, error: null }; } } }
  });
  await assert.rejects(
    missingIdSender.sendContactEmail({ email: "alex@example.net", name: "Alex", subject: "General enquiry", message: "Hi" }),
    /did not accept/
  );
});
