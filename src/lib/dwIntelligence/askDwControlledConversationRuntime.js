import {
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  createAskDwCaseState,
} from './askDwCaseState.js'
import { createAskDwCaseAwareRuntime } from './askDwConversationRuntime.js'
import {
  ASK_DW_CONTROLLED_ACTIVATION_PROFILE,
  createAskDwControlledActivationRuntime,
} from './askDwControlledActivation.js'

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function required(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} required`)
  return normalized
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Ask DW controlled conversation time invalid')
  return date.toISOString()
}

function uniqueInvoiceIds(invoiceId, invoiceIds) {
  const ids = Array.isArray(invoiceIds) && invoiceIds.length > 0
    ? invoiceIds.map((value) => required(value, 'Ask DW controlled invoice candidate'))
    : [invoiceId]

  const unique = [...new Set(ids)]
  if (!unique.includes(invoiceId)) {
    throw new Error('Ask DW selected invoice must be present in invoice candidates')
  }
  return unique
}

function assertControlledProfile(profile) {
  if (!profile || profile.id !== ASK_DW_CONTROLLED_ACTIVATION_PROFILE.id) {
    throw new Error('Ask DW controlled conversation requires the controlled activation profile')
  }
  if (
    profile.modelPlanningEnabled !== false ||
    profile.externalAiEnabled !== false ||
    profile.modelDependency !== false ||
    profile.financialExecutionAuthorized !== false ||
    profile.canonicalMutationAuthorized !== false
  ) {
    throw new Error('Ask DW controlled conversation profile is not fail-closed')
  }
}

function adaptControlledResultToLiveRead(result) {
  const activationReceipt = result?.activationReceipt
  const intelligenceReceipt = result?.intelligenceReceipt

  if (!activationReceipt || activationReceipt.writesPerformed !== false) {
    throw new Error('Ask DW controlled conversation requires a zero-write activation receipt')
  }
  if (intelligenceReceipt?.writesPerformed !== false) {
    throw new Error('Ask DW controlled conversation intelligence receipt did not prove zero writes')
  }
  if (intelligenceReceipt?.financialExecutionAuthorized !== false) {
    throw new Error('Ask DW controlled conversation unexpectedly reported execution authority')
  }

  return freeze({
    ...result,
    liveReadReceipt: freeze({
      source: 'ASK_DW_CONTROLLED_ACTIVATION',
      profile: activationReceipt.profile,
      canonicalInvoiceRead: activationReceipt.canonicalInvoiceRead === true,
      clientRead: activationReceipt.clientRead === true,
      policyRead: activationReceipt.policyRead === true,
      activityRead: activationReceipt.activityRead === true,
      paymentLedgerRead: activationReceipt.paymentLedgerRead === true,
      executionHistoryRead: activationReceipt.executionHistoryRead === true,
      authorityInputComplete: activationReceipt.authorityInputComplete === true,
      authorityLimitation: activationReceipt.authorityLimitation ?? null,
      writesPerformed: false,
      financialExecutionAuthorized: false,
      canonicalMutationAuthorized: false,
    }),
  })
}

/**
 * Creates a reference-only M1D case state anchored to an invoice already
 * resolved by the UI. Optional invoiceIds are reference candidates only;
 * they do not implement M2B client/name resolution and contain no money.
 */
export function createAskDwControlledInvoiceCaseState({
  tenantId,
  invoiceId,
  invoiceIds = null,
  conversationId,
  caseId = 'invoice-case',
  turnId = 'bootstrap',
  now = new Date(),
  expiresAt = null,
} = {}) {
  const tenant = required(tenantId, 'Ask DW controlled conversation tenantId')
  const invoice = required(invoiceId, 'Ask DW controlled conversation invoiceId')
  const conversation = required(conversationId, 'Ask DW controlled conversation conversationId')
  const candidates = uniqueInvoiceIds(invoice, invoiceIds)
  const at = iso(now)

  let state = createAskDwCaseState({
    tenantId: tenant,
    conversationId: conversation,
    caseId,
    turnId,
    now: at,
    expiresAt,
  })

  state = applyAskDwCaseEvent(state, {
    type: ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES,
    payload: {
      invoiceRefs: candidates.map((id) => ({ kind: 'invoice', id })),
    },
    tenantId: tenant,
    expectedVersion: state.version,
    turnId,
    at,
  })

  state = applyAskDwCaseEvent(state, {
    type: ASK_DW_CASE_EVENT.SELECT_INVOICE,
    payload: { invoiceRef: { kind: 'invoice', id: invoice } },
    tenantId: tenant,
    expectedVersion: state.version,
    turnId,
    at,
  })

  return state
}

/**
 * M2A composition boundary.
 *
 * M1D/M1E owns durable reference continuity and deterministic founder control.
 * Controlled activation owns fresh hosted invoice/client/activity/policy reads
 * plus deterministic truth and fail-closed authority.
 *
 * M2A deliberately adds:
 * - no real client-name resolver (M2B),
 * - no portfolio aggregation,
 * - no payment/execution ledger fiction,
 * - no provider/model dependency,
 * - no writes/sends,
 * - no execution authority.
 */
export function createAskDwControlledConversationRuntime({
  supabase,
  resolveCaseEvents = null,
} = {}) {
  const controlled = createAskDwControlledActivationRuntime({ supabase })
  assertControlledProfile(controlled.profile)

  async function runControlledInvoiceQuestion(args) {
    const result = await controlled.runInvoiceQuestion(args)
    return adaptControlledResultToLiveRead(result)
  }

  const conversation = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: runControlledInvoiceQuestion,
    resolveCaseEvents,
  })

  return freeze({
    scope: controlled.scope,
    conversationScope: 'INVOICE_DW_INTELLIGENCE_V1_CASE_STATE_V0',
    profile: controlled.profile,
    runInvoiceQuestion: runControlledInvoiceQuestion,
    runConversationTurn: conversation.runTurn,
  })
}
