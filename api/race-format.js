export const MAX_POSSIBLE_FRAMES_PER_MATCH = 500;
// Race-to possible-frame counts are odd (2N−1), so a ceiling of 500 frames
// supports Race to 250 / 499 possible frames, but not Race to 251 / 501.
export const MAX_RACE_TO = Math.floor((MAX_POSSIBLE_FRAMES_PER_MATCH + 1) / 2);
export const MAX_RACE_POSSIBLE_FRAMES = (2 * MAX_RACE_TO) - 1;
export const MAX_RACE_FRAME_PATTERN_LENGTH = 99;
// Bound deferred per-row validation and transaction scope for bulk changes;
// larger schedules can be applied in smaller operations.
export const MAX_FORMAT_FRAME_ROWS_PER_OPERATION = 10_000;

export function assertFormatFrameBudget(matchCount, framesPerMatch) {
  if (!Number.isSafeInteger(matchCount) || matchCount < 0
    || !Number.isSafeInteger(framesPerMatch) || framesPerMatch < 1) {
    throw new RangeError("The fixture frame workload could not be validated.");
  }
  const frameRows = matchCount * framesPerMatch;
  if (!Number.isSafeInteger(frameRows)) {
    throw new RangeError("The fixture frame workload could not be validated.");
  }
  if (frameRows > MAX_FORMAT_FRAME_ROWS_PER_OPERATION) {
    throw new RangeError(`This change would create more than ${MAX_FORMAT_FRAME_ROWS_PER_OPERATION} possible-frame records in one operation. Apply the format to fewer fixtures at a time.`);
  }
  return frameRows;
}

const FRAME_TYPES = new Set(["singles", "doubles"]);

function normalizeFrames(value, maxLength, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxLength) {
    throw new RangeError(`${label} must contain between 1 and ${maxLength} Singles or Doubles frames.`);
  }
  return value.map((frame, index) => {
    const type = frame?.type ?? frame?.frameType;
    if (!FRAME_TYPES.has(type)) throw new RangeError(`Frame ${index + 1} must be Singles or Doubles.`);
    return { frameNumber: index + 1, type };
  });
}

/**
 * Normalizes a Race-to format into its authoritative, ordered 2N−1 frame list.
 * Large formats use a compact repeating framePattern so requests stay bounded;
 * exact `frames` remains accepted for existing clients and irregular sequences.
 */
export function normalizeRaceFormat(details) {
  const raceTo = details?.raceTo;
  if (!Number.isInteger(raceTo) || raceTo < 1 || raceTo > MAX_RACE_TO) {
    throw new RangeError(`Choose a Race-to target from 1 to ${MAX_RACE_TO} frames.`);
  }

  const hasPattern = Object.hasOwn(details, "framePattern");
  const hasExactFrames = Object.hasOwn(details, "frames");
  if (hasPattern === hasExactFrames) {
    throw new RangeError("Provide either an exact frame list or a repeating frame pattern.");
  }

  const possibleFrames = (2 * raceTo) - 1;
  if (hasPattern) {
    const pattern = normalizeFrames(details.framePattern, MAX_RACE_FRAME_PATTERN_LENGTH, "Frame pattern");
    return {
      raceTo,
      frames: Array.from({ length: possibleFrames }, (_, index) => ({
        frameNumber: index + 1,
        type: pattern[index % pattern.length].type
      }))
    };
  }

  // Exact lists stay suitable for the compact editor and bounded request body;
  // longer formats must use the repeating pattern representation.
  const frames = normalizeFrames(details.frames, MAX_RACE_FRAME_PATTERN_LENGTH, "Exact frame list");
  if (frames.length !== possibleFrames) {
    throw new RangeError(`Race to ${raceTo} requires exactly ${possibleFrames} ordered possible frames.`);
  }
  return { raceTo, frames };
}
