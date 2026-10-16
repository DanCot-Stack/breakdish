const livePage = document.querySelector("[data-live-matches-page]");

if (livePage) {
  const api = window.BreakDishApi;
  const status = livePage.querySelector("[data-live-status]");
  const list = livePage.querySelector("[data-live-match-list]");
  const labels = {
    team_league: "Team League",
    singles_league: "Singles League",
    doubles_league: "Doubles League",
    tournament_flyer: "Tournament/Flyer",
    money_match: "Money Match",
    practice: "Practice Match"
  };
  const rows = new Map();
  let serverOffsetMs = 0;
  let loaded = false;
  let lastCount = 0;
  let pollInFlight = false;

  function setStatus(message, state = "success") {
    status.dataset.state = state;
    status.textContent = message;
  }

  function formatElapsed(startedAt, completedAt = null) {
    const start = Date.parse(startedAt || "");
    if (!Number.isFinite(start)) return "Time unavailable";
    const end = completedAt ? Date.parse(completedAt) : Date.now() + serverOffsetMs;
    if (!Number.isFinite(end)) return "Time unavailable";
    const elapsed = Math.max(0, Math.floor((end - start) / 1000));
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createRow(match) {
    const article = makeElement("article", "live-match-row");
    article.dataset.matchId = match.id;
    const main = makeElement("div", "live-match-row-main");
    const heading = makeElement("div", "live-match-row-heading");
    heading.append(makeElement("span", "live-indicator", "LIVE"));
    const category = makeElement("span", "match-category-tag");
    category.dataset.category = "";
    heading.append(category);
    const event = makeElement("p", "live-match-meta");
    event.dataset.event = "";
    const sides = makeElement("p", "live-match-sides");
    const home = makeElement("span", "live-match-home");
    const score = makeElement("strong", "live-match-score");
    const away = makeElement("span", "live-match-away");
    score.dataset.score = "";
    sides.append(home, score, away);
    const meta = makeElement("p", "live-match-meta");
    meta.dataset.meta = "";
    const frame = makeElement("p", "live-match-frame");
    frame.dataset.frame = "";
    const timer = makeElement("time", "live-match-timer", "Time unavailable");
    timer.dataset.timer = "";
    main.append(heading, event, sides, meta, frame, timer);
    const link = makeElement("a", "button button-gold", "View Match");
    link.dataset.viewMatch = "";
    article.append(main, link);
    return article;
  }

  function currentFrameText(frame) {
    if (!frame) return "Current frame details are not available yet.";
    const grouped = [1, 2].map((side) => {
      const players = (frame.players || []).filter((player) => Number(player.side) === side);
      if (players.some((player) => player.isBye)) return "Bye";
      return players.map((player) => player.name).filter(Boolean).join(" / ");
    });
    const details = grouped.every(Boolean) ? `: ${grouped[0]} v ${grouped[1]}` : "";
    const type = frame.type === "doubles" ? "Doubles" : "Singles";
    const eventName = frame.event?.type === "counter_dish" ? "Counter Dish" : frame.event?.type === "dish" ? "Dish" : "";
    const eventPlayer = frame.event?.userId
      ? (frame.players || []).find((player) => player.userId === frame.event.userId)?.name
      : "";
    const event = eventName ? ` · ${eventName}${eventPlayer ? ` (${eventPlayer})` : ""}` : "";
    return `Frame ${frame.number} · ${type}${details}${event}`;
  }

  function updateRow(article, match) {
    const category = labels[match.type] || "Match";
    article.querySelector("[data-category]").textContent = category;
    const eventName = match.leagueName || match.tournamentName || "Competition match";
    article.querySelector("[data-event]").textContent = eventName;
    article.querySelector(".live-match-home").textContent = match.homeTeam || match.homeSideName || "Home side";
    article.querySelector(".live-match-away").textContent = match.awayTeam || match.awaySideName || "Away side";
    article.querySelector("[data-score]").textContent = `${match.homeScore}–${match.awayScore}`;
    article.querySelector("[data-score]").setAttribute("aria-label", `Score ${match.homeScore} to ${match.awayScore}`);
    const meta = [match.divisionName, match.venue].filter(Boolean).join(" · ");
    article.querySelector("[data-meta]").textContent = meta || "";
    const frame = article.querySelector("[data-frame]");
    frame.textContent = currentFrameText(match.currentFrame);
    frame.hidden = !match.currentFrame;
    const timer = article.querySelector("[data-timer]");
    timer.dataset.startedAt = match.startedAt || "";
    timer.dataset.completedAt = match.completedAt || "";
    timer.textContent = formatElapsed(match.startedAt, match.completedAt);
    timer.setAttribute("aria-label", `Elapsed match time ${timer.textContent}`);
    article.querySelector("[data-view-match]").href = `match.html?id=${encodeURIComponent(match.id)}`;
  }

  function reconcile(matches) {
    const activeIds = new Set(matches.map((match) => match.id));
    for (const [matchId, article] of rows) {
      if (activeIds.has(matchId)) continue;
      if (article.contains(document.activeElement)) {
        setStatus("A match has left the live list. Its final details remain available in Match Centre.");
        status.focus();
      }
      article.remove();
      rows.delete(matchId);
    }

    matches.forEach((match, index) => {
      let article = rows.get(match.id);
      if (!article) {
        article = createRow(match);
        rows.set(match.id, article);
      }
      updateRow(article, match);
      const existingAtIndex = list.children[index];
      if (existingAtIndex !== article && !article.contains(document.activeElement)) {
        list.insertBefore(article, existingAtIndex || null);
      }
    });

    if (!matches.length && !loaded) setStatus("No matches are currently in progress.");
    else if (matches.length && (!loaded || matches.length !== lastCount)) {
      setStatus(`${matches.length} ${matches.length === 1 ? "match is" : "matches are"} live. Updates check every few seconds.`);
    }
    loaded = true;
    lastCount = matches.length;
  }

  function updateTimers() {
    if (document.visibilityState !== "visible") return;
    list.querySelectorAll("[data-timer]").forEach((timer) => {
      timer.textContent = formatElapsed(timer.dataset.startedAt, timer.dataset.completedAt || null);
      timer.setAttribute("aria-label", `Elapsed match time ${timer.textContent}`);
    });
  }

  async function refresh() {
    if (pollInFlight || document.visibilityState !== "visible") return;
    pollInFlight = true;
    const requestStartedAt = Date.now();
    try {
      const { response, payload } = await api.request("/api/matches/live", { cache: "no-store" });
      if (!response.ok) throw new Error(payload.error || "The Live Matches service could not load.");
      const requestFinishedAt = Date.now();
      const serverTime = Date.parse(payload.serverTime || "");
      if (Number.isFinite(serverTime)) serverOffsetMs = serverTime - ((requestStartedAt + requestFinishedAt) / 2);
      reconcile(Array.isArray(payload.matches) ? payload.matches : []);
      updateTimers();
    } catch (error) {
      setStatus(error instanceof TypeError
        ? "We couldn't reach the match service. The latest live information may be out of date."
        : error.message, "error");
    } finally {
      pollInFlight = false;
    }
  }

  const pollTimer = window.setInterval(refresh, 4000);
  const elapsedTimer = window.setInterval(updateTimers, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  window.addEventListener("pagehide", () => {
    window.clearInterval(pollTimer);
    window.clearInterval(elapsedTimer);
  }, { once: true });
  refresh();
}
