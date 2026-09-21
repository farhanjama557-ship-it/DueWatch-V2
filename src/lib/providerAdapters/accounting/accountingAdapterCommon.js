/**
 * M2H-CP2 — pure accounting-provider adapter utilities.
 *
 * This module does not admit claims, decide freshness, or select governing
 * truth. Provider adapters only describe observations for CP1's constructors.
 */

export const ACCOUNTING_ADAPTER_WRITE_SUPPORT = 'NO'

export function materialString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function finiteAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}

export function requireConnectionIdentity(connection, provider) {
  if (materialString(connection?.tenantId) == null) throw new Error('connection tenantId required')
  if (connection?.provider !== provider) throw new Error(`connection provider must be ${provider}`)
  if (materialString(connection?.providerAccountId) == null) {
    throw new Error('connection providerAccountId required')
  }
  return freeze({
    tenantId: connection.tenantId.trim(), provider,
    providerAccountId: connection.providerAccountId.trim(),
  })
}

/**
 * Pure page state for CP2 laboratory replay. Completeness is explicit; a
 * failed or missing page never means an empty source. Boundary duplicates are
 * idempotent by provider-account-scoped object identity, and an older version
 * cannot replace a newer one.
 */
export function createAccountingSyncState(expectedConnection) {
  const expected = requireConnectionIdentity(expectedConnection, expectedConnection?.provider)
  const objects = new Map()
  let failed = false
  let terminalPageSeen = false

  return {
    ingestPage({ connection, items = [], pageComplete = false, failed: pageFailed = false } = {}) {
      let supplied
      try {
        supplied = requireConnectionIdentity(connection, expected.provider)
      } catch {
        return freeze({ accepted: false, reason: 'REJECTED_CONNECTION_IDENTITY',
          syncComplete: false, itemCount: objects.size })
      }
      for (const field of ['tenantId', 'provider', 'providerAccountId']) {
        if (supplied[field] !== expected[field]) {
          return freeze({ accepted: false, reason: `REJECTED_${field.toUpperCase()}`,
            syncComplete: false, itemCount: objects.size })
        }
      }
      if (pageFailed) {
        failed = true
        return freeze({ accepted: false, reason: 'PAGE_FAILED', syncComplete: false,
          itemCount: objects.size })
      }
      for (const item of items) {
        const objectType = materialString(item?.objectType)
        const externalObjectId = materialString(item?.externalObjectId)
        const versionAt = Date.parse(item?.versionAt ?? '')
        if (!objectType || !externalObjectId || !Number.isFinite(versionAt)) {
          failed = true
          continue
        }
        const key = `${expected.provider}:${expected.providerAccountId}:${objectType}:${externalObjectId}`
        const prior = objects.get(key)
        if (!prior || versionAt > prior.versionAt) {
          objects.set(key, { ...JSON.parse(JSON.stringify(item)), versionAt })
        }
      }
      terminalPageSeen ||= pageComplete === true
      return freeze({ accepted: true, reason: null,
        syncComplete: terminalPageSeen && !failed, itemCount: objects.size })
    },
    get snapshot() {
      return freeze({ syncComplete: terminalPageSeen && !failed, sourceUnavailable: failed,
        items: [...objects.values()].map(({ versionAt, ...item }) => item) })
    },
  }
}

export function refetchObligation({ tenantId, provider, providerAccountId, eventId, targets, reason }) {
  const identity = requireConnectionIdentity({ tenantId, provider, providerAccountId }, provider)
  return freeze({
    kind: 'M2H_CP2_REFETCH_OBLIGATION_V0', ...identity,
    eventId, targets: [...new Set(targets)].sort(), reason,
    stateWrittenFromEvent: false, persistentLifecycleOwner: 'M2H_CP6',
  })
}
