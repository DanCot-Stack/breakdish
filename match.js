const page = document.querySelector("[data-match-page]");

if (page) {
  const api = window.BreakDishApi;
  const status = page.querySelector("[data-match-status]");
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

  function renderMatchList(matches) {
    list.replaceChildren();
    if (!matches.length) {
      setStatus(filterLeagueId
        ? "No fixtures or results have been published for this league yet."
        : "No public matches are listed yet. Match schedules will appear here when organisers publish them.", "success");
      return;
    }
    for (const match of matches) {
      const card = textElement("article", "match-list-card");
      const header = textElement("div", "match-list-card-header");
      header.append(
        textElement("span", "match-category-tag", labels[match.type] || "Match"),
        textElement("span", `match-state-tag is-${match.status}`, match.status.replaceAll("_", " "))
      );
      const name = textElement("h3", "", matchLabel(match));
      const meta = textElement("p", "match-list-meta", `${formatDate(match.scheduledAt)}${match.divisionName ? ` · ${match.divisionName}` : ""}${match.venue ? ` · ${match.venue}` : ""}`);
      const score = textElement("p", "match-list-score", `${match.homeScore} — ${match.awayScore}`);
      const link = textElement("a", "button button-gold", "Open scoreboard");
      link.href = `match.html?id=${encodeURIComponent(match.id)}`;
      card.append(header, name, meta, score, link);
      list.append(card);
    }
    setStatus(`${matches.length} ${matches.length === 1 ? "match" : "matches"} listed.`, "success");
  }

  function currentSidePlayers(frame, side) {
    return (frame.players || []).filter((player) => Number(player.side) === side && player.userId);
  }

  function latestConfirmations(confirmations) {
    const latest = new Map();
    for (const confirmation of confirmations || []) latest.set(Number(confirmation.side), confirmation);
    return latest;
  }

  function buildCardHeader(match) {
    const header = textElement("header", "match-scoreboard-header");
    const identity = textElement("div", "match-scoreboard-identity");
    identity.append(
      textElement("span", "match-category-tag", labels[match.type] || "Match"),
      textElement("h2", "", matchLabel(match)),
      textElement("p", "match-list-meta", `${formatDate(match.scheduledAt)}${match.venue ? ` · ${match.venue}` : ""}`)
    );
    if (match.status === "in_progress") identity.append(textElement("span", "live-indicator", "LIVE"));
    if (match.startedAt) {
      const timer = textElement("time", "live-match-timer match-scoreboard-timer");
      timer.dataset.matchTimer = "";
      identity.append(timer);
    }
    const score = textElement("div", "match-score-summary");
    score.setAttribute("aria-label", `Score ${match.homeScore} to ${match.awayScore}`);
    score.append(
      textElement("span", "match-score-team", sideName(match, 1)),
      textElement("strong", "match-score-number", `${match.homeScore} – ${match.awayScore}`),
      textElement("span", "match-score-team", sideName(match, 2)),
      textElement("small", "", `${match.framesCompleted} played · ${match.framesRemaining} remaining`)
    );
    header.append(identity, score);
    return header;
  }

  async function loadEligiblePlayers(matchId, side) {
    if (!signedIn) return [];
    const result = await request(`/api/matches/${encodeURIComponent(matchId)}/eligible-players?side=${side}`);
    return Array.isArray(result.players) ? result.players : [];
  }

  function makeSelect(label, options, value = "") {
    const wrapper = textElement("label", "match-field");
    wrapper.append(textElement("span", "", label));
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose player";
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

  async function buildFrameCard(frame, match, isCurrent = false) {
    const card = textElement("article", `score-frame-card${frame.status === "completed" ? " is-complete" : ""}${isCurrent ? " is-current" : ""}`);
    const heading = textElement("div", "score-frame-heading");
    heading.append(
      textElement("span", "score-frame-number", `FRAME ${frame.number}`),
      textElement("span", "match-category-tag", frame.type === "singles" ? "Singles" : "Doubles"),
      textElement("span", `match-state-tag is-${frame.status}`, frame.status.replaceAll("_", " "))
    );
    if (isCurrent) heading.append(textElement("span", "match-state-tag is-in_progress", "Current frame"));
    card.append(heading);
    if (frame.status === "completed") {
      const winning = sideName(match, frame.winnerSide);
      card.append(textElement("p", "score-frame-result", `${winning} won${frame.outcome === "bye" ? " by Bye" : frame.outcome === "forfeit" ? " by forfeit" : ""}.`));
    }
    const selectedBySide = [1, 2].map((side) => {
      const selected = (frame.players || []).filter((player) => Number(player.side) === side);
      if (selected.some((player) => player.isBye)) return "Bye";
      return selected.map((player) => player.name).filter(Boolean).join(" / ");
    });
    if (selectedBySide.some(Boolean)) {
      card.append(textElement("p", "score-frame-current-players",
        `${sideName(match, 1)}: ${selectedBySide[0] || "Players not selected"} · ${sideName(match, 2)}: ${selectedBySide[1] || "Players not selected"}`));
    }
    if (frame.event?.type) {
      const eventLabel = frame.event.type === "counter_dish" ? "Counter Dish" : "Dish";
      const eventPlayer = (frame.players || []).find((player) => player.userId === frame.event.userId)?.name;
      card.append(textElement("p", "score-frame-event", `${eventLabel}${eventPlayer ? ` · ${eventPlayer}` : ""}`));
    }
    const grid = textElement("div", "score-frame-sides");
    const canEditResult = signedIn && match.status === "in_progress";
    const editable = canEditResult && frame.status !== "completed";
    const slots = frame.type === "singles" ? 1 : 2;
    const selects = new Map();
    let playerLoadError = "";
    for (const side of [1, 2]) {
      const label = sideName(match, side);
      const fieldset = document.createElement("fieldset");
      fieldset.className = "score-frame-side";
      fieldset.append(textElement("legend", "", label));
      let eligible = [];
      if (signedIn) {
        try { eligible = await loadEligiblePlayers(match.id, side); }
        catch (error) { playerLoadError ||= error.message; }
      }
      const current = (frame.players || []).filter((player) => Number(player.side) === side).sort((a, b) => Number(a.slot) - Number(b.slot));
      const available = new Map(eligible.map((player) => [player.userId, { value: player.userId, label: player.displayName }]));
      current.forEach((player) => {
        if (player.userId && !available.has(player.userId)) {
          available.set(player.userId, { value: player.userId, label: `${player.name} (historical selection)`, disabled: true });
        }
      });
      const options = [...available.values(), { value: "__bye__", label: "Bye" }];
      for (let slot = 1; slot <= slots; slot++) {
        const selected = current.find((player) => Number(player.slot) === slot);
        const value = selected?.isBye ? "__bye__" : selected?.userId || "";
        const field = makeSelect(slots === 1 ? `${label} player` : `${label} player ${slot}`, options, value);
        field.select.disabled = !editable;
        if (slots === 2 && slot === 2 && current.some((player) => player.isBye)) {
          field.select.value = "__bye__";
          field.select.disabled = true;
        }
        selects.set(`${side}:${slot}`, field.select);
        fieldset.append(field.wrapper);
      }
      grid.append(fieldset);
    }
    card.append(grid);
    if (playerLoadError && editable) card.append(textElement("p", "match-inline-status is-error", playerLoadError));

    if (editable) {
      const savePlayers = textElement("button", "button button-quiet", "Save players");
      savePlayers.type = "button";
      savePlayers.addEventListener("click", () => mutate(async () => {
        const sideData = [];
        for (const side of [1, 2]) {
          const values = Array.from({ length: slots }, (_, index) => selects.get(`${side}:${index + 1}`).value);
          const bye = values.includes("__bye__");
          if (bye && values.some((value) => value && value !== "__bye__")) throw new Error("Choose a full side of players or a full side Bye.");
          if (bye && slots === 2 && values.some((value) => value !== "__bye__" && value !== "")) throw new Error("A Doubles Bye fills both player slots.");
          sideData.push({ side, bye, players: values.filter((value) => value && value !== "__bye__") });
        }
        for (const selection of sideData) {
          await request(`/api/matches/${encodeURIComponent(match.id)}/frames/${frame.number}/players`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ side: selection.side, bye: selection.bye, players: selection.players })
          });
        }
      }, "Player selections saved."));
      card.append(savePlayers);
    }

    if (canEditResult) {
      const resultForm = textElement("div", "score-frame-result-form");
      const winnerField = makeSelect("Frame winner", [
        { value: "1", label: sideName(match, 1) }, { value: "2", label: sideName(match, 2) }
      ], frame.winnerSide ? String(frame.winnerSide) : "");
      const eventField = makeSelect("Frame event", [
        { value: "none", label: "No Dish" }, { value: "dish", label: "Dish" }, { value: "counter_dish", label: "Counter Dish" }
      ], frame.event?.type || "none");
      const eventPlayer = makeSelect("Winning player", [], frame.event?.userId || "");
      const refreshWinnerOptions = () => {
        const selectedSide = Number(winnerField.select.value);
        const players = Array.from({ length: slots }, (_, index) => selects.get(`${selectedSide}:${index + 1}`)?.value).filter((value) => value && value !== "__bye__");
        const currentValue = eventPlayer.select.value;
        const displayNames = new Map((frame.players || []).map((player) => [player.userId, player.name]));
        eventPlayer.select.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = ""; placeholder.textContent = "Choose winning player"; eventPlayer.select.append(placeholder);
        players.forEach((userId) => {
          const option = document.createElement("option");
          option.value = userId;
          option.textContent = displayNames.get(userId) || userId;
          eventPlayer.select.append(option);
        });
        if (players.includes(currentValue)) eventPlayer.select.value = currentValue;
      };
      refreshWinnerOptions();
      winnerField.select.addEventListener("change", refreshWinnerOptions);
      for (const field of [winnerField, eventField, eventPlayer]) field.select.disabled = !canEditResult;
      resultForm.append(winnerField.wrapper, eventField.wrapper, eventPlayer.wrapper);
      const saveResult = textElement("button", "button button-gold", frame.status === "completed" ? "Update frame result" : "Record frame result");
      saveResult.type = "button";
      saveResult.addEventListener("click", () => mutate(async () => {
        const hasBye = Array.from(selects.values()).some((select) => select.value === "__bye__");
        if (hasBye) {
          await request(`/api/matches/${encodeURIComponent(match.id)}/frames/${frame.number}/result`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome: "bye" })
          });
        } else {
          if (!winnerField.select.value) throw new Error("Choose the frame winner.");
          const eventType = eventField.select.value === "none" ? null : eventField.select.value;
          if (eventType && !eventPlayer.select.value) throw new Error("Choose the winning player for this Dish or Counter Dish.");
          await request(`/api/matches/${encodeURIComponent(match.id)}/frames/${frame.number}/result`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ outcome: "played", winnerSide: Number(winnerField.select.value), dishEvent: eventType, dishPlayerId: eventPlayer.select.value || null })
          });
        }
      }, "Frame result saved."));
      resultForm.append(saveResult);
      card.append(resultForm);
    }
    return card;
  }

  async function renderMatch(result) {
    matchData = result;
    const match = result.match;
    title.innerHTML = "MATCH<br><em>SCOREBOARD.</em>";
    sectionTitle.innerHTML = "LIVE<br><span>SCOREBOARD.</span>";
    sectionKicker.textContent = labels[match.type] || "MATCH";
    intro.textContent = `${matchLabel(match)} · ${match.status.replaceAll("_", " ")}`;
    list.hidden = true;
    detail.hidden = false;
    detail.replaceChildren();
    detail.append(buildCardHeader(match));
    const stateText = match.status === "in_progress" ? "LIVE · Match in progress." : `Match state: ${match.status.replaceAll("_", " ")}.`;
    const state = textElement("p", `match-state-banner is-${match.status}`, `${stateText} ${match.framesCompleted} of ${match.framesTotal} frames complete.`);
    detail.append(state);

    if (!signedIn) {
      const access = textElement("p", "match-access-note", "Sign in to update a scoreboard, select players or confirm a result.");
      const login = textElement("a", "button button-quiet", "Log in");
      login.href = `login.html?next=${encodeURIComponent(`match.html?id=${match.id}`)}`;
      detail.append(access, login);
    } else if (match.status === "scheduled") {
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

    const frames = textElement("div", "score-frame-list");
    const currentFrameNumber = match.status === "in_progress"
      ? (result.frames || []).find((frame) => frame.status !== "completed")?.number
      : null;
    for (const frame of result.frames || []) frames.append(await buildFrameCard(frame, match, frame.number === currentFrameNumber));
    detail.append(frames);

    const confirmationSection = textElement("section", "match-confirmation-panel");
    confirmationSection.append(textElement("h3", "", "Result confirmation"));
    const latest = latestConfirmations(result.confirmations);
    const confirmed = [1, 2].filter((side) => latest.get(side)?.action === "confirmed");
    confirmationSection.append(textElement("p", "", `${sideName(match, 1)}: ${latest.get(1)?.action === "confirmed" ? "confirmed" : "awaiting confirmation"} · ${sideName(match, 2)}: ${latest.get(2)?.action === "confirmed" ? "confirmed" : "awaiting confirmation"}`));
    if (signedIn && ["awaiting_confirmation", "disputed"].includes(match.status)) {
      if (match.type === "team_league") {
        const sideField = makeSelect("Team side to confirm", [{ value: "1", label: sideName(match, 1) }, { value: "2", label: sideName(match, 2) }], "1");
        const confirm = textElement("button", "button button-gold", "Confirm result for selected side");
        confirm.type = "button";
        confirm.addEventListener("click", () => mutate(async () => {
          await request(`/api/matches/${encodeURIComponent(match.id)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side: Number(sideField.select.value) }) });
        }, "Confirmation recorded."));
        confirmationSection.append(sideField.wrapper, confirm);
      } else {
        const confirm = textElement("button", "button button-gold", "Confirm my side's result");
        confirm.type = "button";
        confirm.addEventListener("click", () => mutate(async () => {
          await request(`/api/matches/${encodeURIComponent(match.id)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        }, "Confirmation recorded."));
        confirmationSection.append(confirm);
      }
      if (confirmed.length) {
        const retract = textElement("button", "button button-quiet", "Retract my confirmation");
        retract.type = "button";
        retract.addEventListener("click", () => mutate(async () => {
          const side = match.type === "team_league" ? Number(confirmationSection.querySelector("select")?.value) : undefined;
          await request(`/api/matches/${encodeURIComponent(match.id)}/confirm/retract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(side ? { side } : {}) });
        }, "Confirmation retracted."));
        confirmationSection.append(retract);
      }
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
    if (confirmed.length === 2 && match.status === "awaiting_confirmation") {
      const finalize = textElement("button", "button button-gold", "Finalize result"); finalize.type = "button";
      finalize.addEventListener("click", () => mutate(async () => {
        await request(`/api/matches/${encodeURIComponent(match.id)}/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      }, "Result finalized."));
      confirmationSection.append(finalize);
    }
    detail.append(confirmationSection);

    if (signedIn) {
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
    const buttons = detail.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    setStatus("Saving scoreboard update…", "pending");
    try {
      await action();
      pendingFormChanges = false;
      const id = new URLSearchParams(window.location.search).get("id");
      await loadMatch(id, { quiet: true });
      if (successMessage) setStatus(successMessage, "success");
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
    if (matchId) {
      try { await loadMatch(matchId); }
      catch (error) { setStatus(error.message, "error"); }
      return;
    }
    if (filterLeagueId) {
      title.innerHTML = "LEAGUE<br><em>MATCHES.</em>";
      sectionTitle.innerHTML = "FIXTURES<br><span>&amp; RESULTS.</span>";
      sectionKicker.textContent = "LEAGUE MATCHES";
      intro.textContent = "Fixtures and recorded results for this league will appear here when organisers publish them.";
      const competitionLink = page.querySelector("[data-match-league-link]");
      if (competitionLink) competitionLink.href = `competition.html?id=${encodeURIComponent(filterLeagueId)}`;
    }
    setStatus(filterLeagueId ? "Loading this league's matches…" : "Loading public matches…", "pending");
    try {
      const endpoint = filterLeagueId ? `/api/matches?leagueId=${encodeURIComponent(filterLeagueId)}` : "/api/matches";
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
