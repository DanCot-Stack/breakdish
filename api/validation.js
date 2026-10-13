const validSubjects = new Set([
  "General enquiry",
  "League or competition",
  "Player or team feature",
  "News and partnership"
]);

function isValidEmailAddress(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(email);
}

function validateSubmission(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (name.length < 1 || name.length > 100) return { error: "Enter a name of up to 100 characters." };
  if (!isValidEmailAddress(email)) {
    return { error: "Enter a valid email address of up to 254 characters." };
  }
  if (!validSubjects.has(subject)) return { error: "Choose a valid enquiry topic." };
  if (message.length < 1 || message.length > 5000) {
    return { error: "Enter a message of up to 5,000 characters." };
  }

  return { value: { name, email, subject, message } };
}

export { isValidEmailAddress, validateSubmission };
