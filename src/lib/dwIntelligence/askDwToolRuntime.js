export const ASK_DW_READ_TOOL = Object.freeze({
  CANONICAL_STATE: 'canonical_state',
  EVIDENCE_SEARCH: 'evidence_search',
  PAYMENT_RECONCILIATION: 'payment_reconciliation',
  DISPUTE_CONTEXT: 'dispute_context',
  PRECEDENT_SEARCH: 'precedent_search',
  ACTIVITY_HISTORY: 'activity_history',
  PORTFOLIO_SUMMARY: 'portfolio_summary',
})

export const ASK_DW_TOOL_SCOPE = Object.freeze({
  INVOICE: 'INVOICE',
  CLIENT: 'CLIENT',
  PORTFOLIO: 'PORTFOLIO',
})

const ALLOWED_TOOL_NAMES = new Set(Object.values(ASK_DW_READ_TOOL))
const FORBIDDEN_RESULT_KEYS = new Set([
  'authorityGranted',
  'canExecute',
  'executeNow',
  'canonicalMutation',
  'providerSend',
  'sideEffect',
])

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function plainClone(value) {
  if (value == null) return value
  const serialized = JSON.stringify(value)
  if (serialized == null) throw new Error('Ask DW tool result must be JSON-serializable')
  return JSON.parse(serialized)
}

function inspectForbiddenKeys(value, path = '$') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectForbiddenKeys(item, `${path}[${index}]`))
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) {
      throw new Error(`Ask DW read tool attempted to return forbidden authority/execution field at ${path}.${key}`)
    }
    inspectForbiddenKeys(nested, `${path}.${key}`)
  }
}

function assertTenantContext(context = {}) {
  const tenantId = String(context.tenantId || '').trim()
  if (!tenantId) throw new Error('Ask DW tool tenantId required')
  return tenantId
}

function assertScope(scope, context = {}) {
  if (!Object.values(ASK_DW_TOOL_SCOPE).includes(scope)) {
    throw new Error(`Unsupported Ask DW tool scope: ${scope}`)
  }
  if (scope === ASK_DW_TOOL_SCOPE.INVOICE && !String(context.invoiceId || '').trim()) {
    throw new Error('Ask DW invoice-scoped tool requires invoiceId')
  }
  if (scope === ASK_DW_TOOL_SCOPE.CLIENT && !String(context.clientId || '').trim()) {
    throw new Error('Ask DW client-scoped tool requires clientId')
  }
}

function validateDefinition(name, definition = {}) {
  if (!ALLOWED_TOOL_NAMES.has(name)) throw new Error(`Unsupported Ask DW read tool: ${name}`)
  if (typeof definition.handler !== 'function') throw new Error(`Ask DW read tool ${name} requires a handler`)
  const scopes = Array.isArray(definition.scopes) ? definition.scopes : []
  if (scopes.length === 0 || scopes.some((scope) => !Object.values(ASK_DW_TOOL_SCOPE).includes(scope))) {
    throw new Error(`Ask DW read tool ${name} requires valid scopes`)
  }
  return Object.freeze({
    name,
    handler: definition.handler,
    scopes: Object.freeze([...scopes]),
    sourceClass: String(definition.sourceClass || 'ATTRIBUTED_READ'),
    canonicalAuthority: definition.canonicalAuthority === true,
  })
}

/**
 * Creates an allow-listed, read-only tool registry for Ask DW.
 *
 * Handlers receive a frozen tenant/scoped context and JSON-safe input. Tool
 * results may provide facts/evidence, but they cannot return execution or
 * authority fields and never mutate canonical financial state through this
 * registry.
 */
export function createAskDwReadToolRegistry({ definitions = {} } = {}) {
  const registry = new Map()
  for (const [name, definition] of Object.entries(definitions)) {
    registry.set(name, validateDefinition(name, definition))
  }

  return freeze({
    list() {
      return Object.freeze([...registry.values()].map((definition) => Object.freeze({
        name: definition.name,
        scopes: definition.scopes,
        sourceClass: definition.sourceClass,
        canonicalAuthority: definition.canonicalAuthority,
        readOnly: true,
      })))
    },

    async execute({ name, scope, input = {}, context = {} } = {}) {
      const tenantId = assertTenantContext(context)
      assertScope(scope, context)
      const definition = registry.get(name)
      if (!definition) throw new Error(`Ask DW read tool not registered: ${name}`)
      if (!definition.scopes.includes(scope)) {
        throw new Error(`Ask DW read tool ${name} does not support scope ${scope}`)
      }

      const safeInput = freeze(plainClone(input) ?? {})
      const safeContext = freeze({
        tenantId,
        invoiceId: context.invoiceId ?? null,
        clientId: context.clientId ?? null,
        asOf: context.asOf ?? null,
      })

      const raw = await definition.handler({ input: safeInput, context: safeContext })
      const result = plainClone(raw ?? null)
      inspectForbiddenKeys(result)

      return freeze({
        name,
        scope,
        tenantId,
        sourceClass: definition.sourceClass,
        canonicalAuthority: definition.canonicalAuthority,
        readOnly: true,
        sideEffect: false,
        result,
      })
    },
  })
}
