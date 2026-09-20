/**
 * AP1 — Autopilot operating-mode contract.
 *
 * Pure domain logic only. This file does not mutate canonical money state,
 * send communications, grant authority, or infer permission from behavior.
 */

export const AUTOPILOT_MODE = Object.freeze({
  NORMAL: 'NORMAL',
  NIGHT_SHIFT: 'NIGHT_SHIFT',
  FULL_AUTOPILOT_AWAY: 'FULL_AUTOPILOT_AWAY',
  CASH_RECOVERY: 'CASH_RECOVERY',
  PROTECT: 'PROTECT',
  QUARTER_END: 'QUARTER_END',
})

export const MODE_ACTIVATION = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  EXPIRED: 'EXPIRED',
  NOT_STARTED: 'NOT_STARTED',
  SCHEDULE_REQUIRED: 'SCHEDULE_REQUIRED',
  INVALID: 'INVALID',
})

const MODES = new Set(Object.values(AUTOPILOT_MODE))
const TEMPORARY_MODES = new Set([
  AUTOPILOT_MODE.FULL_AUTOPILOT_AWAY,
  AUTOPILOT_MODE.CASH_RECOVERY,
  AUTOPILOT_MODE.PROTECT,
  AUTOPILOT_MODE.QUARTER_END,
])

function validIso(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  return Number.isFinite(new Date(value).valueOf())
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

export function isAutopilotMode(value) {
  return MODES.has(value)
}

export function normalizeModeConfig(config, { userId } = {}) {
  if (!config || typeof config !== 'object') throw new Error('mode config required')
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('userId required')
  if (config.user_id !== userId) throw new Error('mode config tenant mismatch')
  if (!isAutopilotMode(config.mode)) throw new Error('invalid autopilot mode')

  const normalized = {
    user_id: userId,
    mode: config.mode,
    enabled: config.enabled === true,
    starts_at: config.starts_at ?? null,
    expires_at: config.expires_at ?? null,
    schedule: config.schedule ?? null,
    business_timezone: config.business_timezone ?? null,
    founder_timezone: config.founder_timezone ?? null,
    revision: Number.isInteger(config.revision) && config.revision > 0 ? config.revision : 1,
  }

  if (normalized.starts_at && !validIso(normalized.starts_at)) throw new Error('invalid mode starts_at')
  if (normalized.expires_at && !validIso(normalized.expires_at)) throw new Error('invalid mode expires_at')
  if (
    normalized.starts_at &&
    normalized.expires_at &&
    new Date(normalized.expires_at) <= new Date(normalized.starts_at)
  ) throw new Error('mode expires_at must be after starts_at')

  if (TEMPORARY_MODES.has(normalized.mode) && normalized.enabled && !normalized.expires_at) {
    throw new Error('temporary autopilot mode requires explicit expiry')
  }

  return freeze(normalized)
}

/**
 * Resolves the activation state that does not require recurring schedule math.
 * NIGHT_SHIFT with a schedule intentionally returns SCHEDULE_REQUIRED; AP2 owns
 * timezone/contact-window semantics so AP1 never pretends a system clock is
 * sufficient.
 */
export function resolveModeActivation(config, { userId, now = new Date() } = {}) {
  const normalized = normalizeModeConfig(config, { userId })
  const evaluatedAt = new Date(now)
  if (!Number.isFinite(evaluatedAt.valueOf())) throw new Error('valid now required')

  if (!normalized.enabled) {
    return freeze({
      mode: normalized.mode,
      activation: MODE_ACTIVATION.INACTIVE,
      active: false,
      evaluated_at: evaluatedAt.toISOString(),
      reason: 'mode_disabled',
    })
  }

  if (normalized.starts_at && evaluatedAt < new Date(normalized.starts_at)) {
    return freeze({
      mode: normalized.mode,
      activation: MODE_ACTIVATION.NOT_STARTED,
      active: false,
      evaluated_at: evaluatedAt.toISOString(),
      reason: 'mode_not_started',
    })
  }

  if (normalized.expires_at && evaluatedAt >= new Date(normalized.expires_at)) {
    return freeze({
      mode: normalized.mode,
      activation: MODE_ACTIVATION.EXPIRED,
      active: false,
      evaluated_at: evaluatedAt.toISOString(),
      reason: 'mode_expired',
    })
  }

  if (normalized.mode === AUTOPILOT_MODE.NIGHT_SHIFT && normalized.schedule) {
    return freeze({
      mode: normalized.mode,
      activation: MODE_ACTIVATION.SCHEDULE_REQUIRED,
      active: false,
      evaluated_at: evaluatedAt.toISOString(),
      reason: 'night_shift_schedule_requires_time_layer',
    })
  }

  return freeze({
    mode: normalized.mode,
    activation: MODE_ACTIVATION.ACTIVE,
    active: true,
    evaluated_at: evaluatedAt.toISOString(),
    reason: null,
  })
}

export function modeMayExpandAuthority() {
  // Locked invariant: operating posture can change prioritization/coverage,
  // never standing permission.
  return false
}
