const page = document.querySelector("[data-match-page]");

if (page) {
  const api = window.BreakDishApi;
  const status = page.querySelector("[data-match-status]");
  if (status) status.tabIndex = -1;
  const list = page.querySelector("[data-match-list]");
  const detail = page.querySelector("[data-match-detail]");
  const title = page.querySelector("[data-match-page-title]");
  const sectionTitle = page.querySelector("[data-match-section-title]");
  const sectionKicker = page.querySelector("[data-match-section-kicker]");
  const intro = page.querySelector("[data-match-intro]");
  const labels = {
    team_league: "Team League",
    singles_league: "Singles League",
    doubles_league: "Doubles League",
    tournament_flyer: "Tournament/Flyer",
    money_match: "Money Match",
    practice: "Practice Match"
  };
  let signedIn = false;
  let matchData;
  let filterLeagueId = null;
  let previousMatches = false;
  let serverOffsetMs = 0;
  let matchPollTimer = null;
  let matchClockTimer = null;
  let matchRefreshInFlight = false;
  let mutationPending = false;
  let pendingFormChanges = false;
  let lastRenderedSnapshot = "";
  const startDialog = page.querySelector("[data-start-match-dialog]");
  const startDialogMatchup = startDialog?.querySelector("[data-start-matchup]");
  const startDialogStatus = startDialog?.querySelector("[data-start-match-status]");
  const confirmStartButton = startDialog?.querySelector("[data-confirm-start]");

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function setStatus(message, state = "pending") {
    status.dataset.state = state;
    status.textContent = message;
  }

  function formatDate(value) {
    if (!value) return "Date to be confirmed";
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? "Date to be confirmed" : new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London"
    }).format(parsed);
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

  async function request(path, options) {
    const result = await api.request(path, options);
    if (!result.response.ok) throw new Error(result.payload.error || "The match service could not complete that request.");
    return result.payload;
  }

  async function loadSession() {
    try {
      const { response } = await api.request("/api/me");
      signedIn = response.ok;
    } catch {
      signedIn = false;
    }
  }

  function matchLabel(match) {
    if (match.homeTeam || match.awayTeam || match.homeSideName || match.awaySideName) {
      return `${sideName(match, 1)} v ${sideName(match, 2)}`;
    }
    if (match.tournamentName) return match.tournamentName;
    if (match.leagueName) return match.leagueName;
    return labels[match.type] || "BREAK DISH match";
  }

  function sideName(match, side) {
    if (side === 1) return match.homeTeam || match.homeSideName || "Home";
    return match.awayTeam || match.awaySideName || "Away";
  }

  function displayMatchStatus(value) {
    const labels = {
      scheduled: "Scheduled",
      in_progress: "Live",
      awaiting_confirmation: "Awaiting confirmation",
      disputed: "Disputed",
      completed: "Completed",
      cancelled: "Cancelled"
    };
    return labels[value] || String(value || "Unknown").replaceAll("_", " ");
  }

  function renderMatchList(matches) {
    list.replaceChildren();
    list.classList.toggle("is-previous-matches", previousMatches);
    if (!matches.length) {
      setStatus(previousMatches
        ? "No completed matches are available yet."
        : filterLeagueId
          ? "No fixtures or results have been published for this league yet."
          : "No public matches are listed yet. Match schedules will appear here when organisers publish them.", "success");
      return;
    }
    for (const match of matches) {
      const card = textElement("article", "match-list-card");
      const header = textElement("div", "match-list-card-header");
      header.append(
        textElement("span", "match-category-tag", labels[match.type] || "Match"),
        textElement("span", `match-state-tag is-${match.status}`, previousMatches ? "Final" : match.status.replaceAll("_", " "))
      );
      if (match.testOnly === true) header.append(textElement("strong", "match-test-label", "TEST MATCH — EXCLUDED FROM STATISTICS"));
      const name = textElement("h3", "", matchLabel(match));
      const competition = previousMatches && (match.leagueName || match.tournamentName)
        ? textElement("p", "match-list-meta", [match.leagueName || match.tournamentName, match.divisionName].filter(Boolean).join(" · "))
        : null;
      const date = previousMatches ? (match.completedAt || match.scheduledAt) : match.scheduledAt;
      const meta = textElement("p", "match-list-meta", `${formatDate(date)}${match.venue ? ` · ${match.venue}` : ""}`);
      const score = textElement("p", "match-list-score", `${match.homeScore} — ${match.awayScore}`);
      const link = textElement("a", "button button-gold", previousMatches ? "View Match" : "Open scoreboard");
      link.href = `match.html?id=${encodeURIComponent(match.id)}`;
      card.append(header, name);
      if (competition) card.append(competition);
      card.append(meta, score, link);
      list.append(card);
    }
    setStatus(`${matches.length} ${matches.length === 1 ? "match" : "matches"} listed.`, "success");
  }

  function latestConfirmations(confirmations) {
    const latest = new Map();
    for (const confirmation of confirmations || []) latest.set(Number(confirmation.side), confirmation);
    return latest;
  }

  function actionButton(label, className, ariaLabel, onClick, disabled = false) {
    const control = textElement("button", className, label);
    control.type = "button";
    control.setAttribute("aria-label", ariaLabel);
    control.disabled = disabled;
    control.addEventListener("click", onClick);
    return control;
  }

  function isAutomaticSinglesMatch(match, frame) {
    return frame.type === "singles"
      && ["singles_league", "tournament_flyer", "practice", "money_match"].includes(match.type);
  }

  function currentFramePlayers(frame, side) {
    return (frame.players || []).filter((player) => Number(player.side) === side)
      .sort((left, right) => Number(left.slot) - Number(right.slot));
  }

  function buildCardHeader(match, frames, permissions = {}, onScoreSide, onRetractSide) {
    const header = textElement("header", "match-scoreboard-header");
    const identity = textElement("div", "match-scoreboard-identity");
    const labelsRow = textElement("div", "match-scoreboard-labels");
    let timer = null;
    const context = [
      match.leagueName,
      match.divisionName,
      match.roundNumber ? "Round " + match.roundNumber : "",
      formatDate(match.scheduledAt),
      match.venue
    ].filter(Boolean).join(" · ");
    identity.append(textElement("h1", "match-scoreboard-title", "Match Centre scoreboard"));
    labelsRow.append(
      textElement("span", "match-category-tag", labels[match.type] || "Match"),
      textElement("span", "match-state-tag is-" + match.status, displayMatchStatus(match.status))
    );
    if (Number.isInteger(match.raceTo)) {
      labelsRow.append(textElement("span", "match-category-tag", "Race to " + match.raceTo));
    }
    identity.append(labelsRow);
    if (context) identity.append(textElement("p", "match-list-meta", context));
    if (match.testOnly === true) {
      identity.append(textElement("strong", "match-test-label", "TEST MATCH — EXCLUDED FROM STATISTICS"));
    }
    if (match.startedAt) {
      timer = textElement("time", "live-match-timer match-scoreboard-timer");
      timer.dataset.matchTimer = "";
      timer.setAttribute("aria-label", "Elapsed match time");
    }

    const score = textElement("div", "match-score-summary");
    score.setAttribute("aria-label", "Frame score: " + sideName(match, 1) + " " + match.homeScore + " to " + sideName(match, 2) + " " + match.awayScore);
    for (const side of [1, 2]) {
      const team = textElement("section", "match-score-side is-side-" + side);
      team.setAttribute("aria-label", sideName(match, side) + " frame score");
      team.append(
        textElement("span", "match-score-team", sideName(match, side)),
        textElement("strong", "match-score-number", String(side === 1 ? match.homeScore : match.awayScore))
      );
      if (permissions.canScore === true && match.status === "in_progress") {
        const controls = textElement("div", "match-score-actions");
        controls.append(actionButton("+", "match-score-control is-add",
          "Record a frame win for " + sideName(match, side), () => onScoreSide?.(side)));
        const correctable = [...(frames || [])].reverse().find((frame) =>
          frame.status === "completed" && frame.outcome === "played" && Number(frame.winnerSide) === side);
        controls.append(actionButton("−", "match-score-control is-correct",
          "Retract the latest played frame awarded to " + sideName(match, side),
          () => onRetractSide?.(side, correctable), !correctable));
        team.append(controls);
      }
      score.append(team);
    }
    const progressText = Number.isInteger(match.raceTo)
      ? `${match.framesCompleted} of ${match.framesTotal} possible frames · Race to ${match.raceTo}`
      : match.framesCompleted + " of " + match.framesTotal + " frames played · " + match.framesRemaining + " remaining";
    score.append(textElement("small", "match-score-progress", progressText));
    header.append(identity);
    if (timer) header.append(timer);
    header.append(score);
    return header;
  }

  let eligiblePlayerCache = new Map();
  async function loadEligiblePlayers(matchId, side) {
    if (!signedIn) return [];
    const key = matchId + ":" + side;
    if (!eligiblePlayerCache.has(key)) {
      eligiblePlayerCache.set(key, request("/api/matches/" + encodeURIComponent(matchId) + "/eligible-players?side=" + side)
        .then((result) => Array.isArray(result.players) ? result.players : [])
        .catch((error) => {
          eligiblePlayerCache.delete(key);
          throw error;
        }));
    }
    return eligiblePlayerCache.get(key);
  }

  function makeSelect(label, options, value = "", placeholderText = "Choose player") {
    const wrapper = textElement("label", "match-field");
    wrapper.append(textElement("span", "", label));
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = placeholderText;
    select.append(placeholder);
    options.forEach((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      item.disabled = option.disabled === true;
      select.append(item);
    });
    select.value = value;
    wrapper.append(select);
    return { wrapper, select };
  }

  function setFramePlayers(match, frame, side, players, bye = false) {
    return request("/api/matches/" + encodeURIComponent(match.id) + "/frames/" + frame.number + "/players", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, players, bye })
    });
  }

  function frameSelectionMatches(frame, side, values, slots) {
    const saved = currentFramePlayers(frame, side);
    if (saved.some((player) => player.isBye)) {
      return values.length === slots && values.every((value) => value === "__bye__");
    }
    const savedValues = Array.from({ length: slots }, (_, index) =>
      saved.find((player) => Number(player.slot) === index + 1)?.userId || "");
    return values.length === slots && values.every((value, index) => value === savedValues[index]);
  }

  async function buildFrameCard(frame, match, permissions = {}, isCurrent = false) {
    const card = textElement("article", "score-frame-card" + (frame.status === "completed" ? " is-complete" : "") + (isCurrent ? " is-current" : ""));
    const heading = textElement("div", "score-frame-heading");
    heading.append(
      textElement("span", "score-frame-number", "FRAME " + frame.number),
      textElement("span", "match-category-tag", frame.type === "singles" ? "Singles" : "Doubles"),
      textElement("span", "match-state-tag is-" + frame.status, displayMatchStatus(frame.status))
    );
    if (isCurrent) heading.append(textElement("span", "match-state-tag is-in_progress", "Current frame"));
    card.append(heading);

    if (frame.status === "completed") {
      const winning = sideName(match, frame.winnerSide);
      card.append(textElement("p", "score-frame-result",
        winning + " won" + (frame.outcome === "bye" ? " by Bye" : frame.outcome === "forfeit" ? " by forfeit" : "") + "."));
    }
    const selectedBySide = [1, 2].map((side) => {
      const selected = currentFramePlayers(frame, side);
      if (selected.some((player) => player.isBye)) return "Bye";
      return selected.map((player) => player.name).filter(Boolean).join(" / ");
    });
    if (isAutomaticSinglesMatch(match, frame) && frame.status !== "completed") {
      card.append(textElement("p", "score-frame-current-players is-singles-pair",
        sideName(match, 1) + " · " + sideName(match, 2)));
    } else if (frame.playersVisible === true && selectedBySide.some(Boolean)) {
      card.append(textElement("p", "score-frame-current-players",
        sideName(match, 1) + ": " + (selectedBySide[0] || "Players not selected") + " · " + sideName(match, 2) + ": " + (selectedBySide[1] || "Players not selected")));
    } else if (frame.playersVisible !== true && frame.status !== "completed") {
      card.append(textElement("p", "match-read-only-note", "Player selections for this upcoming frame are not published yet."));
    } else if (frame.playersVisible === true && !selectedBySide.some(Boolean)) {
      card.append(textElement("p", "score-frame-current-players", "Players have not been selected for this frame yet."));
    }
    if (frame.event?.type) {
      const eventLabel = frame.event.type === "counter_dish" ? "Counter Dish" : "Dish";
      const eventPlayer = (frame.players || []).find((player) => player.userId === frame.event.userId)?.name;
      card.append(textElement("p", "score-frame-event", eventLabel + (eventPlayer ? " · " + eventPlayer : "")));
    }

    const canManagePlayers = permissions.canScore === true
      && match.status === "in_progress" && frame.status !== "completed";
    const canScore = permissions.canScore === true;
    const isAutoSingles = isAutomaticSinglesMatch(match, frame);
    const slots = frame.type === "singles" ? 1 : 2;
    const selects = new Map();
    const eligibleBySide = new Map();
    let playerLoadError = "";

    if (canManagePlayers && !isAutoSingles) {
      const grid = textElement("div", "score-frame-sides");
      for (const side of [1, 2]) {
        const label = sideName(match, side);
        const fieldset = document.createElement("fieldset");
        fieldset.className = "score-frame-side is-side-" + side;
        fieldset.append(textElement("legend", "", label));
        let eligible = [];
        try {
          eligible = await loadEligiblePlayers(match.id, side);
          eligibleBySide.set(side, eligible);
        } catch (error) { playerLoadError ||= error.message; }
        const current = currentFramePlayers(frame, side);
        const available = new Map(eligible.map((player) => [player.userId, { value: player.userId, label: player.displayName }]));
        current.forEach((player) => {
          if (player.userId && !available.has(player.userId)) {
            available.set(player.userId, { value: player.userId, label: player.name + " (historical selection)", disabled: true });
          }
        });
        const options = [...available.values(), { value: "__bye__", label: "Bye" }];
        for (let slot = 1; slot <= slots; slot++) {
          const selected = current.find((player) => Number(player.slot) === slot);
          const value = selected?.isBye ? "__bye__" : selected?.userId || "";
          const field = makeSelect(slots === 1 ? label + " player" : label + " player " + slot, options, value);
          if (slots === 2 && slot === 2 && current.some((player) => player.isBye)) {
            field.select.value = "__bye__";
            field.select.disabled = true;
          }
          selects.set(side + ":" + slot, field.select);
          fieldset.append(field.wrapper);
        }
        grid.append(fieldset);
      }
      card.append(grid);
    }

    if (playerLoadError && canManagePlayers) card.append(textElement("p", "match-inline-status is-error", playerLoadError));

    if (canManagePlayers && !isAutoSingles) {
      const savePlayers = textElement("button", "button button-quiet", "Save players");
      savePlayers.type = "button";
      savePlayers.addEventListener("click", () => mutate(async () => {
        const sideData = [];
        for (const side of [1, 2]) {
          const values = Array.from({ length: slots }, (_, index) => selects.get(side + ":" + (index + 1)).value);
          const bye = values.includes("__bye__");
          if (bye && values.some((value) => value && value !== "__bye__")) throw new Error("Choose a full side of players or a full side Bye.");
          if (bye && slots === 2 && values.some((value) => value !== "__bye__" && value !== "")) throw new Error("A Doubles Bye fills both player slots.");
          sideData.push({ side, bye, players: values.filter((value) => value && value !== "__bye__") });
        }
        for (const selection of sideData) {
          await setFramePlayers(match, frame, selection.side, selection.players, selection.bye);
        }
      }, "Player selections saved."));
      card.append(savePlayers);
    }

    if (canManagePlayers && isAutoSingles) {
      try {
        for (const side of [1, 2]) eligibleBySide.set(side, await loadEligiblePlayers(match.id, side));
      } catch (error) { playerLoadError ||= error.message; }
    }

    let eventField = null;
    let eventPlayer = null;
    if (canManagePlayers) {
      const scoringDetails = textElement("div", "score-frame-event-controls");
      eventField = makeSelect("Frame achievement", [
        { value: "none", label: "No Dish" },
        { value: "dish", label: "Dish" },
        { value: "counter_dish", label: "Counter Dish" }
      ], frame.event?.type || "none", "Choose achievement");
      const eventOptions = [1, 2].flatMap((side) =>
        (eligibleBySide.get(side) || []).map((player) => ({ value: player.userId, label: sideName(match, side) + " · " + player.displayName })));
      eventPlayer = makeSelect("Player credited", eventOptions, frame.event?.userId || "", "Choose player");
      eventPlayer.select.disabled = eventField.select.value === "none" || eventOptions.length === 0;
      eventField.select.addEventListener("change", () => {
        eventPlayer.select.disabled = eventField.select.value === "none" || eventOptions.length === 0;
        if (eventField.select.value === "none") eventPlayer.select.value = "";
      });
      scoringDetails.append(eventField.wrapper, eventPlayer.wrapper,
        textElement("p", "match-read-only-note", "Dish and Counter Dish are recorded with the frame result and attributed to one of its selected players."));
      card.append(scoringDetails);
    }

    let scoreFrameForSide = null;
    if (canScore && isCurrent) {
      scoreFrameForSide = (side) => mutate(async () => {
        if (![1, 2].includes(side)) throw new Error("Choose a valid scoring side.");
        let byeSide = null;
        if (isAutoSingles) {
          for (const targetSide of [1, 2]) {
            const eligible = eligibleBySide.get(targetSide) || await loadEligiblePlayers(match.id, targetSide);
            if (eligible.length !== 1) throw new Error("The registered Singles participants could not be confirmed.");
            const selected = currentFramePlayers(frame, targetSide);
            if (selected.length !== 1 || selected[0].userId !== eligible[0].userId) {
              await setFramePlayers(match, frame, targetSide, [eligible[0].userId]);
            }
          }
        } else {
          for (const targetSide of [1, 2]) {
            const values = Array.from({ length: slots }, (_, index) => selects.get(targetSide + ":" + (index + 1))?.value || "");
            const bye = values.includes("__bye__");
            if (bye) {
              if (!values.every((value) => value === "__bye__")) throw new Error("A Bye fills every player slot on its side.");
              if (!frameSelectionMatches(frame, targetSide, values, slots)) throw new Error("Save player selections before recording this frame.");
              byeSide = targetSide;
              continue;
            }
            if (values.some((value) => !value)) throw new Error("Select and save the players for both sides before recording this frame.");
            if (!frameSelectionMatches(frame, targetSide, values, slots)) throw new Error("Save player selections before recording this frame.");
          }
        }

        const existingByeSide = [1, 2].find((targetSide) => currentFramePlayers(frame, targetSide).some((player) => player.isBye));
        const recordedByeSide = byeSide || existingByeSide || null;
        if (recordedByeSide && side === recordedByeSide) throw new Error("A Bye cannot receive the frame win.");
        if (eventField?.select.value !== "none") {
          const eventPlayerId = eventPlayer?.select.value;
          const eligibleWinner = isAutoSingles
            ? (eligibleBySide.get(side) || []).some((player) => player.userId === eventPlayerId)
            : currentFramePlayers(frame, side).some((player) => player.userId === eventPlayerId);
          if (!eventPlayerId || !eligibleWinner) throw new Error("Choose a player from the winning side for the Dish or Counter Dish.");
        }

        const outcome = recordedByeSide ? "bye" : "played";
        await request("/api/matches/" + encodeURIComponent(match.id) + "/frames/" + frame.number + "/result", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            outcome,
            winnerSide: outcome === "played" ? side : undefined,
            dishEvent: outcome === "played" && eventField?.select.value !== "none" ? eventField.select.value : null,
            dishPlayerId: outcome === "played" && eventField?.select.value !== "none" ? eventPlayer?.select.value : null
          })
        });
      }, "Frame result saved.");
    }

    if (frame.status === "completed" && frame.outcome === "played" && canScore && match.status === "in_progress") {
      const correction = textElement("details", "score-frame-correction");
      correction.append(textElement("summary", "", "Correct this frame"));
      const actions = textElement("div", "score-frame-correction-actions");
      for (const side of [1, 2]) {
        actions.append(actionButton("Award to " + sideName(match, side), "button button-quiet",
          "Correct frame " + frame.number + " winner to " + sideName(match, side), () => {
            if (!window.confirm("Correct frame " + frame.number + " to " + sideName(match, side) + "? This audited correction will clear any Dish or Counter Dish recorded on that frame.")) return;
            mutate(async () => {
              await request("/api/matches/" + encodeURIComponent(match.id) + "/frames/" + frame.number + "/result", {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ outcome: "played", winnerSide: side, dishEvent: null, dishPlayerId: null })
              });
            }, "Frame correction recorded in match history.");
          }));
      }
      if (frame.playersVisible === true) {
        const eventCorrection = textElement("div", "score-frame-event-correction");
        const eventType = makeSelect("Dish record", [
          { value: "none", label: "No Dish" }, { value: "dish", label: "Dish" }, { value: "counter_dish", label: "Counter Dish" }
        ], frame.event?.type || "none", "Choose record");
        const eventUsers = (frame.players || []).filter((player) => player.userId)
          .map((player) => ({ value: player.userId, label: sideName(match, Number(player.side)) + " · " + player.name }));
        const eventUser = makeSelect("Player credited", eventUsers, frame.event?.userId || "", "Choose player");
        const saveEvent = textElement("button", "button button-quiet", "Save Dish correction");
        saveEvent.type = "button";
        saveEvent.addEventListener("click", () => mutate(async () => {
          const type = eventType.select.value === "none" ? null : eventType.select.value;
          if (type && !eventUser.select.value) throw new Error("Choose the player credited for this Dish or Counter Dish.");
          await request("/api/matches/" + encodeURIComponent(match.id) + "/frames/" + frame.number + "/event", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, userId: type ? eventUser.select.value : null })
          });
        }, "Dish correction saved in match history."));
        eventCorrection.append(eventType.wrapper, eventUser.wrapper, saveEvent);
        actions.append(eventCorrection);
      }
      correction.append(actions);
      card.append(correction);
    }
    return { element: card, scoreFrameForSide };
  }
  async function renderMatch(result) {
    matchData = result;
    eligiblePlayerCache = new Map();
    const match = result.match;
    const isFinal = match.status === "completed";
    title.innerHTML = isFinal ? "FINAL<br><em>RESULT.</em>" : "MATCH<br><em>SCOREBOARD.</em>";
    sectionTitle.innerHTML = isFinal ? "COMPLETED<br><span>MATCH.</span>" : "LIVE<br><span>SCOREBOARD.</span>";
    sectionKicker.textContent = isFinal ? "FINAL RESULT" : labels[match.type] || "MATCH";
    intro.textContent = `${matchLabel(match)} · ${displayMatchStatus(match.status)}`;
    list.hidden = true;
    detail.hidden = false;
    page.classList.add("has-match-detail");
    detail.replaceChildren();

    const framesList = result.frames || [];
    const permissions = result.permissions || {};
    const currentFrame = match.status === "in_progress"
      ? framesList.find((frame) => frame.status !== "completed") || null
      : null;
    const currentView = currentFrame
      ? await buildFrameCard(currentFrame, match, permissions, true)
      : null;
    const onRetractSide = (side, frame) => {
      if (!frame) return;
      if (!window.confirm(`Retract the latest played frame awarded to ${sideName(match, side)} (frame ${frame.number})? This audited action removes that frame result, preserves its player selection and clears any Dish or Counter Dish recorded on it.`)) return;
      mutate(async () => {
        await request(`/api/matches/${encodeURIComponent(match.id)}/frames/${frame.number}/result`, { method: "DELETE" });
      }, "Frame result retracted and recorded in match history.");
    };
    detail.append(buildCardHeader(match, framesList, permissions, currentView?.scoreFrameForSide, onRetractSide));

    if (permissions.canOperate !== true) {
      const access = textElement("p", "match-access-note", "Read-only match view. Scoreboard controls are limited to registered players in this match.");
      const login = textElement("a", "button button-quiet", "Log in");
      login.href = `login.html?next=${encodeURIComponent(`match.html?id=${match.id}`)}`;
      detail.append(access);
      if (!signedIn) detail.append(login);
    }
    if (permissions.canStart === true && match.status === "scheduled") {
      const start = textElement("button", "button button-gold", "Start Match");
      start.type = "button";
      start.addEventListener("click", () => {
        if (!startDialog || !startDialogMatchup) return;
        startDialogMatchup.textContent = matchLabel(match);
        if (startDialogStatus) startDialogStatus.textContent = "";
        startDialog.showModal();
        confirmStartButton?.focus();
      });
      detail.append(start);
    }

    if (currentView) {
      const active = textElement("section", "score-frame-active");
      active.setAttribute("aria-label", `Current frame ${currentFrame.number}`);
      active.append(currentView.element);
      detail.append(active);
    }
    const completedFrames = framesList.filter((frame) => frame.status === "completed");
    if (completedFrames.length) {
      const history = textElement("details", "score-frame-group is-history");
      history.append(textElement("summary", "", `Completed frames · ${completedFrames.length}`));
      const cards = textElement("div", "score-frame-list");
      for (const frame of completedFrames) {
        const row = textElement("details", "score-frame-history-row");
        const summary = document.createElement("summary");
        const winner = [1, 2].includes(Number(frame.winnerSide))
          ? sideName(match, Number(frame.winnerSide))
          : frame.outcome === "draw" ? "Draw" : "Result pending";
        const eventLabel = frame.event?.type === "counter_dish" ? "Counter Dish"
          : frame.event?.type === "dish" ? "Dish" : "No Dish recorded";
        const eventPlayer = frame.event?.userId
          ? (frame.players || []).find((player) => player.userId === frame.event.userId)?.name
          : "";
        summary.append(
          textElement("span", "score-frame-history-number", `Frame ${frame.number}`),
          textElement("span", "score-frame-history-winner", ["Draw", "Result pending"].includes(winner) ? winner : `${winner} won`),
          textElement("span", "score-frame-history-event", eventPlayer ? `${eventLabel} · ${eventPlayer}` : eventLabel)
        );
        row.append(summary);
        row.addEventListener("toggle", async () => {
          if (!row.open || row.dataset.loaded === "true" || row.dataset.loading === "true") return;
          row.dataset.loading = "true";
          try {
            const view = await buildFrameCard(frame, match, permissions, false);
            view.element.classList.add("score-frame-history-detail");
            row.append(view.element);
            row.dataset.loaded = "true";
          } finally {
            delete row.dataset.loading;
          }
        });
        cards.append(row);
      }
      history.append(cards);
      detail.append(history);
    }
    const upcomingFrames = framesList.filter((frame) => frame.status !== "completed" && frame.number !== currentFrame?.number);
    if (upcomingFrames.length) {
      const upcoming = textElement("details", "score-frame-group is-upcoming");
      const visibleUpcoming = upcomingFrames.slice(0, 10);
      upcoming.append(textElement("summary", "", `Upcoming frames · ${upcomingFrames.length}`));
      const cards = textElement("div", "score-frame-list");
      for (const frame of visibleUpcoming) {
        const view = await buildFrameCard(frame, match, permissions, false);
        cards.append(view.element);
      }
      if (visibleUpcoming.length < upcomingFrames.length) {
        cards.append(textElement("p", "match-read-only-note", `The next ${visibleUpcoming.length} frames are shown. Later frames will appear as the match progresses.`));
      }
      upcoming.append(cards);
      detail.append(upcoming);
    }
    if (!framesList.length) detail.append(textElement("p", "match-read-only-note", "Frame details are not available for this match."));

    const confirmationSection = textElement("section", "match-confirmation-panel");
    confirmationSection.append(textElement("h3", "", "Result confirmation"));
    const latest = latestConfirmations(result.confirmations);
    const confirmed = [1, 2].filter((side) => latest.get(side)?.action === "confirmed");
    const retractableSides = Array.isArray(result.permissions?.retractableSides) ? result.permissions.retractableSides.map(Number) : [];
    confirmationSection.append(textElement("p", "", `${sideName(match, 1)}: ${latest.get(1)?.action === "confirmed" ? "confirmed" : "awaiting confirmation"} · ${sideName(match, 2)}: ${latest.get(2)?.action === "confirmed" ? "confirmed" : "awaiting confirmation"}`));
    const confirmableSides = Array.isArray(permissions.confirmableSides) ? permissions.confirmableSides.map(Number) : [];
    if (confirmableSides.length) {
      let confirmationSideSelect = null;
      if (match.type === "team_league" && confirmableSides.length > 1) {
        const sideField = makeSelect("Team side to confirm", confirmableSides.map((side) => ({ value: String(side), label: sideName(match, side) })), String(confirmableSides[0]));
        confirmationSideSelect = sideField.select;
        confirmationSection.append(sideField.wrapper);
      }
      const confirm = textElement("button", "button button-gold", match.type === "team_league" ? "Confirm result for selected side" : "Confirm my side's result");
      confirm.type = "button";
      confirm.addEventListener("click", () => mutate(async () => {
        const side = match.type === "team_league" ? Number(confirmationSideSelect?.value || confirmableSides[0]) : undefined;
        if (match.type === "team_league" && !confirmableSides.includes(side)) throw new Error("You are not authorised to confirm that side.");
        await request(`/api/matches/${encodeURIComponent(match.id)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(side ? { side } : {}) });
      }, "Confirmation recorded."));
      confirmationSection.append(confirm);
    }
    if (retractableSides.length) {
      let retractionSideSelect = null;
      if (match.type === "team_league" && retractableSides.length > 1) {
        const sideField = makeSelect("Team side to retract", retractableSides.map((side) => ({ value: String(side), label: sideName(match, side) })), String(retractableSides[0]));
        retractionSideSelect = sideField.select;
        confirmationSection.append(sideField.wrapper);
      }
      const retract = textElement("button", "button button-quiet", "Retract this side's confirmation");
      retract.type = "button";
      retract.addEventListener("click", () => mutate(async () => {
        const side = match.type === "team_league" ? Number(retractionSideSelect?.value || retractableSides[0]) : undefined;
        if (match.type === "team_league" && !retractableSides.includes(side)) throw new Error("You are not authorised to retract that side's confirmation.");
        await request(`/api/matches/${encodeURIComponent(match.id)}/confirm/retract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(side ? { side } : {}) });
      }, "Confirmation retracted."));
      confirmationSection.append(retract);
    }
    if (permissions.canRaiseDispute === true) {
      const disputeForm = document.createElement("form");
      disputeForm.className = "match-dispute-form";
      const reasonField = textElement("label", "match-field");
      reasonField.append(textElement("span", "", "Raise a dispute"));
      const reason = document.createElement("textarea"); reason.required = true; reason.maxLength = 1000; reason.rows = 3; reason.placeholder = "Explain the result concern";
      reasonField.append(reason);
      const dispute = textElement("button", "button button-quiet", "Submit dispute"); dispute.type = "submit";
      disputeForm.append(reasonField, dispute);
      disputeForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!reason.reportValidity()) return;
        mutate(async () => {
          await request(`/api/matches/${encodeURIComponent(match.id)}/disputes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.value }) });
        }, "Dispute recorded.");
      });
      confirmationSection.append(disputeForm);
    }
    if (match.status === "completed") confirmationSection.append(textElement("p", "match-final-note", "This result is final. Confirmations and score changes remain in the audit history."));
    if (permissions.canFinalize === true && confirmed.length === 2 && match.status === "awaiting_confirmation") {
      const finalize = textElement("button", "button button-gold", "Finalize result"); finalize.type = "button";
      finalize.addEventListener("click", () => mutate(async () => {
        await request(`/api/matches/${encodeURIComponent(match.id)}/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      }, "Result finalized."));
      confirmationSection.append(finalize);
    }
    detail.append(confirmationSection);

    if (permissions.canViewAudit === true) {
      const audit = textElement("details", "match-audit-panel");
      audit.append(textElement("summary", "", "Match activity history"));
      const auditContent = textElement("ol", "match-audit-list", "Loading activity…");
      audit.append(auditContent);
      audit.addEventListener("toggle", async () => {
        if (!audit.open || audit.dataset.loaded) return;
        audit.dataset.loaded = "true";
        try {
          const payload = await request(`/api/matches/${encodeURIComponent(match.id)}/audit`);
          auditContent.replaceChildren();
          if (!payload.events?.length) auditContent.append(textElement("li", "", "No recorded actions yet."));
          for (const item of payload.events || []) auditContent.append(textElement("li", "", `${formatDate(item.occurred_at)} · ${item.action_type.replaceAll("_", " ")}`));
        } catch (error) { auditContent.textContent = error.message; }
      });
      detail.append(audit);
    }
    updateMatchTimer();
    syncMatchPolling();
  }

  function matchSnapshot(result) {
    return JSON.stringify({ match: result.match, frames: result.frames, confirmations: result.confirmations, disputes: result.disputes });
  }

  function updateMatchTimer() {
    const match = matchData?.match;
    if (!match?.startedAt) return;
    const value = formatElapsed(match.startedAt, match.completedAt);
    detail.querySelectorAll("[data-match-timer]").forEach((timer) => {
      timer.textContent = value;
      timer.setAttribute("aria-label", `Elapsed match time ${value}`);
    });
  }

  function syncMatchPolling() {
    const match = matchData?.match;
    const shouldPoll = ["in_progress", "awaiting_confirmation", "disputed"].includes(match?.status);
    if (shouldPoll && !matchPollTimer) {
      matchPollTimer = window.setInterval(refreshCurrentMatch, 4000);
      matchClockTimer = window.setInterval(updateMatchTimer, 1000);
    } else if (!shouldPoll) {
      if (matchPollTimer) window.clearInterval(matchPollTimer);
      if (matchClockTimer) window.clearInterval(matchClockTimer);
      matchPollTimer = null;
      matchClockTimer = null;
    }
  }

  async function loadMatch(matchId, { quiet = false, onlyIfChanged = false } = {}) {
    if (!quiet) setStatus("Loading match details…", "pending");
    const requestStartedAt = Date.now();
    const result = await request(`/api/matches/${encodeURIComponent(matchId)}`, { cache: "no-store" });
    const requestFinishedAt = Date.now();
    const serverTime = Date.parse(result.serverTime || "");
    if (Number.isFinite(serverTime)) serverOffsetMs = serverTime - ((requestStartedAt + requestFinishedAt) / 2);
    const snapshot = matchSnapshot(result);
    if (onlyIfChanged && snapshot === lastRenderedSnapshot) {
      matchData = result;
      updateMatchTimer();
      return;
    }
    await renderMatch(result);
    lastRenderedSnapshot = snapshot;
    if (!quiet) setStatus("Match details loaded.", "success");
  }

  async function refreshCurrentMatch() {
    if (matchRefreshInFlight || mutationPending || document.visibilityState !== "visible" || !matchData?.match?.id) return;
    const active = document.activeElement;
    const scoringControlFocused = detail.contains(active) && active.matches("select, input, textarea, button");
    if (scoringControlFocused || pendingFormChanges || detail.querySelector("details[open]")) return;
    matchRefreshInFlight = true;
    try {
      await loadMatch(matchData.match.id, { quiet: true, onlyIfChanged: true });
    } catch (error) {
      setStatus(error instanceof TypeError ? "Live updates are temporarily unavailable. The displayed score may be out of date." : error.message, "error");
    } finally {
      matchRefreshInFlight = false;
    }
  }

  async function mutate(action, successMessage) {
    if (mutationPending) return false;
    mutationPending = true;
    const scrollPosition = window.scrollY;
    const focusedControlLabel = document.activeElement?.closest?.("button")?.getAttribute("aria-label") || null;
    const buttons = detail.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    setStatus("Saving scoreboard update…", "pending");
    try {
      await action();
      pendingFormChanges = false;
      const id = new URLSearchParams(window.location.search).get("id");
      await loadMatch(id, { quiet: true });
      if (successMessage) setStatus(successMessage, "success");
      const replacementControl = focusedControlLabel
        ? Array.from(detail.querySelectorAll("button[aria-label]")).find((button) => button.getAttribute("aria-label") === focusedControlLabel && !button.disabled)
        : null;
      const focusTarget = replacementControl || status;
      focusTarget?.focus?.({ preventScroll: true });
      window.scrollTo(0, scrollPosition);
      requestAnimationFrame(() => window.scrollTo(0, scrollPosition));
      return true;
    } catch (error) {
      setStatus(error instanceof TypeError ? "We couldn't reach the match service. Your changes were not confirmed." : error.message, "error");
      buttons.forEach((button) => { button.disabled = false; });
      return false;
    } finally {
      mutationPending = false;
    }
  }

  detail.addEventListener("change", (event) => {
    if (event.target.matches("select, input, textarea")) pendingFormChanges = true;
  });
  detail.addEventListener("input", (event) => {
    if (event.target.matches("input, textarea")) pendingFormChanges = true;
  });
  confirmStartButton?.addEventListener("click", async () => {
    if (!matchData?.match?.id || mutationPending) return;
    confirmStartButton.disabled = true;
    const started = await mutate(async () => {
      await request(`/api/matches/${encodeURIComponent(matchData.match.id)}/start`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
    }, "Match started.");
    if (started) startDialog?.close();
    else if (startDialogStatus) startDialogStatus.textContent = status.textContent;
    confirmStartButton.disabled = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      updateMatchTimer();
      refreshCurrentMatch();
    }
  });
  window.addEventListener("pagehide", () => {
    if (matchPollTimer) window.clearInterval(matchPollTimer);
    if (matchClockTimer) window.clearInterval(matchClockTimer);
  }, { once: true });

  async function initialise() {
    await loadSession();
    const search = new URLSearchParams(window.location.search);
    const matchId = search.get("id");
    filterLeagueId = search.get("leagueId");
    previousMatches = search.get("status") === "completed";
    if (matchId) {
      try { await loadMatch(matchId); }
      catch (error) { setStatus(error.message, "error"); }
      return;
    }
    if (previousMatches) {
      document.title = "Previous Matches | BREAK DISH";
      title.innerHTML = "PREVIOUS<br><em>MATCHES.</em>";
      sectionTitle.innerHTML = "COMPLETED<br><span>RESULTS.</span>";
      sectionKicker.textContent = "PREVIOUS MATCHES";
      intro.textContent = "Completed match scores and final details from leagues and competitions.";
      page.querySelector(".match-hero > p").textContent = "Browse finished matches and their confirmed final scores. Open any match to review its read-only result and frame details.";
      page.querySelector("[data-nav-previous-matches]")?.setAttribute("aria-current", "page");
    } else if (filterLeagueId) {
      title.innerHTML = "LEAGUE<br><em>MATCHES.</em>";
      sectionTitle.innerHTML = "FIXTURES<br><span>&amp; RESULTS.</span>";
      sectionKicker.textContent = "LEAGUE MATCHES";
      intro.textContent = "Fixtures and recorded results for this league will appear here when organisers publish them.";
      const competitionLink = page.querySelector("[data-match-league-link]");
      if (competitionLink) competitionLink.href = `competition.html?id=${encodeURIComponent(filterLeagueId)}`;
    }
    setStatus(previousMatches ? "Loading completed matches…" : filterLeagueId ? "Loading this league's matches…" : "Loading public matches…", "pending");
    try {
      const filters = new URLSearchParams();
      if (filterLeagueId) filters.set("leagueId", filterLeagueId);
      if (previousMatches) filters.set("status", "completed");
      const query = filters.toString();
      const endpoint = query ? `/api/matches?${query}` : "/api/matches";
      const payload = await request(endpoint);
      if (filterLeagueId && payload.matches?.[0]?.leagueName) {
        intro.textContent = `${payload.matches[0].leagueName}: fixtures and recorded results published by league organisers.`;
      }
      renderMatchList(payload.matches || []);
    } catch (error) {
      setStatus(error instanceof TypeError ? "We couldn't reach the match service. Please try again later." : error.message, "error");
    }
  }

  initialise();
}
