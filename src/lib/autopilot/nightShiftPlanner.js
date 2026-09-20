import { MODE_ACTIVATION } from './nightShiftModes.js'
import { evaluateContactWindow, resolveNightShiftSchedule } from './nightShiftTime.js'
import {
  NIGHT_SHIFT_AUTHORITY,
  evaluateNightShiftAuthority,
} from './nightShiftAuthority.js'
import {
  CASH_GUARD_STATE,
  STRATEGY_STATE,
  evaluateTemporaryStrategy,
} from './nightShiftCashGuard.js'

export const NIGHT_SHIFT_DISPOSITION = Object.freeze({
  EXECUTE: 'EXECUTE',
  SCHEDULE: 'SCHEDULE',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  BLOCKED: 'BLOCKED',
})

export const NIGHT_SHIFT_WORK_STATE = Object.freeze({
  WATCHING: 'Watching',
  ANALYZING: 'Analyzing',
  VERIFYING: 'Verifying',
  PREPARING: 'Preparing',
  SENDING: 'Sending',
  WAITING: 'Waiting',
  PROTECTING: 'Protecting',
  NEEDS_APPROVAL: 'Needs approval',
  HANDLED: 'Handled',
  CAUGHT_UP: 'Caught up',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function plan(disposition, workState, reason, extras = {}) {
  return freeze({
    disposition,
    work_state: workState,
    reason,
    executed: false,
    provider_receipt: null,
    ...extras,
  })
}

/**
 * Deterministic Night Shift work planning. This function never performs an
 * external side effect. EXECUTE means "eligible to enter the existing
 * execution boundary now"; the existing execution core must still revalidate
 * authority, acquire an idempotency claim, call the provider, and persist proof.
 */
export function planNightShiftWork({
  userId,
  modeConfig,
  invoice,
  baseEvaluation,
  authorityPolicy,
  protectedClients,
  clientContact,
  cashGuard = null,
  temporaryStrategy = null,
  now = new Date(),
} = {}) {
  let modeState
  try {
    modeState = resolveNightShiftSchedule(modeConfig, { userId, now })
  } catch {
    return plan(NIGHT_SHIFT_DISPOSITION.BLOCKED, NIGHT_SHIFT_WORK_STATE.WATCHING, 'mode_state_invalid')
  }

  if (modeState.activation !== MODE_ACTIVATION.ACTIVE || modeState.active !== true) {
    return plan(NIGHT_SHIFT_DISPOSITION.BLOCKED, NIGHT_SHIFT_WORK_STATE.WATCHING, modeState.reason || 'mode_not_active', {
      mode: modeState.mode ?? null,
      mode_state: modeState.activation,
      next_check_at: modeState.next_start_at ?? null,
    })
  }

  const authority = evaluateNightShiftAuthority({
    userId,
    invoice,
    baseEvaluation,
    authorityPolicy,
    protectedClients,
    channel: 'email',
  })

  const strategy = temporaryStrategy
    ? evaluateTemporaryStrategy({ userId, strategy: temporaryStrategy, now })
    : freeze({ state: STRATEGY_STATE.INACTIVE, active: false, planning_overrides: {} })

  const context = {
    mode: modeState.mode,
    authority,
    cash_guard_state: cashGuard?.state ?? null,
    strategy_state: strategy.state,
    planning_overrides: strategy.active ? strategy.planning_overrides : {},
    priority_reason: cashGuard?.state === CASH_GUARD_STATE.SHORTFALL
      ? 'cash_guard_shortfall'
      : null,
  }

  if (authority.status === NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED) {
    return plan(
      NIGHT_SHIFT_DISPOSITION.NEEDS_APPROVAL,
      NIGHT_SHIFT_WORK_STATE.NEEDS_APPROVAL,
      authority.reason,
      context,
    )
  }
  if (authority.status !== NIGHT_SHIFT_AUTHORITY.AUTOMATIC) {
    return plan(
      NIGHT_SHIFT_DISPOSITION.BLOCKED,
      NIGHT_SHIFT_WORK_STATE.VERIFYING,
      authority.reason,
      context,
    )
  }

  const contact = evaluateContactWindow({
    timezone: clientContact?.timezone,
    windows: clientContact?.windows,
    now,
  })

  if (!contact.allowed) {
    if (contact.reason === 'outside_contact_window' && contact.next_allowed_at) {
      return plan(
        NIGHT_SHIFT_DISPOSITION.SCHEDULE,
        NIGHT_SHIFT_WORK_STATE.WAITING,
        'waiting_for_client_contact_window',
        {
          ...context,
          scheduled_for: contact.next_allowed_at,
          requires_execution_time_revalidation: true,
        },
      )
    }
    return plan(
      NIGHT_SHIFT_DISPOSITION.BLOCKED,
      NIGHT_SHIFT_WORK_STATE.VERIFYING,
      contact.reason,
      context,
    )
  }

  return plan(
    NIGHT_SHIFT_DISPOSITION.EXECUTE,
    NIGHT_SHIFT_WORK_STATE.PREPARING,
    null,
    {
      ...context,
      action: authority.action,
      channel: authority.channel,
      rule_id: authority.rule_id ?? null,
      requires_execution_time_revalidation: true,
    },
  )
}
