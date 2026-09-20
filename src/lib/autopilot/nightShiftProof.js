import { NIGHT_SHIFT_DISPOSITION } from './nightShiftPlanner.js'

export const SHIFT_RESULT = Object.freeze({
  COMPLETED: 'COMPLETED',
  WITHHELD: 'WITHHELD',
  SCHEDULED: 'SCHEDULED',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0
}

function requireTenant(value, userId, label) {
  if (value?.user_id !== userId) throw new Error(`${label} tenant mismatch`)
}

function validProviderReceipt(receipt) {
  return receipt &&
    typeof receipt === 'object' &&
    nonEmpty(receipt.provider) &&
    nonEmpty(receipt.provider_message_id) &&
    nonEmpty(receipt.execution_claim_id)
}

/**
 * A shift-log entry is a proof object, not narration. External completion
 * cannot be represented as COMPLETED unless provider + idempotency receipts
 * are present. This function also refuses an external action that was not
 * authorized by its attached authority proof.
 */
export function buildShiftLogEntry({
  userId,
  shiftRunId,
  occurredAt = new Date().toISOString(),
  object = {},
  observation,
  evidenceRefs,
  decision,
  authorityProof,
  plan,
  result,
  nextCheckAt = null,
  providerReceipt = null,
} = {}) {
  if (!nonEmpty(userId)) throw new Error('userId required')
  if (!nonEmpty(shiftRunId)) throw new Error('shiftRunId required')
  if (!Array.isArray(evidenceRefs)) throw new Error('evidence refs required')
  if (!result || !Object.values(SHIFT_RESULT).includes(result.status)) throw new Error('valid shift result required')
  if (!plan || !Object.values(NIGHT_SHIFT_DISPOSITION).includes(plan.disposition)) {
    throw new Error('valid plan required')
  }

  const externalPerformed = result.external_action_performed === true
  if (externalPerformed && authorityProof?.authorized !== true) {
    throw new Error('unauthorized external action cannot be logged as performed')
  }
  if (externalPerformed && !validProviderReceipt(providerReceipt)) {
    throw new Error('external completion requires provider and execution claim receipt')
  }
  if (result.status === SHIFT_RESULT.COMPLETED && externalPerformed && plan.disposition !== NIGHT_SHIFT_DISPOSITION.EXECUTE) {
    throw new Error('completed external action requires execute disposition')
  }

  const at = new Date(occurredAt)
  if (!Number.isFinite(at.valueOf())) throw new Error('valid occurredAt required')
  if (nextCheckAt && !Number.isFinite(new Date(nextCheckAt).valueOf())) throw new Error('valid nextCheckAt required')

  return freeze({
    kind: 'DW_SHIFT_LOG_ENTRY_V1',
    user_id: userId,
    shift_run_id: shiftRunId,
    occurred_at: at.toISOString(),
    object: { ...object },
    observation: observation ?? null,
    evidence_refs: [...evidenceRefs],
    decision: decision ?? null,
    authority_proof: authorityProof ? { ...authorityProof } : null,
    disposition: plan.disposition,
    result: {
      status: result.status,
      external_action_performed: externalPerformed,
      detail: result.detail ?? null,
    },
    provider_receipt: providerReceipt ? { ...providerReceipt } : null,
    next_check_at: nextCheckAt ? new Date(nextCheckAt).toISOString() : null,
  })
}

function canonicalCollectedAmount(events, userId, shiftRunId) {
  let total = 0
  let count = 0
  for (const event of events) {
    requireTenant(event, userId, 'canonical money event')
    if (event.shift_run_id !== shiftRunId) throw new Error('canonical money event shift mismatch')
    if (
      event.kind !== 'PAYMENT_SETTLED' ||
      event.canonical !== true ||
      !nonEmpty(event.evidence_ref) ||
      !Number.isFinite(Number(event.amount)) ||
      Number(event.amount) < 0
    ) continue
    total += Number(event.amount)
    count += 1
  }
  return { total, count }
}

/**
 * Morning Handoff aggregates proof. "Money collected" comes only from
 * canonical settled-payment evidence; reminder completions count only when a
 * provider receipt exists. No prediction or PTP can enter collected cash.
 */
export function buildMorningHandoff({
  userId,
  shiftRun,
  entries,
  canonicalMoneyEvents,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!nonEmpty(userId)) throw new Error('userId required')
  requireTenant(shiftRun, userId, 'shift run')
  if (!nonEmpty(shiftRun?.id)) throw new Error('shift run id required')
  if (!Array.isArray(entries)) throw new Error('shift entries required')
  if (!Array.isArray(canonicalMoneyEvents)) throw new Error('canonical money events required')

  for (const entry of entries) {
    requireTenant(entry, userId, 'shift entry')
    if (entry.shift_run_id !== shiftRun.id) throw new Error('shift entry run mismatch')
  }

  const collected = canonicalCollectedAmount(canonicalMoneyEvents, userId, shiftRun.id)
  const completedExternal = entries.filter((entry) =>
    entry.result?.status === SHIFT_RESULT.COMPLETED &&
    entry.result?.external_action_performed === true &&
    validProviderReceipt(entry.provider_receipt)
  )
  const approvals = entries.filter((entry) =>
    entry.disposition === NIGHT_SHIFT_DISPOSITION.NEEDS_APPROVAL ||
    entry.result?.status === SHIFT_RESULT.NEEDS_APPROVAL
  )
  const scheduled = entries.filter((entry) =>
    entry.disposition === NIGHT_SHIFT_DISPOSITION.SCHEDULE ||
    entry.result?.status === SHIFT_RESULT.SCHEDULED
  )
  const withheld = entries.filter((entry) =>
    entry.disposition === NIGHT_SHIFT_DISPOSITION.BLOCKED ||
    entry.result?.status === SHIFT_RESULT.WITHHELD
  )
  const uncertain = entries.filter((entry) => entry.result?.status === SHIFT_RESULT.UNCERTAIN)
  const unauthorized = entries.filter((entry) =>
    entry.result?.external_action_performed === true &&
    entry.authority_proof?.authorized !== true
  )

  return freeze({
    kind: 'DW_MORNING_HANDOFF_V1',
    user_id: userId,
    shift_run_id: shiftRun.id,
    generated_at: new Date(generatedAt).toISOString(),
    mode: shiftRun.mode ?? null,
    money_collected: collected.total,
    canonical_payment_events: collected.count,
    actions_handled: completedExternal.length,
    external_actions_proven: completedExternal.length,
    approvals_waiting: approvals.length,
    actions_scheduled: scheduled.length,
    actions_withheld: withheld.length,
    uncertain_actions: uncertain.length,
    unauthorized_actions: unauthorized.length,
    proof_entry_count: entries.length,
  })
}
