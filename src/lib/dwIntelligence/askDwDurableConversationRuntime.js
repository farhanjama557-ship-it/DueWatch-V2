import {
  ASK_DW_CONVERSATION_STATUS,
  createAskDwCaseState,
  validateAskDwCaseState,
} from './askDwCaseState.js'
import {
  createAskDwControlledConversationRuntime,
  createAskDwControlledInvoiceCaseState,
} from './askDwControlledConversationRuntime.js'
import {
  ASK_DW_ENTITY_RESOLVER_PROFILE,
  createAskDwEntityResolver,
} from './askDwEntityResolver.js'
import {
  ASK_DW_CONVERSATION_PERSISTENCE_PROFILE,
  AskDwConversationExpiredError,
  AskDwConversationPersistenceConflictError,
  createAskDwConversationPersistence,
} from './askDwConversationPersistence.js'

export const ASK_DW_DURABLE_CONVERSATION_PROFILE = Object.freeze({
  id: 'ASK_DW_DURABLE_CONVERSATION_V0',
  durableCaseState: true,
  storesTranscript: false,
  storesReferenceWorkflowStateOnly: true,
  canonicalFinancialTruthStored: false,
  rawToolOutputsStored: false,
  businessAuthorityStored: false,
  executionAuthorityStored: false,
  freshLiveReadStillRequired: true,
  authorityRecheckStillRequired: true,
  staleConcurrentWritesFailClosed: true,
  modelDependencyAddedByDurability: false,
  providerDependencyAddedByDurability: false,
  financialExecutionAuthorizedByDurability: false,
})

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
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} required`)
  return normalized
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Ask DW durable conversation time invalid')
  return date.toISOString()
}

function conversationRunner(runtime) {
  const runner = runtime?.runConversationTurn || runtime?.runTurn
  if (typeof runner !== 'function') {
    throw new Error('Ask DW durable conversation requires a conversation runtime')
  }
  return runner.bind(runtime)
}

function initialState({
  tenantId,
  conversationId,
  caseId,
  turnId,
  now,
  expiresAt,
  initialInvoiceId,
  initialInvoiceIds,
}) {
  if (initialInvoiceId) {
    return createAskDwControlledInvoiceCaseState({
      tenantId,
      conversationId,
      caseId,
      turnId,
      now,
      expiresAt,
      invoiceId: initialInvoiceId,
      invoiceIds: initialInvoiceIds,
    })
  }

  return createAskDwCaseState({
    tenantId,
    conversationId,
    caseId,
    turnId,
    now: iso(now),
    expiresAt,
  })
}

function expiredByTime(state, now) {
  if (!state?.expiresAt) return false
  const expiry = Date.parse(state.expiresAt)
  const current = Date.parse(iso(now))
  return Number.isFinite(expiry) && current >= expiry
}

function expiryResult(state, durability) {
  return freeze({
    status: 'CONVERSATION_EXPIRED',
    caseState: state,
    caseContext: null,
    appliedEvents: [],
    control: null,
    resolver: null,
    askDw: null,
    executionBoundary: null,
    reason: 'This Ask DW conversation has expired and cannot be revived.',
    durability,
  })
}

function staleResult() {
  return freeze({
    status: 'CONVERSATION_STALE_RELOAD_REQUIRED',
    caseState: null,
    caseContext: null,
    appliedEvents: [],
    control: null,
    resolver: null,
    askDw: null,
    executionBoundary: null,
    reason: 'This Ask DW conversation changed in another session. Reload the conversation and retry this turn.',
    durability: freeze({
      loaded: true,
      persisted: false,
      staleWriteRejected: true,
      canonicalFinancialTruthPersisted: false,
      businessAuthorityPersisted: false,
    }),
  })
}

export function createAskDwDurableConversationRuntime({
  conversationRuntime,
  persistence,
} = {}) {
  const runConversation = conversationRunner(conversationRuntime)

  if (!persistence?.load || !persistence?.persist) {
    throw new Error('Ask DW durable conversation requires persistence')
  }

  async function runConversationTurn({
    tenantId,
    conversationId,
    caseId = 'primary',
    turnId,
    text,
    now = new Date(),
    expiresAt = null,
    initialInvoiceId = null,
    initialInvoiceIds = null,
  } = {}) {
    const tenant = required(tenantId, 'Ask DW durable conversation tenantId')
    const conversation = required(conversationId, 'Ask DW durable conversation conversationId')
    const turn = required(turnId, 'Ask DW durable conversation turnId')
    const at = iso(now)

    const loaded = await persistence.load({
      tenantId: tenant,
      conversationId: conversation,
    })

    const state = loaded?.state || initialState({
      tenantId: tenant,
      conversationId: conversation,
      caseId: required(caseId, 'Ask DW durable conversation caseId'),
      turnId: turn,
      now: at,
      expiresAt,
      initialInvoiceId,
      initialInvoiceIds,
    })

    validateAskDwCaseState(state)

    if (state.tenantId !== tenant || state.conversationId !== conversation) {
      throw new Error('Ask DW durable conversation loaded scope mismatch')
    }

    const loadedDurability = freeze({
      loaded: Boolean(loaded),
      persisted: false,
      loadedVersion: loaded?.state?.version ?? null,
      canonicalFinancialTruthPersisted: false,
      businessAuthorityPersisted: false,
    })

    if (
      state.status === ASK_DW_CONVERSATION_STATUS.EXPIRED ||
      expiredByTime(state, at)
    ) {
      return expiryResult(state, loadedDurability)
    }

    const priorVersion = state.version
    const result = await runConversation({
      tenantId: tenant,
      caseState: state,
      turnId: turn,
      text,
      now: new Date(at),
    })

    validateAskDwCaseState(result?.caseState)

    if (
      result.caseState.tenantId !== tenant ||
      result.caseState.conversationId !== conversation
    ) {
      throw new Error('Ask DW durable conversation runtime returned wrong scope')
    }

    let persistenceReceipt = null
    const mustPersist = !loaded || result.caseState.version !== priorVersion

    if (mustPersist) {
      try {
        persistenceReceipt = await persistence.persist({
          tenantId: tenant,
          expectedVersion: loaded ? priorVersion : null,
          state: result.caseState,
        })
      } catch (error) {
        if (
          error instanceof AskDwConversationExpiredError ||
          error?.code === 'ASK_DW_CONVERSATION_EXPIRED'
        ) {
          return expiryResult(state, freeze({
            ...loadedDurability,
            persistenceRaceExpired: true,
          }))
        }
        if (
          error instanceof AskDwConversationPersistenceConflictError ||
          error?.code === 'ASK_DW_CONVERSATION_STALE'
        ) {
          return staleResult()
        }
        throw error
      }
    }

    return freeze({
      ...clone(result),
      durability: freeze({
        loaded: Boolean(loaded),
        persisted: mustPersist,
        loadedVersion: loaded?.state?.version ?? null,
        persistedVersion: persistenceReceipt?.stateVersion ?? result.caseState.version,
        persistenceReceipt,
        canonicalFinancialTruthPersisted: false,
        rawToolOutputsPersisted: false,
        businessAuthorityPersisted: false,
        financialExecutionAuthorizedByPersistence: false,
      }),
    })
  }

  return freeze({
    profile: ASK_DW_DURABLE_CONVERSATION_PROFILE,
    persistenceProfile: persistence.profile ?? null,
    runConversationTurn,
  })
}

export function createAskDwDurableControlledConversationRuntime({
  supabase,
  persistence = null,
} = {}) {
  const entityResolver = createAskDwEntityResolver({ supabase })
  const controlled = createAskDwControlledConversationRuntime({
    supabase,
    resolveCaseEvents: entityResolver.resolveCaseEvents,
  })
  const store = persistence || createAskDwConversationPersistence({ supabase })
  const durable = createAskDwDurableConversationRuntime({
    conversationRuntime: controlled,
    persistence: store,
  })

  return freeze({
    scope: controlled.scope,
    conversationScope: 'INVOICE_DW_INTELLIGENCE_V1_CASE_STATE_DURABLE_V0',
    profile: ASK_DW_DURABLE_CONVERSATION_PROFILE,
    controlledProfile: controlled.profile,
    resolverProfile: ASK_DW_ENTITY_RESOLVER_PROFILE,
    persistenceProfile: ASK_DW_CONVERSATION_PERSISTENCE_PROFILE,
    runInvoiceQuestion: controlled.runInvoiceQuestion,
    runConversationTurn: durable.runConversationTurn,
  })
}
