// Pure identity/idempotency-key logic for the Autopilot execution-claim
// invariant — no Deno/Supabase imports, so this runs and tests identically
// under Node and under the Edge Function's Deno runtime (same convention as
// rules.js). The actual atomic acquisition lives in Postgres
// (acquire_autopilot_execution_claim, see the accompanying migration);
// this module only builds the deterministic identity that function keys
// off of, so both the scheduler and its tests share one implementation.

export const ACTION_TYPE_SEND_REMINDER = 'send_reminder'

export const CLAIM_STATUS = {
  IN_FLIGHT: 'in_flight',
  SENT: 'sent',
  SEND_FAILED: 'send_failed',
  UNCERTAIN: 'uncertain',
}

// A UUID-shaped string check is enough here: this module never talks to
// Postgres directly, so it can't ask the database whether a value is a
// real uuid. Malformed/missing identity fields must fail closed rather
// than silently building a key from garbage.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuidLike(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

// The conceptual execution identity: user_id + invoice_id + rule_id +
// action_type. Deliberately excludes anything that would let the same
// already-executed rule become eligible again merely because time passed,
// another scheduler cycle ran, or the rule's own metadata (tone,
// trigger_days, name, sort_order) changed — none of those are inputs here.
export function buildExecutionIdentity({ userId, invoiceId, ruleId, actionType }) {
  if (!isUuidLike(userId) || !isUuidLike(invoiceId) || !isUuidLike(ruleId)) {
    return null
  }
  if (typeof actionType !== 'string' || actionType.trim() === '') {
    return null
  }
  return { userId, invoiceId, ruleId, actionType }
}

// Deterministic representation of the identity, used both as evidence
// stored on the claim row and as the literal Resend Idempotency-Key header
// value. Plain concatenation (not a hash) is deliberate: it stays
// human-readable/debuggable, and every component is already a
// fixed-format uuid or a short fixed vocabulary action_type, so there's no
// need to invent a second hashing scheme alongside nextActionAuthority.js's
// rule-snapshot fingerprint. Resend's Idempotency-Key header has no
// documented lower length bound and comfortably accepts values well under
// common proxy/header limits; this format tops out around 115 characters.
const IDEMPOTENCY_PREFIX = 'duewatch-autopilot-send'
const MAX_IDEMPOTENCY_KEY_LENGTH = 255
// Header values must be a single line of visible ASCII (RFC 7230 field-content).
const SAFE_HEADER_VALUE_RE = /^[\x21-\x7e]+$/

export function buildIdempotencyKey(identity) {
  const built = buildExecutionIdentity(identity)
  if (!built) return null
  const key = `${IDEMPOTENCY_PREFIX}:${built.actionType}:${built.userId}:${built.invoiceId}:${built.ruleId}`
  if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !SAFE_HEADER_VALUE_RE.test(key)) {
    return null
  }
  return key
}

// Third review-fix pass, MEDIUM: when a caller loses the race to acquire an
// execution claim, both real acquireClaim adapters (autopilot-scheduler and
// send-reminder-email) look up the prior claim's real status. If THAT
// lookup itself errors, the caller must never collapse it into `null` —
// upstream, `null` reads as "no known status," which claimLostMessage below
// (and any future caller) would otherwise report as a generic "already in
// progress," inventing a state nobody actually observed. A query failure is
// its own distinct, explicit outcome.
export const EXISTING_CLAIM_STATUS_UNKNOWN = 'unknown_status_query_failed'

// `error` is whatever the status-lookup query returned in its `error` slot
// (or any other error the adapter needs to fail closed on); `status` is the
// real column value when the read succeeded. A query error always wins,
// regardless of what (if anything) `status` also holds.
export function resolveExistingClaimStatus({ error, status } = {}) {
  if (error) return EXISTING_CLAIM_STATUS_UNKNOWN
  return status ?? null
}

// Shared, human-facing copy for a CLAIM_LOST outcome — both real adapters
// (scheduler auto-send logging and the founder-facing approval endpoint)
// use the exact same vocabulary so "sent"/"uncertain"/"send_failed"/unknown
// are never described inconsistently depending on which caller lost the
// race.
export function claimLostMessage(existingStatus) {
  if (existingStatus === CLAIM_STATUS.SENT) return 'This reminder has already been sent.'
  if (existingStatus === CLAIM_STATUS.UNCERTAIN) {
    return 'A previous attempt to send this reminder had an uncertain outcome and was not automatically retried. Check Activity before trying again.'
  }
  if (existingStatus === CLAIM_STATUS.SEND_FAILED) {
    return 'A previous attempt to send this reminder failed. Check Activity before trying again.'
  }
  if (existingStatus === EXISTING_CLAIM_STATUS_UNKNOWN) {
    return "Duewatch found an existing execution record but couldn't verify its status. No new reminder was sent."
  }
  return 'Another request for this reminder is already in progress.'
}
