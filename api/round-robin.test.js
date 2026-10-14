import test from "node:test";
import assert from "node:assert/strict";
import { generateRoundRobin, roundRobinFixtureCount, scheduledAtForRound } from "./round-robin.js";

const entrants = (count) => Array.from({ length: count }, (_, index) => ({ id: `entry-${index + 1}`, label: `Entry ${index + 1}` }));
const pairKey = (fixture) => [fixture.sideOne.id, fixture.sideTwo.id].sort().join("|");

test("single round robin pairs every opponent exactly once and matches the fixture count", () => {
  const rounds = generateRoundRobin(entrants(6));
  const fixtures = rounds.flatMap((round) => round.fixtures);
  assert.equal(rounds.length, 5);
  assert.equal(fixtures.length, 6 * 5 / 2);
  assert.equal(fixtures.length, roundRobinFixtureCount(6));
  assert.equal(new Set(fixtures.map(pairKey)).size, 15);
  assert.ok(rounds.every((round) => round.fixtures.length === 3 && round.bye === null));
});

test("double round robin reverses both sides and matches the fixture count", () => {
  const rounds = generateRoundRobin(entrants(4), 2);
  const firstLeg = rounds.slice(0, 3).flatMap((round) => round.fixtures);
  const returnLeg = rounds.slice(3).flatMap((round) => round.fixtures);
  assert.equal(rounds.length, 6);
  assert.equal(firstLeg.length + returnLeg.length, 4 * 3);
  assert.equal(firstLeg.length + returnLeg.length, roundRobinFixtureCount(4, 2));
  for (const firstFixture of firstLeg) {
    const reverse = returnLeg.find((fixture) => fixture.sideOne.id === firstFixture.sideTwo.id
      && fixture.sideTwo.id === firstFixture.sideOne.id);
    assert.ok(reverse, `return fixture should reverse ${firstFixture.sideOne.id} and ${firstFixture.sideTwo.id}`);
  }
});

test("odd participant counts create a named bye each round without fake fixtures", () => {
  for (const meetings of [1, 2]) {
    const count = 5;
    const rounds = generateRoundRobin(entrants(count), meetings);
    const fixtures = rounds.flatMap((round) => round.fixtures);
    assert.equal(rounds.length, count * meetings);
    assert.equal(fixtures.length, roundRobinFixtureCount(count, meetings));
    assert.ok(rounds.every((round) => round.bye && round.bye.id.startsWith("entry-")));
    assert.ok(fixtures.every(({ sideOne, sideTwo }) => sideOne && sideTwo));
    assert.equal(fixtures.some(({ sideOne, sideTwo }) => sideOne.id === "bye" || sideTwo.id === "bye"), false);
  }
});

test("a three participant single round robin has three pairings and one bye per round", () => {
  const rounds = generateRoundRobin(entrants(3));
  assert.equal(rounds.length, 3);
  assert.equal(rounds.flatMap((round) => round.fixtures).length, 3);
  assert.equal(new Set(rounds.flatMap((round) => round.fixtures).map(pairKey)).size, 3);
  assert.ok(rounds.every((round) => round.bye));
});

test("round dates advance by local calendar days and retain UK kick-off time through DST", () => {
  const first = "2027-03-21T19:30:00.000Z"; // 19:30 in London before the clock change
  const next = new Date(scheduledAtForRound(first, 2, 7));
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(next);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  assert.equal(values.weekday, "Sun");
  assert.equal(values.hour, "19");
  assert.equal(values.minute, "30");
});

test("round robin validates participant IDs, counts and scheduling inputs", () => {
  assert.throws(() => generateRoundRobin(entrants(1)), /at least two/);
  assert.throws(() => generateRoundRobin([{ id: "same" }, { id: "same" }]), /unique ID/);
  assert.throws(() => generateRoundRobin(entrants(2), 3), /one or two/);
  assert.throws(() => scheduledAtForRound("bad date", 1, 7), /valid first fixture date/);
  assert.throws(() => scheduledAtForRound(new Date().toISOString(), 1, 0), /1 to 365 days/);
});
