/**
 * M2G-G7 Company Brain conversational context.
 *
 * Ask DW may READ what the founder confirmed about the company. It may not
 * reinterpret that into new policy or permission, and it may not mutate it.
 *
 * This is a SEPARATE typed context from askDwCaseState's caseContext on
 * purpose. caseContext deliberately excludes canonical financial facts and
 * authority so a conversational reference can never carry money truth or
 * permission; stuffing Company Brain into it would quietly break that split.
 * This context therefore keeps its own boundary: it carries founder-confirmed
 * understanding and a read-only PROJECTION of authority state, and it is
 * inspected for canonical-money and mutable-authority fields before it is ever
 * handed to a model.
 *
 * Everything here is derived from the frozen G6 read seams in
 * ../companyBrain/founderReview.js. G7 adds no Company Brain semantics.
 */

const CONTEXT_VERSION = 'ASK_DW_COMPANY_BRAIN_CONTEXT_V0'

/**
 * Canonical money must never travel inside the Company Brain context: the
 * Company Brain is operational memory, not the financial ledger.
 */
const FORBIDDEN_CONTEXT_KEYS = new Set([
  'amount', 'amount_paid', 'balance', 'paid', 'currency', 'due_date',
  'inv_date', 'invoice_date', 'canonicalFacts', 'canonical_facts',
  'arState', 'rawToolResponse', 'raw_tool_response', 'toolOutput', 'tool_output',
  // Authority appears only as the read-only projection built below, under
  // explicitly named keys. A raw authority object must never ride along.
  'authoritySnapshot', 'authority_snapshot', 'authorized', 'executionAuthorized',
  'canActAutomatically', 'permissions', 'grantAuthority', 'explicitGrant',
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

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function inspect(value, path = '$companyBrainContext') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`))
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
      throw new Error(`Ask DW forbidden Company Brain context field at ${path}.${key}`)
    }
    inspect(nested, `${path}.${key}`)
  }
}

function shortText(value, limit = 400) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/** Only what a conversation needs to describe an item, never its raw payload. */
function summariseItem(item) {
  return {
    reviewKey: item.reviewKey,
    category: item.category,
    itemType: item.itemType,
    subject: item.subject,
    scope: clone(item.scope),
    clientId: item.clientId ?? null,
    reviewStatus: item.reviewStatus,
    reviewRequiredReason: item.reviewRequiredReason ?? null,
    changedSinceReview: item.changedSinceReview === true,
    supportingSourceRevoked: item.supportingSourceRevoked === true,
    conflictStatus: item.conflictStatus,
    why: shortText(item.why),
    // The founder's correction wins over DW's proposal where one exists.
    statedValue: clone(item.reviewStatus === 'EDITED' ? item.reviewedValue : item.proposedValue),
    founderCorrected: item.reviewStatus === 'EDITED',
    evidenceRefs: safeArray(item.evidence).map((entry) => entry.sourceVersionId).filter(Boolean),
    competingPositions: item.itemType === 'CONFLICT'
      ? safeArray(item.proposition?.competingPositions).map((position) => ({
        claimId: position.claimId,
        scope: clone(position.scope),
        value: clone(position.value),
      }))
      : [],
    currentResult: item.itemType === 'CONFLICT' ? item.proposition?.currentResult ?? null : null,
    // Reviewing an item never made it permission, in any state.
    authorityImpact: 'NONE',
  }
}

function relevantTo(item, focus) {
  if (!focus) return true
  if (focus.clientId && item.clientId && item.clientId !== focus.clientId) return false
  return true
}

function grantIsCurrentAt(grant, evaluatedAt) {
  const at = Date.parse(evaluatedAt)
  if (!Number.isFinite(at)) return false
  const from = Date.parse(grant?.effectiveWindow?.effectiveFrom)
  if (!Number.isFinite(from)) return false
  const hasExpiry = grant?.effectiveWindow?.expiresAt != null
  const expires = hasExpiry ? Date.parse(grant.effectiveWindow.expiresAt) : null
  if (hasExpiry && !Number.isFinite(expires)) return false
  if (at < from) return false
  if (expires != null && at >= expires) return false
  return true
}

/**
 * Projects the frozen G6 founder-review read model into the read-only slice a
 * conversation is permitted to discuss.
 *
 * @param {object} input.readModel  a COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0
 * @param {string} input.tenantId   the authenticated tenant, checked not trusted
 * @param {object} [input.focus]    optional { clientId } conversational focus
 */
export function buildAskDwCompanyBrainContext({ readModel, tenantId, focus = null } = {}) {
  const tenant = String(tenantId || '').trim()
  if (!tenant) throw new Error('Ask DW Company Brain context tenantId required')
  if (!readModel) {
    // A missing read model is reported as unavailable, never as "no Company
    // Brain material". Those are different answers and only one is honest.
    return freeze({
      schemaVersion: CONTEXT_VERSION,
      tenantId: tenant,
      available: false,
      unavailableReason: 'COMPANY_BRAIN_READ_UNAVAILABLE',
      understanding: [],
      conflicts: [],
      roles: [],
      pendingFounderDecisions: [],
      changedSinceReview: [],
      authority: null,
      readiness: null,
      boundaries: BOUNDARIES,
    })
  }
  if (readModel.kind !== 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0') {
    throw new Error('Ask DW Company Brain context requires a G6 founder review read model')
  }
  if (readModel.tenantId !== tenant) throw new Error('Ask DW Company Brain context tenant mismatch')

  const items = safeArray(readModel.items).filter((item) => relevantTo(item, focus))
  const understanding = items.filter((item) =>
    ['UNDERSTANDING', 'POLICY_OR_RULE', 'OPERATING_MODEL'].includes(item.itemType))
  const conflicts = items.filter((item) => item.itemType === 'CONFLICT')
  const roles = items.filter((item) =>
    ['ROLE_OR_RESPONSIBILITY', 'DELEGATION'].includes(item.itemType))
  const pending = items.filter((item) =>
    item.reviewStatus === 'PENDING' || item.reviewStatus === 'REVIEW_REQUIRED')
  const changed = items.filter((item) =>
    item.changedSinceReview === true || item.supportingSourceRevoked === true)

  const currentAuthorityGrants = safeArray(readModel.authority?.currentAuthorityGrants)
  if (currentAuthorityGrants.some((grant) =>
    grant?.status !== 'GRANTED' || !grantIsCurrentAt(grant, readModel.authority?.evaluatedAt))) {
    throw new Error('Ask DW Company Brain current authority projection contains a non-current grant')
  }

  const authority = readModel.authority ? {
    evaluatedAt: readModel.authority.evaluatedAt,
    activeGrantCount: readModel.authority.activeGrantCount,
    proposalCount: readModel.authority.proposalCount,
    noStandingAuthorityConfigured: readModel.authority.noStandingAuthorityConfigured === true,
    // Each dimension is named so an answer can be exact about what is allowed.
    currentGrants: currentAuthorityGrants.map((grant) => ({
      grantId: grant.id,
      action: grant.action,
      scope: clone(grant.scope),
      clientId: grant.scope?.clientId ?? null,
      channel: grant.channel ?? null,
      approvalRequirement: grant.approvalRequirement,
      limits: grant.limits ? {
        maxAmountMinor: grant.limits.maxAmountMinor ?? null,
        currencyCode: grant.limits.currency ?? null,
      } : {},
      conditions: clone(grant.conditions ?? {}),
      effectiveFrom: grant.effectiveWindow?.effectiveFrom ?? null,
      expiresAt: grant.effectiveWindow?.expiresAt ?? null,
      status: grant.status,
    })),
    proposals: safeArray(readModel.authority.proposedAuthority).map((proposal) => ({
      proposalId: proposal.id,
      action: proposal.action,
      scope: clone(proposal.scope),
      status: proposal.status,
      // A proposal is inert. Describing it is not offering it.
      authorityGranted: false,
    })),
    revokedCount: safeArray(readModel.authority.revokedAuthority).length,
    staleCount: safeArray(readModel.authority.staleAuthority).length,
  } : null

  const context = {
    schemaVersion: CONTEXT_VERSION,
    tenantId: tenant,
    available: true,
    unavailableReason: null,
    generatedAt: readModel.generatedAt,
    focus: focus ? clone(focus) : null,
    understanding: understanding.map(summariseItem),
    conflicts: conflicts.map(summariseItem),
    roles: roles.map(summariseItem),
    pendingFounderDecisions: pending.map(summariseItem),
    changedSinceReview: changed.map(summariseItem),
    summary: {
      understandingReviewed: readModel.summary?.understandingReviewed ?? 0,
      needsReview: readModel.summary?.needsReview ?? 0,
      conflictsUnresolved: readModel.summary?.conflictsUnresolved ?? 0,
      changedSinceReview: readModel.summary?.changedSinceReview ?? 0,
    },
    authority,
    readiness: readModel.readiness ? {
      companyBrainReviewComplete: readModel.readiness.companyBrainReviewComplete === true,
      dwStandingAuthorityConfigured: readModel.readiness.dwStandingAuthorityConfigured === true,
      itemsAwaitingReview: readModel.readiness.itemsAwaitingReview ?? 0,
      conflictsRemaining: readModel.readiness.conflictsRemaining ?? 0,
    } : null,
    boundaries: BOUNDARIES,
  }

  inspect(context)
  return freeze(context)
}

const BOUNDARIES = Object.freeze({
  readOnly: true,
  isCanonicalFinancialTruth: false,
  canMutateCompanyBrain: false,
  canGrantAuthority: false,
  canRevokeAuthority: false,
  canExecute: false,
  conversationCanMutate: false,
  understandingApprovalIsAuthority: false,
  humanRoleIsDwAuthority: false,
  repeatedApprovalIsAuthority: false,
  modelConfidenceIsAuthority: false,
  providerCapabilityIsAuthority: false,
  usualBehaviourIsPolicy: false,
})

/**
 * The exact set of things a Company Brain answer is allowed to assert, so a
 * generated claim can be checked against something deterministic.
 */
export function askDwCompanyBrainAssertables(context) {
  if (!context?.available) return Object.freeze([])
  const assertables = []
  const push = (kind, item) => assertables.push(Object.freeze({
    kind,
    reviewKey: item.reviewKey,
    subject: item.subject,
    status: item.reviewStatus,
    clientId: item.clientId ?? null,
  }))
  for (const item of context.understanding) push('UNDERSTANDING', item)
  for (const item of context.conflicts) push('CONFLICT', item)
  for (const item of context.roles) push('ROLE', item)
  for (const grant of context.authority?.currentGrants || []) {
    assertables.push(Object.freeze({
      kind: 'AUTHORITY_GRANT', grantId: grant.grantId, action: grant.action,
      clientId: grant.clientId, status: grant.status,
    }))
  }
  return Object.freeze(assertables)
}

/**
 * Whether an unresolved conflict blocks a confident answer on a topic.
 * DW abstaining here is correct behaviour, not a failure.
 */
export function askDwCompanyBrainHasUnresolvedConflict(context, { clientId = null, subject = null } = {}) {
  if (!context?.available) return false
  return context.conflicts.some((conflict) =>
    conflict.conflictStatus === 'CONFLICTED' &&
    (clientId == null || conflict.clientId === clientId) &&
    (subject == null || conflict.subject === subject))
}
