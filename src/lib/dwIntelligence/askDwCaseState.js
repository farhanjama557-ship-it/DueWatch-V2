const CASE_STATE_VERSION = 'ASK_DW_CASE_STATE_V0'

export const ASK_DW_CASE_EVENT = Object.freeze({
  OPEN_CASE: 'OPEN_CASE',
  SWITCH_CASE: 'SWITCH_CASE',
  SET_ACTIVE_CLIENT: 'SET_ACTIVE_CLIENT',
  CLEAR_ACTIVE_FOCUS: 'CLEAR_ACTIVE_FOCUS',
  SET_INVOICE_CANDIDATES: 'SET_INVOICE_CANDIDATES',
  SELECT_INVOICE: 'SELECT_INVOICE',
  CORRECT_ACTIVE_INVOICE: 'CORRECT_ACTIVE_INVOICE',
  SET_ACTIVE_DISPUTE: 'SET_ACTIVE_DISPUTE',
  SET_INVESTIGATION: 'SET_INVESTIGATION',
  SET_ARTIFACT_REF: 'SET_ARTIFACT_REF',
  SET_EVIDENCE_REFS: 'SET_EVIDENCE_REFS',
  SET_OPEN_QUESTIONS: 'SET_OPEN_QUESTIONS',
  SET_RECOMMENDATION_REF: 'SET_RECOMMENDATION_REF',
  RESOLVE_REFERENCE: 'RESOLVE_REFERENCE',
  OFFER_ACTION: 'OFFER_ACTION',
  REQUEST_ACTION_CONFIRMATION: 'REQUEST_ACTION_CONFIRMATION',
  SUSPEND_ACTION: 'SUSPEND_ACTION',
  CANCEL_ACTION: 'CANCEL_ACTION',
  CONFIRM_ACTION_REFERENCE: 'CONFIRM_ACTION_REFERENCE',
  SET_PRESENTATION: 'SET_PRESENTATION',
  RECORD_CONVERSATION_MEMORY: 'RECORD_CONVERSATION_MEMORY',
  CLOSE_CASE: 'CLOSE_CASE',
  EXPIRE_CONVERSATION: 'EXPIRE_CONVERSATION',
})

export const ASK_DW_ACTION_STATUS = Object.freeze({
  OFFERED: 'OFFERED',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  SUSPENDED: 'SUSPENDED',
  CONFIRMED_PENDING_REVALIDATION: 'CONFIRMED_PENDING_REVALIDATION',
  CANCELLED: 'CANCELLED',
  INVALIDATED: 'INVALIDATED',
})

export const ASK_DW_CASE_STATUS = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
})

export const ASK_DW_CONVERSATION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
})

const REF_KINDS = new Set([
  'client',
  'invoice',
  'dispute',
  'investigation',
  'artifact',
  'evidence',
  'recommendation',
])

const ACTION_STATUSES = new Set(Object.values(ASK_DW_ACTION_STATUS))
const CASE_STATUSES = new Set(Object.values(ASK_DW_CASE_STATUS))
const CONVERSATION_STATUSES = new Set(Object.values(ASK_DW_CONVERSATION_STATUS))
const MAX_RECENT_CASES = 3
const MAX_ACTION_HISTORY = 5
const MAX_REFERENCE_BINDINGS = 20
const MAX_INVOICE_CANDIDATES = 20
const MAX_EVIDENCE_REFS = 50
const MAX_OPEN_QUESTIONS = 10
const MAX_MEMORY_TURNS = 12
const MAX_MEMORY_TOPICS = 8
const MAX_MEMORY_SUBJECTS = 6
const MAX_CONVERSATIONAL_NICKNAMES = 12
const MAX_CONVERSATIONAL_NICKNAME_LENGTH = 40
const FORBIDDEN_CONVERSATIONAL_NICKNAME_TOKENS = new Set([
  'act', 'authority', 'authorized', 'balance', 'canonical', 'contract', 'execute',
  'grant', 'invoice', 'paid', 'payment', 'permission', 'policy', 'send', 'truth',
  'writeoff',
])

const MEMORY_RESOLUTION_STATES = new Set(['UNCHANGED', 'RESOLVED', 'UNRESOLVED'])
const MEMORY_TURN_TYPES = new Set([
  'GREETING', 'ACKNOWLEDGEMENT', 'DAILY_PRIORITIES', 'PORTFOLIO_STATUS',
  'NEEDS_FOUNDER', 'WHAT_CHANGED', 'FOLLOW_UP', 'EVIDENCE_REQUEST',
  'CORRECTION', 'CHALLENGE', 'COMPANY_BRAIN_QUESTION', 'AUTHORITY_QUESTION',
  'AR_JOB',
])
const MEMORY_CORRECTION_KINDS = new Set([
  'REFERENT', 'NEW_EVIDENCE', 'CHALLENGE', 'UNDERSTANDING',
])
const MEMORY_RESOLUTION_STATUSES = new Set([
  'ANSWERED', 'CONTROLLED', 'RESOLVED', 'RESOLVED_WITH_LIMITATION', 'NOOP',
  'NEEDS_CLIENT_RESOLUTION', 'CLIENT_NOT_FOUND', 'CLIENT_HAS_NO_INVOICES',
  'NEEDS_INVOICE_RESOLUTION', 'INVOICE_NOT_FOUND', 'NEEDS_REFERENCE_RESOLUTION',
])

const CONVERSATION_MEMORY_BOUNDARIES = Object.freeze({
  storesTranscript: false,
  isEvidence: false,
  canOverrideLiveReads: false,
  canMutateG6Context: false,
  canGrantAuthority: false,
  founderNicknamesConversationScoped: true,
  vocabularySource: 'READ_ONLY_G6_CONTEXT_ONLY',
})

const FORBIDDEN_DURABLE_KEYS = new Set([
  'amount',
  'amount_paid',
  'balance',
  'paid',
  'currency',
  'due_date',
  'inv_date',
  'invoice_date',
  'canonicalFacts',
  'canonical_facts',
  'rawToolResponse',
  'raw_tool_response',
  'toolOutput',
  'tool_output',
  'authority',
  'authoritySnapshot',
  'authority_snapshot',
  'authorized',
  'canActAutomatically',
  'permissions',
])

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function requiredId(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} required`)
  return normalized
}

function optionalString(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function boundedString(value, name, maxLength) {
  const normalized = requiredId(value, name)
  if (normalized.length > maxLength) throw new Error(`${name} too long`)
  return normalized
}

export function normalizeAskDwConversationNicknameTerm(value) {
  const term = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!term || term.length > MAX_CONVERSATIONAL_NICKNAME_LENGTH) {
    throw new Error('conversation nickname invalid')
  }
  const tokens = term.split(' ')
  if (tokens.length > 4 || tokens.some((token) =>
    !/^[a-z][a-z'-]*$/.test(token) ||
    FORBIDDEN_CONVERSATIONAL_NICKNAME_TOKENS.has(token))) {
    throw new Error('conversation nickname invalid')
  }
  if (term.includes('write off')) throw new Error('conversation nickname invalid')
  return term
}

function normalizeRef(ref, expectedKind = null) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error('case reference must be an object')
  }
  const kind = requiredId(ref.kind, 'case reference kind')
  const id = requiredId(ref.id, 'case reference id')
  if (!REF_KINDS.has(kind)) throw new Error(`unsupported case reference kind: ${kind}`)
  if (expectedKind && kind !== expectedKind) {
    throw new Error(`expected ${expectedKind} reference`)
  }
  return Object.freeze({ kind, id })
}

function normalizeRefs(refs, expectedKind = null, max = 50) {
  if (!Array.isArray(refs)) throw new Error('case reference list must be an array')
  const unique = new Map()
  for (const ref of refs.slice(0, max)) {
    const normalized = normalizeRef(ref, expectedKind)
    unique.set(`${normalized.kind}:${normalized.id}`, normalized)
  }
  return Object.freeze([...unique.values()])
}

function sameRef(left, right) {
  if (!left || !right) return false
  return left.kind === right.kind && left.id === right.id
}

function containsRef(refs, ref) {
  return (refs || []).some((candidate) => sameRef(candidate, ref))
}

function actionTargetsRef(action, ref) {
  return (action?.targetRefs || []).some((target) => sameRef(target, ref))
}

function makeCase({ caseId, turnId, at }) {
  return {
    caseId,
    status: ASK_DW_CASE_STATUS.OPEN,
    createdAt: at,
    updatedAt: at,
    lastTurnId: turnId,
    focus: {
      clientRef: null,
      invoiceRef: null,
      disputeRef: null,
    },
    candidates: {
      invoiceRefs: [],
    },
    investigation: {
      ref: null,
      status: 'IDLE',
      startedAtTurnId: null,
      updatedAtTurnId: turnId,
    },
    artifactRef: null,
    evidenceRefs: [],
    openQuestions: [],
    recommendationRef: null,
    referenceBindings: [],
    actions: [],
    activeActionId: null,
  }
}

function makeConversationMemory() {
  return {
    recentTurns: [],
    recentTopics: [],
    recentSubjects: [],
    unresolvedReference: null,
    conversationalNicknames: [],
    compactedTurnCount: 0,
    boundaries: clone(CONVERSATION_MEMORY_BOUNDARIES),
  }
}

function ensureConversationMemory(state) {
  if (!state.memory) state.memory = makeConversationMemory()
  return state.memory
}

function activeCase(state) {
  const current = state.cases?.[state.activeCaseId]
  if (!current) throw new Error('active case missing')
  return current
}

function activeAction(caseState) {
  if (!caseState.activeActionId) return null
  return caseState.actions.find((action) => action.actionId === caseState.activeActionId) || null
}

function invalidateCurrentAction(caseState, { reason, turnId, at, targetRef = null } = {}) {
  const action = activeAction(caseState)
  if (!action) return
  if (targetRef && !actionTargetsRef(action, targetRef)) return
  if ([ASK_DW_ACTION_STATUS.CANCELLED, ASK_DW_ACTION_STATUS.INVALIDATED].includes(action.status)) return

  action.status = ASK_DW_ACTION_STATUS.INVALIDATED
  action.invalidatedReason = requiredId(reason, 'action invalidation reason')
  action.invalidatedAtTurnId = turnId
  action.updatedAt = at
  caseState.activeActionId = null
}

function clearInvoiceDerivedState(caseState, { oldInvoiceRef, turnId, at, reason }) {
  if (oldInvoiceRef) {
    invalidateCurrentAction(caseState, {
      reason,
      turnId,
      at,
      targetRef: oldInvoiceRef,
    })
  }

  caseState.focus.invoiceRef = null
  caseState.focus.disputeRef = null
  caseState.investigation = {
    ref: null,
    status: 'IDLE',
    startedAtTurnId: null,
    updatedAtTurnId: turnId,
  }
  caseState.artifactRef = null
  caseState.evidenceRefs = []
  caseState.openQuestions = []
  caseState.recommendationRef = null
  caseState.referenceBindings = caseState.referenceBindings.filter(
    (binding) => !['invoice', 'dispute', 'investigation', 'artifact', 'evidence', 'recommendation']
      .includes(binding.ref.kind),
  )
}

function clearClientDerivedState(caseState, { oldClientRef, turnId, at, reason }) {
  if (oldClientRef) {
    invalidateCurrentAction(caseState, {
      reason,
      turnId,
      at,
      targetRef: oldClientRef,
    })
  }

  clearInvoiceDerivedState(caseState, {
    oldInvoiceRef: caseState.focus.invoiceRef,
    turnId,
    at,
    reason,
  })
  caseState.focus.clientRef = null
  caseState.candidates.invoiceRefs = []
  caseState.referenceBindings = caseState.referenceBindings.filter(
    (binding) => binding.ref.kind !== 'client',
  )
}

function upsertReferenceBinding(caseState, { term, ref, turnId }) {
  const normalizedTerm = requiredId(term, 'reference term').toLowerCase()
  const normalizedRef = normalizeRef(ref)
  const remaining = caseState.referenceBindings.filter(
    (binding) => binding.term !== normalizedTerm,
  )
  remaining.push({
    term: normalizedTerm,
    ref: normalizedRef,
    resolvedAtTurnId: turnId,
  })
  caseState.referenceBindings = remaining.slice(-MAX_REFERENCE_BINDINGS)
}

function assertNoForbiddenDurableKeys(value, path = 'state') {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_DURABLE_KEYS.has(key)) {
      throw new Error(`forbidden live/canonical field in case state at ${path}.${key}`)
    }
    assertNoForbiddenDurableKeys(nested, `${path}.${key}`)
  }
}

function validateState(state) {
  if (!state || typeof state !== 'object') throw new Error('case state object required')
  if (state.schemaVersion !== CASE_STATE_VERSION) throw new Error('unsupported case state version')
  requiredId(state.tenantId, 'case state tenantId')
  requiredId(state.conversationId, 'case state conversationId')
  requiredId(state.activeCaseId, 'case state activeCaseId')
  if (!Number.isInteger(state.version) || state.version < 0) throw new Error('case state version invalid')
  if (!CONVERSATION_STATUSES.has(state.status)) throw new Error('conversation status invalid')
  if (!Array.isArray(state.recentCaseIds) || state.recentCaseIds.length > MAX_RECENT_CASES) {
    throw new Error('recent case list invalid')
  }
  if (!state.cases || typeof state.cases !== 'object') throw new Error('case map required')
  if (!state.cases[state.activeCaseId]) throw new Error('active case not present in case map')

  for (const caseState of Object.values(state.cases)) {
    if (!CASE_STATUSES.has(caseState.status)) throw new Error('case status invalid')
    if (caseState.candidates.invoiceRefs.length > MAX_INVOICE_CANDIDATES) {
      throw new Error('too many invoice candidates')
    }
    if (caseState.evidenceRefs.length > MAX_EVIDENCE_REFS) throw new Error('too many evidence refs')
    if (caseState.openQuestions.length > MAX_OPEN_QUESTIONS) throw new Error('too many open questions')
    if (caseState.actions.length > MAX_ACTION_HISTORY) throw new Error('action history too large')
    for (const action of caseState.actions) {
      if (!ACTION_STATUSES.has(action.status)) throw new Error('action status invalid')
    }
  }

  if (state.memory != null) {
    const memory = state.memory
    if (!Array.isArray(memory.recentTurns) || memory.recentTurns.length > MAX_MEMORY_TURNS) {
      throw new Error('conversation memory turn window invalid')
    }
    if (!Array.isArray(memory.recentTopics) || memory.recentTopics.length > MAX_MEMORY_TOPICS) {
      throw new Error('conversation memory topic window invalid')
    }
    if (!Array.isArray(memory.recentSubjects) || memory.recentSubjects.length > MAX_MEMORY_SUBJECTS) {
      throw new Error('conversation memory subject window invalid')
    }
    if (!Array.isArray(memory.conversationalNicknames) ||
        memory.conversationalNicknames.length > MAX_CONVERSATIONAL_NICKNAMES) {
      throw new Error('conversation nickname window invalid')
    }
    if (!Number.isInteger(memory.compactedTurnCount) || memory.compactedTurnCount < 0) {
      throw new Error('conversation memory compacted turn count invalid')
    }
    for (const item of memory.recentTurns) {
      requiredId(item.turnId, 'conversation memory turnId')
      requiredId(item.caseId, 'conversation memory turn caseId')
      if (!MEMORY_TURN_TYPES.has(requiredId(item.turnType, 'conversation memory turnType'))) {
        throw new Error('conversation memory turn type invalid')
      }
      if (item.correctionKind != null && !MEMORY_CORRECTION_KINDS.has(item.correctionKind)) {
        throw new Error('conversation memory correction kind invalid')
      }
      if (item.resolutionStatus != null && !MEMORY_RESOLUTION_STATUSES.has(item.resolutionStatus)) {
        throw new Error('conversation memory resolution status invalid')
      }
      if (!['normal', 'deep'].includes(item.mode)) throw new Error('conversation memory mode invalid')
    }
    for (const item of memory.recentTopics) {
      if (!MEMORY_TURN_TYPES.has(requiredId(item.topic, 'conversation memory topic'))) {
        throw new Error('conversation memory topic invalid')
      }
      requiredId(item.lastTurnId, 'conversation memory topic turnId')
    }
    for (const item of memory.recentSubjects) {
      requiredId(item.caseId, 'conversation memory subject caseId')
      requiredId(item.lastTurnId, 'conversation memory subject turnId')
      if (item.clientRef) normalizeRef(item.clientRef, 'client')
      if (item.invoiceRef) normalizeRef(item.invoiceRef, 'invoice')
    }
    for (const item of memory.conversationalNicknames) {
      if (normalizeAskDwConversationNicknameTerm(item.term) !== item.term) {
        throw new Error('conversation nickname normalization invalid')
      }
      normalizeRef(item.ref)
      requiredId(item.createdAtTurnId, 'conversation nickname created turnId')
      requiredId(item.lastUsedAtTurnId, 'conversation nickname last used turnId')
    }
    if (memory.unresolvedReference) {
      if (!MEMORY_RESOLUTION_STATUSES.has(requiredId(
        memory.unresolvedReference.status,
        'unresolved reference status',
      ))) {
        throw new Error('unresolved reference status invalid')
      }
      requiredId(memory.unresolvedReference.caseId, 'unresolved reference caseId')
      requiredId(memory.unresolvedReference.recordedAtTurnId, 'unresolved reference turnId')
      if (memory.unresolvedReference.clientRef) {
        normalizeRef(memory.unresolvedReference.clientRef, 'client')
      }
      normalizeRefs(memory.unresolvedReference.candidateInvoiceRefs || [], 'invoice', MAX_INVOICE_CANDIDATES)
    }
    const boundaryKeys = Object.keys(memory.boundaries || {}).sort()
    const expectedBoundaryKeys = Object.keys(CONVERSATION_MEMORY_BOUNDARIES).sort()
    if (boundaryKeys.length !== expectedBoundaryKeys.length ||
        boundaryKeys.some((key, index) => key !== expectedBoundaryKeys[index]) ||
        expectedBoundaryKeys.some((key) =>
          memory.boundaries[key] !== CONVERSATION_MEMORY_BOUNDARIES[key])) {
      throw new Error('conversation memory boundaries invalid')
    }
  }

  assertNoForbiddenDurableKeys(state)
  return true
}

export function createAskDwCaseState({
  tenantId,
  conversationId,
  caseId,
  turnId,
  now,
  expiresAt = null,
} = {}) {
  const tenant = requiredId(tenantId, 'tenantId')
  const conversation = requiredId(conversationId, 'conversationId')
  const initialCaseId = requiredId(caseId, 'caseId')
  const initialTurnId = requiredId(turnId, 'turnId')
  const at = requiredId(now, 'now')

  const state = {
    schemaVersion: CASE_STATE_VERSION,
    version: 0,
    tenantId: tenant,
    conversationId: conversation,
    status: ASK_DW_CONVERSATION_STATUS.ACTIVE,
    createdAt: at,
    updatedAt: at,
    expiresAt: optionalString(expiresAt),
    lastTransition: null,
    activeCaseId: initialCaseId,
    recentCaseIds: [],
    cases: {
      [initialCaseId]: makeCase({
        caseId: initialCaseId,
        turnId: initialTurnId,
        at,
      }),
    },
    presentation: {
      tone: 'CONVERSATIONAL',
      detail: 'STANDARD',
    },
    memory: makeConversationMemory(),
    boundaries: {
      canonicalFinancialTruthStored: false,
      rawToolOutputsStored: false,
      businessAuthorityStored: false,
      confirmationNeverEqualsExecution: true,
      freshStateRequiredBeforeExecution: true,
      authorityRecheckRequiredBeforeExecution: true,
    },
  }

  validateState(state)
  return freeze(state)
}

function requireActiveConversation(state, eventType) {
  if (state.status === ASK_DW_CONVERSATION_STATUS.EXPIRED &&
      eventType !== ASK_DW_CASE_EVENT.EXPIRE_CONVERSATION) {
    throw new Error('case conversation expired')
  }
}

function assertNotExpiredByTime(state, at, eventType) {
  if (!state.expiresAt || eventType === ASK_DW_CASE_EVENT.EXPIRE_CONVERSATION) return
  const expires = Date.parse(state.expiresAt)
  const current = Date.parse(at)
  if (Number.isFinite(expires) && Number.isFinite(current) && current >= expires) {
    throw new Error('case conversation expired by TTL')
  }
}

function normalizeQuestion(question) {
  if (!question || typeof question !== 'object') throw new Error('open question object required')
  return {
    questionId: requiredId(question.questionId, 'questionId'),
    topic: requiredId(question.topic, 'question topic'),
    createdAtTurnId: requiredId(question.createdAtTurnId, 'question createdAtTurnId'),
  }
}

function updateAction(caseState, actionId, updater) {
  const index = caseState.actions.findIndex((action) => action.actionId === actionId)
  if (index < 0) throw new Error(`action not found: ${actionId}`)
  updater(caseState.actions[index])
  return caseState.actions[index]
}

function performEvent(next, event) {
  const payload = event.payload || {}
  const turnId = requiredId(event.turnId, 'event turnId')
  const at = requiredId(event.at, 'event at')
  const type = requiredId(event.type, 'event type')

  if (type === ASK_DW_CASE_EVENT.SET_PRESENTATION) {
    if (payload.tone != null) next.presentation.tone = requiredId(payload.tone, 'presentation tone')
    if (payload.detail != null) next.presentation.detail = requiredId(payload.detail, 'presentation detail')
    return
  }

  if (type === ASK_DW_CASE_EVENT.RECORD_CONVERSATION_MEMORY) {
    const memory = ensureConversationMemory(next)
    const caseState = activeCase(next)
    const turnType = boundedString(payload.turnType, 'conversation memory turnType', 80)
    if (!MEMORY_TURN_TYPES.has(turnType)) throw new Error('conversation memory turn type invalid')
    const mode = requiredId(payload.mode, 'conversation memory mode').toLowerCase()
    if (!['normal', 'deep'].includes(mode)) throw new Error('conversation memory mode invalid')
    const resolutionState = requiredId(
      payload.referenceResolution || 'UNCHANGED',
      'conversation memory reference resolution',
    )
    if (!MEMORY_RESOLUTION_STATES.has(resolutionState)) {
      throw new Error('conversation memory reference resolution invalid')
    }

    const correctionKind = optionalString(payload.correctionKind)
    if (correctionKind && !MEMORY_CORRECTION_KINDS.has(correctionKind)) {
      throw new Error('conversation memory correction kind invalid')
    }
    const resolutionStatus = optionalString(payload.resolutionStatus)
    if (resolutionStatus && !MEMORY_RESOLUTION_STATUSES.has(resolutionStatus)) {
      throw new Error('conversation memory resolution status invalid')
    }

    const turnRecord = {
      turnId,
      turnType,
      correctionKind,
      mode,
      resolutionStatus,
      caseId: next.activeCaseId,
    }
    memory.recentTurns.push(turnRecord)
    if (memory.recentTurns.length > MAX_MEMORY_TURNS) {
      const overflow = memory.recentTurns.length - MAX_MEMORY_TURNS
      memory.recentTurns = memory.recentTurns.slice(-MAX_MEMORY_TURNS)
      memory.compactedTurnCount += overflow
    }

    memory.recentTopics = [
      ...memory.recentTopics.filter((item) => item.topic !== turnType),
      { topic: turnType, lastTurnId: turnId },
    ].slice(-MAX_MEMORY_TOPICS)

    if (caseState.focus.clientRef || caseState.focus.invoiceRef) {
      const subjectKey = [
        caseState.focus.clientRef?.id || '',
        caseState.focus.invoiceRef?.id || '',
      ].join(':')
      memory.recentSubjects = [
        ...memory.recentSubjects.filter((item) => [
          item.clientRef?.id || '',
          item.invoiceRef?.id || '',
        ].join(':') !== subjectKey),
        {
          caseId: next.activeCaseId,
          clientRef: caseState.focus.clientRef ? normalizeRef(caseState.focus.clientRef, 'client') : null,
          invoiceRef: caseState.focus.invoiceRef ? normalizeRef(caseState.focus.invoiceRef, 'invoice') : null,
          lastTurnId: turnId,
        },
      ].slice(-MAX_MEMORY_SUBJECTS)
    }

    if (resolutionState === 'UNRESOLVED') {
      memory.unresolvedReference = {
        status: requiredId(resolutionStatus, 'unresolved reference status'),
        caseId: next.activeCaseId,
        clientRef: caseState.focus.clientRef ? normalizeRef(caseState.focus.clientRef, 'client') : null,
        candidateInvoiceRefs: [...normalizeRefs(
          caseState.candidates.invoiceRefs || [],
          'invoice',
          MAX_INVOICE_CANDIDATES,
        )],
        recordedAtTurnId: turnId,
      }
    } else if (resolutionState === 'RESOLVED') {
      memory.unresolvedReference = null
    }

    if (payload.nickname) {
      const term = normalizeAskDwConversationNicknameTerm(payload.nickname.term)
      const nicknameRef = normalizeRef(payload.nickname.ref)
      const matchesCurrentFocus = sameRef(nicknameRef, caseState.focus.clientRef) ||
        sameRef(nicknameRef, caseState.focus.invoiceRef)
      if (!matchesCurrentFocus) {
        throw new Error('conversation nickname must target the current verified focus')
      }
      const existing = memory.conversationalNicknames.find((item) => item.term === term)
      memory.conversationalNicknames = [
        ...memory.conversationalNicknames.filter((item) => item.term !== term),
        {
          term,
          ref: nicknameRef,
          createdAtTurnId: existing?.createdAtTurnId || turnId,
          lastUsedAtTurnId: turnId,
        },
      ].slice(-MAX_CONVERSATIONAL_NICKNAMES)
      upsertReferenceBinding(caseState, { term, ref: nicknameRef, turnId })
    }
    return
  }

  if (type === ASK_DW_CASE_EVENT.EXPIRE_CONVERSATION) {
    next.status = ASK_DW_CONVERSATION_STATUS.EXPIRED
    for (const caseState of Object.values(next.cases)) {
      invalidateCurrentAction(caseState, {
        reason: 'CONVERSATION_EXPIRED',
        turnId,
        at,
      })
    }
    return
  }

  if (type === ASK_DW_CASE_EVENT.OPEN_CASE) {
    const newCaseId = requiredId(payload.caseId, 'new caseId')
    if (next.cases[newCaseId]) throw new Error(`case already exists: ${newCaseId}`)
    const previous = next.activeCaseId
    next.cases[newCaseId] = makeCase({ caseId: newCaseId, turnId, at })
    next.activeCaseId = newCaseId
    next.recentCaseIds = [previous, ...next.recentCaseIds.filter((id) => id !== previous)]
      .slice(0, MAX_RECENT_CASES)
    return
  }

  if (type === ASK_DW_CASE_EVENT.SWITCH_CASE) {
    const targetCaseId = requiredId(payload.caseId, 'target caseId')
    if (!next.cases[targetCaseId]) throw new Error(`case not found: ${targetCaseId}`)
    if (targetCaseId === next.activeCaseId) return
    const previous = next.activeCaseId
    next.activeCaseId = targetCaseId
    next.recentCaseIds = [previous, ...next.recentCaseIds.filter(
      (id) => id !== previous && id !== targetCaseId,
    )].slice(0, MAX_RECENT_CASES)
    return
  }

  const caseState = activeCase(next)
  if (caseState.status === ASK_DW_CASE_STATUS.CLOSED && type !== ASK_DW_CASE_EVENT.CLOSE_CASE) {
    throw new Error('active case is closed')
  }

  if (type === ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT) {
    const newRef = normalizeRef(payload.clientRef, 'client')
    const oldRef = caseState.focus.clientRef
    if (!sameRef(oldRef, newRef)) {
      clearClientDerivedState(caseState, {
        oldClientRef: oldRef,
        turnId,
        at,
        reason: 'ACTIVE_CLIENT_CHANGED',
      })
      caseState.focus.clientRef = newRef
    }
    return
  }

  if (type === ASK_DW_CASE_EVENT.CLEAR_ACTIVE_FOCUS) {
    clearClientDerivedState(caseState, {
      oldClientRef: caseState.focus.clientRef,
      turnId,
      at,
      reason: 'ACTIVE_REFERENCE_UNAVAILABLE',
    })
    return
  }

  if (type === ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES) {
    const invoiceRefs = [...normalizeRefs(
      payload.invoiceRefs || [],
      'invoice',
      MAX_INVOICE_CANDIDATES,
    )]
    if (caseState.focus.invoiceRef && !containsRef(invoiceRefs, caseState.focus.invoiceRef)) {
      clearInvoiceDerivedState(caseState, {
        oldInvoiceRef: caseState.focus.invoiceRef,
        turnId,
        at,
        reason: 'ACTIVE_INVOICE_LEFT_CANDIDATE_SET',
      })
    }
    caseState.candidates.invoiceRefs = invoiceRefs
    return
  }

  if (type === ASK_DW_CASE_EVENT.SELECT_INVOICE ||
      type === ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE) {
    const newRef = normalizeRef(payload.invoiceRef, 'invoice')
    if (caseState.candidates.invoiceRefs.length > 0 &&
        !containsRef(caseState.candidates.invoiceRefs, newRef)) {
      throw new Error('selected invoice is not in resolved candidate set')
    }
    const oldRef = caseState.focus.invoiceRef
    if (!sameRef(oldRef, newRef)) {
      clearInvoiceDerivedState(caseState, {
        oldInvoiceRef: oldRef,
        turnId,
        at,
        reason: type === ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE
          ? 'ACTIVE_INVOICE_CORRECTED'
          : 'ACTIVE_INVOICE_CHANGED',
      })
      caseState.focus.invoiceRef = newRef
    }
    return
  }

  if (type === ASK_DW_CASE_EVENT.SET_ACTIVE_DISPUTE) {
    caseState.focus.disputeRef = payload.disputeRef
      ? normalizeRef(payload.disputeRef, 'dispute')
      : null
    return
  }

  if (type === ASK_DW_CASE_EVENT.SET_INVESTIGATION) {
    const status = requiredId(payload.status, 'investigation status')
    const investigationRef = payload.investigationRef
      ? normalizeRef(payload.investigationRef, 'investigation')
      : caseState.investigation.ref
    caseState.investigation = {
      ref: investigationRef,
      status,
      startedAtTurnId: caseState.investigation.startedAtTurnId || turnId,
      updatedAtTurnId: turnId,
    }
    return
  }

  if (type === ASK_DW_CASE_EVENT.SET_ARTIFACT_REF) {
    caseState.artifactRef = payload.artifactRef
      ? normalizeRef(payload.artifactRef, 'artifact')
      : null
    return
  }

  if (type === ASK_DW_CASE_EVENT.SET_EVIDENCE_REFS) {
    caseState.evidenceRefs = [...normalizeRefs(
      payload.evidenceRefs || [],
      'evidence',
      MAX_EVIDENCE_REFS,
    )]
    return
  }

  if (type === ASK_DW_CASE_EVENT.SET_OPEN_QUESTIONS) {
    if (!Array.isArray(payload.questions)) throw new Error('questions array required')
    caseState.openQuestions = payload.questions.slice(0, MAX_OPEN_QUESTIONS).map(normalizeQuestion)
    return
  }

  if (type === ASK_DW_CASE_EVENT.SET_RECOMMENDATION_REF) {
    caseState.recommendationRef = payload.recommendationRef
      ? normalizeRef(payload.recommendationRef, 'recommendation')
      : null
    return
  }

  if (type === ASK_DW_CASE_EVENT.RESOLVE_REFERENCE) {
    upsertReferenceBinding(caseState, {
      term: payload.term,
      ref: payload.ref,
      turnId,
    })
    return
  }

  if (type === ASK_DW_CASE_EVENT.OFFER_ACTION) {
    const actionId = requiredId(payload.actionId, 'actionId')
    if (caseState.actions.some((action) => action.actionId === actionId)) {
      throw new Error(`action already exists: ${actionId}`)
    }
    const targetRefs = [...normalizeRefs(payload.targetRefs || [])]
    if (targetRefs.length === 0) throw new Error('offered action requires at least one target reference')

    const action = {
      actionId,
      actionType: requiredId(payload.actionType, 'actionType'),
      targetRefs,
      scope: requiredId(payload.scope, 'action scope'),
      status: ASK_DW_ACTION_STATUS.OFFERED,
      offeredAtTurnId: turnId,
      updatedAtTurnId: turnId,
      createdAt: at,
      updatedAt: at,
      invalidatedReason: null,
      invalidatedAtTurnId: null,
      suspendedAtTurnId: null,
      confirmedAtTurnId: null,
      authorityRequirement: 'EXPLICIT_REFERENCE_CONFIRMATION_PLUS_FRESH_REVALIDATION',
      requiresFreshState: true,
      requiresAuthorityRecheck: true,
      executionAuthorized: false,
    }

    caseState.actions.push(action)
    caseState.actions = caseState.actions.slice(-MAX_ACTION_HISTORY)
    caseState.activeActionId = actionId
    return
  }

  if (type === ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION) {
    const actionId = requiredId(payload.actionId, 'actionId')
    const action = updateAction(caseState, actionId, (item) => {
      if (item.status !== ASK_DW_ACTION_STATUS.OFFERED) {
        throw new Error('only an offered action can request confirmation')
      }
      item.status = ASK_DW_ACTION_STATUS.AWAITING_CONFIRMATION
      item.updatedAtTurnId = turnId
      item.updatedAt = at
    })
    caseState.activeActionId = action.actionId
    return
  }

  if (type === ASK_DW_CASE_EVENT.SUSPEND_ACTION) {
    const actionId = requiredId(payload.actionId, 'actionId')
    const action = updateAction(caseState, actionId, (item) => {
      if (![ASK_DW_ACTION_STATUS.OFFERED, ASK_DW_ACTION_STATUS.AWAITING_CONFIRMATION]
        .includes(item.status)) {
        throw new Error('action cannot be suspended from current status')
      }
      item.status = ASK_DW_ACTION_STATUS.SUSPENDED
      item.suspendedAtTurnId = turnId
      item.updatedAtTurnId = turnId
      item.updatedAt = at
    })
    caseState.activeActionId = action.actionId
    return
  }

  if (type === ASK_DW_CASE_EVENT.CANCEL_ACTION) {
    const actionId = requiredId(payload.actionId, 'actionId')
    updateAction(caseState, actionId, (item) => {
      if ([ASK_DW_ACTION_STATUS.CANCELLED, ASK_DW_ACTION_STATUS.INVALIDATED]
        .includes(item.status)) return
      item.status = ASK_DW_ACTION_STATUS.CANCELLED
      item.updatedAtTurnId = turnId
      item.updatedAt = at
    })
    if (caseState.activeActionId === actionId) caseState.activeActionId = null
    return
  }

  if (type === ASK_DW_CASE_EVENT.CONFIRM_ACTION_REFERENCE) {
    const actionId = requiredId(payload.actionId, 'actionId')
    const offeredAtTurnId = requiredId(payload.offeredAtTurnId, 'offeredAtTurnId')
    const action = updateAction(caseState, actionId, (item) => {
      if (![ASK_DW_ACTION_STATUS.AWAITING_CONFIRMATION, ASK_DW_ACTION_STATUS.SUSPENDED]
        .includes(item.status)) {
        throw new Error('action is not awaiting a confirmable reference')
      }
      if (item.offeredAtTurnId !== offeredAtTurnId) {
        throw new Error('action turn anchor mismatch')
      }
      item.status = ASK_DW_ACTION_STATUS.CONFIRMED_PENDING_REVALIDATION
      item.confirmedAtTurnId = turnId
      item.updatedAtTurnId = turnId
      item.updatedAt = at
      item.executionAuthorized = false
      item.requiresFreshState = true
      item.requiresAuthorityRecheck = true
    })
    caseState.activeActionId = action.actionId
    return
  }

  if (type === ASK_DW_CASE_EVENT.CLOSE_CASE) {
    caseState.status = ASK_DW_CASE_STATUS.CLOSED
    invalidateCurrentAction(caseState, {
      reason: 'CASE_CLOSED',
      turnId,
      at,
    })
    return
  }

  throw new Error(`unsupported Ask DW case event: ${type}`)
}

export function applyAskDwCaseEvent(state, event = {}) {
  validateState(state)
  const expectedVersion = event.expectedVersion
  if (!Number.isInteger(expectedVersion)) throw new Error('event expectedVersion required')
  if (expectedVersion !== state.version) {
    throw new Error(`stale case state version: expected ${expectedVersion}, actual ${state.version}`)
  }

  const tenantId = requiredId(event.tenantId, 'event tenantId')
  if (tenantId !== state.tenantId) throw new Error('cross-tenant case event blocked')

  const at = requiredId(event.at, 'event at')
  const type = requiredId(event.type, 'event type')
  requireActiveConversation(state, type)
  assertNotExpiredByTime(state, at, type)

  const next = clone(state)
  performEvent(next, event)

  const currentCase = next.cases[next.activeCaseId]
  if (currentCase) {
    currentCase.updatedAt = at
    currentCase.lastTurnId = requiredId(event.turnId, 'event turnId')
  }

  next.version += 1
  next.updatedAt = at
  next.lastTransition = {
    type,
    turnId: requiredId(event.turnId, 'event turnId'),
    at,
    caseId: next.activeCaseId,
  }

  validateState(next)
  return freeze(next)
}

export function getAskDwActiveCase(state) {
  validateState(state)
  return activeCase(state)
}

export function getAskDwActiveAction(state) {
  const caseState = getAskDwActiveCase(state)
  return activeAction(caseState)
}

export function getAskDwConversationMemory(state) {
  validateState(state)
  return freeze(clone(state.memory || makeConversationMemory()))
}

export function resolveAskDwReference(state, term) {
  const caseState = getAskDwActiveCase(state)
  const normalizedTerm = requiredId(term, 'reference term').toLowerCase()
  const binding = [...caseState.referenceBindings]
    .reverse()
    .find((item) => item.term === normalizedTerm)
  return binding ? binding.ref : null
}

export function assertAskDwActionReadyForExecutionBoundary(state, actionId) {
  const caseState = getAskDwActiveCase(state)
  const action = caseState.actions.find((item) => item.actionId === actionId)
  if (!action) throw new Error(`action not found: ${actionId}`)
  if (action.status !== ASK_DW_ACTION_STATUS.CONFIRMED_PENDING_REVALIDATION) {
    throw new Error('action does not have current explicit reference confirmation')
  }
  if (action.executionAuthorized !== false ||
      action.requiresFreshState !== true ||
      action.requiresAuthorityRecheck !== true) {
    throw new Error('case state action boundary is malformed')
  }

  return freeze({
    actionId: action.actionId,
    actionType: action.actionType,
    targetRefs: clone(action.targetRefs),
    scope: action.scope,
    confirmationTurnId: action.confirmedAtTurnId,
    executionAuthorized: false,
    requiresFreshState: true,
    requiresAuthorityRecheck: true,
  })
}

export function validateAskDwCaseState(state) {
  return validateState(state)
}
