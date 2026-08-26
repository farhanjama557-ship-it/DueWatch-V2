import { evaluateNextActionAuthority } from '../nextActionAuthority.js'
import { runPhase2BWorkflow } from './phase2bEngine.js'

/**
 * Phase 2B integration seam.
 *
 * IMPORTANT:
 * - This adapter does not invent a second authority system.
 * - The existing Duewatch evaluateNextActionAuthority() contract remains the
 *   only source of reminder policy/authority evaluation.
 * - Phase 2B is sandbox-only. This adapter never invokes a provider send.
 * - Production execution, when separately authorized later, must continue
 *   through the existing shared autopilotExecutionCore boundary.
 */
export function evaluatePhase2BInvoice({
  userId,
  invoice,
  client,
  rules,
  autopilotSettings,
  handledKeys,
  pendingInvoiceIds,
  events = [],
  evidence = [],
  memory = [],
  tombstones = [],
  precedents = [],
  pooling = null,
  prediction = null,
  predictionRequired = false,
  question = null,
  preferenceEvents = [],
  disputed = false,
  identificationStatus = null,
  now = new Date(),
} = {}) {
  const authorityEvaluation = evaluateNextActionAuthority({
    userId,
    invoice,
    rules,
    autopilotSettings,
    events,
    handledKeys,
    pendingInvoiceIds,
    now,
  })

  return runPhase2BWorkflow({
    tenantId: userId,
    invoice,
    client,
    now,
    evidence,
    memory,
    tombstones,
    precedents,
    pooling,
    prediction,
    predictionRequired,
    authorityEvaluation,
    founderApproved: false,
    question,
    preferenceEvents,
    disputed,
    identificationStatus,
    sandboxTransport: true,
  })
}

/**
 * Maps proof-engine state to the existing product seams without executing.
 * This is intentionally descriptive only in Phase 2B increment 1.
 */
export function phase2bHandoff(result) {
  if (!result || typeof result !== 'object') {
    return { target: 'none', allowed: false, reason: 'invalid_phase2b_result' }
  }

  if (result.hardViolations?.length) {
    return { target: 'none', allowed: false, reason: 'hard_gate_violation' }
  }

  if (result.state === 'APPROVAL') {
    return {
      target: 'awaiting_signature',
      allowed: false,
      reason: 'founder_approval_required',
      action: result.stagedAction?.action ?? null,
    }
  }

  if (result.state === 'HANDLED' && result.execution?.outcome === 'SANDBOX_SENT') {
    return {
      target: 'sandbox_transport',
      allowed: true,
      productionAllowed: false,
      action: result.stagedAction?.action ?? null,
    }
  }

  return {
    target: 'none',
    allowed: false,
    reason: result.execution?.outcome ?? String(result.state || 'no_action').toLowerCase(),
  }
}
