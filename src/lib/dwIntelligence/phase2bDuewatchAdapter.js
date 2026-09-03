import { evaluateNextActionAuthority } from '../nextActionAuthority.js'
import { runPhase2BWorkflow } from './phase2bEngine.js'
import {
  DW_INVESTIGATION_SOURCE,
  admitDwInvestigationInput,
} from './dwInvestigationInput.js'
import { buildAskDwCompanyBrainContext } from './askDwCompanyBrainContext.js'
import { buildDwGovernanceContext } from './dwGovernanceContext.js'

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
  companyBrainReadModel = null,
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

  // Every entry point admits its input through the same gate, so one dataset
  // reaches one engine state whether the founder asked or an event fired.
  const { intelligenceInput } = admitDwInvestigationInput({
    source: DW_INVESTIGATION_SOURCE.DW_INTELLIGENCE,
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
    handledKeys,
    pendingInvoiceIds,
    authorityEvaluation,
    founderApproved: false,
    question,
    preferenceEvents,
    disputed,
    identificationStatus,
    sandboxTransport: true,
  })

  const result = runPhase2BWorkflow(intelligenceInput)

  // The governance envelope travels beside the proof, never inside it: the
  // engine keeps owning the financial and intelligence proof, and the envelope
  // carries only references and freshness. Proactive DW Intelligence now sees
  // the same Company Brain, conflict and G5 grant references Ask DW sees.
  // A missing tenant stays the ENGINE's outcome: runPhase2BWorkflow already
  // returns BLOCKED_TENANT_SCOPE for it, and building the Brain context here
  // would turn that governed result into a thrown error instead.
  const tenant = String(userId || '').trim()
  const governance = buildDwGovernanceContext({
    tenantId: tenant || null,
    companyBrainContext: tenant
      ? buildAskDwCompanyBrainContext({
        readModel: companyBrainReadModel,
        tenantId: tenant,
        focus: client?.id ? { clientId: client.id } : null,
      })
      : null,
  })

  return { ...result, governance }
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
