const menuButton = document.querySelector(".menu-toggle");
const nav = document.querySelector("#primary-nav");

if (menuButton && nav) {
  menuButton.addEventListener("click", () => {
    const expanded = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!expanded));
    menuButton.setAttribute("aria-label", expanded ? "Open navigation" : "Close navigation");
    nav.classList.toggle("is-open", !expanded);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menuButton.getAttribute("aria-expanded") !== "true") return;
    nav.classList.remove("is-open");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation");
    menuButton.focus();
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      menuButton.setAttribute("aria-expanded", "false");
      menuButton.setAttribute("aria-label", "Open navigation");
    });
  });
}

const year = document.querySelector("#year");
if (year) year.textContent = new Date().getFullYear();

const contactForm = document.querySelector("#contact-form");
const formStatus = document.querySelector("#form-status");

if (contactForm && formStatus) {
  const submitButton = contactForm.querySelector("[type=submit]");

  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!contactForm.reportValidity()) return;

    const formData = new FormData(contactForm);
    const payload = {
      name: formData.get("name"),
      email: formData.get("email"),
      subject: formData.get("topic"),
      message: formData.get("message"),
      website: formData.get("website")
    };
    const originalButtonText = submitButton?.innerHTML;

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending…";
    }
    formStatus.dataset.state = "pending";
    formStatus.textContent = "Sending your enquiry…";

    try {
      const { response, payload: result } = await apiRequest("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "omit"
      });

      if (!response.ok) {
        throw new Error(result.error || "We couldn't send your enquiry. Please try again.");
      }

      contactForm.reset();
      formStatus.dataset.state = "success";
      formStatus.textContent = "Thanks for getting in touch. Your message has been received.";
    } catch (error) {
      formStatus.dataset.state = "error";
      formStatus.textContent = error instanceof TypeError
        ? "We couldn't reach the contact service. Your message is still here; please try again in a moment."
        : error.message;
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.innerHTML = originalButtonText;
      }
    }
  });
}

function getApiBaseUrl() {
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return "http://localhost:3001";

  const configured = document.querySelector('meta[name="breakdish-api-url"]')?.content.trim();
  if (configured) return configured.replace(/\/$/, "");

  throw new Error("The BREAK DISH API URL has not been configured for this website.");
}

async function apiRequest(path, options = {}) {
  const { credentials = "include", ...requestOptions } = options;
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...requestOptions,
    credentials,
    headers: { ...(requestOptions.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function getSafeNextPage(candidate) {
  const fallback = "account.html";
  if (typeof candidate !== "string" || !candidate.trim()) return fallback;

  try {
    const destination = new URL(candidate, window.location.href);
    const page = destination.pathname.split("/").pop();
    const allowedPages = new Set(["account.html", "join-league.html", "create-league.html", "competition.html"]);
    if (destination.origin !== window.location.origin || !allowedPages.has(page)) return fallback;
    return `${page}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}

function setStatus(status, message, state) {
  if (!status) return;
  status.dataset.state = state;
  status.textContent = message;
}

async function updateAccountNavigation() {
  const accountActions = document.querySelector(".header-account-actions");
  const navigation = document.querySelector("#primary-nav");
  if (!accountActions || !navigation) return;
  const pageHasLogoutAction = Boolean(document.querySelector("[data-logout]"));
  const loginLink = accountActions.querySelector('a[href="login.html"]');
  const signupLink = accountActions.querySelector('a[href="signup.html"]');

  try {
    const { response } = await apiRequest("/api/me");
    const signedIn = response.ok;
    if (loginLink) loginLink.hidden = signedIn;
    if (signupLink) signupLink.hidden = signedIn;

    let accountLink = accountActions.querySelector("[data-nav-account]");
    let logoutButton = navigation.querySelector("[data-nav-logout]");
    let logoutStatus = navigation.querySelector("[data-nav-auth-status]");
    if (signedIn && !accountLink) {
      accountLink = createTextElement("a", "header-login", "My Account");
      accountLink.href = "account.html";
      accountLink.dataset.navAccount = "";
      if (window.location.pathname.endsWith("/account.html")) accountLink.setAttribute("aria-current", "page");
      accountActions.insertBefore(accountLink, loginLink || accountActions.firstChild);
    }
    if (signedIn && !logoutButton && !pageHasLogoutAction) {
      logoutButton = createTextElement("button", "nav-logout", "Log out");
      logoutButton.type = "button";
      logoutButton.dataset.navLogout = "";
      navigation.append(logoutButton);

      logoutStatus = createTextElement("span", "nav-auth-status");
      logoutStatus.dataset.navAuthStatus = "";
      logoutStatus.setAttribute("role", "status");
      logoutStatus.setAttribute("aria-live", "polite");
      logoutStatus.setAttribute("aria-atomic", "true");
      logoutStatus.hidden = true;
      navigation.append(logoutStatus);

      logoutButton.addEventListener("click", async () => {
        logoutButton.disabled = true;
        logoutStatus.hidden = false;
        setStatus(logoutStatus, "Signing out…", "pending");
        try {
          const { response } = await apiRequest("/api/auth/sign-out", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          if (!response.ok) throw new Error("We couldn't sign you out. Please try again.");
          window.location.assign("login.html?signed-out=1");
        } catch (error) {
          logoutButton.disabled = false;
          setStatus(logoutStatus, error instanceof TypeError
            ? "We couldn't reach the account service. Please try again."
            : error.message, "error");
        }
      });
    }
    if (accountLink) accountLink.hidden = !signedIn;
    if (!signedIn) {
      logoutButton?.remove();
      logoutStatus?.remove();
    }
  } catch {
    // Leave the standard sign-in links available when the API cannot be reached.
  }
}

updateAccountNavigation();

document.querySelectorAll("[data-auth-form]").forEach((form) => {
  const status = form.querySelector("[role='status']");
  const submitButton = form.querySelector("[type='submit']");
  const password = form.querySelector("[name='password']");
  const confirmation = form.querySelector("[name='password-confirm']");
  const kind = form.dataset.authForm;

  const validateConfirmation = () => {
    if (!password || !confirmation) return;
    confirmation.setCustomValidity(
      confirmation.value && confirmation.value !== password.value
        ? "The passwords do not match."
        : ""
    );
  };

  password?.addEventListener("input", validateConfirmation);
  confirmation?.addEventListener("input", validateConfirmation);

  const switchLink = form.querySelector(".member-switch a");
  if (switchLink) {
    const destination = kind === "signup" ? "login.html" : "signup.html";
    const nextPage = getSafeNextPage(new URLSearchParams(window.location.search).get("next"));
    switchLink.href = `${destination}?next=${encodeURIComponent(nextPage)}`;
  }

  if (kind === "login" && new URLSearchParams(window.location.search).get("signed-out") === "1") {
    setStatus(status, "You have been signed out.", "success");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    validateConfirmation();
    if (!form.reportValidity()) return;

    const values = new FormData(form);
    const payload = kind === "signup"
      ? { name: values.get("name").trim(), email: values.get("email").trim(), password: values.get("password"), callbackURL: window.location.origin + "/" }
      : { email: values.get("email").trim(), password: values.get("password"), rememberMe: form.elements.namedItem("rememberMe")?.checked === true };
    const originalText = submitButton?.textContent;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = kind === "signup" ? "Creating account…" : "Signing in…";
    }
    setStatus(status, kind === "signup" ? "Creating your account securely…" : "Checking your details…", "pending");

    try {
      const path = kind === "signup" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
      const { response, payload: result } = await apiRequest(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        let message = "We couldn't complete that request. Please try again.";
        if (response.status === 429) message = "Too many attempts. Please wait a little before trying again.";
        else if (kind === "login" && response.status < 500) message = "We couldn't sign you in. Check your email and password, then try again.";
        else if (kind === "signup" && response.status === 409) message = "An account with that email may already exist. Try logging in.";
        else if (typeof result.message === "string" && response.status < 500) message = result.message;
        else if (typeof result.error?.message === "string" && response.status < 500) message = result.error.message;
        throw new Error(message);
      }

      if (kind === "signup") {
        const { response: sessionResponse } = await apiRequest("/api/me");
        if (!sessionResponse.ok) {
          password.value = "";
          if (confirmation) confirmation.value = "";
          setStatus(status, "Your account request was accepted. Check your email for a verification link, then log in.", "success");
          return;
        }
      }

      setStatus(status, kind === "signup" ? "Your account is ready. Taking you to your profile…" : "You're signed in. Taking you to your account…", "success");
      const requestedPage = new URLSearchParams(window.location.search).get("next");
      window.location.assign(getSafeNextPage(requestedPage));
    } catch (error) {
      setStatus(status, error instanceof TypeError
        ? "We couldn't reach the account service. Your details are still here; please try again."
        : error.message, "error");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
      }
    }
  });
});

const accountPage = document.querySelector("[data-account-page]");
if (accountPage) {
  const accountStatus = accountPage.querySelector("[data-account-status]");
  const accountPanel = accountPage.querySelector("[data-account-panel]");
  const profileForm = accountPage.querySelector("[data-profile-form]");
  const profileStatus = accountPage.querySelector("[data-profile-status]");
  const logoutButton = accountPage.querySelector("[data-logout]");

  const loadAccount = async () => {
    setStatus(accountStatus, "Checking your secure session…", "pending");
    try {
      const { response: sessionResponse, payload: sessionData } = await apiRequest("/api/me");
      if (sessionResponse.status === 401) {
        window.location.replace("login.html?next=account.html");
        return;
      }
      if (!sessionResponse.ok) throw new Error("We couldn't load your account. Please try again.");

      const { response, payload } = await apiRequest("/api/me/profile");
      if (response.status === 401) {
        window.location.replace("login.html?next=account.html");
        return;
      }
      if (!response.ok) throw new Error(payload.error || "We couldn't load your player profile.");
      const profile = payload.profile;
      accountPage.querySelector("[data-account-email]").textContent = sessionData.user.email;
      profileForm.elements.displayName.value = profile.displayName || "";
      profileForm.elements.location.value = profile.location || "";
      profileForm.elements.biography.value = profile.biography || "";
      accountPanel.hidden = false;
      setStatus(accountStatus, "Your account and player profile are ready.", "success");
    } catch (error) {
      setStatus(accountStatus, error instanceof TypeError
        ? "We couldn't reach the account service. Check your connection and try again."
        : error.message, "error");
      const retry = accountPage.querySelector("[data-account-retry]");
      if (retry) retry.hidden = false;
    }
  };

  profileForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!profileForm.reportValidity()) return;
    const button = profileForm.querySelector("[type='submit']");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Saving…";
    setStatus(profileStatus, "Saving your profile…", "pending");
    try {
      const { response, payload } = await apiRequest("/api/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: profileForm.elements.displayName.value,
          location: profileForm.elements.location.value,
          biography: profileForm.elements.biography.value
        })
      });
      if (response.status === 401) {
        window.location.replace("login.html?next=account.html");
        return;
      }
      if (!response.ok) throw new Error(payload.error || "We couldn't save your profile. Please try again.");
      setStatus(profileStatus, "Your player profile has been saved.", "success");
    } catch (error) {
      setStatus(profileStatus, error instanceof TypeError
        ? "We couldn't reach the account service. Your changes are still here; please try again."
        : error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  logoutButton?.addEventListener("click", async () => {
    logoutButton.disabled = true;
    setStatus(accountStatus, "Signing out…", "pending");
    try {
      const { response, payload } = await apiRequest("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      if (!response.ok) throw new Error(payload.message || "We couldn't sign you out. Please try again.");
      window.location.assign("login.html?signed-out=1");
    } catch (error) {
      setStatus(accountStatus, error instanceof TypeError
        ? "We couldn't reach the account service. You are still signed in. Please try again."
        : error.message, "error");
      logoutButton.disabled = false;
    }
  });

  accountPage.querySelector("[data-account-retry]")?.addEventListener("click", () => {
    accountPage.querySelector("[data-account-retry]").hidden = true;
    loadAccount();
  });
  loadAccount();
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const homeLeagueDirectory = document.querySelector("[data-home-league-directory]");
if (homeLeagueDirectory) {
  const homeLeagueStatus = document.querySelector("[data-home-league-status]");
  const emptyState = document.querySelector("[data-home-league-empty]");

  const loadHomeLeagueDirectory = async () => {
    homeLeagueDirectory.replaceChildren();
    if (emptyState) emptyState.hidden = true;
    setStatus(homeLeagueStatus, "Loading public leagues…", "pending");
    try {
      const { response, payload } = await apiRequest("/api/leagues");
      if (!response.ok) throw new Error(payload.error || "We couldn't load public leagues.");
      const leagues = Array.isArray(payload.leagues) ? payload.leagues : [];
      if (!leagues.length) {
        setStatus(homeLeagueStatus, "No public leagues are listed yet.", "success");
        if (emptyState) emptyState.hidden = false;
        return;
      }

      leagues.forEach((league) => {
        const card = createTextElement("article", "league-directory-card");
        const kicker = createTextElement("div", "section-kicker", league.status === "active" ? "ACTIVE LEAGUE" : "OPEN LEAGUE");
        const title = createTextElement("h3", "", league.name);
        const location = createTextElement("p", "league-card-location", league.location || "Location not provided");
        const description = createTextElement("p", "league-card-description", league.description || "The organiser has not added a description yet.");
        const details = createTextElement("div", "league-card-details");
        details.append(
          createTextElement("span", "", league.joinPolicy === "open" ? "Open joining" : "Approval required"),
          createTextElement("span", "", `${league.memberCount || 0} active members`)
        );
        const detailsLink = createTextElement("a", "league-details-link", "Seasons, divisions & teams");
        detailsLink.href = `competition.html?id=${encodeURIComponent(league.id)}`;
        const actionArea = createTextElement("div", "league-card-action");
        const directoryLink = createTextElement("a", "button button-gold", "Open league directory");
        directoryLink.href = "join-league.html#league-directory";
        actionArea.append(directoryLink);
        card.append(kicker, title, location, description, details, detailsLink, actionArea);
        homeLeagueDirectory.append(card);
      });
      setStatus(homeLeagueStatus, `${leagues.length} public ${leagues.length === 1 ? "league" : "leagues"} available.`, "success");
    } catch (error) {
      setStatus(homeLeagueStatus, error instanceof TypeError
        ? "We couldn't reach the league service. Public league listings are unavailable right now."
        : error.message, "error");
    }
  };

  loadHomeLeagueDirectory();
}

function appendLoginLink(container, text, returnPage) {
  container.replaceChildren(document.createTextNode(`${text} `));
  const link = createTextElement("a", "text-link", "Log in");
  link.href = `login.html?next=${encodeURIComponent(returnPage)}`;
  container.append(link);
}

const directoryPage = document.querySelector("[data-league-directory-page]");
if (directoryPage) {
  const directory = directoryPage.querySelector("[data-league-directory]");
  const directoryStatus = directoryPage.querySelector("[data-directory-status]");

  const renderLeagueDirectory = (leagues) => {
    directory.replaceChildren();
    if (!leagues.length) {
      setStatus(directoryStatus, "No public leagues are listed yet. A league organiser can create one from the Create a League page.", "success");
      return;
    }

    leagues.forEach((league) => {
      const card = createTextElement("article", "league-directory-card");
      const kicker = createTextElement("div", "section-kicker", league.status === "active" ? "ACTIVE LEAGUE" : "OPEN LEAGUE");
      const title = createTextElement("h3", "", league.name);
      const detailsLink = createTextElement("a", "league-details-link", "Seasons, divisions & teams");
      detailsLink.href = `competition.html?id=${encodeURIComponent(league.id)}`;
      const location = createTextElement("p", "league-card-location", league.location || "Location not provided");
      const description = createTextElement("p", "league-card-description", league.description || "The organiser has not added a description yet.");
      const details = createTextElement("div", "league-card-details");
      details.append(
        createTextElement("span", "", league.joinPolicy === "open" ? "Open joining" : "Approval required"),
        createTextElement("span", "", `${league.memberCount || 0} active members`)
      );
      const actionArea = createTextElement("div", "league-card-action");
      const membership = league.viewerMembership;
      let buttonLabel = league.joinPolicy === "open" ? "Join league" : "Request to join";
      let terminal = false;
      if (membership?.status === "active") {
        buttonLabel = membership.role === "owner" ? "League owner" : "Joined";
        terminal = true;
      } else if (membership?.status === "pending") {
        buttonLabel = "Request pending";
        terminal = true;
      } else if (membership?.status === "suspended") {
        buttonLabel = "Contact organiser";
        terminal = true;
      }
      const button = createTextElement("button", "button button-gold league-join-button", buttonLabel);
      button.type = "button";
      button.disabled = terminal;
      const cardStatus = createTextElement("p", "league-card-status");
      cardStatus.setAttribute("role", "status");
      if (membership?.status === "declined") cardStatus.textContent = "Your previous request was declined. You can request to join again.";
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = league.joinPolicy === "open" ? "Joining…" : "Sending request…";
        setStatus(cardStatus, "Contacting the league service…", "pending");
        try {
          const { response, payload } = await apiRequest(`/api/leagues/${encodeURIComponent(league.id)}/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          if (response.status === 401) {
            button.textContent = league.joinPolicy === "open" ? "Log in to join" : "Log in to request";
            button.disabled = false;
            appendLoginLink(cardStatus, "Sign in to continue.", "join-league.html");
            return;
          }
          if (!response.ok) throw new Error(payload.error || "We couldn't update your membership. Please try again.");
          league.viewerMembership = payload.membership;
          button.textContent = payload.membership.status === "active" ? "Joined" : "Request pending";
          button.disabled = payload.membership.status === "active" || payload.membership.status === "pending";
          setStatus(cardStatus, payload.membership.status === "active"
            ? "You are now an active league member."
            : "Your request was sent to the league owner or an administrator.", "success");
        } catch (error) {
          button.disabled = false;
          button.textContent = buttonLabel;
          setStatus(cardStatus, error instanceof TypeError
            ? "We couldn't reach the league service. Please try again."
            : error.message, "error");
        }
      });
      actionArea.append(button);
      card.append(kicker, title, detailsLink, location, description, details, actionArea, cardStatus);
      directory.append(card);
    });
    setStatus(directoryStatus, `${leagues.length} public ${leagues.length === 1 ? "league" : "leagues"} available.`, "success");
  };

  const loadDirectory = async () => {
    setStatus(directoryStatus, "Loading public leagues…", "pending");
    try {
      const { response, payload } = await apiRequest("/api/leagues");
      if (!response.ok) throw new Error(payload.error || "We couldn't load public leagues.");
      renderLeagueDirectory(payload.leagues || []);
    } catch (error) {
      setStatus(directoryStatus, error instanceof TypeError
        ? "We couldn't reach the league service. Please try again later."
        : error.message, "error");
    }
  };

  loadDirectory();
}

const createLeagueForm = document.querySelector("[data-league-create-form]");
const leagueManagement = document.querySelector("[data-league-management]");

if (createLeagueForm) {
  const status = createLeagueForm.querySelector("[data-league-create-status]");
  createLeagueForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!createLeagueForm.reportValidity()) return;
    const button = createLeagueForm.querySelector("[type='submit']");
    const originalText = button.innerHTML;
    const fields = new FormData(createLeagueForm);
    button.disabled = true;
    button.textContent = "Creating…";
    setStatus(status, "Creating your league and assigning your owner role…", "pending");
    try {
      const { response, payload } = await apiRequest("/api/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fields.get("name"),
          location: fields.get("location"),
          description: fields.get("description"),
          joinPolicy: fields.get("joinPolicy")
        })
      });
      if (response.status === 401) {
        appendLoginLink(status, "Sign in to create a league.", "create-league.html");
        status.dataset.state = "error";
        return;
      }
      if (!response.ok) throw new Error(payload.error || "We couldn't create the league. Please try again.");
      createLeagueForm.reset();
      setStatus(status, `${payload.league.name} was created. You are its active owner.`, "success");
      await loadLeagueManagement();
    } catch (error) {
      setStatus(status, error instanceof TypeError
        ? "We couldn't reach the league service. Your details are still here; please try again."
        : error.message, "error");
    } finally {
      button.disabled = false;
      button.innerHTML = originalText;
    }
  });
}

async function loadLeagueManagement() {
  if (!leagueManagement) return;
  const status = leagueManagement.querySelector("[data-management-status]");
  const list = leagueManagement.querySelector("[data-managed-leagues]");
  setStatus(status, "Loading your leagues…", "pending");
  list.replaceChildren();
  try {
    const { response, payload } = await apiRequest("/api/me/leagues");
    if (response.status === 401) {
      appendLoginLink(status, "Sign in to see and manage your leagues.", "create-league.html");
      status.dataset.state = "error";
      return;
    }
    if (!response.ok) throw new Error(payload.error || "We couldn't load your leagues.");
    const leagues = payload.leagues || [];
    if (!leagues.length) {
      setStatus(status, "You do not have an active league membership yet. Create a league or browse the public directory.", "success");
      return;
    }
    setStatus(status, `${leagues.length} league ${leagues.length === 1 ? "membership" : "memberships"} found.`, "success");

    for (const league of leagues) {
      const card = createTextElement("article", "managed-league-card");
      const header = createTextElement("div", "managed-league-header");
      const titleBlock = document.createElement("div");
      titleBlock.append(createTextElement("h3", "", league.name), createTextElement("p", "", `${league.location || "Location not provided"} · ${league.viewerMembership?.role || "member"}`));
      header.append(titleBlock, createTextElement("span", "demo-tag", league.joinPolicy === "open" ? "OPEN JOINING" : "APPROVAL REQUIRED"));
      card.append(header);
      const competitionLink = createTextElement("a", "text-link", "Manage seasons, divisions & teams ↗");
      competitionLink.href = `competition.html?id=${encodeURIComponent(league.id)}`;
      card.append(competitionLink);
      if (["owner", "administrator"].includes(league.viewerMembership?.role)) {
        const [requestResult, memberResult] = await Promise.all([
          apiRequest(`/api/leagues/${encodeURIComponent(league.id)}/requests`),
          apiRequest(`/api/leagues/${encodeURIComponent(league.id)}/members`)
        ]);
        if (!requestResult.response.ok || !memberResult.response.ok) {
          card.append(createTextElement("p", "form-status", "Membership tools could not be loaded. Refresh and try again."));
        } else {
          const requestsSection = createTextElement("section", "management-subsection");
          requestsSection.append(createTextElement("h4", "", "Join requests"));
          const requests = requestResult.payload.requests || [];
          if (!requests.length) requestsSection.append(createTextElement("p", "management-empty", "No requests are waiting for review."));
          requests.forEach((request) => {
            const row = createTextElement("div", "management-row");
            row.append(createTextElement("span", "", request.displayName || "Player"));
            ["approve", "decline"].forEach((action) => {
              const button = createTextElement("button", action === "approve" ? "button button-gold" : "button button-quiet", action === "approve" ? "Approve" : "Decline");
              button.type = "button";
              button.addEventListener("click", async () => {
                button.disabled = true;
                try {
                  const { response, payload } = await apiRequest(`/api/leagues/${encodeURIComponent(league.id)}/requests/${encodeURIComponent(request.userId)}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action })
                  });
                  if (!response.ok) throw new Error(payload.error || "The request could not be updated.");
                  await loadLeagueManagement();
                } catch (error) {
                  button.disabled = false;
                  setStatus(status, error instanceof TypeError ? "The service is unavailable. Try again." : error.message, "error");
                }
              });
              row.append(button);
            });
            requestsSection.append(row);
          });
          card.append(requestsSection);

          const membersSection = createTextElement("section", "management-subsection");
          membersSection.append(createTextElement("h4", "", "Active members"));
          (memberResult.payload.members || []).forEach((member) => {
            const row = createTextElement("div", "management-row member-management-row");
            row.append(createTextElement("span", "", `${member.displayName || "Player"} · ${member.role}`));
            if (league.viewerMembership?.role === "owner" && member.role !== "owner") {
              const roleSelect = document.createElement("select");
              roleSelect.setAttribute("aria-label", `Role for ${member.displayName || "player"}`);
              [["member", "Member"], ["administrator", "Administrator"]].forEach(([value, label]) => {
                const option = createTextElement("option", "", label);
                option.value = value;
                roleSelect.append(option);
              });
              roleSelect.value = member.role;
              const saveRole = createTextElement("button", "button button-quiet", "Save role");
              saveRole.type = "button";
              saveRole.addEventListener("click", async () => {
                saveRole.disabled = true;
                try {
                  const { response, payload } = await apiRequest(`/api/leagues/${encodeURIComponent(league.id)}/members/${encodeURIComponent(member.userId)}/role`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ role: roleSelect.value })
                  });
                  if (!response.ok) throw new Error(payload.error || "The member role could not be changed.");
                  await loadLeagueManagement();
                } catch (error) {
                  saveRole.disabled = false;
                  setStatus(status, error instanceof TypeError ? "The service is unavailable. Try again." : error.message, "error");
                }
              });
              row.append(roleSelect, saveRole);
            }
            membersSection.append(row);
          });
          card.append(membersSection);
        }
      }
      list.append(card);
    }
  } catch (error) {
    setStatus(status, error instanceof TypeError
      ? "We couldn't reach the league service. Try again later."
      : error.message, "error");
  }
}

if (leagueManagement) loadLeagueManagement();

const competitionPage = document.querySelector("[data-competition-page]");
if (competitionPage) {
  const status = competitionPage.querySelector("[data-competition-status]");
  const seasonsContainer = competitionPage.querySelector("[data-season-list]");
  const title = competitionPage.querySelector("[data-competition-title]");
  const description = competitionPage.querySelector("[data-competition-description]");
  const leagueId = new URLSearchParams(window.location.search).get("id");

  const addField = (form, labelText, name, type = "text", options = {}) => {
    const wrapper = createTextElement("div", "competition-field");
    const id = `competition-${name}-${Math.random().toString(36).slice(2, 8)}`;
    const label = createTextElement("label", "", labelText);
    label.htmlFor = id;
    let control;
    if (type === "select") {
      control = document.createElement("select");
      (options.choices || []).forEach(([value, text]) => {
        const option = createTextElement("option", "", text);
        option.value = value;
        control.append(option);
      });
    } else {
      control = document.createElement("input");
      control.type = type;
      if (options.maxLength) control.maxLength = options.maxLength;
      if (options.placeholder) control.placeholder = options.placeholder;
    }
    control.id = id;
    control.name = name;
    if (options.required) control.required = true;
    if (options.value !== undefined && options.value !== null) control.value = options.value;
    wrapper.append(label, control);
    form.append(wrapper);
    return control;
  };

  const makeForm = (className, heading) => {
    const form = createTextElement("form", className);
    form.append(createTextElement("h4", "", heading));
    return form;
  };

  const makeButton = (text, className = "button button-gold") => {
    const button = createTextElement("button", className, text);
    button.type = "submit";
    return button;
  };

  const statusElement = (text = "") => {
    const element = createTextElement("p", "form-status competition-feedback", text);
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
    return element;
  };

  const wireForm = (form, action, successText) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector("[type='submit']");
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Saving…";
      const feedback = form.querySelector(".competition-feedback");
      setStatus(feedback, "Saving your changes…", "pending");
      try {
        const payload = await action(new FormData(form));
        if (payload) setStatus(feedback, successText, "success");
        await loadCompetition();
        if (payload && feedback.isConnected) setStatus(feedback, successText, "success");
      } catch (error) {
        setStatus(feedback, error instanceof TypeError
          ? "We couldn't reach the league service. Your entries are still here; please try again."
          : error.message, "error");
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    });
  };

  const request = async (path, options = {}) => {
    const { response, payload } = await apiRequest(path, options);
    if (!response.ok) {
      if (response.status === 401) throw new Error("Sign in with an active league account to continue.");
      throw new Error(payload.error || "We couldn't save that change. Please try again.");
    }
    return payload;
  };

  const addSeasonActions = (season, isManager) => {
    const panel = createTextElement("div", "season-management");
    const dateOptions = [
      { name: "startsOn", label: "Start date", value: season.startsOn || "" },
      { name: "endsOn", label: "End date", value: season.endsOn || "" }
    ];

    if (isManager && season.status === "draft") {
      const editForm = makeForm("competition-form season-edit-form", "Edit draft season");
      addField(editForm, "Season name", "name", "text", { value: season.name, maxLength: 120, required: true });
      dateOptions.forEach(({ name, label, value }) => addField(editForm, label, name, "date", { value }));
      editForm.append(makeButton("Save season details"), statusElement());
      wireForm(editForm, async (data) => {
        const payload = Object.fromEntries(data.entries());
        return request(`/api/seasons/${encodeURIComponent(season.id)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
      }, "Season details saved.");
      panel.append(editForm);
    }

    if (isManager && season.status !== "completed") {
      const transition = season.status === "draft" ? "active" : "completed";
      const form = makeForm("competition-form status-transition-form", "Season status");
      form.append(createTextElement("p", "management-help", season.status === "draft"
        ? "Activate when divisions and initial teams are ready. Season details and division structure then become read-only."
        : "Completing this season preserves its records and makes its teams and roster read-only."));
      const button = makeButton(season.status === "draft" ? "Activate season" : "Complete season");
      form.append(button, statusElement());
      wireForm(form, () => request(`/api/seasons/${encodeURIComponent(season.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: transition })
      }), `Season marked ${transition}.`);
      panel.append(form);
    }

    if (isManager && season.status === "draft") {
      const divisionForm = makeForm("competition-form division-create-form", "Add a division");
      addField(divisionForm, "Division name", "name", "text", { maxLength: 100, required: true, placeholder: "e.g. Premier Division" });
      divisionForm.append(makeButton("Create division"), statusElement());
      wireForm(divisionForm, async (data) => request(`/api/seasons/${encodeURIComponent(season.id)}/divisions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: data.get("name") })
      }), "Division created.");
      panel.append(divisionForm);
    }

    if (isManager && season.status !== "completed") {
      const divisionChoices = [["", "No division"]];
      season.divisions.forEach((division) => divisionChoices.push([division.id, division.name]));
      const teamForm = makeForm("competition-form team-create-form", "Add a team");
      addField(teamForm, "Team name", "name", "text", { maxLength: 120, required: true, placeholder: "Team name" });
      addField(teamForm, "Home venue (optional)", "homeVenue", "text", { maxLength: 160, placeholder: "Venue name" });
      addField(teamForm, "Division (optional)", "divisionId", "select", { choices: divisionChoices });
      teamForm.append(makeButton("Create team"), statusElement());
      wireForm(teamForm, async (data) => request(`/api/seasons/${encodeURIComponent(season.id)}/teams`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.get("name"), homeVenue: data.get("homeVenue"), divisionId: data.get("divisionId") || null })
      }), "Team created.");
      panel.append(teamForm);
    }
    return panel;
  };

  const renderTeamCard = async (team, season, isManager) => {
    const card = createTextElement("article", "competition-team-card");
    const header = createTextElement("div", "competition-team-header");
    const titleBlock = document.createElement("div");
    titleBlock.append(createTextElement("h4", "", team.name), createTextElement("p", "", team.homeVenue || "Home venue not listed"));
    header.append(titleBlock, createTextElement("span", team.status === "active" ? "demo-tag" : "demo-tag team-inactive-tag", team.status === "active" ? "ACTIVE" : "INACTIVE"));
    card.append(header, createTextElement("p", "team-roster-count", `${team.memberCount} ${team.memberCount === 1 ? "player" : "players"}${team.viewerRole === "captain" ? " · Your team" : ""}`));

    const roster = createTextElement("ul", "team-roster-list");
    if (!team.members.length) roster.append(createTextElement("li", "management-empty", "No players have been added to this team."));
    team.members.forEach((member) => {
      const row = createTextElement("li", "team-roster-row");
      row.append(createTextElement("span", "", `${member.displayName}${member.role === "captain" ? " · Captain" : ""}`));
      const mayRemove = team.canManageRoster && (isManager || member.role !== "captain");
      if (mayRemove && member.userId && season.status !== "completed" && team.status === "active") {
        const remove = createTextElement("button", "button button-quiet button-compact", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${member.displayName} from ${team.name}`);
        remove.addEventListener("click", () => runTeamMutation(remove, async () => {
          await request(`/api/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.userId)}`, { method: "DELETE" });
        }, "Player removed from the roster."));
        row.append(remove);
      }
      roster.append(row);
    });
    card.append(roster);

    if (isManager && season.status !== "completed") {
      const edit = makeForm("competition-form team-edit-form", "Team settings");
      if (season.status === "draft") addField(edit, "Team name", "name", "text", { value: team.name, maxLength: 120, required: true });
      addField(edit, "Home venue", "homeVenue", "text", { value: team.homeVenue || "", maxLength: 160 });
      if (season.status === "draft") {
        const divisionChoices = [["", "No division"]];
        season.divisions.forEach((division) => divisionChoices.push([division.id, division.name]));
        addField(edit, "Division", "divisionId", "select", { choices: divisionChoices, value: team.divisionId || "" });
      }
      addField(edit, "Team status", "status", "select", { choices: [["active", "Active"], ["inactive", "Inactive"]], value: team.status });
      edit.append(makeButton("Save team settings", "button button-quiet"), statusElement());
      wireForm(edit, async (data) => {
        const payload = Object.fromEntries(data.entries());
        if (Object.hasOwn(payload, "divisionId")) payload.divisionId = payload.divisionId || null;
        payload.homeVenue = payload.homeVenue || null;
        return request(`/api/teams/${encodeURIComponent(team.id)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
      }, "Team settings saved.");
      card.append(edit);
    }

    if (team.canManageRoster && season.status !== "completed" && team.status === "active") {
      const rosterManagement = createTextElement("div", "roster-management");
      const feedback = statusElement("Loading eligible players…");
      rosterManagement.append(
        createTextElement("h5", "", "Roster tools"),
        createTextElement("p", "roster-signing-rule", "Teams may accept three signings after the season starts. Returns and transfers count toward the limit."),
        feedback
      );
      try {
        const { response, payload } = await apiRequest(`/api/teams/${encodeURIComponent(team.id)}/eligible-players`);
        if (!response.ok) throw new Error(payload.error || "Eligible players could not be loaded.");
        const players = payload.players || [];
        const available = players.filter((player) => !player.registeredTeamId);
        const addForm = makeForm("competition-form roster-add-form", "Add an active league member");
        addField(addForm, "Player", "userId", "select", {
          required: true,
          choices: available.length ? available.map((player) => [player.id, player.displayName]) : [["", "No eligible players available"]]
        });
        const addButton = makeButton("Add to roster");
        addButton.disabled = !available.length;
        addForm.append(addButton, statusElement());
        wireForm(addForm, async (data) => request(`/api/teams/${encodeURIComponent(team.id)}/members`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: data.get("userId") })
        }), "Player added to the roster.");
        rosterManagement.replaceChildren(
          createTextElement("h5", "", "Roster tools"),
          createTextElement("p", "roster-signing-rule", "Teams may accept three signings after the season starts. Returns and transfers count toward the limit."),
          addForm
        );

        if (isManager) {
          const transferable = players.filter((player) => player.registeredTeamId && player.registeredTeamId !== team.id);
          const transferForm = makeForm("competition-form roster-transfer-form", "Transfer a player from another team");
          addField(transferForm, "Player", "userId", "select", {
            required: true,
            choices: transferable.length ? transferable.map((player) => [player.id, `${player.displayName} · ${player.registeredTeamName}`]) : [["", "No players are registered elsewhere"]]
          });
          addField(transferForm, "Reason (optional)", "reason", "text", { maxLength: 500, placeholder: "Transfer note" });
          const transferButton = makeButton("Complete transfer");
          transferButton.disabled = !transferable.length;
          transferForm.append(transferButton, statusElement());
          wireForm(transferForm, async (data) => request(`/api/teams/${encodeURIComponent(team.id)}/transfers`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: data.get("userId"), reason: data.get("reason") })
          }), "Player transferred to this team.");
          rosterManagement.append(transferForm);

          const rosterPlayers = players.filter((player) => player.onTeam);
          const captainForm = makeForm("competition-form captain-form", "Assign team captain");
          addField(captainForm, "Active roster member", "userId", "select", {
            required: true,
            choices: rosterPlayers.length ? rosterPlayers.map((player) => [player.id, player.displayName]) : [["", "Add a player first"]]
          });
          const assign = makeButton("Save captain");
          assign.disabled = !rosterPlayers.length;
          captainForm.append(assign, statusElement());
          wireForm(captainForm, async (data) => request(`/api/teams/${encodeURIComponent(team.id)}/captain`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: data.get("userId") })
          }), "Team captain updated.");
          rosterManagement.append(captainForm);
          if (team.members.some((member) => member.role === "captain")) {
            const removeCaptain = createTextElement("button", "button button-quiet button-compact", "Remove captain assignment");
            removeCaptain.type = "button";
            removeCaptain.addEventListener("click", () => runTeamMutation(removeCaptain, async () => {
              await request(`/api/teams/${encodeURIComponent(team.id)}/captain`, { method: "DELETE" });
            }, "Captain assignment removed."));
            rosterManagement.append(removeCaptain);
          }
        }

        if (isManager) {
          const history = document.createElement("details");
          history.className = "roster-signing-history";
          const summary = document.createElement("summary");
          summary.textContent = "Signing history";
          history.append(summary);
          const historyStatus = statusElement("Open to load this team’s signing history.");
          history.append(historyStatus);
          history.addEventListener("toggle", async () => {
            if (!history.open || history.dataset.loaded === "true") return;
            setStatus(historyStatus, "Loading signing history…", "pending");
            try {
              const { response, payload } = await apiRequest(`/api/teams/${encodeURIComponent(team.id)}/signing-history`);
              if (!response.ok) throw new Error(payload.error || "Signing history could not be loaded.");
              const events = payload.events || [];
              if (!events.length) setStatus(historyStatus, "No signing history recorded for this team yet.", "success");
              else {
                const list = document.createElement("ul");
                list.className = "team-signing-history-list";
                events.forEach((event) => {
                  const row = document.createElement("li");
                  const labels = { signed: `Signed · ${event.signing_type?.replaceAll("_", " ") || "legacy"}`, transferred_out: "Transferred out", removed: "Removed", season_closed: "Season completed", legacy_closure: "Previous roster ended" };
                  row.append(createTextElement("strong", "", `${event.player_name} · ${labels[event.event_type] || event.event_type}`));
                  const detail = [new Date(event.occurred_at).toLocaleString(), event.authorized_by_name && `Authorised by ${event.authorized_by_name}`, event.reason].filter(Boolean).join(" · ");
                  row.append(createTextElement("span", "", detail));
                  list.append(row);
                });
                historyStatus.replaceWith(list);
              }
              history.dataset.loaded = "true";
            } catch (error) {
              setStatus(historyStatus, error instanceof TypeError ? "Signing history is unavailable right now." : error.message, "error");
            }
          });
          rosterManagement.append(history);
        }
      } catch (error) {
        setStatus(feedback, error instanceof TypeError ? "Roster tools are unavailable right now." : error.message, "error");
      }
      card.append(rosterManagement);
    }
    return card;
  };

  async function runTeamMutation(button, action, successText) {
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Saving…";
    setStatus(status, "Saving roster changes…", "pending");
    try {
      await action();
      await loadCompetition();
      setStatus(status, successText, "success");
    } catch (error) {
      setStatus(status, error instanceof TypeError ? "We couldn't reach the league service. Try again." : error.message, "error");
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  const renderCompetition = async (competition) => {
    title.replaceChildren(document.createTextNode(competition.league.name));
    title.classList.add("competition-title");
    description.textContent = [competition.league.location, competition.league.description].filter(Boolean).join(" · ") || "Season and team information published by this league's organisers.";
    seasonsContainer.replaceChildren();
    const isManager = ["owner", "administrator"].includes(competition.viewerRole);
    if (!competition.seasons.length) {
      setStatus(status, isManager ? "No seasons yet. Create a draft season to begin organising divisions and teams." : "No public seasons have been published yet.", "success");
      if (isManager) {
        const createSeasonForm = makeForm("competition-form season-create-form", "Create a season");
        addField(createSeasonForm, "Season name", "name", "text", { maxLength: 120, required: true, placeholder: "e.g. 2026–27 Season" });
        addField(createSeasonForm, "Start date (optional)", "startsOn", "date");
        addField(createSeasonForm, "End date (optional)", "endsOn", "date");
        createSeasonForm.append(makeButton("Create draft season"), statusElement());
        wireForm(createSeasonForm, async (data) => request(`/api/leagues/${encodeURIComponent(competition.league.id)}/seasons`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: data.get("name"), startsOn: data.get("startsOn") || null, endsOn: data.get("endsOn") || null })
        }), "Draft season created.");
        seasonsContainer.append(createSeasonForm);
      }
      return;
    }
    setStatus(status, `${competition.seasons.length} ${competition.seasons.length === 1 ? "season" : "seasons"} listed.`, "success");
    if (isManager) {
      const createSeasonForm = makeForm("competition-form season-create-form", "Create another season");
      addField(createSeasonForm, "Season name", "name", "text", { maxLength: 120, required: true, placeholder: "Season name" });
      addField(createSeasonForm, "Start date (optional)", "startsOn", "date");
      addField(createSeasonForm, "End date (optional)", "endsOn", "date");
      createSeasonForm.append(makeButton("Create draft season"), statusElement());
      wireForm(createSeasonForm, async (data) => request(`/api/leagues/${encodeURIComponent(competition.league.id)}/seasons`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.get("name"), startsOn: data.get("startsOn") || null, endsOn: data.get("endsOn") || null })
      }), "Draft season created.");
      seasonsContainer.append(createSeasonForm);
    }

    for (const season of competition.seasons) {
      const seasonCard = createTextElement("article", "season-card");
      const seasonHeader = createTextElement("div", "season-header");
      const seasonTitle = document.createElement("div");
      seasonTitle.append(createTextElement("div", "section-kicker", `SEASON / ${season.status.toUpperCase()}`), createTextElement("h3", "", season.name));
      const dates = [season.startsOn, season.endsOn].filter(Boolean).join(" — ") || "Dates to be confirmed";
      seasonHeader.append(seasonTitle, createTextElement("span", "demo-tag", dates));
      seasonCard.append(seasonHeader);
      if (isManager) seasonCard.append(addSeasonActions(season, isManager));

      for (const division of season.divisions) {
        const divisionBlock = createTextElement("section", "competition-division");
        const divisionHeader = createTextElement("div", "division-header");
        divisionHeader.append(createTextElement("h4", "", division.name));
        if (isManager && season.status === "draft") {
          const rename = createTextElement("button", "button button-quiet button-compact", "Rename");
          rename.type = "button";
          rename.addEventListener("click", async () => {
            const nextName = window.prompt("New division name", division.name);
            if (nextName === null) return;
            try {
              await request(`/api/divisions/${encodeURIComponent(division.id)}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nextName })
              });
              await loadCompetition();
            } catch (error) {
              setStatus(status, error instanceof TypeError ? "We couldn't reach the league service." : error.message, "error");
            }
          });
          divisionHeader.append(rename);
        }
        divisionBlock.append(divisionHeader);
        const teamGrid = createTextElement("div", "competition-team-grid");
        if (!division.teams.length) teamGrid.append(createTextElement("p", "management-empty", "No teams are assigned to this division yet."));
        for (const team of division.teams) teamGrid.append(await renderTeamCard(team, season, isManager));
        divisionBlock.append(teamGrid);
        seasonCard.append(divisionBlock);
      }

      const unassignedBlock = createTextElement("section", "competition-division unassigned-teams");
      unassignedBlock.append(createTextElement("h4", "", season.divisions.length ? "Without a division" : "Teams"));
      const unassignedGrid = createTextElement("div", "competition-team-grid");
      if (!season.teams.length) unassignedGrid.append(createTextElement("p", "management-empty", "No teams are listed here yet."));
      for (const team of season.teams) unassignedGrid.append(await renderTeamCard(team, season, isManager));
      unassignedBlock.append(unassignedGrid);
      seasonCard.append(unassignedBlock);
      seasonsContainer.append(seasonCard);
    }
  };

  async function loadCompetition() {
    seasonsContainer.replaceChildren();
    if (!leagueId) {
      setStatus(status, "A league ID is missing. Return to the public league directory and choose a league.", "error");
      return;
    }
    setStatus(status, "Loading seasons, divisions and teams…", "pending");
    try {
      const { response, payload } = await apiRequest(`/api/leagues/${encodeURIComponent(leagueId)}/competition`);
      if (!response.ok) throw new Error(payload.error || "We couldn't load this league's competition structure.");
      await renderCompetition(payload.competition);
    } catch (error) {
      setStatus(status, error instanceof TypeError
        ? "We couldn't reach the league service. Please try again later."
        : error.message, "error");
    }
  }

  loadCompetition();
}
