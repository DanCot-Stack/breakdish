import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFormatFrameBudget,
  MAX_FORMAT_FRAME_ROWS_PER_OPERATION,
  MAX_POSSIBLE_FRAMES_PER_MATCH,
  MAX_RACE_POSSIBLE_FRAMES,
  MAX_RACE_TO,
  normalizeRaceFormat
} from "./race-format.js";

test("Race-to arithmetic safely expands requested targets into exactly 2N−1 frames", () => {
  for (const raceTo of [1, 3, 6, 10, 89, 100, 123, 250]) {
    const result = normalizeRaceFormat({
      raceTo,
      framePattern: [{ type: "singles" }, { type: "doubles" }]
    });
    const expected = (2 * raceTo) - 1;
    assert.equal(result.raceTo, raceTo);
    assert.equal(result.frames.length, expected);
    assert.ok(result.frames.length <= MAX_POSSIBLE_FRAMES_PER_MATCH);
    assert.equal(result.frames[0].frameNumber, 1);
    assert.equal(result.frames.at(-1).frameNumber, expected);
    assert.equal(result.frames[0].type, "singles");
    if (expected > 1) assert.equal(result.frames[1].type, "doubles");
    assert.ok(result.frames.every((frame, index) => frame.type === (index % 2 === 0 ? "singles" : "doubles")));
  }
  assert.equal(MAX_POSSIBLE_FRAMES_PER_MATCH, 500);
  assert.equal(MAX_RACE_TO, 250);
  assert.equal(MAX_RACE_POSSIBLE_FRAMES, 499);
  assert.equal(normalizeRaceFormat({ raceTo: 250, framePattern: [{ type: "singles" }] }).frames.length, 499,
    "Race to 250 is the largest supported target under the 500-frame match ceiling.");
});

test("Race-to supports exact possible-frame lists as well as compact patterns", () => {
  const exact = normalizeRaceFormat({
    raceTo: 3,
    frames: Array.from({ length: 5 }, (_, index) => ({ type: index % 2 ? "doubles" : "singles" }))
  });
  assert.deepEqual(exact.frames.map(({ frameNumber }) => frameNumber), [1, 2, 3, 4, 5]);
  assert.deepEqual(exact.frames.map(({ type }) => type), ["singles", "doubles", "singles", "doubles", "singles"]);
});

test("Race-to rejects invalid, over-budget, ambiguous and wrong-length formats", () => {
  for (const raceTo of [0, -1, 1.5, 251, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => normalizeRaceFormat({ raceTo, framePattern: [{ type: "singles" }] }), RangeError);
  }
  assert.throws(() => normalizeRaceFormat({ raceTo: 250, framePattern: [{ type: "singles" }], frames: [] }), /either an exact frame list or a repeating frame pattern/);
  assert.throws(() => normalizeRaceFormat({ raceTo: 3, frames: [{ type: "singles" }] }), /exactly 5/);
  assert.throws(() => normalizeRaceFormat({ raceTo: 51, frames: Array.from({ length: 101 }, () => ({ type: "singles" })) }), /between 1 and 99/);
  assert.throws(() => normalizeRaceFormat({ raceTo: 3, framePattern: Array.from({ length: 100 }, () => ({ type: "singles" })) }), /between 1 and 99/);
  assert.throws(() => normalizeRaceFormat({ raceTo: 6, framePattern: [{ type: "unknown" }] }), /must be Singles or Doubles/);
});

test("bulk fixture format changes have a bounded frame-row workload", () => {
  assert.equal(assertFormatFrameBudget(20, 499), 9980);
  assert.equal(assertFormatFrameBudget(0, 499), 0);
  assert.equal(MAX_FORMAT_FRAME_ROWS_PER_OPERATION, 10_000);
  assert.throws(() => assertFormatFrameBudget(21, 499), /more than 10000 possible-frame records/);
  assert.throws(() => assertFormatFrameBudget(Number.MAX_SAFE_INTEGER, 499), /could not be validated/);
});
