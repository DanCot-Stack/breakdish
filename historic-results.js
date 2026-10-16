const historicPage = document.querySelector("[data-historic-results-page]");

if (historicPage) {
  const api = window.BreakDishApi;
  const status = historicPage.querySelector("[data-historic-status]");
  const list = historicPage.querySelector("[data-historic-list]");
  const breadcrumb = historicPage.querySelector("[data-historic-breadcrumb]");
  const heading = historicPage.querySelector("[data-historic-heading]");
  const kicker = historicPage.querySelector("[data-historic-kicker]");
  const intro = historicPage.querySelector("[data-historic-intro]");
  const labels = {
    team_league: "Team League",
    singles_league: "Singles League",
    doubles_league: "Doubles League"
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(message, state = "success") {
    status.dataset.state = state;
    status.textContent = message;
  }

  function formatDate(value, dateOnly = false) {
    if (!value) return "Date not recorded";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) return "Date not recorded";
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeZone: dateOnly ? "UTC" : "Europe/London",
      ...(dateOnly ? {} : { timeStyle: "short" })
    }).format(parsed);
  }

  async function get(path) {
    const { response, payload } = await api.request(path);
    if (!response.ok) throw new Error(payload.error || "Historic results could not be loaded.");
    return payload;
  }

  function addBreadcrumb(label, href = null) {
    breadcrumb.append(element("span", "", "›"));
    if (href) {
      const link = element("a", "", label);
      link.href = href;
      breadcrumb.append(link);
      return;
    }
    const current = element("span", "", label);
    current.setAttribute("aria-current", "page");
    breadcrumb.append(current);
  }

  function directoryCard(title, description, statistic, href) {
    const card = element("article", "match-list-card historic-directory-card");
    const content = element("div");
    content.append(element("h3", "", title));
    if (description) content.append(element("p", "match-list-meta", description));
    content.append(element("p", "match-list-meta", statistic));
    const link = element("a", "button button-gold", "View results");
    link.href = href;
    card.append(content, link);
    return card;
  }

  function renderLeagues(leagues) {
    list.replaceChildren();
    if (!leagues.length) {
      setStatus("No completed league results are available yet. Results will appear here when a season is completed and has final match scores.");
      return;
    }
    for (const league of leagues) {
      const description = [league.location].filter(Boolean).join(" · ");
      list.append(directoryCard(
        league.name, description,
        `${league.seasonCount} ${league.seasonCount === 1 ? "completed season" : "completed seasons"} · ${league.resultCount} ${league.resultCount === 1 ? "result" : "results"}`,
        `historic-results.html?leagueId=${encodeURIComponent(league.id)}`
      ));
    }
    setStatus(`${leagues.length} ${leagues.length === 1 ? "league" : "leagues"} with historic results.`);
  }

  function renderSeasons(seasons, leagueId, leagueName) {
    list.replaceChildren();
    breadcrumb.replaceChildren();
    const home = element("a", "", "Historic Results");
    home.href = "historic-results.html";
    breadcrumb.append(home);
    addBreadcrumb(leagueName);
    heading.innerHTML = "CHOOSE A<br><span>SEASON.</span>";
    kicker.textContent = "LEAGUE / COMPLETED SEASONS";
    intro.textContent = `Choose a completed ${leagueName} season to view its final results.`;
    if (!seasons.length) {
      setStatus("This league has no completed seasons with final results yet.");
      return;
    }
    for (const season of seasons) {
      const dates = [season.startsOn && formatDate(season.startsOn, true), season.endsOn && formatDate(season.endsOn, true)].filter(Boolean).join(" – ");
      list.append(directoryCard(
        season.name, dates || "Completed season",
        `${season.resultCount} ${season.resultCount === 1 ? "final result" : "final results"}`,
        `historic-results.html?leagueId=${encodeURIComponent(leagueId)}&seasonId=${encodeURIComponent(season.id)}`
      ));
    }
    setStatus(`${seasons.length} completed ${seasons.length === 1 ? "season" : "seasons"} with results.`);
  }

  function sideName(match, side) {
    if (side === 1) return match.homeTeam || match.homeSideName || "Home side";
    return match.awayTeam || match.awaySideName || "Away side";
  }

  function renderMatches(matches, leagueId, seasonId, leagueName, seasonName) {
    list.replaceChildren();
    breadcrumb.replaceChildren();
    const home = element("a", "", "Historic Results");
    home.href = "historic-results.html";
    breadcrumb.append(home);
    addBreadcrumb(leagueName, `historic-results.html?leagueId=${encodeURIComponent(leagueId)}`);
    addBreadcrumb(seasonName);
    heading.innerHTML = "FINAL MATCH<br><span>RESULTS.</span>";
    kicker.textContent = "COMPLETED / VERIFIED SCORES";
    intro.textContent = `${leagueName} · ${seasonName}. These results are taken from completed official league matches.`;
    if (!matches.length) {
      setStatus("No completed league match results are listed for this season.");
      return;
    }
    for (const match of matches) {
      const card = element("article", "match-list-card historic-result-card");
      const metaRow = element("div", "match-list-card-header");
      metaRow.append(
        element("span", "match-category-tag", labels[match.type] || "League match"),
        element("span", "match-state-tag is-completed", "Final")
      );
      card.append(metaRow, element("h3", "", `${sideName(match, 1)} v ${sideName(match, 2)}`));
      card.append(element("p", "match-list-meta", [match.leagueName || leagueName, match.divisionName].filter(Boolean).join(" · ")));
      const details = [formatDate(match.completedAt || match.scheduledAt)];
      if (match.roundNumber != null) details.push(`Round ${match.roundNumber}`);
      card.append(element("p", "match-list-meta", details.join(" · ")));
      card.append(element("p", "match-list-score", `${match.homeScore} — ${match.awayScore}`));
      const link = element("a", "button button-gold", "View Match");
      link.href = `match.html?id=${encodeURIComponent(match.id)}`;
      card.append(link);
      list.append(card);
    }
    setStatus(`${matches.length} final ${matches.length === 1 ? "result" : "results"}.`);
  }

  async function load() {
    const params = new URLSearchParams(window.location.search);
    const leagueId = params.get("leagueId");
    const seasonId = params.get("seasonId");
    if (seasonId && !leagueId) {
      setStatus("Choose a league before selecting a season.", "error");
      return;
    }
    try {
      if (!leagueId) {
        const { leagues = [] } = await get("/api/historic-results");
        renderLeagues(leagues);
        return;
      }
      const { seasons = [] } = await get(`/api/historic-results/${encodeURIComponent(leagueId)}/seasons`);
      const season = seasonId ? seasons.find((item) => item.id === seasonId) : null;
      const leagueResponse = await get("/api/historic-results");
      const league = leagueResponse.leagues?.find((item) => item.id === leagueId);
      if (!league) {
        setStatus("This league is not available in the historic results directory.", "error");
        return;
      }
      if (!seasonId) {
        renderSeasons(seasons, leagueId, league.name);
        return;
      }
      if (!season) {
        setStatus("This completed season is not available in the selected league.", "error");
        return;
      }
      const { matches = [] } = await get(`/api/historic-results/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/matches`);
      renderMatches(matches, leagueId, seasonId, league.name, season.name);
    } catch (error) {
      setStatus(error.message || "Historic results could not be loaded. Please try again.", "error");
    }
  }

  load();
}
