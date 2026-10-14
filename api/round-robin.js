const ROUND_ROBIN_TIME_ZONE = "Europe/London";

export function roundRobinFixtureCount(participantCount, meetings = 1) {
  if (!Number.isInteger(participantCount) || participantCount < 0 || ![1, 2].includes(meetings)) {
    throw new TypeError("Fixture count needs a non-negative participant count and one or two meetings.");
  }
  return meetings * participantCount * (participantCount - 1) / 2;
}

export function generateRoundRobin(participants, meetings = 1) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new TypeError("Choose at least two participants for a round-robin schedule.");
  }
  if (![1, 2].includes(meetings)) throw new TypeError("Choose one or two meetings per opponent.");
  const ids = participants.map((participant) => participant?.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new TypeError("Every round-robin participant must have a unique ID.");
  }

  const wheel = [...participants];
  if (wheel.length % 2) wheel.push(null);
  const firstLeg = [];
  const roundCount = wheel.length - 1;
  let rotation = [...wheel];

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex++) {
    const fixtures = [];
    let bye = null;
    for (let pairIndex = 0; pairIndex < rotation.length / 2; pairIndex++) {
      let sideOne = rotation[pairIndex];
      let sideTwo = rotation[rotation.length - 1 - pairIndex];
      if (!sideOne || !sideTwo) {
        bye = sideOne || sideTwo;
        continue;
      }
      if ((roundIndex + pairIndex) % 2) [sideOne, sideTwo] = [sideTwo, sideOne];
      fixtures.push({ sideOne, sideTwo });
    }
    firstLeg.push({ roundNumber: roundIndex + 1, fixtures, bye });
    rotation = [rotation[0], rotation.at(-1), ...rotation.slice(1, -1)];
  }

  if (meetings === 1) return firstLeg;
  const returnLeg = firstLeg.map((round) => ({
    roundNumber: round.roundNumber + roundCount,
    bye: round.bye,
    fixtures: round.fixtures.map(({ sideOne, sideTwo }) => ({ sideOne: sideTwo, sideTwo: sideOne }))
  }));
  return [...firstLeg, ...returnLeg];
}

function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
}

function zonedLocalDateTimeToUtc(target, timeZone) {
  const targetEpoch = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let candidate = targetEpoch;
  for (let attempt = 0; attempt < 5; attempt++) {
    const actual = partsAt(new Date(candidate), timeZone);
    const actualEpoch = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const adjustment = targetEpoch - actualEpoch;
    if (!adjustment) return new Date(candidate);
    candidate += adjustment;
  }
  throw new TypeError("A generated fixture time does not exist in the selected time zone.");
}

export function scheduledAtForRound(firstScheduledAt, roundNumber, intervalDays = 7, timeZone = ROUND_ROBIN_TIME_ZONE) {
  const start = new Date(firstScheduledAt);
  if (Number.isNaN(start.getTime()) || !Number.isInteger(roundNumber) || roundNumber < 1
    || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) {
    throw new TypeError("Provide a valid first fixture date, round number and interval of 1 to 365 days.");
  }
  const startParts = partsAt(start, timeZone);
  const calendarDate = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day + ((roundNumber - 1) * intervalDays)));
  const nextDate = {
    year: calendarDate.getUTCFullYear(),
    month: calendarDate.getUTCMonth() + 1,
    day: calendarDate.getUTCDate(),
    hour: startParts.hour,
    minute: startParts.minute
  };
  return zonedLocalDateTimeToUtc(nextDate, timeZone).toISOString();
}
