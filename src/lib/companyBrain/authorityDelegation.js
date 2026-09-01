/**
 * M2G-G5 Authority & Delegation.
 *
 * Facts may be derived. Policy may be resolved. DW authority must be an
 * explicit, current grant. This module ends at deterministic authority
 * determination: it has no provider, scheduler, financial-write, or external
 * execution dependency.
 */

import crypto from 'node:crypto'

export const AUTHORITY_GRANTEE = Object.freeze({ DW: 'DW' })

export const AUTHORITY_SCOPE = Object.freeze({
  COMPANY: 'COMPANY',
  CLIENT: 'CLIENT',
  ENTITY: 'ENTITY',
})

export const AUTHORITY_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED',
  GRANTED: 'GRANTED',
  REVOKED: 'REVOKED',
  STALE: 'STALE',
  INVALIDATED: 'INVALIDATED',
  SUPERSEDED: 'SUPERSEDED',
})

export const AUTHORITY_DECISION = Object.freeze({
  ALLOWED: 'ALLOWED',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  DENIED: 'DENIED',
  UNKNOWN: 'UNKNOWN',
  STALE: 'STALE',
})

export const APPROVAL_REQUIREMENT = Object.freeze({
  NONE: 'NONE',
  FOUNDER: 'FOUNDER',
})

export const AUTHORITY_ACTION = Object.freeze({
  SEND_REMINDER: 'SEND_REMINDER',
  SEND_COLLECTION_MESSAGE: 'SEND_COLLECTION_MESSAGE',
  APPLY_LATE_FEE: 'APPLY_LATE_FEE',
  WAIVE_LATE_FEE: 'WAIVE_LATE_FEE',
  SETTLE_INVOICE: 'SETTLE_INVOICE',
  WRITE_OFF_INVOICE: 'WRITE_OFF_INVOICE',
  ISSUE_REFUND: 'ISSUE_REFUND',
})

export const AUTHORITY_REASON = Object.freeze({
  EXPLICIT_GRANT_MATCHED: 'EXPLICIT_GRANT_MATCHED',
  EXPLICIT_APPROVAL_REQUIRED: 'EXPLICIT_APPROVAL_REQUIRED',
  AUTHORITY_UNCONFIGURED: 'AUTHORITY_UNCONFIGURED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  SCOPE_MALFORMED: 'SCOPE_MALFORMED',
  SCOPE_MISMATCH: 'SCOPE_MISMATCH',
  ENTITY_AMBIGUOUS: 'ENTITY_AMBIGUOUS',
  ENTITY_UNRESOLVED: 'ENTITY_UNRESOLVED',
  AMOUNT_REQUIRED: 'AMOUNT_REQUIRED',
  AMOUNT_LIMIT_EXCEEDED: 'AMOUNT_LIMIT_EXCEEDED',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  CHANNEL_REQUIRED: 'CHANNEL_REQUIRED',
  CHANNEL_MISMATCH: 'CHANNEL_MISMATCH',
  CONDITION_MISMATCH: 'CONDITION_MISMATCH',
  NOT_YET_EFFECTIVE: 'NOT_YET_EFFECTIVE',
  EXPIRED: 'EXPIRED',
  AUTHORITY_REVOKED: 'AUTHORITY_REVOKED',
  REVIEWED_DEPENDENCY_MISSING: 'REVIEWED_DEPENDENCY_MISSING',
  REVIEWED_DEPENDENCY_REVOKED: 'REVIEWED_DEPENDENCY_REVOKED',
  REVIEWED_DEPENDENCY_CHANGED: 'REVIEWED_DEPENDENCY_CHANGED',
  MALFORMED_GRANT: 'MALFORMED_GRANT',
  INVALID_GRANT_CHAIN: 'INVALID_GRANT_CHAIN',
  AMBIGUOUS_CURRENT_GRANTS: 'AMBIGUOUS_CURRENT_GRANTS',
})

const ACTION_RULES = Object.freeze({
  [AUTHORITY_ACTION.SEND_REMINDER]: { amount: false, channel: true },
  [AUTHORITY_ACTION.SEND_COLLECTION_MESSAGE]: { amount: false, channel: true },
  [AUTHORITY_ACTION.APPLY_LATE_FEE]: { amount: true, channel: false },
  [AUTHORITY_ACTION.WAIVE_LATE_FEE]: { amount: true, channel: false },
  [AUTHORITY_ACTION.SETTLE_INVOICE]: { amount: true, channel: false },
  [AUTHORITY_ACTION.WRITE_OFF_INVOICE]: { amount: true, channel: false },
  [AUTHORITY_ACTION.ISSUE_REFUND]: { amount: true, channel: false },
})

const VALID_GRANT_STATUSES = new Set([
  AUTHORITY_STATUS.GRANTED,
  AUTHORITY_STATUS.REVOKED,
  AUTHORITY_STATUS.STALE,
  AUTHORITY_STATUS.INVALIDATED,
  AUTHORITY_STATUS.SUPERSEDED,
])

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex')
}

function uuidFrom(value) {
  const digest = hash(value)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`)
  return value.trim()
}

function timestamp(value, name) {
  const normalized = text(value, name)
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== normalized) {
    throw new Error(`${name} must be a canonical ISO timestamp`)
  }
  return normalized
}

function assertActor(actor, tenantId) {
  if (!actor?.authenticated || !actor.id) throw new Error('authenticated actor required')
  if (actor.tenantId !== tenantId) throw new Error('actor tenant mismatch')
}

function assertFounder(actor, tenantId) {
  assertActor(actor, tenantId)
  if (actor.role !== 'FOUNDER') throw new Error('founder role required')
  // The repository's current tenant model is one authenticated owner per
  // tenant (user_id). Do not manufacture broader RBAC in G5.
  if (actor.id !== tenantId) throw new Error('tenant owner grantor required')
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('authority scope required')
  const level = text(scope.level, 'authority scope level').toUpperCase()
  if (!Object.values(AUTHORITY_SCOPE).includes(level)) throw new Error('unknown authority scope level')
  if (level === AUTHORITY_SCOPE.COMPANY) {
    if (scope.clientId != null || scope.entityId != null || scope.entityType != null) {
      throw new Error('company authority scope cannot carry entity dimensions')
    }
    return freeze({ level })
  }
  if (level === AUTHORITY_SCOPE.CLIENT) {
    if (scope.entityId != null || scope.entityType != null) throw new Error('client scope cannot carry generic entity dimensions')
    return freeze({ level, clientId: text(scope.clientId, 'client scope clientId') })
  }
  if (scope.clientId != null) throw new Error('entity scope cannot carry clientId')
  return freeze({
    level,
    entityType: text(scope.entityType, 'entity scope entityType').toUpperCase(),
    entityId: text(scope.entityId, 'entity scope entityId'),
  })
}

function normalizeLimits(action, limits) {
  const rules = ACTION_RULES[action]
  if (!rules) throw new Error('unknown authority action')
  if (!rules.amount) {
    if (limits != null && (limits.maxAmountMinor != null || limits.currency != null)) {
      throw new Error('action does not accept an amount limit')
    }
    return freeze({ maxAmountMinor: null, currency: null })
  }
  if (!limits || !Number.isSafeInteger(limits.maxAmountMinor) || limits.maxAmountMinor < 0) {
    throw new Error('amount-limited action requires non-negative integer maxAmountMinor')
  }
  return freeze({
    maxAmountMinor: limits.maxAmountMinor,
    currency: text(limits.currency, 'authority currency').toUpperCase(),
  })
}

function normalizeChannel(action, channel) {
  if (!ACTION_RULES[action]) throw new Error('unknown authority action')
  if (ACTION_RULES[action].channel) return text(channel, 'authority channel').toUpperCase()
  if (channel != null) throw new Error('action does not accept a channel')
  return null
}

function normalizeConditions(conditions) {
  if (conditions == null) return freeze({})
  if (typeof conditions !== 'object' || Array.isArray(conditions)) throw new Error('authority conditions must be an object')
  if (Object.values(conditions).some((value) => value === undefined)) throw new Error('authority conditions cannot contain undefined')
  return freeze(structuredClone(conditions))
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') throw new Error('authority effective window required')
  const effectiveFrom = timestamp(window.effectiveFrom, 'authority effectiveFrom')
  const expiresAt = window.expiresAt == null ? null : timestamp(window.expiresAt, 'authority expiresAt')
  if (expiresAt && expiresAt <= effectiveFrom) throw new Error('authority expiry must follow effectiveFrom')
  return freeze({ effectiveFrom, expiresAt })
}

function normalizeReference(reference, tenantId, name) {
  if (!reference || typeof reference !== 'object') throw new Error(`${name} malformed`)
  if (reference.tenantId !== tenantId) throw new Error(`${name} tenant mismatch`)
  const fingerprint = reference.fingerprint == null ? null : text(reference.fingerprint, `${name} fingerprint`)
  if (fingerprint && !/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error(`${name} fingerprint malformed`)
  return freeze({
    tenantId,
    kind: text(reference.kind, `${name} kind`).toUpperCase(),
    id: text(reference.id, `${name} id`),
    fingerprint,
    requiredCurrent: reference.requiredCurrent === true,
  })
}

function normalizeProvenance(references, tenantId) {
  if (!Array.isArray(references) || references.length === 0) throw new Error('authority provenance required')
  const normalized = references.map((reference) => normalizeReference(reference, tenantId, 'authority provenance'))
  return freeze([...new Map(normalized.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values()]
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)))
}

function normalizeReviewedState(reviewedState, tenantId) {
  if (!reviewedState || typeof reviewedState !== 'object') throw new Error('reviewed upstream state required')
  const dependencies = Array.isArray(reviewedState.dependencies)
    ? reviewedState.dependencies.map((reference) => normalizeReference({ ...reference, requiredCurrent: reference.requiredCurrent !== false }, tenantId, 'reviewed dependency'))
    : []
  return freeze({
    reviewedAt: timestamp(reviewedState.reviewedAt, 'upstream reviewedAt'),
    dependencies: dependencies.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
  })
}

function normalizeCurrentReferences(currentState, tenantId) {
  const rows = Array.isArray(currentState?.references) ? currentState.references : []
  return rows
    .filter((row) => row?.tenantId === tenantId)
    .map((row) => ({
      tenantId,
      kind: typeof row.kind === 'string' ? row.kind.toUpperCase() : null,
      id: row.id,
      fingerprint: row.fingerprint ?? null,
      active: row.active === true,
      resolutionState: row.resolutionState ?? null,
    }))
}

function referenceKey(reference) {
  return `${reference.kind}:${reference.id}`
}

function validateReferenceCurrent(reference, currentState, tenantId) {
  const current = normalizeCurrentReferences(currentState, tenantId)
    .find((entry) => referenceKey(entry) === referenceKey(reference))
  if (!current) return { fresh: false, reason: AUTHORITY_REASON.REVIEWED_DEPENDENCY_MISSING }
  // Immutable provenance must exist for the tenant even when its continuing
  // activity is not a material condition of the grant. `requiredCurrent`
  // controls freshness, not whether unknown provenance is accepted.
  if (!reference.requiredCurrent) return { fresh: true, reason: null }
  if (!current.active) return { fresh: false, reason: AUTHORITY_REASON.REVIEWED_DEPENDENCY_REVOKED }
  if (reference.fingerprint && current.fingerprint !== reference.fingerprint) {
    return { fresh: false, reason: AUTHORITY_REASON.REVIEWED_DEPENDENCY_CHANGED }
  }
  return { fresh: true, reason: null }
}

function validateScopeResolution(scope, currentState, tenantId) {
  if (scope.level === AUTHORITY_SCOPE.COMPANY) return { valid: true, reason: null }
  const expectedKind = scope.level === AUTHORITY_SCOPE.CLIENT ? 'CLIENT' : scope.entityType
  const expectedId = scope.level === AUTHORITY_SCOPE.CLIENT ? scope.clientId : scope.entityId
  const reference = normalizeCurrentReferences(currentState, tenantId)
    .find((entry) => entry.kind === expectedKind && entry.id === expectedId)
  if (!reference || reference.resolutionState === 'UNRESOLVED' || !reference.active) {
    return { valid: false, reason: AUTHORITY_REASON.ENTITY_UNRESOLVED }
  }
  if (reference.resolutionState === 'AMBIGUOUS' || reference.resolutionState === 'CONFLICTED') {
    return { valid: false, reason: AUTHORITY_REASON.ENTITY_AMBIGUOUS }
  }
  if (reference.resolutionState !== 'RESOLVED') return { valid: false, reason: AUTHORITY_REASON.ENTITY_UNRESOLVED }
  return { valid: true, reason: null }
}

function normalizeGrantInput(input, tenantId) {
  const action = text(input.action, 'authority action').toUpperCase()
  if (!ACTION_RULES[action]) throw new Error('unknown authority action')
  const grantee = input.grantee || {}
  if (grantee.type !== AUTHORITY_GRANTEE.DW || grantee.id !== 'DUEWATCH') {
    throw new Error('standing authority grantee must be DueWatch')
  }
  const approvalRequirement = text(input.approvalRequirement, 'approval requirement').toUpperCase()
  if (!Object.values(APPROVAL_REQUIREMENT).includes(approvalRequirement)) throw new Error('unknown approval requirement')
  return {
    action,
    grantee: freeze({ type: AUTHORITY_GRANTEE.DW, id: 'DUEWATCH' }),
    scope: normalizeScope(input.scope),
    limits: normalizeLimits(action, input.limits),
    conditions: normalizeConditions(input.conditions),
    effectiveWindow: normalizeWindow(input.effectiveWindow),
    channel: normalizeChannel(action, input.channel),
    approvalRequirement,
    provenance: normalizeProvenance(input.provenance, tenantId),
    reviewedState: normalizeReviewedState(input.reviewedState, tenantId),
    proposalId: input.proposalId == null ? null : text(input.proposalId, 'authority proposalId'),
    supersedesGrantId: input.supersedesGrantId == null ? null : text(input.supersedesGrantId, 'superseded grant id'),
  }
}

function grantIntegrity(grant, tenantId) {
  try {
    if (!grant || grant.kind !== 'DW_AUTHORITY_GRANT_V0' || grant.tenantId !== tenantId) throw new Error('untrusted grant')
    if (!VALID_GRANT_STATUSES.has(grant.status)) throw new Error('invalid grant status')
    text(grant.id, 'grant id')
    text(grant.grantor?.actorId, 'grantor actor')
    if (grant.grantor?.role !== 'FOUNDER' || grant.grantor.actorId !== tenantId) throw new Error('invalid grantor')
    if (!Number.isInteger(grant.revision) || grant.revision < 1) throw new Error('invalid grant revision')
    normalizeGrantInput(grant, tenantId)
    timestamp(grant.createdAt, 'grant createdAt')
    timestamp(grant.decidedAt, 'grant decidedAt')
    return { valid: true, reason: null }
  } catch {
    return { valid: false, reason: AUTHORITY_REASON.MALFORMED_GRANT }
  }
}

function grantFreshness(grant, currentState, tenantId) {
  for (const reference of [...grant.provenance, ...grant.reviewedState.dependencies]) {
    const result = validateReferenceCurrent(reference, currentState, tenantId)
    if (!result.fresh) return result
  }
  return { fresh: true, reason: null }
}

function timeState(grant, asOf) {
  if (asOf < grant.effectiveWindow.effectiveFrom) return AUTHORITY_REASON.NOT_YET_EFFECTIVE
  if (grant.effectiveWindow.expiresAt && asOf >= grant.effectiveWindow.expiresAt) return AUTHORITY_REASON.EXPIRED
  return null
}

function historyOrder(a, b) {
  return a.decidedAt.localeCompare(b.decidedAt) || a.id.localeCompare(b.id)
}

function auditEntry(grant, derivedReason = null) {
  return freeze({ grant, derivedReason })
}

/** Canonical current/superseded/revoked/stale/invalidated authority derivation. */
export function deriveAuthorityState({ actor, tenantId, grants = [], currentState = {}, asOf } = {}) {
  assertActor(actor, tenantId)
  const evaluatedAt = timestamp(asOf, 'authority asOf')
  const tenantGrants = grants.filter((grant) => grant?.tenantId === tenantId).sort(historyOrder)
  const byId = new Map(tenantGrants.map((grant) => [grant.id, grant]))
  const supersededIds = new Set()
  for (const successor of tenantGrants) {
    if (successor.supersedesGrantId && byId.has(successor.supersedesGrantId)) {
      // The link itself is the founder's explicit replacement instruction.
      // It suppresses the predecessor even when the successor later cannot govern.
      supersededIds.add(successor.supersedesGrantId)
    }
  }

  const state = {
    currentGrants: [],
    supersededGrants: [],
    revokedGrants: [],
    staleGrants: [],
    invalidatedGrants: [],
  }
  for (const grant of tenantGrants) {
    if (supersededIds.has(grant.id) || grant.status === AUTHORITY_STATUS.SUPERSEDED) {
      state.supersededGrants.push(auditEntry(grant, AUTHORITY_STATUS.SUPERSEDED))
      continue
    }
    if (grant.status === AUTHORITY_STATUS.REVOKED || grant.revokedAt) {
      state.revokedGrants.push(auditEntry(grant, AUTHORITY_REASON.AUTHORITY_REVOKED))
      continue
    }
    if (grant.status === AUTHORITY_STATUS.STALE) {
      state.staleGrants.push(auditEntry(grant, AUTHORITY_REASON.REVIEWED_DEPENDENCY_CHANGED))
      continue
    }
    if (grant.status === AUTHORITY_STATUS.INVALIDATED) {
      state.invalidatedGrants.push(auditEntry(grant, AUTHORITY_REASON.MALFORMED_GRANT))
      continue
    }
    const integrity = grantIntegrity(grant, tenantId)
    if (!integrity.valid) {
      state.invalidatedGrants.push(auditEntry(grant, integrity.reason))
      continue
    }
    const freshness = grantFreshness(grant, currentState, tenantId)
    if (!freshness.fresh) {
      state.staleGrants.push(auditEntry(grant, freshness.reason))
      continue
    }
    const inactiveReason = timeState(grant, evaluatedAt)
    if (inactiveReason) {
      state.invalidatedGrants.push(auditEntry(grant, inactiveReason))
      continue
    }
    state.currentGrants.push(grant)
  }
  return freeze({
    kind: 'DW_AUTHORITY_CURRENT_STATE_V0',
    tenantId,
    evaluatedAt,
    ...state,
  })
}

/**
 * Creates an inert proposal. Observed roles/delegation, G3/G4 state, provider
 * capability, confidence, and approval history are context only.
 */
export function createG5AuthorityProposal({
  actor,
  tenantId,
  action,
  scope,
  proposedConfiguration,
  evidence = {},
  createdAt,
} = {}) {
  assertActor(actor, tenantId)
  const normalizedAction = text(action, 'proposal action').toUpperCase()
  if (!ACTION_RULES[normalizedAction]) throw new Error('unknown authority action')
  const normalizedScope = normalizeScope(scope)
  const at = timestamp(createdAt, 'proposal createdAt')
  if (Array.isArray(evidence?.references)) {
    for (const reference of evidence.references) {
      if (reference?.tenantId !== tenantId) throw new Error('authority proposal evidence tenant mismatch')
    }
  }
  const semantic = {
    tenantId,
    action: normalizedAction,
    scope: normalizedScope,
    proposedConfiguration: structuredClone(proposedConfiguration || {}),
    evidence: structuredClone(evidence || {}),
  }
  return freeze({
    kind: 'DW_AUTHORITY_PROPOSAL_V0',
    id: `authority-proposal-${hash(semantic).slice(0, 24)}`,
    tenantId,
    action: normalizedAction,
    scope: normalizedScope,
    proposedConfiguration: semantic.proposedConfiguration,
    evidence: semantic.evidence,
    status: AUTHORITY_STATUS.PROPOSED,
    createdAt: at,
    authorityGranted: false,
    grantableByInference: false,
    boundaries: {
      humanAuthorityIsDwAuthority: false,
      operatingModelApprovalIsAuthority: false,
      policyApplicabilityIsAuthority: false,
      repeatedApprovalIsAuthority: false,
      providerCapabilityIsAuthority: false,
      modelConfidenceIsAuthority: false,
      canExecute: false,
    },
  })
}

function requestScope(request) {
  try {
    return { scope: normalizeScope(request?.scope), reason: null }
  } catch {
    return { scope: null, reason: AUTHORITY_REASON.SCOPE_MALFORMED }
  }
}

function outcome(decision, reason, evaluatedAt, extra = {}) {
  return freeze({
    kind: 'DW_AUTHORITY_EVALUATION_V0',
    decision,
    reason,
    evaluatedAt,
    grant: null,
    grantRevision: null,
    scopeMatch: false,
    amountEvaluation: 'NOT_EVALUATED',
    channelEvaluation: 'NOT_EVALUATED',
    timeEvaluation: 'NOT_EVALUATED',
    conditionEvaluation: 'NOT_EVALUATED',
    approvalRequirement: null,
    freshness: 'NOT_EVALUATED',
    provenance: [],
    reviewedState: null,
    canonicalMoneyMutated: false,
    executed: false,
    ...extra,
  })
}

function sameScope(left, right) {
  return stable(left) === stable(right)
}

function relevantTip(entries, action, scope) {
  return [...entries]
    .reverse()
    .find((entry) => entry.grant?.action === action && sameScope(entry.grant.scope, scope)) || null
}

/** Canonical, pure, deterministic G5 authority evaluator. */
export function evaluateAuthority({
  actor,
  tenantId,
  request,
  grants = [],
  currentState = {},
  asOf,
  // These inputs remain explicitly non-authoritative. They are accepted so
  // callers cannot be tempted to build a second inference-based evaluator.
  proposals = [],
  observedHumanDelegation = [],
  resolvedPolicy = null,
  operatingModel = null,
  approvalHistory = [],
  providerCapabilities = [],
  modelOutput = null,
} = {}) {
  let evaluatedAt
  try {
    evaluatedAt = timestamp(asOf, 'authority asOf')
  } catch {
    return outcome(AUTHORITY_DECISION.UNKNOWN, AUTHORITY_REASON.MALFORMED_REQUEST, asOf ?? null)
  }
  try {
    assertActor(actor, tenantId)
  } catch {
    return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.TENANT_MISMATCH, evaluatedAt)
  }
  const action = typeof request?.action === 'string' ? request.action.toUpperCase() : null
  if (!ACTION_RULES[action]) return outcome(AUTHORITY_DECISION.UNKNOWN, AUTHORITY_REASON.UNKNOWN_ACTION, evaluatedAt)
  if (request?.actor?.type !== AUTHORITY_GRANTEE.DW || request.actor.id !== 'DUEWATCH') {
    return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.MALFORMED_REQUEST, evaluatedAt)
  }
  const scoped = requestScope(request)
  if (!scoped.scope) return outcome(AUTHORITY_DECISION.UNKNOWN, scoped.reason, evaluatedAt)
  const scopeResolution = validateScopeResolution(scoped.scope, currentState, tenantId)
  if (!scopeResolution.valid) return outcome(AUTHORITY_DECISION.UNKNOWN, scopeResolution.reason, evaluatedAt)

  const rules = ACTION_RULES[action]
  if (rules.amount && (!Number.isSafeInteger(request.amountMinor) || request.amountMinor < 0 || typeof request.currency !== 'string')) {
    return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.AMOUNT_REQUIRED, evaluatedAt)
  }
  if (rules.channel && (typeof request.channel !== 'string' || !request.channel.trim())) {
    return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.CHANNEL_REQUIRED, evaluatedAt)
  }
  const state = deriveAuthorityState({ actor, tenantId, grants, currentState, asOf: evaluatedAt })
  const actionGrants = state.currentGrants.filter((grant) => grant.action === action)
  const scopeGrants = actionGrants.filter((grant) => sameScope(grant.scope, scoped.scope))

  if (!scopeGrants.length) {
    const stale = relevantTip(state.staleGrants, action, scoped.scope)
    if (stale) return outcome(AUTHORITY_DECISION.STALE, stale.derivedReason, evaluatedAt, { freshness: 'STALE', reviewedState: stale.grant.reviewedState })
    const revoked = relevantTip(state.revokedGrants, action, scoped.scope)
    if (revoked) return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.AUTHORITY_REVOKED, evaluatedAt, { freshness: 'CURRENT' })
    const invalid = relevantTip(state.invalidatedGrants, action, scoped.scope)
    if (invalid) {
      const inactive = [AUTHORITY_REASON.EXPIRED, AUTHORITY_REASON.NOT_YET_EFFECTIVE].includes(invalid.derivedReason)
      return outcome(inactive ? AUTHORITY_DECISION.DENIED : AUTHORITY_DECISION.UNKNOWN, invalid.derivedReason || AUTHORITY_REASON.INVALID_GRANT_CHAIN, evaluatedAt)
    }
    return outcome(
      actionGrants.length ? AUTHORITY_DECISION.DENIED : AUTHORITY_DECISION.NEEDS_APPROVAL,
      actionGrants.length ? AUTHORITY_REASON.SCOPE_MISMATCH : AUTHORITY_REASON.AUTHORITY_UNCONFIGURED,
      evaluatedAt,
      {
        ignoredNonAuthorityContext: {
          proposals: Array.isArray(proposals) ? proposals.length : 0,
          observedHumanDelegation: Array.isArray(observedHumanDelegation) ? observedHumanDelegation.length : 0,
          resolvedPolicy: Boolean(resolvedPolicy),
          operatingModel: Boolean(operatingModel),
          approvalHistory: Array.isArray(approvalHistory) ? approvalHistory.length : 0,
          providerCapabilities: Array.isArray(providerCapabilities) ? providerCapabilities.length : 0,
          modelOutput: Boolean(modelOutput),
        },
      },
    )
  }

  let candidates = scopeGrants
  const requestedChannel = rules.channel ? request.channel.toUpperCase() : null
  const channelMatches = candidates.filter((grant) => grant.channel === requestedChannel)
  if (!channelMatches.length) return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.CHANNEL_MISMATCH, evaluatedAt, { scopeMatch: true, channelEvaluation: 'MISMATCH' })
  candidates = channelMatches

  if (rules.amount) {
    const currency = request.currency.toUpperCase()
    const currencyMatches = candidates.filter((grant) => grant.limits.currency === currency)
    if (!currencyMatches.length) return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.CURRENCY_MISMATCH, evaluatedAt, { scopeMatch: true, channelEvaluation: 'MATCH', amountEvaluation: 'CURRENCY_MISMATCH' })
    const amountMatches = currencyMatches.filter((grant) => request.amountMinor <= grant.limits.maxAmountMinor)
    if (!amountMatches.length) return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.AMOUNT_LIMIT_EXCEEDED, evaluatedAt, { scopeMatch: true, channelEvaluation: 'MATCH', amountEvaluation: 'ABOVE_LIMIT' })
    candidates = amountMatches
  }

  const requestedConditions = request.conditions == null ? {} : request.conditions
  const conditionMatches = candidates.filter((grant) => stable(grant.conditions) === stable(requestedConditions))
  if (!conditionMatches.length) return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.CONDITION_MISMATCH, evaluatedAt, { scopeMatch: true, channelEvaluation: 'MATCH', amountEvaluation: rules.amount ? 'WITHIN_LIMIT' : 'NOT_APPLICABLE', conditionEvaluation: 'MISMATCH' })
  candidates = conditionMatches.sort((a, b) => b.revision - a.revision || b.decidedAt.localeCompare(a.decidedAt) || a.id.localeCompare(b.id))
  if (candidates.length !== 1) return outcome(AUTHORITY_DECISION.DENIED, AUTHORITY_REASON.AMBIGUOUS_CURRENT_GRANTS, evaluatedAt, { scopeMatch: true })

  const grant = candidates[0]
  const common = {
    grant,
    grantRevision: grant.revision,
    scopeMatch: true,
    amountEvaluation: rules.amount ? 'WITHIN_LIMIT' : 'NOT_APPLICABLE',
    channelEvaluation: rules.channel ? 'MATCH' : 'NOT_APPLICABLE',
    timeEvaluation: 'EFFECTIVE',
    conditionEvaluation: 'MATCH',
    approvalRequirement: grant.approvalRequirement,
    freshness: 'CURRENT',
    provenance: grant.provenance,
    reviewedState: grant.reviewedState,
  }
  if (grant.approvalRequirement === APPROVAL_REQUIREMENT.FOUNDER) {
    return outcome(AUTHORITY_DECISION.NEEDS_APPROVAL, AUTHORITY_REASON.EXPLICIT_APPROVAL_REQUIRED, evaluatedAt, common)
  }
  return outcome(AUTHORITY_DECISION.ALLOWED, AUTHORITY_REASON.EXPLICIT_GRANT_MATCHED, evaluatedAt, common)
}

export class AuthorityDelegationStore {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock
    this.proposals = []
    this.grants = []
    this.revocations = []
    this.attempts = []
  }

  recordProposal({ actor, tenantId, proposal } = {}) {
    assertActor(actor, tenantId)
    if (proposal?.kind !== 'DW_AUTHORITY_PROPOSAL_V0' || proposal.tenantId !== tenantId) throw new Error('trusted tenant authority proposal required')
    const existing = this.proposals.find((row) => row.tenantId === tenantId && row.id === proposal.id)
    if (existing) return existing
    this.proposals.push(proposal)
    return proposal
  }

  grantAuthority({ actor, tenantId, idempotencyKey, explicitGrant, currentState, ...input } = {}) {
    assertFounder(actor, tenantId)
    if (explicitGrant !== true) throw new Error('explicit authority-grant operation required')
    const key = text(idempotencyKey, 'authority idempotency key')
    const normalized = normalizeGrantInput(input, tenantId)
    const scopeResolution = validateScopeResolution(normalized.scope, currentState, tenantId)
    if (!scopeResolution.valid) throw new Error(scopeResolution.reason)
    for (const reference of [...normalized.provenance, ...normalized.reviewedState.dependencies]) {
      const validity = validateReferenceCurrent(reference, currentState, tenantId)
      if (!validity.fresh) throw new Error(validity.reason)
    }
    const requestFingerprint = hash({ tenantId, key, normalized })
    const prior = this.grants.find((row) => row.tenantId === tenantId && row.idempotencyKey === key)
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) {
        this.attempts.push(freeze({ tenantId, actorId: actor.id, idempotencyKey: key, outcome: 'REJECTED_IDEMPOTENCY_CONFLICT', requestFingerprint, attemptedAt: this.clock() }))
        throw new Error('authority grant idempotency conflict')
      }
      return prior
    }
    const predecessor = normalized.supersedesGrantId == null
      ? null
      : this.grants.find((row) => row.tenantId === tenantId && row.id === normalized.supersedesGrantId)
    if (normalized.supersedesGrantId && !predecessor) throw new Error('superseded authority grant missing or tenant mismatch')
    const decidedAt = timestamp(this.clock(), 'authority decision time')
    const grant = freeze({
      kind: 'DW_AUTHORITY_GRANT_V0',
      schemaVersion: 'DW_AUTHORITY_V0',
      id: uuidFrom(`${tenantId}:${key}`),
      tenantId,
      grantor: { actorId: actor.id, role: 'FOUNDER' },
      ...normalized,
      status: AUTHORITY_STATUS.GRANTED,
      revision: predecessor ? predecessor.revision + 1 : 1,
      idempotencyKey: key,
      requestFingerprint,
      createdAt: decidedAt,
      decidedAt,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
    })
    this.grants.push(grant)
    this.attempts.push(freeze({ tenantId, actorId: actor.id, idempotencyKey: key, outcome: 'ACCEPTED', grantId: grant.id, requestFingerprint, attemptedAt: decidedAt }))
    return grant
  }

  revokeAuthority({ actor, tenantId, grantId, idempotencyKey, reason } = {}) {
    assertFounder(actor, tenantId)
    const key = text(idempotencyKey, 'revocation idempotency key')
    const existingEvent = this.revocations.find((row) => row.tenantId === tenantId && row.idempotencyKey === key)
    if (existingEvent) {
      if (existingEvent.grantId !== grantId || existingEvent.reason !== reason) throw new Error('authority revocation idempotency conflict')
      return this.grants.find((row) => row.tenantId === tenantId && row.id === grantId)
    }
    const index = this.grants.findIndex((row) => row.tenantId === tenantId && row.id === grantId)
    if (index < 0) throw new Error('authority grant missing or tenant mismatch')
    const revokedAt = timestamp(this.clock(), 'authority revocation time')
    const event = freeze({
      kind: 'DW_AUTHORITY_REVOCATION_V0',
      id: uuidFrom(`${tenantId}:${key}:revoke`),
      tenantId,
      grantId,
      actorId: actor.id,
      idempotencyKey: key,
      reason: text(reason, 'authority revocation reason'),
      revokedAt,
    })
    this.revocations.push(event)
    this.grants[index] = freeze({
      ...structuredClone(this.grants[index]),
      status: AUTHORITY_STATUS.REVOKED,
      revokedAt,
      revokedBy: actor.id,
      revocationReason: event.reason,
    })
    return this.grants[index]
  }

  readHistory({ actor, tenantId } = {}) {
    assertActor(actor, tenantId)
    return freeze({
      grants: this.grants.filter((row) => row.tenantId === tenantId).sort(historyOrder),
      revocations: this.revocations.filter((row) => row.tenantId === tenantId),
      attempts: this.attempts.filter((row) => row.tenantId === tenantId),
    })
  }
}

/** Minimal, deeply-frozen read-only seam for later Ask DW / DW Intelligence use. */
export function buildAuthorityReadModel({ actor, tenantId, store, currentState, asOf, consumer = 'GENERIC' } = {}) {
  assertActor(actor, tenantId)
  if (!(store instanceof AuthorityDelegationStore)) throw new Error('authority store required')
  const state = deriveAuthorityState({ actor, tenantId, grants: store.grants, currentState, asOf })
  return freeze({
    kind: 'DW_AUTHORITY_READ_MODEL_V0',
    consumer,
    tenantId,
    evaluatedAt: state.evaluatedAt,
    currentAuthorityGrants: state.currentGrants,
    proposedAuthority: store.proposals.filter((row) => row.tenantId === tenantId),
    revokedAuthority: state.revokedGrants,
    staleAuthority: state.staleGrants,
    supersededAuthority: state.supersededGrants,
    invalidatedAuthority: state.invalidatedGrants,
    boundaries: {
      readOnly: true,
      canGrant: false,
      canRevoke: false,
      canExecute: false,
      modelOutputCanGrant: false,
      recommendationCanGrant: false,
      canonicalMoneyWritable: false,
    },
  })
}

export function toAskDwAuthorityContext(input = {}) {
  return buildAuthorityReadModel({ ...input, consumer: 'ASK_DW' })
}

export function toDwIntelligenceAuthorityContext(input = {}) {
  return buildAuthorityReadModel({ ...input, consumer: 'DW_INTELLIGENCE' })
}
