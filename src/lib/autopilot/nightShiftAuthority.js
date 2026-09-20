import { ACTION_SEND_REMINDER } from '../nextActionAuthority.js'

export const NIGHT_SHIFT_AUTHORITY = Object.freeze({
  AUTOMATIC: 'AUTOMATIC',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  BLOCKED: 'BLOCKED',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function result(status, reason, extras = {}) {
  return freeze({
    status,
    automatic: status === NIGHT_SHIFT_AUTHORITY.AUTOMATIC,
    requires_approval: status === NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED,
    reason,
    ...extras,
  })
}

function validPolicy(policy, userId) {
  return policy &&
    typeof policy === 'object' &&
    policy.user_id === userId &&
    policy.enabled === true &&
    Array.isArray(policy.allowed_actions) &&
    Array.isArray(policy.allowed_channels)
}

/**
 * AP3 wraps the existing Phase 2A.1 authority result. It never chooses a rule,
 * invents an action, or upgrades permission. It can only preserve automatic
 * authority, downgrade it to founder approval, or block it.
 */
export function evaluateNightShiftAuthority({
  userId,
  invoice,
  baseEvaluation,
  authorityPolicy,
  protectedClients,
  channel = 'email',
} = {}) {
  if (typeof userId !== 'string' || userId.length === 0) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'user_id_required')
  }
  if (!invoice || invoice.user_id !== userId) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'tenant_mismatch')
  }
  if (!baseEvaluation?.authority?.authorized || !baseEvaluation?.recommendation) {
    return result(
      NIGHT_SHIFT_AUTHORITY.BLOCKED,
      baseEvaluation?.authority?.blockedReason || 'base_authority_absent',
    )
  }

  const action = baseEvaluation.recommendation.action
  // Locked proof-scope boundary: Night Shift cannot turn a north-star action
  // into executable authority before a canonical action engine exists for it.
  if (action !== ACTION_SEND_REMINDER) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'action_outside_verified_execution_scope', { action })
  }

  if (!validPolicy(authorityPolicy, userId)) {
    const reason = authorityPolicy?.user_id && authorityPolicy.user_id !== userId
      ? 'authority_policy_tenant_mismatch'
      : 'explicit_authority_policy_unavailable'
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, reason, { action })
  }

  if (!authorityPolicy.allowed_actions.includes(action)) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'action_not_authorized_by_policy', { action })
  }
  if (!authorityPolicy.allowed_channels.includes(channel)) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'channel_not_authorized_by_policy', { action, channel })
  }

  if (!Array.isArray(protectedClients)) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'protected_client_state_unavailable', { action, channel })
  }
  if (protectedClients.some((entry) => entry?.user_id !== userId)) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'protected_client_state_tenant_mismatch', { action, channel })
  }

  const protectedClient = protectedClients.find((entry) =>
    entry?.enabled === true && entry.client_id === invoice.client_id
  )

  if (baseEvaluation.permission?.requiresApproval === true) {
    return result(NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED, 'base_authority_requires_approval', {
      action,
      channel,
      rule_id: baseEvaluation.recommendation.ruleId ?? null,
    })
  }

  // canActAutomatically=false with requiresApproval=false is NOT an invitation
  // to convert a pause/off state into an approval request. Preserve the lower
  // layer's refusal to auto-execute.
  if (baseEvaluation.permission?.canActAutomatically !== true) {
    return result(NIGHT_SHIFT_AUTHORITY.BLOCKED, 'base_permission_not_automatic', { action, channel })
  }

  if (protectedClient && protectedClient.outbound_requires_approval !== false) {
    return result(NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED, 'protected_client_requires_approval', {
      action,
      channel,
      client_id: invoice.client_id,
    })
  }

  const amountOutstanding = Number(baseEvaluation.facts?.amountOutstanding)
  const ceiling = authorityPolicy.max_automatic_invoice_amount
  if (
    ceiling != null &&
    Number.isFinite(Number(ceiling)) &&
    Number.isFinite(amountOutstanding) &&
    amountOutstanding > Number(ceiling)
  ) {
    return result(NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED, 'automatic_value_ceiling_exceeded', {
      action,
      channel,
      amount_outstanding: amountOutstanding,
      ceiling: Number(ceiling),
    })
  }

  const tone = baseEvaluation.recommendation.tone ?? null
  if (
    Array.isArray(authorityPolicy.allowed_automatic_tones) &&
    !authorityPolicy.allowed_automatic_tones.includes(tone)
  ) {
    return result(NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED, 'tone_outside_automatic_authority', {
      action,
      channel,
      tone,
    })
  }

  return result(NIGHT_SHIFT_AUTHORITY.AUTOMATIC, null, {
    action,
    channel,
    rule_id: baseEvaluation.recommendation.ruleId ?? null,
    rule_name: baseEvaluation.recommendation.ruleName ?? null,
  })
}
