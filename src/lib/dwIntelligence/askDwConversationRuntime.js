import {
  ASK_DW_ACTION_STATUS,
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  assertAskDwActionReadyForExecutionBoundary,
  getAskDwActiveAction,
  getAskDwActiveCase,
  validateAskDwCaseState,
} from './askDwCaseState.js'

const CASE_CONTEXT_VERSION = 'ASK_DW_CASE_CONTEXT_V0'

const SAFE_RESOLVER_EVENT_TYPES = new Set([
  ASK_DW_CASE_EVENT.OPEN_CASE,
  ASK_DW_CASE_EVENT.SWITCH_CASE,
  ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT,
  ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES,
  ASK_DW_CASE_EVENT.SELECT_INVOICE,
  ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE,
  ASK_DW_CASE_EVENT.RESOLVE_REFERENCE,
  ASK_DW_CASE_EVENT.SET_PRESENTATION,
])

const SHORTER_PHRASES = new Set([
  'make it shorter',
  'shorter',
  'keep it short',
  'be brief',
])

const OTHER_INVOICE_PHRASES = new Set([
  'other invoice',
  'the other invoice',
  'nah the other invoice',
  'no the other invoice',
])

const SUSPEND_ACTION_PHRASES = new Set([
  'dont do it yet',
  'do not do it yet',
  'not yet',
  'hold off',
])

const CONFIRM_ACTION_PHRASES = new Set([
  'do it',
  'actually do it',
  'yes do it',
  'go ahead',
])

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function requiredId(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} required`)
  return normalized
}

function normalizeTurnText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Ask DW conversation turn time invalid')
  return date.toISOString()
}

function sameRef(left, right) {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id)
}

function assertConversationTtl(state, at) {
  if (!state.expiresAt) return
  const expires = Date.parse(state.expiresAt)
  const current = Date.parse(at)
  if (Number.isFinite(expires) && Number.isFinite(current) && current >= expires) {
    throw new Error('Ask DW case conversation expired by TTL')
  }
}

function controlResult(classification, {
  event = null,
  blocked = false,
  status = null,
  reason = null,
} = {}) {
  return freeze({
    classification,
    event: event ? clone(event) : null,
    blocked,
    status,
    reason,
  })
}

function activeActionSummary(action) {
  if (!action) return null
  return {
    actionId: action.actionId,
    actionType: action.actionType,
    targetRefs: clone(action.targetRefs || []),
    scope: action.scope,
    status: action.status,
    offeredAtTurnId: action.offeredAtTurnId,
    suspendedAtTurnId: action.suspendedAtTurnId ?? null,
    confirmedAtTurnId: action.confirmedAtTurnId ?? null,
  }
}

/**
 * Reference-only projection of M1D state for model planning/rendering.
 * Financial values, raw tool output, permission snapshots and authority
 * decisions are intentionally absent.
 */
export function buildAskDwCaseContext(state) {
  validateAskDwCaseState(state)
  const current = getAskDwActiveCase(state)
  const action = getAskDwActiveAction(state)

  return freeze({
    schemaVersion: CASE_CONTEXT_VERSION,
    conversationId: state.conversationId,
    stateVersion: state.version,
    activeCaseId: state.activeCaseId,
    conversationStatus: state.status,
    focus: clone(current.focus),
    candidates: {
      invoiceRefs: clone(current.candidates?.invoiceRefs || []),
    },
    investigation: clone(current.investigation),
    artifactRef: clone(current.artifactRef),
    evidenceRefs: clone(current.evidenceRefs || []),
    openQuestions: clone(current.openQuestions || []),
    recommendationRef: clone(current.recommendationRef),
    referenceBindings: clone(current.referenceBindings || []),
    presentation: clone(state.presentation),
    activeAction: activeActionSummary(action),
    boundaries: {
      referenceOnly: true,
      canonicalFinancialTruthStored: false,
      rawToolOutputsStored: false,
      businessAuthorityStored: false,
      confirmationNeverEqualsExecution: true,
      freshStateRequiredBeforeExecution: true,
      authorityRecheckRequiredBeforeExecution: true,
    },
  })
}

/**
 * Deterministic founder-control gate.
 *
 * Critical action phrases are exact normalized matches. A model or fuzzy
 * substring match cannot turn ordinary prose into an action confirmation.
 */
export function resolveAskDwDeterministicCaseControl({ state, text } = {}) {
  validateAskDwCaseState(state)
  const normalized = normalizeTurnText(text)
  const current = getAskDwActiveCase(state)
  const action = getAskDwActiveAction(state)

  if (SHORTER_PHRASES.has(normalized)) {
    return controlResult('SET_PRESENTATION_BRIEF', {
      event: {
        type: ASK_DW_CASE_EVENT.SET_PRESENTATION,
        payload: { detail: 'BRIEF' },
      },
    })
  }

  if (OTHER_INVOICE_PHRASES.has(normalized)) {
    const candidates = current.candidates?.invoiceRefs || []
    const alternatives = candidates.filter((ref) => !sameRef(ref, current.focus?.invoiceRef))
    if (alternatives.length !== 1) {
      return controlResult('OTHER_INVOICE', {
        blocked: true,
        status: 'NEEDS_REFERENCE_RESOLUTION',
        reason: alternatives.length === 0
          ? 'No unique alternate invoice is resolved in the active case.'
          : 'More than one alternate invoice is resolved; explicit selection is required.',
      })
    }
    return controlResult('CORRECT_ACTIVE_INVOICE', {
      event: {
        type: ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE,
        payload: { invoiceRef: alternatives[0] },
      },
    })
  }

  if (SUSPEND_ACTION_PHRASES.has(normalized)) {
    if (!action) {
      return controlResult('SUSPEND_ACTION', {
        blocked: true,
        status: 'NEEDS_ACTION_REFERENCE',
        reason: 'No active action is available to suspend.',
      })
    }
    if (![ASK_DW_ACTION_STATUS.OFFERED, ASK_DW_ACTION_STATUS.AWAITING_CONFIRMATION]
      .includes(action.status)) {
      return controlResult('SUSPEND_ACTION', {
        blocked: true,
        status: 'NEEDS_ACTION_REFERENCE',
        reason: `Active action cannot be suspended from status ${action.status}.`,
      })
    }
    return controlResult('SUSPEND_ACTION', {
      event: {
        type: ASK_DW_CASE_EVENT.SUSPEND_ACTION,
        payload: { actionId: action.actionId },
      },
    })
  }

  if (CONFIRM_ACTION_PHRASES.has(normalized)) {
    if (!action) {
      return controlResult('CONFIRM_ACTION_REFERENCE', {
        blocked: true,
        status: 'NEEDS_ACTION_REFERENCE',
        reason: 'No active action is available for exact reference confirmation.',
      })
    }
    if (![ASK_DW_ACTION_STATUS.AWAITING_CONFIRMATION, ASK_DW_ACTION_STATUS.SUSPENDED]
      .includes(action.status)) {
      return controlResult('CONFIRM_ACTION_REFERENCE', {
        blocked: true,
        status: 'NEEDS_ACTION_REFERENCE',
        reason: `Active action is not confirmable from status ${action.status}.`,
      })
    }
    return controlResult('CONFIRM_ACTION_REFERENCE', {
      event: {
        type: ASK_DW_CASE_EVENT.CONFIRM_ACTION_REFERENCE,
        payload: {
          actionId: action.actionId,
          offeredAtTurnId: action.offeredAtTurnId,
        },
      },
    })
  }

  return controlResult('NONE')
}

function validateResolverEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Ask DW case resolver event must be an object')
  }
  const type = requiredId(event.type, 'Ask DW case resolver event type')
  if (!SAFE_RESOLVER_EVENT_TYPES.has(type)) {
    throw new Error(`Ask DW case resolver event not allowed: ${type}`)
  }
  return {
    type,
    payload: clone(event.payload || {}),
  }
}

function applyTurnEvent(state, event, { tenantId, turnId, at }) {
  return applyAskDwCaseEvent(state, {
    type: event.type,
    payload: clone(event.payload || {}),
    tenantId,
    expectedVersion: state.version,
    turnId,
    at,
  })
}

function noReadResult({
  status,
  state,
  control,
  appliedEvents,
  reason,
}) {
  return freeze({
    status,
    caseState: state,
    caseContext: buildAskDwCaseContext(state),
    appliedEvents: clone(appliedEvents),
    control,
    askDw: null,
    executionBoundary: null,
    reason,
    safeguards: {
      liveTruthReadPerformed: false,
      canonicalTruthPersistedToCaseState: false,
      caseStateCanGrantAuthority: false,
      directExecutionPerformed: false,
      deterministicActionPhraseGate: true,
    },
  })
}

function hasLiveReadReceipt(result) {
  return Boolean(
    result?.liveReadReceipt &&
    result.liveReadReceipt.writesPerformed === false
  )
}

function directSideEffect(result) {
  return Boolean(
    result?.core?.intelligence?.execution?.sideEffect === true ||
    result?.intelligence?.execution?.sideEffect === true ||
    result?.execution?.sideEffect === true
  )
}

/**
 * M1E: compose M1D case state with the existing invoice-scoped live Ask DW
 * runtime. Case state selects references and presentation continuity; the live
 * runtime still reloads canonical truth and deterministic authority every turn.
 */
export function createAskDwCaseAwareRuntime({
  runInvoiceQuestion,
  resolveCaseEvents = null,
} = {}) {
  if (typeof runInvoiceQuestion !== 'function') {
    throw new Error('Ask DW case-aware runtime requires runInvoiceQuestion')
  }
  if (resolveCaseEvents != null && typeof resolveCaseEvents !== 'function') {
    throw new Error('Ask DW resolveCaseEvents must be a function')
  }

  return freeze({
    async runTurn({
      tenantId,
      caseState,
      turnId,
      text,
      mode = 'normal',
      now = new Date(),
      proposedResolverEvents = [],
    } = {}) {
      validateAskDwCaseState(caseState)
      const tenant = requiredId(tenantId, 'Ask DW conversation tenantId')
      const turn = requiredId(turnId, 'Ask DW conversation turnId')
      if (tenant !== caseState.tenantId) {
        throw new Error('Ask DW conversation cross-tenant turn blocked')
      }
      if (caseState.status !== 'ACTIVE') {
        throw new Error('Ask DW case conversation is not active')
      }

      const at = isoTime(now)
      assertConversationTtl(caseState, at)
      let next = caseState
      const appliedEvents = []

      let resolverEvents = Array.isArray(proposedResolverEvents)
        ? [...proposedResolverEvents]
        : []

      if (resolveCaseEvents) {
        const resolved = await resolveCaseEvents(freeze({
          tenantId: tenant,
          turnId: turn,
          text: String(text || ''),
          caseContext: buildAskDwCaseContext(next),
        }))
        const emitted = Array.isArray(resolved) ? resolved : (resolved?.events || [])
        if (!Array.isArray(emitted)) {
          throw new Error('Ask DW resolveCaseEvents must return an event array')
        }
        resolverEvents = [...resolverEvents, ...emitted]
      }

      for (const rawEvent of resolverEvents) {
        const event = validateResolverEvent(rawEvent)
        next = applyTurnEvent(next, event, { tenantId: tenant, turnId: turn, at })
        appliedEvents.push(event)
      }

      const control = resolveAskDwDeterministicCaseControl({ state: next, text })
      if (control.blocked) {
        return noReadResult({
          status: control.status,
          state: next,
          control,
          appliedEvents,
          reason: control.reason,
        })
      }

      if (control.event) {
        next = applyTurnEvent(next, control.event, { tenantId: tenant, turnId: turn, at })
        appliedEvents.push(control.event)
      }

      const caseContext = buildAskDwCaseContext(next)
      const invoiceId = caseContext.focus?.invoiceRef?.id ?? null

      if (!invoiceId) {
        return noReadResult({
          status: 'NEEDS_INVOICE_RESOLUTION',
          state: next,
          control,
          appliedEvents,
          reason: 'The active case does not have a resolved invoice reference.',
        })
      }

      let pendingBoundary = null
      if (control.classification === 'CONFIRM_ACTION_REFERENCE') {
        const action = getAskDwActiveAction(next)
        if (!action) throw new Error('confirmed action reference disappeared from case state')
        pendingBoundary = assertAskDwActionReadyForExecutionBoundary(next, action.actionId)
      }

      const askDw = await runInvoiceQuestion({
        tenantId: tenant,
        invoiceId,
        mode,
        text: String(text || ''),
        now: new Date(at),
        caseContext,
      })

      if (directSideEffect(askDw)) {
        throw new Error('Ask DW case-aware runtime blocked a direct side effect')
      }
      if (askDw?.liveReadReceipt?.writesPerformed === true) {
        throw new Error('Ask DW case-aware runtime requires read-only live refresh')
      }

      const executionBoundary = pendingBoundary
        ? freeze({
            ...clone(pendingBoundary),
            revalidation: {
              freshStateRefetched: hasLiveReadReceipt(askDw),
              freshAuthorityRechecked: askDw?.truthLock != null &&
                Object.prototype.hasOwnProperty.call(askDw.truthLock, 'authority'),
              authorityActual: askDw?.truthLock?.authority?.actual ?? null,
              executionAuthorizedByCaseState: false,
              directExecutionPerformed: false,
            },
          })
        : null

      return freeze({
        status: 'ANSWERED',
        caseState: next,
        caseContext,
        appliedEvents: clone(appliedEvents),
        control,
        askDw,
        executionBoundary,
        reason: null,
        safeguards: {
          liveTruthReadPerformed: hasLiveReadReceipt(askDw),
          canonicalTruthPersistedToCaseState: false,
          caseStateCanGrantAuthority: false,
          directExecutionPerformed: false,
          deterministicActionPhraseGate: true,
        },
      })
    },
  })
}
