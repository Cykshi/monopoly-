// ================= SHARED VALIDATION =================
//
// One home for the "is this payload even shaped right?" checks that every
// socket handler needs. Keeping them here means an event handler reads as the
// RULE it enforces, not as a pile of typeof guards — and a new handler can't
// accidentally invent a looser check than its neighbours.
//
// Every rejection returns the same shape the client already understands:
//   { ok: false, code, error }
// so nothing about the existing ack contract changes.

// Rejection payload. `code` is the machine-readable reason, `error` the human
// string the client renders. Both are deliberately about the RULE, never about
// server internals (no stack traces, no file paths, no token material).
function reject(ack, code, error) {
  const payload = { ok: false, code, error };
  if (typeof ack === 'function') ack(payload);
  return payload;
}

// ---- numbers -------------------------------------------------------------

// A finite, whole number. Rejects NaN, Infinity, -Infinity, "12", 12.5.
function isInt(value) {
  return Number.isInteger(value);
}

// A finite number that may legitimately be zero, including 0 exactly.
// This is the check that replaced `money > 0` as an "is it known?" probe:
// zero is a real balance, not an absent one.
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// A non-negative finite number (money, positions-as-counts, bids).
function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

// A positive finite number (> 0).
function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

// An integer inside [min, max] inclusive.
function isIntInRange(value, min, max) {
  return isInt(value) && value >= min && value <= max;
}

// A whole-dollar amount: integer, non-negative, and not absurdly large. The
// ceiling is a sanity bound, not a game rule — it exists so a hostile client
// can't hand us 1e21 and overflow arithmetic downstream.
const MAX_MONEY = 1_000_000_000;

function isMoneyAmount(value) {
  return isInt(value) && value >= 0 && value <= MAX_MONEY;
}

// A board index (0..39 for this board, passed in so the board module stays the
// authority on its own size).
function isBoardIndex(value, boardSize) {
  return isIntInRange(value, 0, boardSize - 1);
}

// ---- strings -------------------------------------------------------------

// A usable display name: a string that trims to something non-empty. Returns
// the canonical stored form, or null. Length is capped AFTER trimming so
// trailing spaces can't eat the budget.
function normalizeName(raw, maxLength) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

// A usable chat message: non-empty after trimming, and not longer than the cap.
// Returns the canonical text or null. We do NOT strip formatting characters —
// the client renders text nodes, so there is no HTML to escape; the length cap
// is what stops an absurd payload.
function normalizeChatText(raw, maxLength) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return null;
  return trimmed;
}

// A chat message id. Client-generated ids are opaque strings; we only require
// that it is a non-empty string of sane length so it can be echoed and keyed.
function normalizeId(raw, maxLength = 64) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

// ---- payload shapes ------------------------------------------------------

// The payload must be a plain object. `null`, arrays, strings and numbers are
// all rejected — every handler below assumes it can read named fields.
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

module.exports = {
  MAX_MONEY,
  reject,
  isInt,
  isFiniteNumber,
  isNonNegativeNumber,
  isPositiveNumber,
  isIntInRange,
  isMoneyAmount,
  isBoardIndex,
  normalizeName,
  normalizeChatText,
  normalizeId,
  isPlainObject,
};