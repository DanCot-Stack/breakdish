import { Resend } from "resend";
import { isValidEmailAddress } from "./validation.js";

function readEmailConfiguration(env = process.env) {
  const apiKey = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
  const toEmail = typeof env.CONTACT_TO_EMAIL === "string" ? env.CONTACT_TO_EMAIL.trim() : "";
  const fromEmail = typeof env.CONTACT_FROM_EMAIL === "string" ? env.CONTACT_FROM_EMAIL.trim() : "";

  if (!apiKey) throw new Error("RESEND_API_KEY must be configured.");
  if (!isValidEmailAddress(toEmail)) throw new Error("CONTACT_TO_EMAIL must be a valid email address.");
  if (!isValidEmailAddress(fromEmail)) throw new Error("CONTACT_FROM_EMAIL must be a valid email address.");

  return { apiKey, toEmail, fromEmail };
}

function createEmailSender({ env = process.env, client } = {}) {
  const configuration = readEmailConfiguration(env);
  const resend = client || new Resend(configuration.apiKey);

  return {
    async sendContactEmail(submission) {
      const { data, error } = await resend.emails.send({
        from: configuration.fromEmail,
        to: [configuration.toEmail],
        replyTo: submission.email,
        subject: `BREAK DISH enquiry: ${submission.subject}`,
        text: [
          "New BREAK DISH contact form enquiry",
          `Name: ${submission.name}`,
          `Email: ${submission.email}`,
          `Topic: ${submission.subject}`,
          "",
          "Message:",
          submission.message
        ].join("\n")
      });

      if (error || !data || typeof data.id !== "string" || !data.id) {
        throw new Error("The email provider did not accept this message.");
      }
    }
  };
}

export { createEmailSender, readEmailConfiguration };
