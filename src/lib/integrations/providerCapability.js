/**
 * M2H-CP1 — provider capability, which is never DueWatch authority.
 *
 * "Connected ✓" hides six different questions behind one tick. They are kept
 * apart here because collapsing them is how a system ends up emailing a
 * customer for the reason "the token had the scope":
 *
 *   canRead                   the provider exposes this object to read
 *   canTechnicallyWrite       the API could change it
 *   supportedInProviderApi    the provider offers the operation at all
 *   supportedByDuewatchAdapter we have actually implemented it
 *   allowedByCurrentScopes    this connection's OAuth grant covers it
 *   authorizedByG5            NOT STORED HERE. See below.
 *
 * The first five are facts about a machine. The sixth is a decision by the
 * founder, owned by G5, evaluated fresh at the moment of use. A capability
 * record that carried it would be a permission cache, and a permission cache
 * is wrong the moment a grant is revoked.
 *
 *   Gmail scope permits sending  !=  DueWatch may send.
 *   Stripe permits refunds       !=  DueWatch may refund.
 *   QuickBooks token can edit    !=  DueWatch may edit the books.
 */

export const CAPABILITY_AXIS = Object.freeze({
  CAN_READ: 'canRead',
  CAN_TECHNICALLY_WRITE: 'canTechnicallyWrite',
  SUPPORTED_IN_PROVIDER_API: 'supportedInProviderApi',
  SUPPORTED_BY_DUEWATCH_ADAPTER: 'supportedByDuewatchAdapter',
  ALLOWED_BY_CURRENT_SCOPES: 'allowedByCurrentScopes',
})

export const CAPABILITY_VALUE = Object.freeze({
  YES: 'YES',
  NO: 'NO',
  UNKNOWN: 'UNKNOWN',
})

/** Fields a caller must never set: authority does not live in this record. */
const FORBIDDEN_CAPABILITY_FIELDS = new Set([
  'authorizedByG5', 'authorized', 'authorised', 'permitted', 'allowed',
  'canDoIt', 'canAct', 'canExecute', 'grant', 'grants', 'standingAuthority',
])

function value(input, name) {
  if (input === undefined || input === null) return CAPABILITY_VALUE.UNKNOWN
  if (!Object.values(CAPABILITY_VALUE).includes(input)) {
    throw new Error(`${name} must be YES, NO or UNKNOWN — never a bare boolean`)
  }
  return input
}

/**
 * Describes one provider operation across every axis, separately.
 *
 * UNKNOWN is the default for a reason: a provider we have not researched must
 * read as unknown, not as "no" (which would look researched) and certainly not
 * as "yes".
 */
export function describeProviderCapability(input = {}) {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_CAPABILITY_FIELDS.has(key)) {
      throw new Error(
        `${key} cannot be recorded as a provider capability: ` +
        'G5 owns DueWatch authority and must be evaluated at the moment of use')
    }
  }
  const provider = input.provider
  const operation = input.operation
  if (!provider || !operation) throw new Error('capability requires provider and operation')

  return Object.freeze({
    kind: 'M2H_PROVIDER_CAPABILITY_V0',
    provider,
    operation,
    objectType: input.objectType ?? null,
    canRead: value(input.canRead, 'canRead'),
    canTechnicallyWrite: value(input.canTechnicallyWrite, 'canTechnicallyWrite'),
    supportedInProviderApi: value(input.supportedInProviderApi, 'supportedInProviderApi'),
    supportedByDuewatchAdapter: value(input.supportedByDuewatchAdapter, 'supportedByDuewatchAdapter'),
    allowedByCurrentScopes: value(input.allowedByCurrentScopes, 'allowedByCurrentScopes'),
    requiredScopes: Object.freeze([...(input.requiredScopes ?? [])]),
    evidence: input.evidence ?? null,
    // Structural, not advisory: there is no field here from which permission
    // could be read, and saying so is part of the record.
    authorityOwner: 'G5',
    authorityEvaluatedHere: false,
    mustReEvaluateAuthorityAtUse: true,
  })
}

/**
 * Whether the MACHINE could perform the operation. Never whether DueWatch may.
 *
 * The name is long on purpose. A function called `canDo` would be read as
 * permission by the next person in a hurry.
 */
export function providerTechnicallyCapable(capability) {
  return capability?.supportedInProviderApi === CAPABILITY_VALUE.YES &&
    capability?.supportedByDuewatchAdapter === CAPABILITY_VALUE.YES &&
    capability?.allowedByCurrentScopes === CAPABILITY_VALUE.YES
}

/** Capability never authorises. One answer, in code, for every caller. */
export function capabilityGrantsAuthority() {
  return false
}

/** OAuth scope never authorises either — it is the provider's permission, not the founder's. */
export function scopeGrantsAuthority() {
  return false
}

export const PROVIDER_CONNECTION_STATE = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED',
  CONNECTED: 'CONNECTED',
  DEGRADED: 'DEGRADED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
  ERROR: 'ERROR',
})

export const PROVIDER_ERROR_CATEGORY = Object.freeze({
  NONE: 'NONE',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  UNAVAILABLE: 'UNAVAILABLE',
  SCHEMA: 'SCHEMA',
  UNKNOWN: 'UNKNOWN',
})

/**
 * Connection health. Reports observability, never permission, and never
 * implies the absence of findings — a revoked connection has no data, which
 * is not the same as a clean one.
 */
export function describeProviderHealth(input = {}) {
  const connectionState = input.connectionState ?? PROVIDER_CONNECTION_STATE.NOT_CONNECTED
  if (!Object.values(PROVIDER_CONNECTION_STATE).includes(connectionState)) {
    throw new Error(`unknown provider connection state: ${connectionState}`)
  }
  const sourceAvailable = connectionState === PROVIDER_CONNECTION_STATE.CONNECTED
  return Object.freeze({
    kind: 'M2H_PROVIDER_HEALTH_V0',
    provider: input.provider ?? null,
    providerAccountId: input.providerAccountId ?? null,
    connectionState,
    lastSuccessfulObservationAt: input.lastSuccessfulObservationAt ?? null,
    lastErrorCategory: input.lastErrorCategory ?? PROVIDER_ERROR_CATEGORY.NONE,
    sourceAvailable,
    // The whole point: unavailable is an unknown, never an all-clear.
    absenceOfDataMeansUnknown: !sourceAvailable,
  })
}
