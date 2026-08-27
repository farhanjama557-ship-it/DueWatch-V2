import {
  validateAskDwCaseState,
} from './askDwCaseState.js'

const TABLE = 'ask_dw_conversations'
const PERSIST_RPC = 'persist_ask_dw_conversation_state'
const MAX_CONVERSATION_ID_LENGTH = 200
const MAX_STATE_BYTES = 256 * 1024

const SAFE_PERSIST_OUTCOMES = new Set([
  'CREATED',
  'UPDATED',
  'IDEMPOTENT_REPLAY',
])

const FORBIDDEN_PERSISTENCE_CAPABILITY_KEYS = new Set([
  'financialexecutionauthorized',
  'financial_execution_authorized',
  'canonicalmutationauthorized',
  'canonical_mutation_authorized',
  'writesperformed',
  'writes_performed',
  'executionauthority',
  'execution_authority',
  'businessauthority',
  'business_authority',
  'authorityactual',
  'authority_actual',
  'authoritygranted',
  'authority_granted',
  'canexecute',
  'can_execute',
  'canwrite',
  'can_write',
  'cansend',
  'can_send',
  'sendauthorized',
  'send_authorized',
  'mutationauthorized',
  'mutation_authorized',
])

export const ASK_DW_CONVERSATION_PERSISTENCE_PROFILE = Object.freeze({
  id: 'ASK_DW_CONVERSATION_PERSISTENCE_V0',
  table: TABLE,
  writeBoundary: 'AUTHENTICATED_RPC_ONLY',
  authenticatedTenantRequired: true,
  directBrowserTableWrites: false,
  storesReferenceWorkflowStateOnly: true,
  canonicalFinancialTruthStored: false,
  rawToolOutputsStored: false,
  businessAuthorityStored: false,
  executionAuthorityStored: false,
  optimisticConcurrencyRequired: true,
  modelDependency: false,
  providerDependency: false,
  financialExecutionAuthorized: false,
  maxStateBytes: MAX_STATE_BYTES,
})

export class AskDwConversationPersistenceConflictError extends Error {
  constructor(message = 'Ask DW conversation changed in another session.') {
    super(message)
    this.name = 'AskDwConversationPersistenceConflictError'
    this.code = 'ASK_DW_CONVERSATION_STALE'
  }
}

export class AskDwConversationExpiredError extends Error {
  constructor(message = 'Ask DW conversation expired before persistence completed.') {
    super(message)
    this.name = 'AskDwConversationExpiredError'
    this.code = 'ASK_DW_CONVERSATION_EXPIRED'
  }
}

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

function normalizeConversationId(value) {
  const id = required(value, 'Ask DW conversation persistence conversationId')
  if (id.length > MAX_CONVERSATION_ID_LENGTH) {
    throw new Error('Ask DW conversation persistence conversationId too long')
  }
  return id
}

function parseIso(value, label, { optional = false } = {}) {
  if (value == null && optional) return null
  const raw = required(value, label)
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) throw new Error(`${label} invalid`)
  return new Date(time).toISOString()
}

function stateByteLength(state) {
  const serialized = JSON.stringify(state)
  return new TextEncoder().encode(serialized).byteLength
}

function assertPersistenceCapabilitiesSafe(value, path = 'state') {
  if (!value || typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((nested, index) => {
      assertPersistenceCapabilitiesSafe(nested, `${path}[${index}]`)
    })
    return
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase()
    if (FORBIDDEN_PERSISTENCE_CAPABILITY_KEYS.has(normalized)) {
      throw new Error(`forbidden persistence capability field at ${path}.${key}`)
    }
    if (normalized === 'executionauthorized' && nested !== false) {
      throw new Error(`execution authority is not persistable at ${path}.${key}`)
    }
    assertPersistenceCapabilitiesSafe(nested, `${path}.${key}`)
  }
}

function validatePersistenceState(state, { tenantId, conversationId } = {}) {
  validateAskDwCaseState(state)
  assertPersistenceCapabilitiesSafe(state)

  const tenant = required(tenantId, 'Ask DW conversation persistence tenantId')
  const conversation = normalizeConversationId(conversationId)

  if (state.tenantId !== tenant) {
    throw new Error('Ask DW conversation persistence tenant mismatch')
  }
  if (state.conversationId !== conversation) {
    throw new Error('Ask DW conversation persistence conversation mismatch')
  }
  if (stateByteLength(state) > MAX_STATE_BYTES) {
    throw new Error('Ask DW conversation persistence state exceeds size limit')
  }

  parseIso(state.createdAt, 'Ask DW case state createdAt')
  parseIso(state.updatedAt, 'Ask DW case state updatedAt')
  parseIso(state.expiresAt, 'Ask DW case state expiresAt', { optional: true })

  return freeze(clone(state))
}

async function assertAuthenticatedTenant(supabase, tenantId) {
  if (!supabase?.auth?.getUser) {
    throw new Error('Ask DW conversation persistence requires auth.getUser')
  }

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    throw new Error('Ask DW conversation persistence requires authentication')
  }
  if (data.user.id !== tenantId) {
    throw new Error('Ask DW conversation persistence tenant mismatch')
  }
}

function isStaleError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code === '40001' ||
    message.includes('ASK_DW_CONVERSATION_STALE') ||
    message.includes('ASK_DW_CONVERSATION_ALREADY_EXISTS')
}

function isExpiredError(error) {
  return String(error?.message || '').includes('ASK_DW_CONVERSATION_EXPIRED')
}

function normalizePersistReceipt(data, state) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Ask DW persistence RPC returned an invalid receipt')
  }

  const conversationId = normalizeConversationId(data.conversation_id)
  const stateVersion = Number(data.state_version)

  if (conversationId !== state.conversationId) {
    throw new Error('Ask DW persistence receipt conversation mismatch')
  }
  if (!Number.isInteger(stateVersion) || stateVersion !== state.version) {
    throw new Error('Ask DW persistence receipt version mismatch')
  }

  const outcome = required(data.outcome, 'Ask DW persistence receipt outcome')
  if (!SAFE_PERSIST_OUTCOMES.has(outcome)) {
    throw new Error(`Ask DW persistence receipt outcome not allowed: ${outcome}`)
  }

  return freeze({
    source: 'SUPABASE_RPC',
    rpc: PERSIST_RPC,
    conversationId,
    stateVersion,
    outcome,
    idempotentReplay: data.idempotent_replay === true,
    persistedAt: data.persisted_at == null
      ? null
      : parseIso(data.persisted_at, 'Ask DW persistence receipt persistedAt'),
    canonicalFinancialTruthStored: false,
    businessAuthorityStored: false,
    financialExecutionAuthorized: false,
  })
}

export function createAskDwConversationPersistence({ supabase } = {}) {
  if (!supabase?.from || !supabase?.rpc) {
    throw new Error('Ask DW conversation persistence requires Supabase')
  }

  async function load({ tenantId, conversationId } = {}) {
    const tenant = required(tenantId, 'Ask DW conversation persistence tenantId')
    const conversation = normalizeConversationId(conversationId)

    await assertAuthenticatedTenant(supabase, tenant)

    const { data, error } = await supabase
      .from(TABLE)
      .select('user_id,conversation_id,schema_version,state_version,status,state,expires_at,created_at,updated_at')
      .eq('user_id', tenant)
      .eq('conversation_id', conversation)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    if (data.user_id !== tenant || data.conversation_id !== conversation) {
      throw new Error('Ask DW persisted conversation scope mismatch')
    }

    const state = validatePersistenceState(data.state, {
      tenantId: tenant,
      conversationId: conversation,
    })

    if (data.schema_version !== state.schemaVersion) {
      throw new Error('Ask DW persisted conversation schema mismatch')
    }
    if (!Number.isInteger(data.state_version) || data.state_version !== state.version) {
      throw new Error('Ask DW persisted conversation version mismatch')
    }
    if (data.status !== state.status) {
      throw new Error('Ask DW persisted conversation status mismatch')
    }

    const rowExpires = data.expires_at == null
      ? null
      : parseIso(data.expires_at, 'Ask DW persisted expires_at')
    const stateExpires = state.expiresAt == null
      ? null
      : parseIso(state.expiresAt, 'Ask DW case state expiresAt')

    if (rowExpires !== stateExpires) {
      throw new Error('Ask DW persisted conversation expiry mismatch')
    }

    return freeze({
      state,
      receipt: freeze({
        source: 'SUPABASE_READ',
        conversationId: conversation,
        stateVersion: state.version,
        loadedAt: new Date().toISOString(),
        canonicalFinancialTruthLoaded: false,
        businessAuthorityLoaded: false,
      }),
    })
  }

  async function persist({ tenantId, expectedVersion = null, state } = {}) {
    const tenant = required(tenantId, 'Ask DW conversation persistence tenantId')
    const conversation = normalizeConversationId(state?.conversationId)
    const safeState = validatePersistenceState(state, {
      tenantId: tenant,
      conversationId: conversation,
    })

    if (expectedVersion != null) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error('Ask DW persistence expectedVersion invalid')
      }
      if (safeState.version < expectedVersion) {
        throw new Error('Ask DW persistence state version regressed')
      }
    }

    await assertAuthenticatedTenant(supabase, tenant)

    const { data, error } = await supabase.rpc(PERSIST_RPC, {
      p_conversation_id: conversation,
      p_expected_version: expectedVersion,
      p_state: clone(safeState),
    })

    if (error) {
      if (isExpiredError(error)) {
        throw new AskDwConversationExpiredError()
      }
      if (isStaleError(error)) {
        throw new AskDwConversationPersistenceConflictError()
      }
      throw error
    }

    return normalizePersistReceipt(data, safeState)
  }

  return freeze({
    profile: ASK_DW_CONVERSATION_PERSISTENCE_PROFILE,
    load,
    persist,
  })
}
