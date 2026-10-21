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

  document.addEventListener("pointerdown", (event) => {
    if (menuButton.getAttribute("aria-expanded") !== "true") return;
    if (nav.contains(event.target) || menuButton.contains(event.target)) return;
    nav.classList.remove("is-open");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation");
  });

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      nav.classList.remove("is-open");
      menuButton.setAttribute("aria-expanded", "false");
      menuButton.setAttribute("aria-label", "Open navigation");
    }
  });
}

if (nav) {
  nav.querySelectorAll("details[data-nav-dropdown]").forEach((dropdown) => {
    const summary = dropdown.querySelector("summary");
    const syncExpanded = () => summary?.setAttribute("aria-expanded", String(dropdown.open));
    syncExpanded();
    dropdown.addEventListener("toggle", syncExpanded);
    dropdown.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && dropdown.open) {
        dropdown.open = false;
        summary?.focus();
      } else if (event.key === "ArrowDown" && dropdown.open) {
        const firstLink = dropdown.querySelector(".nav-dropdown-menu a");
        if (firstLink) {
          event.preventDefault();
          firstLink.focus();
        }
      }
    });
  });

  document.addEventListener("pointerdown", (event) => {
    nav.querySelectorAll("details[data-nav-dropdown][open]").forEach((dropdown) => {
      if (!dropdown.contains(event.target)) dropdown.open = false;
    });
  });

  nav.addEventListener("click", (event) => {
    if (!event.target.closest("a")) return;
    nav.querySelectorAll("details[data-nav-dropdown][open]").forEach((dropdown) => { dropdown.open = false; });
    nav.classList.remove("is-open");
    menuButton?.setAttribute("aria-expanded", "false");
    menuButton?.setAttribute("aria-label", "Open navigation");
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

window.BreakDishApi = Object.freeze({ request: apiRequest });

function getSafeNextPage(candidate) {
  const fallback = "account.html";
  if (typeof candidate !== "string" || !candidate.trim()) return fallback;

  try {
    const destination = new URL(candidate, window.location.href);
    const page = destination.pathname.split("/").pop();
    const allowedPages = new Set(["account.html", "join-league.html", "create-league.html", "competition.html", "my-leagues.html", "admin.html"]);
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
  const loginLink = accountActions.querySelector('a[href="login.html"]');
  const signupLink = accountActions.querySelector('a[href="signup.html"]');
  const adminLink = navigation.querySelector("[data-nav-admin]");
  const mobileAccountSection = navigation.querySelector("[data-nav-account-section]");
  const mobileAccountLink = navigation.querySelector("[data-nav-mobile-account]");

  try {
    const { response } = await apiRequest("/api/me");
    const signedIn = response.ok;
    if (loginLink) loginLink.hidden = signedIn;
    if (signupLink) signupLink.hidden = signedIn;
    if (mobileAccountSection) mobileAccountSection.hidden = !signedIn;
    if (mobileAccountLink && window.location.pathname.endsWith("/account.html")) mobileAccountLink.setAttribute("aria-current", "page");
    else mobileAccountLink?.removeAttribute("aria-current");

    if (signedIn) {
      let adminAvailable = false;
      try {
        const managedResult = await apiRequest("/api/me/managed-leagues");
        adminAvailable = managedResult.response.ok && Array.isArray(managedResult.payload.leagues) && managedResult.payload.leagues.length > 0;
      } catch {
        adminAvailable = false;
      }
      if (adminLink) adminLink.hidden = !adminAvailable;
    } else if (adminLink) {
      adminLink.hidden = true;
    }

    let accountLink = accountActions.querySelector("[data-nav-account]");
    if (signedIn && !accountLink) {
      accountLink = createTextElement("a", "header-login", "My Account");
      accountLink.href = "account.html";
      accountLink.dataset.navAccount = "";
      if (window.location.pathname.endsWith("/account.html")) accountLink.setAttribute("aria-current", "page");
      accountActions.insertBefore(accountLink, loginLink || accountActions.firstChild);
    }
    if (accountLink) accountLink.hidden = !signedIn;
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
    const { response, payload } = await apiRequest("/api/me/managed-leagues");
    if (response.status === 401) {
      appendLoginLink(status, "Sign in to see and manage your leagues.", "create-league.html");
      status.dataset.state = "error";
      return;
    }
    if (!response.ok) throw new Error(payload.error || "We couldn't load your leagues.");
    const managedLeagues = payload.leagues || [];
    const requestedLeagueId = new URLSearchParams(window.location.search).get("manage");
    if (requestedLeagueId && !managedLeagues.some((league) => league.id === requestedLeagueId)) {
      setStatus(status, "You do not have owner or administrator access to that league.", "error");
      return;
    }
    const leagues = requestedLeagueId
      ? managedLeagues.filter((league) => league.id === requestedLeagueId)
      : managedLeagues;
    if (!leagues.length) {
      setStatus(status, "You do not manage any active leagues yet. Create a league or ask an owner to grant administrator access.", "success");
      return;
    }
    setStatus(status, `${leagues.length} managed ${leagues.length === 1 ? "league" : "leagues"} found.`, "success");

    for (const league of leagues) {
      const card = createTextElement("article", "managed-league-card");
      const header = createTextElement("div", "managed-league-header");
      const titleBlock = document.createElement("div");
      const role = league.viewerMembership?.role;
      const roleLabel = role === "owner" ? "Owner" : "Administrator";
      titleBlock.append(createTextElement("h3", "", league.name), createTextElement("p", "", `${league.location || "Location not provided"} · ${roleLabel}`));
      header.append(titleBlock, createTextElement("span", "demo-tag", league.joinPolicy === "open" ? "OPEN JOINING" : "APPROVAL REQUIRED"));
      card.append(header);
      const competitionLink = createTextElement("a", "text-link", "Manage seasons, divisions, teams & fixtures ↗");
      competitionLink.href = `competition.html?id=${encodeURIComponent(league.id)}`;
      card.append(competitionLink);
      if (["owner", "administrator"].includes(role)) {
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
            if (role === "owner" && member.role !== "owner") {
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

function createLeagueContextCard(league, context) {
  const card = createTextElement("article", "league-context-card");
  const top = createTextElement("div", "league-context-card-top");
  top.append(
    createTextElement("h3", "", league.name),
    createTextElement("p", "", league.location || "Location not provided")
  );
  card.append(top);

  const roles = createTextElement("div", "league-context-role");
  if (context === "member") {
    if (league.viewerIsPlayer) roles.append(createTextElement("span", "", "Player"));
    const role = league.viewerMembership?.role;
    const roleLabel = role === "owner" ? "Owner" : role === "administrator" ? "Administrator" : "Member";
    roles.append(createTextElement("span", "", roleLabel));
  } else {
    const roleLabel = league.viewerMembership?.role === "owner" ? "Owner" : "Administrator";
    roles.append(createTextElement("span", "", roleLabel));
  }
  card.append(roles);

  const seasonMessage = league.currentSeason
    ? `${league.currentSeason.name} · ${league.currentSeason.status.charAt(0).toUpperCase()}${league.currentSeason.status.slice(1)}`
    : "No season has been set up yet.";
  card.append(createTextElement("p", "league-context-status", seasonMessage));
  return card;
}

function addLeagueContextAction(container, label, href, style = "button button-quiet") {
  const link = createTextElement("a", style, label);
  link.href = href;
  container.append(link);
  return link;
}

const myLeaguesPage = document.querySelector("[data-my-leagues-page]");
if (myLeaguesPage) {
  const status = myLeaguesPage.querySelector("[data-my-leagues-status]");
  const list = myLeaguesPage.querySelector("[data-my-leagues-list]");
  (async () => {
    setStatus(status, "Loading leagues you participate in…", "pending");
    try {
      const { response, payload } = await apiRequest("/api/me/leagues");
      if (response.status === 401) {
        appendLoginLink(status, "Sign in to view My Leagues.", "my-leagues.html");
        status.dataset.state = "error";
        return;
      }
      if (!response.ok) throw new Error(payload.error || "We couldn't load your leagues.");
      const leagues = Array.isArray(payload.leagues) ? payload.leagues : [];
      list.replaceChildren();
      if (!leagues.length) {
        setStatus(status, "No active league memberships or player entries are linked to this account yet. Browse public leagues to get started.", "success");
        return;
      }
      for (const league of leagues) {
        const card = createLeagueContextCard(league, "member");
        const actions = createTextElement("div", "league-context-actions");
        addLeagueContextAction(actions, "League details & fixtures", `competition.html?id=${encodeURIComponent(league.id)}`, "button button-gold");
        addLeagueContextAction(actions, "Fixtures & results", `match.html?leagueId=${encodeURIComponent(league.id)}`);
        card.append(actions);
        list.append(card);
      }
      setStatus(status, `${leagues.length} participating ${leagues.length === 1 ? "league" : "leagues"}.`, "success");
    } catch (error) {
      setStatus(status, error instanceof TypeError ? "We couldn't reach the league service. Try again later." : error.message, "error");
    }
  })();
}

const adminPage = document.querySelector("[data-admin-page]");
if (adminPage) {
  const status = adminPage.querySelector("[data-admin-status]");
  const list = adminPage.querySelector("[data-admin-league-list]");
  (async () => {
    setStatus(status, "Loading leagues you manage…", "pending");
    try {
      const { response, payload } = await apiRequest("/api/me/managed-leagues");
      if (response.status === 401) {
        appendLoginLink(status, "Sign in to open the Admin Control Centre.", "admin.html");
        status.dataset.state = "error";
        return;
      }
      if (!response.ok) throw new Error(payload.error || "We couldn't load the Admin Control Centre.");
      const leagues = Array.isArray(payload.leagues) ? payload.leagues : [];
      list.replaceChildren();
      if (!leagues.length) {
        setStatus(status, "No active owner or administrator access is linked to this account. Team captaincy alone does not grant league-wide Admin access.", "success");
        return;
      }
      for (const league of leagues) {
        const card = createLeagueContextCard(league, "admin");
        const actions = createTextElement("div", "league-context-actions league-context-admin-actions");
        const role = league.viewerMembership?.role;
        const memberLabel = role === "owner" ? "Manage members & admin roles" : "Review members & join requests";
        addLeagueContextAction(actions, memberLabel, `create-league.html?manage=${encodeURIComponent(league.id)}#league-management`, "button button-quiet");
        addLeagueContextAction(actions, "Manage seasons, divisions, teams & fixtures", `competition.html?id=${encodeURIComponent(league.id)}`, "button button-gold");
        card.append(actions);
        list.append(card);
      }
      setStatus(status, `${leagues.length} managed ${leagues.length === 1 ? "league" : "leagues"}.`, "success");
    } catch (error) {
      setStatus(status, error instanceof TypeError ? "We couldn't reach the league service. Try again later." : error.message, "error");
    }
  })();
}

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

  const matchTypeLabels = { team_league: "Team League", singles_league: "Singles League", doubles_league: "Doubles League" };
  const sideLabel = (match, side) => side === 1
    ? match.homeTeam || match.homeSideName || "Home"
    : match.awayTeam || match.awaySideName || "Away";

  const maxRaceTo = 250;
  const maxFramePatternLength = 99;
  const compactFramePattern = (frames) => {
    const types = (Array.isArray(frames) ? frames : []).map((frame) => frame.type ?? frame.frameType);
    if (!types.length) return [{ type: "singles" }];
    for (let length = 1; length <= Math.min(maxFramePatternLength, types.length); length += 1) {
      if (types.every((type, index) => type === types[index % length])) {
        return types.slice(0, length).map((type) => ({ type }));
      }
    }
    if (types.length > maxFramePatternLength) {
      throw new Error("This long format has no supported compact repeating pattern and cannot be safely edited here.");
    }
    return types.map((type) => ({ type }));
  };

  const createFrameEditor = (initialFrames = []) => {
    const list = createTextElement("div", "format-frame-list");
    const addFrame = (type = "singles") => {
      if (list.children.length >= maxFramePatternLength) return false;
      const row = createTextElement("div", "format-frame-row");
      const number = createTextElement("strong", "format-frame-number", `Pattern step ${list.children.length + 1}`);
      const field = createTextElement("label", "competition-field format-frame-type");
      field.append(createTextElement("span", "", "Frame type"));
      const select = document.createElement("select");
      select.dataset.frameType = "true";
      for (const [value, label] of [["singles", "Singles"], ["doubles", "Doubles"]]) {
        const option = createTextElement("option", "", label);
        option.value = value;
        select.append(option);
      }
      select.value = type;
      field.append(select);
      const controls = createTextElement("div", "format-frame-controls");
      const moveUp = createTextElement("button", "button button-quiet button-compact", "Move up");
      moveUp.type = "button";
      moveUp.addEventListener("click", () => {
        const previous = row.previousElementSibling;
        if (previous) list.insertBefore(row, previous);
        updateNumbers();
      });
      const moveDown = createTextElement("button", "button button-quiet button-compact", "Move down");
      moveDown.type = "button";
      moveDown.addEventListener("click", () => {
        const next = row.nextElementSibling;
        if (next) list.insertBefore(next, row);
        updateNumbers();
      });
      const remove = createTextElement("button", "button button-quiet button-compact", "Remove");
      remove.type = "button";
      remove.addEventListener("click", () => {
        if (list.children.length <= 1) return;
        row.remove();
        updateNumbers();
      });
      controls.append(moveUp, moveDown, remove);
      row.append(number, field, controls);
      list.append(row);
      updateNumbers();
      return true;
    };
    const updateNumbers = () => {
      Array.from(list.children).forEach((row, index) => {
        row.querySelector(".format-frame-number").textContent = `Pattern step ${index + 1}`;
        row.querySelectorAll("button").forEach((button, buttonIndex) => {
          button.disabled = (buttonIndex === 0 && index === 0)
            || (buttonIndex === 1 && index === list.children.length - 1)
            || (buttonIndex === 2 && list.children.length === 1);
        });
      });
    };
    compactFramePattern(initialFrames).forEach((frame) => addFrame(frame.type));
    return { list, addFrame, getFrames: () => Array.from(list.querySelectorAll("[data-frame-type]")).map((select) => ({ type: select.value })) };
  };

  const renderLeagueFormat = async (competition, isManager) => {
    const panel = createTextElement("section", "competition-match-management");
    panel.append(createTextElement("div", "section-kicker", "MATCH FORMAT"), createTextElement("h3", "", "League default format"));
    let current = null;
    try {
      const { response, payload } = await apiRequest(`/api/leagues/${encodeURIComponent(competition.league.id)}/match-format`);
      if (response.ok) current = payload.format;
      else if (response.status !== 404) throw new Error(payload.error || "The league format could not be loaded.");
    } catch (error) {
      panel.append(statusElement(error instanceof TypeError ? "The match format service is unavailable." : error.message));
      return panel;
    }
    if (current) {
      const pattern = compactFramePattern(current.frames);
      const summary = pattern.map((frame, index) => `${index + 1}. ${frame.type === "singles" ? "Singles" : "Doubles"}`).join(" · ");
      const raceSummary = current.raceTo == null ? " · legacy format; set Race-to before creating new fixtures" : ` · Race to ${current.raceTo}`;
      panel.append(createTextElement("p", "management-help", `${current.name} · version ${current.version}${raceSummary} · frame pattern: ${summary}${current.frames.length > pattern.length ? ` · repeats to ${current.frames.length} possible frames` : ""}`));
    } else {
      panel.append(createTextElement("p", "management-help", "No match format has been configured. Set the ordered frame list before creating league fixtures."));
    }
    if (!isManager) return panel;

    const form = makeForm("competition-form league-format-form", current ? "Create a new format version" : "Configure the first format");
    addField(form, "Format name", "name", "text", { value: current?.name || "League match format", maxLength: 120, required: true });
    const raceToField = addField(form, "Race to (frames needed to win)", "raceTo", "number", {
      value: current?.raceTo ?? "", min: 1, max: maxRaceTo, step: 1, required: true
    });
    form.append(createTextElement("p", "management-help", `Race to N means first to N frame wins. The frame-type pattern repeats to create exactly 2N−1 possible frames (up to ${2 * maxRaceTo - 1}). Choose up to ${maxFramePatternLength} pattern steps; existing snapshots change only when you explicitly apply the new format to eligible future fixtures.`));
    const editor = createFrameEditor(current?.frames || []);
    form.append(editor.list);
    const add = createTextElement("button", "button button-quiet button-compact", "Add a frame");
    add.type = "button";
    add.textContent = "Add pattern step";
    add.disabled = editor.getFrames().length >= maxFramePatternLength;
    add.addEventListener("click", () => {
      editor.addFrame();
      add.disabled = editor.getFrames().length >= maxFramePatternLength;
    });
    form.append(add);
    addField(form, "When saving this default", "applyMode", "select", {
      choices: [["default", "Use for new fixtures only"], ["future", "Also update all eligible future, unplayed fixtures"]]
    });
    form.append(createTextElement("p", "management-help", "Started and completed matches keep their existing snapshots. Future fixture updates apply only to scheduled matches without player selections."));
    form.append(makeButton(current ? "Save new format version" : "Save league format"), statusElement());
    wireForm(form, async (data) => {
      const framePattern = editor.getFrames();
      if (!framePattern.length || framePattern.length > maxFramePatternLength) throw new Error(`Add between 1 and ${maxFramePatternLength} frame pattern steps.`);
      const raceTo = Number(raceToField.value);
      if (!Number.isInteger(raceTo) || raceTo < 1 || raceTo > maxRaceTo) throw new Error(`Choose a whole Race-to target from 1 to ${maxRaceTo}.`);
      const result = await request(`/api/leagues/${encodeURIComponent(competition.league.id)}/match-format`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.get("name"), raceTo, framePattern, applyToFuture: data.get("applyMode") === "future" })
      });
      return result;
    }, "League format saved. Existing started or completed match snapshots are unchanged.");
    panel.append(form);
    return panel;
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

  const toLocalDateTime = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return "";
    return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const formatFixtureDate = (value) => {
    if (!value) return "Date to be confirmed";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "Date to be confirmed" : new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London"
    }).format(date);
  };

  const createFixtureDraft = (season, activeMembers, doublesEntries) => {
    const row = createTextElement("fieldset", "fixture-entry-row");
    row.append(createTextElement("legend", "", `Fixture ${document.querySelectorAll(".fixture-entry-row").length + 1}`));
    const field = (label, name, type, options = {}) => {
      const control = addField(row, label, name, type, options);
      control.dataset.fixtureField = name;
      return control;
    };
    const matchType = field("Competition type", "type", "select", {
      choices: [["team_league", "Team League"], ["singles_league", "Singles League"], ["doubles_league", "Doubles League"]]
    });
    const teamFields = createTextElement("div", "fixture-side-fields");
    const teamChoices = season.teams.filter((team) => team.status === "active").map((team) => [team.id, team.name]);
    const homeTeam = addField(teamFields, "Home team", "homeTeamId", "select", {
      required: true, choices: teamChoices.length ? [["", "Choose a team"], ...teamChoices] : [["", "No active teams"]]
    });
    const awayTeam = addField(teamFields, "Away team", "awayTeamId", "select", {
      required: true, choices: teamChoices.length ? [["", "Choose a team"], ...teamChoices] : [["", "No active teams"]]
    });
    const divisionChoices = [["", "No division"]];
    season.divisions.forEach((division) => divisionChoices.push([division.id, division.name]));
    const division = addField(teamFields, "Division (optional)", "divisionId", "select", { choices: divisionChoices });
    const singlesFields = createTextElement("div", "fixture-side-fields");
    const memberChoices = activeMembers.map((member) => [member.userId, member.displayName]);
    const playerOne = addField(singlesFields, "Player on side 1", "playerOne", "select", {
      required: true, choices: memberChoices.length ? [["", "Choose a player"], ...memberChoices] : [["", "No active members"]]
    });
    const playerTwo = addField(singlesFields, "Player on side 2", "playerTwo", "select", {
      required: true, choices: memberChoices.length ? [["", "Choose a player"], ...memberChoices] : [["", "No active members"]]
    });
    const doublesFields = createTextElement("div", "fixture-side-fields");
    const pairChoices = doublesEntries.map((entry) => [entry.id, entry.displayName]);
    const pairOptions = pairChoices.length ? [["", "Choose an approved pair"], ...pairChoices] : [["", "No approved pairs with two active members"]];
    const pairOne = addField(doublesFields, "Approved pair on side 1", "doublesEntryOne", "select", {
      required: true, choices: pairOptions
    });
    const pairTwo = addField(doublesFields, "Approved pair on side 2", "doublesEntryTwo", "select", {
      required: true, choices: pairOptions
    });
    if (!doublesEntries.length) {
      doublesFields.append(createTextElement("p", "management-help", "No approved Doubles League pairs with exactly two active league members are available for this season."));
    }
    const scheduledAt = field("Date and time", "scheduledAt", "datetime-local", { required: true });
    const venue = field("Venue (optional)", "venue", "text", { maxLength: 160, placeholder: "Venue name" });
    const remove = createTextElement("button", "button button-quiet button-compact fixture-remove", "Remove fixture row");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (row.parentElement.children.length > 1) row.remove();
    });
    row.append(teamFields, singlesFields, doublesFields, remove);
    const syncType = () => {
      const teamMode = matchType.value === "team_league";
      const doublesMode = matchType.value === "doubles_league";
      teamFields.hidden = !teamMode;
      singlesFields.hidden = teamMode || doublesMode;
      doublesFields.hidden = !doublesMode;
      [homeTeam, awayTeam].forEach((control) => { control.disabled = !teamMode; });
      division.disabled = !teamMode;
      [playerOne, playerTwo].forEach((control) => { control.disabled = teamMode; });
      [pairOne, pairTwo].forEach((control) => { control.disabled = !doublesMode; });
    };
    matchType.addEventListener("change", syncType);
    syncType();
    return row;
  };

  const renderRoundRobinGenerator = async (season) => {
    const disclosure = createTextElement("details", "round-robin-generator");
    disclosure.append(createTextElement("summary", "", "Generate Fixtures — Round Robin"));
    const explanation = createTextElement("p", "management-help", "Choose eligible teams or registered entries, then preview the complete schedule. Nothing is saved until you confirm Save Fixtures.");
    const panel = createTextElement("div", "round-robin-panel");
    disclosure.append(explanation, panel);
    let eligible;
    try {
      eligible = (await request(`/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(season.id)}/round-robin/participants`)).participants;
    } catch (error) {
      panel.append(statusElement(error instanceof TypeError ? "Eligible participants could not be loaded." : error.message));
      return disclosure;
    }

    const form = makeForm("competition-form round-robin-form", "Build a round-robin schedule");
    const typeField = addField(form, "Competition type", "type", "select", {
      choices: [["team_league", "Team League"], ["singles_league", "Singles League"], ["doubles_league", "Doubles League"]]
    });
    const divisionField = addField(form, "Division", "divisionId", "select", { choices: [] });
    const meetingsField = addField(form, "Meet each opponent", "meetings", "select", {
      choices: [["1", "Once"], ["2", "Twice — reverse home/side order"]]
    });
    addField(form, "First fixture date and time", "firstScheduledAt", "datetime-local", { required: true });
    const intervalField = addField(form, "Days between rounds", "intervalDays", "number", { value: 7 });
    intervalField.min = "1";
    intervalField.max = "365";
    intervalField.step = "1";
    intervalField.required = true;
    addField(form, "Default venue (optional)", "defaultVenue", "text", {
      maxLength: 160, placeholder: "Used for Singles/Doubles and teams without a home venue"
    });

    const participantSet = createTextElement("fieldset", "round-robin-participant-set");
    participantSet.append(createTextElement("legend", "", "Eligible participants"));
    participantSet.append(createTextElement("p", "management-help", "Singles use approved player entries. Doubles use approved pairs with exactly two active league players. Team fixtures use active teams in the selected division."));
    const participantActions = createTextElement("div", "round-robin-selection-actions");
    const selectAll = createTextElement("button", "button button-quiet button-compact", "Select all shown");
    selectAll.type = "button";
    const selectNone = createTextElement("button", "button button-quiet button-compact", "Clear selection");
    selectNone.type = "button";
    participantActions.append(selectAll, selectNone);
    const participantList = createTextElement("div", "round-robin-participant-list");
    const selectionFeedback = statusElement();
    participantSet.append(participantActions, participantList, selectionFeedback);
    form.append(participantSet);
    const formFeedback = statusElement();
    form.append(makeButton("Generate Preview"), formFeedback);
    const previewHost = createTextElement("div", "round-robin-preview-host");
    panel.append(form, previewHost);
    let latestPreview = null;
    let latestRequest = null;

    const divisionValue = () => divisionField.value === "__unassigned__" || !divisionField.value ? null : divisionField.value;
    const refreshDivisionChoices = () => {
      divisionField.replaceChildren();
      const type = typeField.value;
      if (type === "team_league") {
        if (!season.divisions.length) {
          const option = createTextElement("option", "", "No divisions in this season");
          option.value = "";
          divisionField.append(option);
          divisionField.closest(".competition-field").hidden = true;
        } else {
          divisionField.closest(".competition-field").hidden = false;
          const prompt = createTextElement("option", "", "Choose a division or unassigned teams");
          prompt.value = "";
          divisionField.append(prompt);
          if (eligible.teams.some((team) => !team.divisionId)) {
            const unassigned = createTextElement("option", "", "Teams without a division");
            unassigned.value = "__unassigned__";
            divisionField.append(unassigned);
          }
          season.divisions.forEach((division) => {
            const option = createTextElement("option", "", division.name);
            option.value = division.id;
            divisionField.append(option);
          });
        }
      } else {
        divisionField.closest(".competition-field").hidden = false;
        const noDivision = createTextElement("option", "", "No division");
        noDivision.value = "";
        divisionField.append(noDivision);
        season.divisions.forEach((division) => {
          const option = createTextElement("option", "", division.name);
          option.value = division.id;
          divisionField.append(option);
        });
      }
    };

    const renderParticipantChoices = () => {
      participantList.replaceChildren();
      const type = typeField.value;
      let choices = eligible[type === "team_league" ? "teams" : type === "singles_league" ? "singles" : "doubles"] || [];
      if (type === "team_league" && divisionField.closest(".competition-field").hidden) {
        choices = choices.filter((team) => !team.divisionId);
      } else if (type === "team_league" && divisionField.value === "__unassigned__") {
        choices = choices.filter((team) => !team.divisionId);
      } else if (type === "team_league" && divisionField.value) {
        choices = choices.filter((team) => team.divisionId === divisionField.value);
      } else if (type === "team_league") {
        choices = [];
      }
      if (!choices.length) {
        participantList.append(createTextElement("p", "management-empty", type === "team_league"
          ? "Choose a division, or add active teams before generating fixtures."
          : type === "singles_league" ? "No approved Singles League participants are available for this season."
            : "No approved Doubles League pairs with two active players are available for this season."));
      }
      choices.forEach((participant) => {
        const label = createTextElement("label", "round-robin-participant");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = "participantId";
        checkbox.value = participant.id;
        checkbox.checked = true;
        const text = createTextElement("span", "", participant.label || participant.name || "Participant");
        if (participant.homeVenue) text.append(createTextElement("small", "round-robin-participant-meta", `Home venue: ${participant.homeVenue}`));
        label.append(checkbox, text);
        participantList.append(label);
      });
      latestPreview = null;
      previewHost.replaceChildren();
    };

    refreshDivisionChoices();
    renderParticipantChoices();
    typeField.addEventListener("change", () => { refreshDivisionChoices(); renderParticipantChoices(); });
    divisionField.addEventListener("change", renderParticipantChoices);
    const invalidatePreview = () => {
      if (!latestPreview) return;
      latestPreview = null;
      latestRequest = null;
      previewHost.replaceChildren();
      setStatus(formFeedback, "Schedule settings changed. Generate a fresh preview before saving.", "pending");
    };
    selectAll.addEventListener("click", () => {
      participantList.querySelectorAll("input[type='checkbox']").forEach((input) => { input.checked = true; });
      invalidatePreview();
    });
    selectNone.addEventListener("click", () => {
      participantList.querySelectorAll("input[type='checkbox']").forEach((input) => { input.checked = false; });
      invalidatePreview();
    });
    form.addEventListener("input", invalidatePreview);

    const renderPreview = (preview, requestBody) => {
      previewHost.replaceChildren();
      latestPreview = preview;
      latestRequest = requestBody;
      const summary = createTextElement("div", "round-robin-preview-summary");
      summary.append(createTextElement("h5", "", `${preview.fixtureCount} fixtures across ${preview.roundCount} rounds`),
        createTextElement("p", "management-help", `Format snapshot: ${preview.format.name} · Race to ${preview.format.raceTo} · up to ${preview.format.possibleFrames} frames · format version ${preview.format.version}. Fixture weeks keep the selected UK local start time.`));
      previewHost.append(summary);
      const editableRows = new Map();
      preview.rounds.forEach((round) => {
        const group = createTextElement("section", "round-robin-round");
        group.append(createTextElement("h5", "", `Round ${round.roundNumber} · ${formatFixtureDate(round.scheduledAt)}`));
        if (round.bye) group.append(createTextElement("p", "round-robin-bye", `${round.bye.label} has no fixture this round.`));
        const rows = createTextElement("div", "round-robin-round-fixtures");
        round.fixtures.forEach((fixture) => {
          const row = createTextElement("article", "round-robin-fixture-row");
          row.dataset.fixtureIndex = String(fixture.index);
          const sides = createTextElement("h6", "", `${fixture.sideOne.label} v ${fixture.sideTwo.label}`);
          const when = addField(row, "Date and time", `round-robin-date-${fixture.index}`, "datetime-local", {
            value: toLocalDateTime(fixture.scheduledAt), required: true
          });
          const venue = addField(row, "Venue", `round-robin-venue-${fixture.index}`, "text", {
            value: fixture.venue || "", maxLength: 160, placeholder: "Venue to be confirmed"
          });
          const originalDateValue = when.value;
          const originalVenue = fixture.venue || null;
          const rowActions = createTextElement("div", "round-robin-row-actions");
          const remove = createTextElement("button", "button button-quiet button-compact", "Remove fixture");
          remove.type = "button";
          remove.addEventListener("click", () => {
            const removed = row.dataset.removed === "true";
            row.dataset.removed = removed ? "false" : "true";
            when.disabled = !removed;
            venue.disabled = !removed;
            remove.textContent = removed ? "Remove fixture" : "Restore fixture";
          });
          rowActions.append(remove);
          row.prepend(sides);
          row.append(rowActions);
          rows.append(row);
          editableRows.set(fixture.index, { row, when, venue, originalDateValue, originalVenue });
        });
        group.append(rows);
        previewHost.append(group);
      });
      const actions = createTextElement("div", "round-robin-preview-actions");
      const save = createTextElement("button", "button button-gold", "Save Fixtures");
      save.type = "button";
      const discard = createTextElement("button", "button button-quiet", "Cancel / Discard Preview");
      discard.type = "button";
      const feedback = statusElement("Review the proposed schedule. Nothing has been saved yet.");
      actions.append(save, discard, feedback);
      previewHost.append(actions);
      discard.addEventListener("click", () => { latestPreview = null; latestRequest = null; previewHost.replaceChildren(); setStatus(formFeedback, "Preview discarded. No fixtures were saved.", "success"); });
      save.addEventListener("click", async () => {
        const omittedFixtureIndexes = [];
        const overrides = [];
        for (const [index, row] of editableRows) {
          if (row.row.dataset.removed === "true") { omittedFixtureIndexes.push(index); continue; }
          if (!row.when.reportValidity()) return;
          const date = new Date(row.when.value);
          if (Number.isNaN(date.valueOf())) { setStatus(feedback, "Enter a valid date and time for each fixture.", "error"); return; }
          const nextVenue = row.venue.value.trim() || null;
          if (row.when.value !== row.originalDateValue || nextVenue !== row.originalVenue) {
            overrides.push({ index, scheduledAt: date.toISOString(), venue: nextVenue });
          }
        }
        save.disabled = true;
        discard.disabled = true;
        setStatus(feedback, "Saving all fixtures in one transaction…", "pending");
        try {
          const result = await request(`/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(season.id)}/round-robin/save`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...latestRequest, formatVersion: preview.format.version, omittedFixtureIndexes, overrides })
          });
          latestPreview = null;
          latestRequest = null;
          await loadCompetition();
          setStatus(status, `${result.savedCount} fixtures saved across ${result.roundCount} rounds${result.removedCount ? `; ${result.removedCount} removed from the preview` : ""}.`, "success");
        } catch (error) {
          setStatus(feedback, error instanceof TypeError ? "The fixture service could not be reached. Your preview is still here; try again." : error.message, "error");
          save.disabled = false;
          discard.disabled = false;
        }
      });
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const participantIds = Array.from(participantList.querySelectorAll("input[type='checkbox']:checked"), (input) => input.value);
      if (participantIds.length < 2) { setStatus(selectionFeedback, "Select at least two eligible participants.", "error"); return; }
      const firstScheduledAt = new Date(form.elements.firstScheduledAt.value);
      if (Number.isNaN(firstScheduledAt.valueOf())) { setStatus(formFeedback, "Choose a valid first fixture date and time.", "error"); return; }
      const requestBody = {
        type: typeField.value,
        divisionId: divisionValue(),
        meetings: Number(meetingsField.value),
        participantIds,
        firstScheduledAt: firstScheduledAt.toISOString(),
        intervalDays: Number(intervalField.value),
        defaultVenue: form.elements.defaultVenue.value.trim() || null
      };
      const submit = form.querySelector("[type='submit']");
      submit.disabled = true;
      setStatus(formFeedback, "Generating a read-only preview…", "pending");
      try {
        const result = await request(`/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(season.id)}/round-robin/preview`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody)
        });
        renderPreview(result.preview, requestBody);
        setStatus(formFeedback, "Preview ready. No fixtures have been saved.", "success");
      } catch (error) {
        setStatus(formFeedback, error instanceof TypeError ? "The fixture service could not be reached." : error.message, "error");
      } finally {
        submit.disabled = false;
      }
    });
    return disclosure;
  };

  const renderFixtureControls = (match) => {
    const controls = createTextElement("div", "fixture-manager-actions");
    const scheduleDetails = createTextElement("details", "fixture-edit-details");
    scheduleDetails.append(createTextElement("summary", "", "Edit date, time or venue"));
    const scheduleForm = makeForm("competition-form fixture-edit-form", "Update scheduled details");
    addField(scheduleForm, "Date and time", "scheduledAt", "datetime-local", { value: toLocalDateTime(match.scheduledAt), required: true });
    addField(scheduleForm, "Venue", "venue", "text", { value: match.venue || "", maxLength: 160 });
    scheduleForm.append(makeButton("Save fixture details", "button button-quiet"), statusElement());
    wireForm(scheduleForm, async (data) => request(`/api/matches/${encodeURIComponent(match.id)}/schedule`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledAt: new Date(data.get("scheduledAt")).toISOString(), venue: data.get("venue") || null })
    }), "Fixture details updated.");
    scheduleDetails.append(scheduleForm);

    const formatDetails = createTextElement("details", "fixture-edit-details");
    formatDetails.append(createTextElement("summary", "", "Edit this fixture’s frame format"));
    const formatContent = createTextElement("div", "fixture-format-content");
    formatDetails.append(formatContent);
    formatDetails.addEventListener("toggle", async () => {
      if (!formatDetails.open || formatDetails.dataset.loaded === "true") return;
      setStatus(status, "Loading fixture format…", "pending");
      try {
        const details = await request(`/api/matches/${encodeURIComponent(match.id)}`);
        const frames = (details.frames || []).map((frame) => ({ type: frame.type }));
        const form = makeForm("competition-form fixture-format-form", "Save a new fixture format version");
        addField(form, "Format name", "name", "text", { value: `Fixture format for ${formatFixtureDate(match.scheduledAt)}`, maxLength: 120, required: true });
        const raceToField = addField(form, "Race to (frames needed to win)", "raceTo", "number", {
          value: details.match?.raceTo ?? "", min: 1, max: maxRaceTo, step: 1, required: true
        });
        form.append(createTextElement("p", "management-help", `First to N frame wins takes the match. The pattern repeats to exactly 2N−1 possible frames, up to ${2 * maxRaceTo - 1}.`));
        const editor = createFrameEditor(frames);
        form.append(editor.list);
        const add = createTextElement("button", "button button-quiet button-compact", "Add pattern step");
        add.type = "button";
        add.disabled = editor.getFrames().length >= maxFramePatternLength;
        add.addEventListener("click", () => {
          editor.addFrame();
          add.disabled = editor.getFrames().length >= maxFramePatternLength;
        });
        form.append(add);
        const defaultLabel = createTextElement("label", "competition-inline-check");
        const makeDefault = document.createElement("input");
        makeDefault.type = "checkbox";
        makeDefault.name = "makeDefault";
        defaultLabel.append(makeDefault, createTextElement("span", "", "Also use this format as the league default for new fixtures"));
        form.append(defaultLabel, createTextElement("p", "management-help", "Leave unchecked to change this scheduled fixture only. Started and completed matches cannot be rewritten."));
        form.append(makeButton("Save fixture format"), statusElement());
        wireForm(form, async (data) => {
          const framePattern = editor.getFrames();
          if (!framePattern.length || framePattern.length > maxFramePatternLength) throw new Error(`Add between 1 and ${maxFramePatternLength} frame pattern steps.`);
          const raceTo = Number(raceToField.value);
          if (!Number.isInteger(raceTo) || raceTo < 1 || raceTo > maxRaceTo) throw new Error(`Choose a whole Race-to target from 1 to ${maxRaceTo}.`);
          return request(`/api/matches/${encodeURIComponent(match.id)}/format`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: data.get("name"), raceTo, framePattern, makeDefault: data.has("makeDefault") })
          });
        }, "Fixture format saved. Other existing match snapshots are unchanged.");
        formatContent.replaceChildren(form);
        formatDetails.dataset.loaded = "true";
        setStatus(status, "Fixture format loaded.", "success");
      } catch (error) {
        formatContent.append(statusElement(error instanceof TypeError ? "Fixture format is unavailable right now." : error.message));
        setStatus(status, "Fixture format could not be loaded.", "error");
      }
    });

    const cancel = createTextElement("button", "button button-quiet button-compact", "Cancel fixture");
    cancel.type = "button";
    cancel.addEventListener("click", async () => {
      if (!window.confirm("Cancel this unstarted fixture? It will remain in the match history as cancelled.")) return;
      cancel.disabled = true;
      try {
        await request(`/api/matches/${encodeURIComponent(match.id)}/cancel`, { method: "POST" });
        await loadCompetition();
      } catch (error) {
        setStatus(status, error instanceof TypeError ? "We couldn't reach the match service." : error.message, "error");
        cancel.disabled = false;
      }
    });
    controls.append(scheduleDetails, formatDetails, cancel);
    return controls;
  };

  const renderSeasonFixtures = async (season, isManager, matches, activeMembers, doublesEntries, doublesEntriesError) => {
    const section = createTextElement("section", "competition-fixtures");
    section.append(createTextElement("div", "section-kicker", "SCHEDULE"), createTextElement("h4", "", "Upcoming fixtures"));
    const divisionChoices = [["", "All divisions"]];
    season.divisions.forEach((division) => divisionChoices.push([division.id, division.name]));
    const filterWrap = createTextElement("div", "fixture-list-filter");
    const filter = document.createElement("select");
    filter.setAttribute("aria-label", "Filter fixtures by division");
    divisionChoices.forEach(([value, label]) => {
      const option = createTextElement("option", "", label); option.value = value; filter.append(option);
    });
    filterWrap.append(createTextElement("label", "", "Division"), filter);
    const list = createTextElement("div", "fixture-list");
    const renderList = () => {
      list.replaceChildren();
      const upcoming = matches.filter((match) => match.seasonId === season.id && match.status === "scheduled"
        && (!filter.value || match.divisionId === filter.value))
        .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      if (!upcoming.length) {
        list.append(createTextElement("p", "management-empty", filter.value ? "No upcoming fixtures are listed for this division." : "No upcoming fixtures have been published for this season."));
        return;
      }
      upcoming.forEach((match) => {
        const card = createTextElement("article", "fixture-card");
        const heading = createTextElement("div", "fixture-card-heading");
        heading.append(createTextElement("span", "match-category-tag", matchTypeLabels[match.type] || "League match"),
          createTextElement("span", "match-state-tag is-scheduled", "scheduled"));
        card.append(heading, createTextElement("h5", "", `${sideLabel(match, 1)} v ${sideLabel(match, 2)}`),
          createTextElement("p", "match-list-meta", `${formatFixtureDate(match.scheduledAt)}${match.roundNumber ? ` · Round ${match.roundNumber}` : ""}${match.divisionName ? ` · ${match.divisionName}` : ""}${match.venue ? ` · ${match.venue}` : ""}`),
          createTextElement("p", "fixture-score", `${match.homeScore} — ${match.awayScore}`));
        const link = createTextElement("a", "text-link", "Open in Match Centre ↗");
        link.href = `match.html?id=${encodeURIComponent(match.id)}`;
        card.append(link);
        if (isManager && season.status !== "completed") card.append(renderFixtureControls(match));
        list.append(card);
      });
    };
    filter.addEventListener("change", renderList);
    section.append(filterWrap, list);
    renderList();

    if (isManager && season.status !== "completed") {
      const form = makeForm("competition-form fixture-create-form", "Add one or more fixtures");
      form.append(createTextElement("p", "management-help", "Build several fixtures in this session. Team fixtures use active teams, Singles fixtures use active league members, and Doubles fixtures use approved pairs."));
      if (doublesEntriesError) form.append(statusElement(`Approved Doubles League pairs could not be loaded: ${doublesEntriesError}`));
      const rows = createTextElement("div", "fixture-entry-list");
      rows.append(createFixtureDraft(season, activeMembers, doublesEntries));
      const addRow = createTextElement("button", "button button-quiet button-compact", "Add another fixture");
      addRow.type = "button";
      addRow.addEventListener("click", () => rows.append(createFixtureDraft(season, activeMembers, doublesEntries)));
      const feedback = statusElement();
      form.append(rows, addRow, makeButton("Create fixtures"), feedback);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const pendingRows = Array.from(rows.children).filter((row) => row.dataset.created !== "true");
        if (!pendingRows.length) return;
        if (!form.reportValidity()) return;
        const submit = form.querySelector("[type='submit']");
        submit.disabled = true;
        setStatus(feedback, "Saving fixtures…", "pending");
        let saved = Array.from(rows.children).filter((row) => row.dataset.created === "true").length;
        try {
          for (const row of pendingRows) {
            const value = (name) => row.querySelector(`[data-fixture-field='${name}']`).value;
            const type = value("type");
            const scheduledAt = new Date(value("scheduledAt"));
            if (Number.isNaN(scheduledAt.valueOf())) throw new Error("Enter a valid date and time for each fixture.");
            let details = { type, leagueId, seasonId: season.id, scheduledAt: scheduledAt.toISOString(), venue: value("venue") || null };
            if (type === "team_league") {
              if (value("homeTeamId") === value("awayTeamId")) throw new Error("A team cannot play itself. Choose two different teams.");
              details = { ...details, divisionId: value("divisionId") || null, homeTeamId: value("homeTeamId"), awayTeamId: value("awayTeamId") };
            } else if (type === "singles_league") {
              if (value("playerOne") === value("playerTwo")) throw new Error("Choose two different registered players for a Singles fixture.");
              details.participants = [{ userId: value("playerOne"), side: 1 }, { userId: value("playerTwo"), side: 2 }];
            } else if (type === "doubles_league") {
              const sideOneEntryId = value("doublesEntryOne");
              const sideTwoEntryId = value("doublesEntryTwo");
              if (!sideOneEntryId || !sideTwoEntryId) throw new Error("Choose an approved pair for both Doubles League sides.");
              if (sideOneEntryId === sideTwoEntryId) throw new Error("A Doubles League entry cannot play against itself.");
              details.doublesEntryIds = [sideOneEntryId, sideTwoEntryId];
            }
            await request("/api/matches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(details) });
            row.dataset.created = "true";
            row.disabled = true;
            row.append(createTextElement("p", "form-status", "Fixture created."));
            saved++;
          }
          await loadCompetition();
          setStatus(status, `${saved} ${saved === 1 ? "fixture" : "fixtures"} created.`, "success");
        } catch (error) {
          setStatus(feedback, `${saved} saved. ${error instanceof TypeError ? "The match service could not be reached." : error.message} Unsaved rows remain available to retry.`, "error");
          submit.disabled = false;
        }
      });
      section.append(form);
      section.append(await renderRoundRobinGenerator(season));
    }
    return section;
  };

  const renderCompetition = async (competition) => {
    title.replaceChildren(document.createTextNode(competition.league.name));
    title.classList.add("competition-title");
    description.textContent = [competition.league.location, competition.league.description].filter(Boolean).join(" · ") || "Season and team information published by this league's organisers.";
    seasonsContainer.replaceChildren();
    const isManager = ["owner", "administrator"].includes(competition.viewerRole);
    seasonsContainer.append(await renderLeagueFormat(competition, isManager));
    let matchRows = [];
    let matchLoadError = "";
    try {
      const { response, payload } = await apiRequest(`/api/matches?leagueId=${encodeURIComponent(competition.league.id)}`);
      if (!response.ok) throw new Error(payload.error || "Upcoming fixtures could not be loaded.");
      matchRows = payload.matches || [];
    } catch (error) {
      matchLoadError = error instanceof TypeError ? "Upcoming fixtures are temporarily unavailable." : error.message;
    }
    let activeMembers = [];
    if (isManager) {
      try {
        const result = await request(`/api/leagues/${encodeURIComponent(competition.league.id)}/members`);
        activeMembers = (result.members || []).filter((member) => member.status === "active");
      } catch {
        activeMembers = [];
      }
    }
    const doublesEntriesBySeason = new Map();
    const doublesEntriesErrors = new Map();
    if (isManager) {
      await Promise.all(competition.seasons.map(async (season) => {
        try {
          const result = await request(`/api/leagues/${encodeURIComponent(competition.league.id)}/seasons/${encodeURIComponent(season.id)}/doubles-entries`);
          doublesEntriesBySeason.set(season.id, result.entries || []);
        } catch (error) {
          doublesEntriesBySeason.set(season.id, []);
          doublesEntriesErrors.set(season.id, error instanceof TypeError
            ? "The match service could not be reached."
            : error.message);
        }
      }));
    }
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
      const fixtureBlock = await renderSeasonFixtures(
        season, isManager, matchRows, activeMembers,
        doublesEntriesBySeason.get(season.id) || [], doublesEntriesErrors.get(season.id) || ""
      );
      if (matchLoadError) fixtureBlock.prepend(statusElement(matchLoadError));
      seasonCard.append(fixtureBlock);
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
