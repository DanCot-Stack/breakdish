import test from "node:test";
import assert from "node:assert/strict";
import { validateSubmission } from "./validation.js";

const validSubmission = {
  name: "  Alex Player  ",
  email: " alex@example.com ",
  subject: "League or competition",
  message: "  Please tell me how to join.  "
};

test("accepts and trims the fields the form collects", () => {
  assert.deepEqual(validateSubmission(validSubmission), {
    value: {
      name: "Alex Player",
      email: "alex@example.com",
      subject: "League or competition",
      message: "Please tell me how to join."
    }
  });
});

test("rejects invalid email addresses", () => {
  assert.match(validateSubmission({ ...validSubmission, email: "not-an-email" }).error, /valid email/i);
  assert.match(validateSubmission({ ...validSubmission, email: "alex@example.com\r\nBcc:attacker@example.com" }).error, /valid email/i);
});

test("rejects subjects that are not offered by the form", () => {
  assert.match(validateSubmission({ ...validSubmission, subject: "Other" }).error, /topic/i);
});

test("rejects fields that exceed server-side limits", () => {
  assert.match(validateSubmission({ ...validSubmission, name: "n".repeat(101) }).error, /name/i);
  assert.match(validateSubmission({ ...validSubmission, email: `a${"a".repeat(253)}@b.co` }).error, /email/i);
  assert.match(validateSubmission({ ...validSubmission, message: "m".repeat(5001) }).error, /message/i);
});

test("rejects missing required values", () => {
  assert.match(validateSubmission({ ...validSubmission, name: " " }).error, /name/i);
  assert.match(validateSubmission({ ...validSubmission, message: " " }).error, /message/i);
});
