export const CASH_GUARD_STATE = Object.freeze({
  OK: 'OK',
  SHORTFALL: 'SHORTFALL',
  UNKNOWN: 'UNKNOWN',
})

export const STRATEGY_STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  NOT_STARTED: 'NOT_STARTED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  INVALID: 'INVALID',
})

const PLANNING_ONLY_KEYS = new Set([
  'priority_bias',
  'verification_frequency_minutes',
  'forecast_weight_cap',
  'monitoring_level',
])

const AUTHORITY_EXPANDING_KEYS = new Set([
  'allowed_actions',
  'allowed_channels',
  'approval_required',
  'authority_ceiling',
  'max_automatic_invoice_amount',
  'protected_clients',
  'reminder_rule',
  'reminder_timing',
  'tone_authority',
])

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function finiteNonNegative(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0
}

/**
 * Cash Guard consumes risk-adjusted expected amounts that were already
 * established by an upstream forecast layer. It does not invent probabilities,
 * settle invoices, or write canonical money truth.
 */
export function evaluateCashGuard({ userId, cashFloor, forecastItems } = {}) {
  if (typeof userId !== 'string' || userId.length === 0) {
    return freeze({ state: CASH_GUARD_STATE.UNKNOWN, reason: 'user_id_required' })
  }
  if (!finiteNonNegative(cashFloor)) {
    return freeze({ state: CASH_GUARD_STATE.UNKNOWN, reason: 'cash_floor_unavailable' })
  }
  if (!Array.isArray(forecastItems)) {
    return freeze({ state: CASH_GUARD_STATE.UNKNOWN, reason: 'forecast_state_unavailable' })
  }
  if (forecastItems.some((item) => item?.user_id !== userId)) {
    return freeze({ state: CASH_GUARD_STATE.UNKNOWN, reason: 'forecast_tenant_mismatch' })
  }

  const accepted = []
  const excluded = []
  for (const item of forecastItems) {
    if (
      item?.eligible === true &&
      finiteNonNegative(item.risk_adjusted_expected_amount) &&
      typeof item.evidence_ref === 'string' &&
      item.evidence_ref.length > 0
    ) {
      accepted.push(item)
    } else {
      excluded.push({
        id: item?.id ?? null,
        reason: 'forecast_item_not_evidence_backed',
      })
    }
  }

  const expected = accepted.reduce(
    (sum, item) => sum + Number(item.risk_adjusted_expected_amount),
    0,
  )
  const floor = Number(cashFloor)
  const shortfall = Math.max(0, floor - expected)

  return freeze({
    state: shortfall > 0 ? CASH_GUARD_STATE.SHORTFALL : CASH_GUARD_STATE.OK,
    reason: null,
    cash_floor: floor,
    risk_adjusted_expected_collections: expected,
    shortfall,
    accepted_items: accepted.length,
    excluded_items: excluded,
    canonical_money_mutated: false,
    authority_granted: false,
  })
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).valueOf())
}

/**
 * Temporary strategy is intentionally planning-only at this checkpoint.
 * Founder approval can change prioritization/verification/forecast weighting,
 * but it cannot rewrite canonical reminder rules or grant new execution
 * authority. Any execution-affecting policy change must flow through the
 * existing persisted authority/rule system and be revalidated there.
 */
export function evaluateTemporaryStrategy({ userId, strategy, now = new Date() } = {}) {
  const evaluatedAt = new Date(now)
  const closed = (state, reason) => freeze({
    state,
    active: false,
    reason,
    planning_overrides: {},
    authority_granted: false,
    canonical_money_mutated: false,
  })

  if (!Number.isFinite(evaluatedAt.valueOf())) return closed(STRATEGY_STATE.INVALID, 'invalid_now')
  if (!strategy || typeof strategy !== 'object') return closed(STRATEGY_STATE.INVALID, 'strategy_unavailable')
  if (strategy.user_id !== userId) return closed(STRATEGY_STATE.INVALID, 'strategy_tenant_mismatch')
  if (strategy.revoked_at) return closed(STRATEGY_STATE.REVOKED, 'strategy_revoked')
  if (!strategy.approved_at || !strategy.approved_by) {
    return closed(STRATEGY_STATE.INVALID, 'founder_approval_required')
  }
  if (!validIso(strategy.starts_at) || !validIso(strategy.expires_at)) {
    return closed(STRATEGY_STATE.INVALID, 'bounded_strategy_window_required')
  }

  const startsAt = new Date(strategy.starts_at)
  const expiresAt = new Date(strategy.expires_at)
  if (expiresAt <= startsAt) return closed(STRATEGY_STATE.INVALID, 'invalid_strategy_window')
  if (evaluatedAt < startsAt) return closed(STRATEGY_STATE.NOT_STARTED, 'strategy_not_started')
  if (evaluatedAt >= expiresAt) return closed(STRATEGY_STATE.EXPIRED, 'strategy_expired')

  const overrides = strategy.overrides
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return closed(STRATEGY_STATE.INVALID, 'strategy_overrides_required')
  }

  const keys = Object.keys(overrides)
  if (keys.some((key) => AUTHORITY_EXPANDING_KEYS.has(key))) {
    return closed(STRATEGY_STATE.INVALID, 'strategy_cannot_expand_authority')
  }
  if (keys.some((key) => !PLANNING_ONLY_KEYS.has(key))) {
    return closed(STRATEGY_STATE.INVALID, 'unsupported_strategy_override')
  }

  const planning = { ...overrides }
  if (
    planning.forecast_weight_cap != null &&
    (!Number.isFinite(Number(planning.forecast_weight_cap)) ||
      Number(planning.forecast_weight_cap) < 0 ||
      Number(planning.forecast_weight_cap) > 1)
  ) {
    return closed(STRATEGY_STATE.INVALID, 'invalid_forecast_weight_cap')
  }
  if (
    planning.verification_frequency_minutes != null &&
    (!Number.isInteger(Number(planning.verification_frequency_minutes)) ||
      Number(planning.verification_frequency_minutes) < 1)
  ) {
    return closed(STRATEGY_STATE.INVALID, 'invalid_verification_frequency')
  }

  return freeze({
    state: STRATEGY_STATE.ACTIVE,
    active: true,
    reason: null,
    planning_overrides: planning,
    starts_at: startsAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    approved_at: strategy.approved_at,
    approved_by: strategy.approved_by,
    authority_granted: false,
    canonical_money_mutated: false,
  })
}
