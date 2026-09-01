/**
 * M2G-G6 Founder Review / Bootstrap UX kernel.
 *
 * G6 turns the deterministic Company Brain (G2 graph, G3 conflict/policy
 * intelligence, G4 operating model, G5 authority) into something a founder can
 * inspect, correct, approve, reject, hold, defer and control.
 *
 * The single non-negotiable distinction this module exists to protect:
 *
 *   "I confirm DW understood my company"  is NOT  "I authorise DW to act".
 *
 * Nothing here grants, edits, revokes or evaluates DW authority: authority is
 * created only by the G5 authenticated founder/tenant-owner grant path in
 * ./authorityDelegation.js. Nothing here executes accounts-receivable work,
 * touches a provider, or writes canonical financial state. Conflicts are
 * resolved only through the existing G3 founder-decision path on the durable
 * store. This module is pure, deterministic, tenant-scoped and read-mostly.
 */

import crypto from 'node:crypto'

import { SEMANTIC_SCOPE } from './graphStore.js'
import { deriveFounderDecisionState } from './policyIntelligence.js'
import { OPERATING_STATEMENT_STATE } from './operatingModel.js'

export const REVIEW_CATEGORY = Object.freeze({
  COMPANY_UNDERSTANDING: 'COMPANY_UNDERSTANDING',
  CONFLICTS: 'CONFLICTS',
  OPERATING_MODEL: 'OPERATING_MODEL',
  ROLES: 'ROLES',
  AUTHORITY: 'AUTHORITY',
  AUTHORITY_PROPOSALS: 'AUTHORITY_PROPOSALS',
  SOURCE_FRESHNESS: 'SOURCE_FRESHNESS',
})

export const REVIEW_ITEM_TYPE = Object.freeze({
  UNDERSTANDING: 'UNDERSTANDING',
  POLICY_OR_RULE: 'POLICY_OR_RULE',
  CONFLICT: 'CONFLICT',
  OPERATING_MODEL: 'OPERATING_MODEL',
  ROLE_OR_RESPONSIBILITY: 'ROLE_OR_RESPONSIBILITY',
  DELEGATION: 'DELEGATION',
  AUTHORITY_PROPOSAL: 'AUTHORITY_PROPOSAL',
  AUTHORITY_STATE: 'AUTHORITY_STATE',
  STALE_OR_CHANGED_ITEM: 'STALE_OR_CHANGED_ITEM',
})

export const REVIEW_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  EDITED: 'EDITED',
  REJECTED: 'REJECTED',
  HELD: 'HELD',
  DEFERRED: 'DEFERRED',
  SUPERSEDED: 'SUPERSEDED',
  STALE: 'STALE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
})

export const REVIEW_ACTION = Object.freeze({
  APPROVE: 'APPROVE',
  EDIT: 'EDIT',
  REJECT: 'REJECT',
  HOLD: 'HOLD',
  DEFER: 'DEFER',
})

export const REVIEW_REQUIRED_REASON = Object.freeze({
  NEVER_REVIEWED: 'NEVER_REVIEWED',
  SUBJECT_CHANGED_SINCE_REVIEW: 'SUBJECT_CHANGED_SINCE_REVIEW',
  SUPPORTING_SOURCE_REVOKED: 'SUPPORTING_SOURCE_REVOKED',
  REVIEWED_SUBJECT_NO_LONGER_PRESENT: 'REVIEWED_SUBJECT_NO_LONGER_PRESENT',
  CONFLICT_UNRESOLVED: 'CONFLICT_UNRESOLVED',
})

export const REVIEW_ATTEMPT_OUTCOME = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY',
  REJECTED_IDEMPOTENCY_CONFLICT: 'REJECTED_IDEMPOTENCY_CONFLICT',
  REJECTED_STALE_REVISION: 'REJECTED_STALE_REVISION',
  REJECTED_SUBJECT_CHANGED: 'REJECTED_SUBJECT_CHANGED',
  REJECTED_ACTION_UNAVAILABLE: 'REJECTED_ACTION_UNAVAILABLE',
})

/** Resolution paths G6 defers to. G6 owns none of them. */
export const REVIEW_RESOLUTION_PATH = Object.freeze({
  G3_FOUNDER_DECISION: 'G3_FOUNDER_DECISION',
  G5_EXPLICIT_AUTHORITY_GRANT: 'G5_EXPLICIT_AUTHORITY_GRANT',
  G5_EXPLICIT_AUTHORITY_REVOCATION: 'G5_EXPLICIT_AUTHORITY_REVOCATION',
  G6_FOUNDER_REVIEW: 'G6_FOUNDER_REVIEW',
})

/**
 * Field names that would smuggle an authority mutation into a review write.
 * A review decision that carries any of them is rejected outright rather than
 * silently ignored.
 */
const AUTHORITY_MUTATION_FIELDS = Object.freeze([
  'explicitGrant', 'grantAuthority', 'grantee', 'grantId', 'approvalRequirement',
  'effectiveWindow', 'authorityAction', 'authorityScope', 'limits', 'channel',
  'revokeAuthority', 'isFounder', 'founderId', 'tenantOverride', 'authorityGranted',
])

const REVIEW_ACTIONS = new Set(Object.values(REVIEW_ACTION))

const UNDERSTANDING_ACTIONS = Object.freeze([
  REVIEW_ACTION.APPROVE, REVIEW_ACTION.EDIT, REVIEW_ACTION.REJECT,
  REVIEW_ACTION.HOLD, REVIEW_ACTION.DEFER,
])
// A conflict is resolved by an explicit G3 founder decision, never by a G6
// "approve". Holding or deferring it keeps it visibly unresolved.
const CONFLICT_ACTIONS = Object.freeze([REVIEW_ACTION.HOLD, REVIEW_ACTION.DEFER])
// A proposal is never "approved" in G6: approving would read as granting.
// It can be narrowed, rejected, held or deferred, and stays inert either way.
const PROPOSAL_ACTIONS = Object.freeze([
  REVIEW_ACTION.EDIT, REVIEW_ACTION.REJECT, REVIEW_ACTION.HOLD, REVIEW_ACTION.DEFER,
])
// Current authority is mutated only through G5. G6 offers no review action.
const AUTHORITY_STATE_ACTIONS = Object.freeze([])

const STATUS_BY_ACTION = Object.freeze({
  [REVIEW_ACTION.APPROVE]: REVIEW_STATUS.APPROVED,
  [REVIEW_ACTION.EDIT]: REVIEW_STATUS.EDITED,
  [REVIEW_ACTION.REJECT]: REVIEW_STATUS.REJECTED,
  [REVIEW_ACTION.HOLD]: REVIEW_STATUS.HELD,
  [REVIEW_ACTION.DEFER]: REVIEW_STATUS.DEFERRED,
})

const RESOLVING_STATUSES = new Set([REVIEW_STATUS.APPROVED, REVIEW_STATUS.EDITED])
const UNRESOLVED_STATUSES = new Set([
  REVIEW_STATUS.PENDING, REVIEW_STATUS.HELD, REVIEW_STATUS.DEFERRED,
  REVIEW_STATUS.REVIEW_REQUIRED, REVIEW_STATUS.STALE,
])

/**
 * Structural boundaries repeated on every G6 object. They are asserted by the
 * G6 adversarial suite so a future refactor cannot quietly drop one.
 */
const REVIEW_BOUNDARIES = Object.freeze({
  readOnly: false,
  understandingApprovalIsAuthority: false,
  operatingModelApprovalIsAuthority: false,
  policyApprovalIsAuthority: false,
  conflictResolutionIsAuthority: false,
  roleUnderstandingIsAuthority: false,
  humanDelegationIsDwAuthority: false,
  repeatedApprovalIsAuthority: false,
  modelConfidenceIsAuthority: false,
  providerCapabilityIsAuthority: false,
  modelOutputCanGrant: false,
  bootstrapCompletionGrantsAuthority: false,
  canGrantAuthority: false,
  canRevokeAuthority: false,
  canEvaluateAuthority: false,
  canExecute: false,
  canonicalMoneyWritable: false,
  askDwCompanyBrainAnswering: false,
})

const READ_MODEL_BOUNDARIES = Object.freeze({ ...REVIEW_BOUNDARIES, readOnly: true })

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

function isCanonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function assertActor(actor, tenantId) {
  if (!actor?.authenticated || !actor.id) throw new Error('authenticated actor required')
  if (actor.tenantId !== tenantId) throw new Error('actor tenant mismatch')
}

/**
 * The founder/tenant-owner test is deliberately identical to G5's: one
 * authenticated owner per tenant. G6 must not widen who counts as a founder.
 */
function assertFounder(actor, tenantId) {
  assertActor(actor, tenantId)
  if (actor.role !== 'FOUNDER') throw new Error('founder role required')
  if (actor.id !== tenantId) throw new Error('tenant owner reviewer required')
}

function sortedUnique(values) {
  return [...new Set((values || []).filter((value) => value != null))].sort()
}

function scopeIdentity(scope = {}) {
  return {
    level: scope.level || SEMANTIC_SCOPE.COMPANY,
    clientId: scope.clientId ?? null,
    roleId: scope.roleId ?? null,
    entityId: scope.entityId ?? null,
  }
}

function reviewKeyFor({ tenantId, category, itemType, subjectType, subjectId }) {
  return `review-${hash({ tenantId, category, itemType, subjectType, subjectId }).slice(0, 32)}`
}

// ── evidence ──────────────────────────────────────────────────────────────────

function buildEvidenceIndex(snapshot) {
  const sourceById = new Map((snapshot.sources || []).map((source) => [source.id, source]))
  // A tombstone identifies its source; the persistence path resolves it to the
  // exact source versions, so accept either keying.
  const tombstonedSourceIds = new Set(
    (snapshot.tombstones || []).flatMap((row) => [row.sourceVersionId, row.sourceId].filter(Boolean)),
  )
  const claimById = new Map((snapshot.claims || []).map((claim) => [claim.id, claim]))
  return { sourceById, tombstonedSourceIds, claimById }
}

function evidenceEntries(claimIds, rootSourceVersionIds, graphNodeKeys, index) {
  const roots = sortedUnique([
    ...rootSourceVersionIds,
    ...claimIds.flatMap((claimId) => index.claimById.get(claimId)?.provenanceRootIds || []),
  ])
  return freeze(roots.map((sourceVersionId) => {
    const source = index.sourceById.get(sourceVersionId) || null
    const tombstoned = index.tombstonedSourceIds.has(sourceVersionId)
    return {
      sourceVersionId,
      sourceType: source?.sourceType ?? null,
      trustZone: source?.trustZone ?? null,
      sourceTimestamp: source?.sourceTimestamp ?? null,
      sourceVersion: source?.sourceVersion ?? null,
      contentHash: source?.contentHash ?? null,
      // A source that is absent from the active snapshot is not presented as
      // current evidence, and a revoked one is never quietly dropped.
      present: Boolean(source),
      active: source ? source.active !== false && !source.revokedAt : false,
      revokedAt: source?.revokedAt ?? null,
      revocationReason: source?.revocationReason ?? null,
      tombstoned,
    }
  }))
}

function claimEvidence(claimIds, index) {
  return freeze(sortedUnique(claimIds).map((claimId) => {
    const claim = index.claimById.get(claimId) || null
    return {
      claimId,
      claimType: claim?.claimType ?? null,
      claimClass: claim?.claimClass ?? null,
      value: claim ? structuredClone(claim.value) : null,
      active: claim?.active === true,
      derived: claim?.derived === true,
      explicit: claim?.explicit === true,
      confidence: claim?.confidence ?? null,
      rootSourceVersionIds: sortedUnique(claim?.provenanceRootIds || []),
      present: Boolean(claim),
    }
  }))
}

// ── review item construction ──────────────────────────────────────────────────

function makeItem({
  tenantId, category, itemType, subjectType, subjectId, subject, proposition,
  proposedValue, why, scope, clientId = null, roleId = null, confidence = null,
  conflictStatus = 'NONE', conflictKeys = [], unresolvedReason = null,
  evidence, claims, reviewableActions, resolutionPath, authorityImpact = 'NONE',
  authorityProposalId = null, authorityGrantId = null, authorityStatus = null,
  temporalState = null, operatingState = null, policyResolutionStatus = null,
  sourceStatementIds = [], generatedAt, asOfDate, extra = {},
}) {
  const reviewKey = reviewKeyFor({ tenantId, category, itemType, subjectType, subjectId })
  // The fingerprint deliberately covers only what a founder actually reviewed
  // about THIS item. An unrelated source change therefore cannot stale it.
  const subjectFingerprint = hash({
    tenantId, reviewKey, proposition, proposedValue, conflictStatus,
    conflictKeys: sortedUnique(conflictKeys), operatingState, policyResolutionStatus,
    temporalState, authorityStatus,
    evidence: evidence.map((row) => ({
      sourceVersionId: row.sourceVersionId,
      contentHash: row.contentHash,
      active: row.active,
      tombstoned: row.tombstoned,
    })),
    claims: claims.map((row) => ({ claimId: row.claimId, value: row.value, active: row.active })),
  })
  const supportingSourceRevoked = evidence.some((row) => !row.active || row.tombstoned || !row.present)
  return freeze({
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_ITEM_V0',
    reviewKey,
    tenantId,
    category,
    itemType,
    subjectType,
    subjectId,
    subject,
    proposition,
    proposedValue: structuredClone(proposedValue ?? null),
    why,
    scope: scopeIdentity(scope),
    clientId,
    roleId,
    confidence,
    conflictStatus,
    conflictKeys: sortedUnique(conflictKeys),
    unresolvedReason,
    evidence,
    claims,
    supportingSourceRevoked,
    subjectFingerprint,
    reviewableActions: freeze([...reviewableActions]),
    resolutionPath,
    // Authority impact of reviewing this item. It is structurally NONE.
    authorityImpact,
    authorityProposalId,
    authorityGrantId,
    authorityStatus,
    temporalState,
    operatingState,
    policyResolutionStatus,
    sourceStatementIds: sortedUnique(sourceStatementIds),
    generatedAt,
    asOfDate,
    ...extra,
    boundaries: REVIEW_BOUNDARIES,
  })
}

const ROLE_TOPICS = new Set(['role', 'role_record'])
const DELEGATION_TOPICS = new Set(['delegation', 'observed_delegation_record'])

function itemTypeForStatement(statement, section) {
  if (statement.policyResolutionStatus) return REVIEW_ITEM_TYPE.POLICY_OR_RULE
  if (DELEGATION_TOPICS.has(statement.topic)) return REVIEW_ITEM_TYPE.DELEGATION
  if (ROLE_TOPICS.has(statement.topic)) return REVIEW_ITEM_TYPE.ROLE_OR_RESPONSIBILITY
  if (section === 'rolesAndResponsibilities') return REVIEW_ITEM_TYPE.ROLE_OR_RESPONSIBILITY
  return REVIEW_ITEM_TYPE.UNDERSTANDING
}

function categoryForItemType(itemType) {
  if (itemType === REVIEW_ITEM_TYPE.ROLE_OR_RESPONSIBILITY || itemType === REVIEW_ITEM_TYPE.DELEGATION) {
    return REVIEW_CATEGORY.ROLES
  }
  if (itemType === REVIEW_ITEM_TYPE.POLICY_OR_RULE) return REVIEW_CATEGORY.OPERATING_MODEL
  return REVIEW_CATEGORY.COMPANY_UNDERSTANDING
}

const OPERATING_SECTIONS = Object.freeze([
  'collections', 'billing', 'reminders', 'promisesToPay', 'escalation', 'disputes',
  'clientHandling', 'rolesAndResponsibilities', 'communication', 'policyOperatingRules',
])

function statementSections(operatingModel) {
  const bySection = new Map()
  for (const section of OPERATING_SECTIONS) {
    for (const statement of operatingModel[section] || []) {
      if (!bySection.has(statement.id)) bySection.set(statement.id, { statement, sections: [] })
      bySection.get(statement.id).sections.push(section)
    }
  }
  for (const override of operatingModel.clientOverrides || []) {
    for (const statement of override.statements || []) {
      if (!bySection.has(statement.id)) bySection.set(statement.id, { statement, sections: [] })
      const entry = bySection.get(statement.id)
      if (!entry.sections.includes('clientOverrides')) entry.sections.push('clientOverrides')
    }
  }
  return [...bySection.values()].sort((a, b) => a.statement.id.localeCompare(b.statement.id))
}

function statementProposition(statement) {
  return freeze({
    topic: statement.topic,
    scope: scopeIdentity(statement.scope),
    clientId: statement.clientId ?? null,
    roleId: statement.roleId ?? null,
    state: statement.state,
    value: structuredClone(statement.value ?? null),
    currentApplicable: statement.currentApplicable === true,
  })
}

/** Shared derivation used by both the store-backed and record-backed entry points. */
function buildReviewItemsCore({
  tenantId,
  knowledge,
  operatingModel,
  conflicts = [],
  currentDecisionsByTarget = new Map(),
  authorityReadModel = null,
  asOfDate,
  generatedAt,
}) {
  if (operatingModel?.tenantId !== tenantId) throw new Error('operating model tenant mismatch')
  if (!isCanonicalDate(asOfDate)) throw new Error('valid founder review as-of date required')
  const at = timestamp(generatedAt, 'founder review generatedAt')
  if (authorityReadModel && authorityReadModel.tenantId !== tenantId) {
    throw new Error('authority read model tenant mismatch')
  }

  const index = buildEvidenceIndex(knowledge)
  const items = []

  // (1) Understanding / policy / roles, from the G4 operating model.
  for (const { statement, sections } of statementSections(operatingModel)) {
    const itemType = itemTypeForStatement(statement, sections[0])
    const category = categoryForItemType(itemType)
    const claims = claimEvidence(statement.sourceClaimIds, index)
    const evidence = evidenceEntries(
      statement.sourceClaimIds, statement.rootSourceVersionIds, statement.sourceGraphNodeKeys, index,
    )
    const conflictStatus = statement.state === OPERATING_STATEMENT_STATE.CONFLICTED
      ? 'CONFLICTED'
      : statement.conflictKeys?.length ? 'CONTESTED' : 'NONE'
    items.push(makeItem({
      tenantId,
      category,
      itemType,
      subjectType: 'OPERATING_STATEMENT',
      // Identity excludes the value, so a changed value re-surfaces the SAME
      // review item as changed-since-review rather than inventing a new one.
      subjectId: stable({
        topic: statement.topic,
        scope: scopeIdentity(statement.scope),
        clientId: statement.clientId ?? null,
        roleId: statement.roleId ?? null,
        policy: Boolean(statement.policyResolutionStatus),
      }),
      subject: statement.topic,
      proposition: statementProposition(statement),
      proposedValue: statement.value ?? null,
      why: statement.explanation,
      scope: statement.scope,
      clientId: statement.clientId ?? null,
      roleId: statement.roleId ?? null,
      confidence: statement.confidence ?? null,
      conflictStatus,
      conflictKeys: statement.conflictKeys || [],
      unresolvedReason: statement.state === OPERATING_STATEMENT_STATE.UNRESOLVED
        ? statement.explanation
        : null,
      evidence,
      claims,
      reviewableActions: UNDERSTANDING_ACTIONS,
      resolutionPath: REVIEW_RESOLUTION_PATH.G6_FOUNDER_REVIEW,
      temporalState: statement.temporalState,
      operatingState: statement.state,
      policyResolutionStatus: statement.policyResolutionStatus,
      sourceStatementIds: [statement.id],
      generatedAt: at,
      asOfDate,
      extra: {
        // The upstream derivation this item came from. The review RPC re-reads
        // it server-side to decide staleness for itself.
        sourceModelProposalId: operatingModel.proposalId ?? null,
        sourceModelFingerprint: operatingModel.fingerprint ?? null,
        operatingSections: freeze([...sections].sort()),
        founderReviewRequiredByG4: statement.founderReviewRequired === true,
        // Human participation described here never becomes DW permission.
        describesHumanResponsibility:
          itemType === REVIEW_ITEM_TYPE.ROLE_OR_RESPONSIBILITY || itemType === REVIEW_ITEM_TYPE.DELEGATION,
      },
    }))
  }

  // (2) Conflicts, from the durable G3 conflict records plus G4 blockers.
  const tenantConflicts = (conflicts || [])
    .filter((row) => row.tenantId === tenantId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  for (const conflict of tenantConflicts) {
    const claims = claimEvidence(conflict.competingClaimIds || [], index)
    const evidence = evidenceEntries(conflict.competingClaimIds || [], [], [], index)
    const decision = currentDecisionsByTarget.get(conflict.id) || null
    const resolved = conflict.status === 'RESOLVED' && Boolean(decision)
    items.push(makeItem({
      tenantId,
      category: REVIEW_CATEGORY.CONFLICTS,
      itemType: REVIEW_ITEM_TYPE.CONFLICT,
      subjectType: 'BRAIN_CONFLICT',
      subjectId: conflict.id,
      subject: conflict.topic,
      proposition: freeze({
        topic: conflict.topic,
        // Every side is preserved and shown; nothing is flattened into a score.
        // Ordered by claim id so the derivation is identical whether the
        // conflict came from the in-process store or from persisted rows,
        // whose membership table carries no ordering of its own.
        competingPositions: (conflict.competingClaimIds || [])
          .map((claimId, position) => ({
            claimId,
            scope: scopeIdentity((conflict.scopes || [])[position] || {}),
            value: structuredClone((conflict.preservedValues || [])[position] ?? null),
          }))
          .sort((a, b) => String(a.claimId).localeCompare(String(b.claimId)))
          .map((entry) => freeze(entry)),
        currentResult: resolved ? 'FOUNDER_DECIDED' : 'NO_SAFE_CURRENT_INSTRUCTION',
      }),
      proposedValue: null,
      why: resolved
        ? 'A recorded G3 founder decision governs this conflict; the losing evidence is preserved.'
        : 'Competing evidence cannot be safely reconciled deterministically; a founder decision is required.',
      scope: (conflict.scopes || [])[0] || { level: SEMANTIC_SCOPE.COMPANY },
      conflictStatus: resolved ? 'RESOLVED' : 'CONFLICTED',
      conflictKeys: [`${conflict.topic}:${conflict.id}`],
      unresolvedReason: resolved ? null : REVIEW_REQUIRED_REASON.CONFLICT_UNRESOLVED,
      evidence,
      claims,
      reviewableActions: CONFLICT_ACTIONS,
      // A conflict is decided by the existing G3 path, not by a G6 approval.
      resolutionPath: REVIEW_RESOLUTION_PATH.G3_FOUNDER_DECISION,
      generatedAt: at,
      asOfDate,
      extra: {
        conflictId: conflict.id,
        conflictRevision: conflict.revision ?? 0,
        resolutionDecisionId: conflict.resolutionDecisionId ?? null,
        founderDecision: decision ? freeze(structuredClone(decision)) : null,
        confidenceResolved: false,
        currentSafeInstructionAvailable: resolved,
      },
    }))
  }

  for (const blocker of operatingModel.blockers || []) {
    items.push(makeItem({
      tenantId,
      category: REVIEW_CATEGORY.CONFLICTS,
      itemType: REVIEW_ITEM_TYPE.CONFLICT,
      subjectType: 'OPERATING_BLOCKER',
      subjectId: blocker.id,
      subject: blocker.topic,
      proposition: freeze({ topic: blocker.topic, scope: scopeIdentity(blocker.scope), currentResult: 'BLOCKED' }),
      proposedValue: null,
      why: blocker.reason,
      scope: blocker.scope,
      conflictStatus: 'CONFLICTED',
      conflictKeys: blocker.conflictKeys || [],
      unresolvedReason: REVIEW_REQUIRED_REASON.CONFLICT_UNRESOLVED,
      evidence: freeze([]),
      claims: freeze([]),
      reviewableActions: CONFLICT_ACTIONS,
      resolutionPath: REVIEW_RESOLUTION_PATH.G3_FOUNDER_DECISION,
      generatedAt: at,
      asOfDate,
      extra: {
        blockerId: blocker.id,
        sourceModelProposalId: operatingModel.proposalId ?? null,
        sourceModelFingerprint: operatingModel.fingerprint ?? null,
        currentSafeInstructionAvailable: false,
        confidenceResolved: false,
      },
    }))
  }

  // (3) Authority proposals and current authority state, read from G5.
  for (const proposal of authorityReadModel?.proposedAuthority || []) {
    items.push(makeItem({
      tenantId,
      category: REVIEW_CATEGORY.AUTHORITY_PROPOSALS,
      itemType: REVIEW_ITEM_TYPE.AUTHORITY_PROPOSAL,
      subjectType: 'AUTHORITY_PROPOSAL',
      subjectId: proposal.id,
      subject: proposal.action,
      proposition: freeze({
        action: proposal.action,
        scope: freeze(structuredClone(proposal.scope)),
        proposedConfiguration: freeze(structuredClone(proposal.proposedConfiguration || {})),
      }),
      proposedValue: proposal.proposedConfiguration || {},
      why: 'DW proposes this exact standing authority. A proposal is inert until an explicit G5 grant.',
      scope: { level: proposal.scope?.level || SEMANTIC_SCOPE.COMPANY, clientId: proposal.scope?.clientId ?? null },
      clientId: proposal.scope?.clientId ?? null,
      evidence: freeze([]),
      claims: freeze([]),
      reviewableActions: PROPOSAL_ACTIONS,
      resolutionPath: REVIEW_RESOLUTION_PATH.G5_EXPLICIT_AUTHORITY_GRANT,
      authorityProposalId: proposal.id,
      authorityStatus: proposal.status,
      generatedAt: at,
      asOfDate,
      extra: {
        authorityGranted: false,
        grantableByInference: false,
        proposalIsInert: true,
        g5ProposalBoundaries: freeze(structuredClone(proposal.boundaries || {})),
      },
    }))
  }

  for (const grant of authorityReadModel?.currentAuthorityGrants || []) {
    items.push(makeItem({
      tenantId,
      category: REVIEW_CATEGORY.AUTHORITY,
      itemType: REVIEW_ITEM_TYPE.AUTHORITY_STATE,
      subjectType: 'AUTHORITY_GRANT',
      subjectId: grant.id,
      subject: grant.action,
      // Every G5 dimension is shown exactly; nothing is summarised away.
      proposition: freeze({
        action: grant.action,
        scope: freeze(structuredClone(grant.scope)),
        client: grant.scope?.clientId ?? null,
        amount: grant.limits?.maxAmountMinor ?? null,
        currency: grant.limits?.currency ?? null,
        conditions: freeze(structuredClone(grant.conditions || {})),
        time: freeze(structuredClone(grant.effectiveWindow)),
        channel: grant.channel ?? null,
        approval: grant.approvalRequirement,
      }),
      proposedValue: null,
      why: 'Standing DW authority created by an explicit, authenticated G5 founder grant.',
      scope: { level: grant.scope?.level || SEMANTIC_SCOPE.COMPANY, clientId: grant.scope?.clientId ?? null },
      clientId: grant.scope?.clientId ?? null,
      evidence: freeze([]),
      claims: freeze([]),
      reviewableActions: AUTHORITY_STATE_ACTIONS,
      resolutionPath: REVIEW_RESOLUTION_PATH.G5_EXPLICIT_AUTHORITY_REVOCATION,
      authorityGrantId: grant.id,
      authorityStatus: grant.status,
      generatedAt: at,
      asOfDate,
      extra: {
        grantRevision: grant.revision,
        grantedAt: grant.decidedAt,
        expiresAt: grant.effectiveWindow?.expiresAt ?? null,
        reviewActionsAvailable: false,
      },
    }))
  }

  return freeze(items.sort((a, b) => a.reviewKey.localeCompare(b.reviewKey)))
}

/**
 * Deterministically derives the founder-review items for a tenant from frozen
 * G2/G3/G4/G5 state. Pure: it persists nothing and decides nothing.
 */
export function buildFounderReviewItems({
  actor, tenantId, brain, graph, operatingModel,
  authorityReadModel = null, asOfDate, generatedAt,
} = {}) {
  assertActor(actor, tenantId)
  if (!brain || !graph) throw new Error('brain and graph required')
  const decisionState = deriveFounderDecisionState(brain, { tenantId })
  const currentDecisionsByTarget = new Map()
  for (const decision of decisionState.currentDecisions) {
    if (!currentDecisionsByTarget.has(decision.targetId)) currentDecisionsByTarget.set(decision.targetId, decision)
  }
  return buildReviewItemsCore({
    tenantId,
    knowledge: brain.prepareSnapshot({ actor, tenantId }),
    operatingModel,
    conflicts: brain.conflicts || [],
    currentDecisionsByTarget,
    authorityReadModel,
    asOfDate,
    generatedAt,
  })
}

/**
 * Same derivation, fed from already-persisted tenant records rather than the
 * in-process stores. The persistence layer decides nothing on its own: it only
 * supplies the exact rows the pure derivation above consumes.
 */
export function buildFounderReviewItemsFromRecords({
  actor, tenantId, knowledge, operatingModel, conflicts = [], founderDecisions = [],
  authorityReadModel = null, asOfDate, generatedAt,
} = {}) {
  assertActor(actor, tenantId)
  const currentDecisionsByTarget = new Map()
  for (const decision of founderDecisions) {
    if (decision?.tenantId !== tenantId) continue
    if (!currentDecisionsByTarget.has(decision.targetId)) currentDecisionsByTarget.set(decision.targetId, decision)
  }
  return buildReviewItemsCore({
    tenantId,
    knowledge: {
      sources: knowledge?.sources || [],
      claims: knowledge?.claims || [],
      tombstones: knowledge?.tombstones || [],
    },
    operatingModel,
    conflicts,
    currentDecisionsByTarget,
    authorityReadModel,
    asOfDate,
    generatedAt,
  })
}

// ── durable review decisions ──────────────────────────────────────────────────

function rejectAuthorityMutationFields(input) {
  for (const field of AUTHORITY_MUTATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new Error(`founder review cannot carry authority field '${field}'`)
    }
  }
}

/**
 * Durable founder-review decisions: append-only, tenant-scoped, revisioned.
 * The store has no authority handle by construction — it cannot grant, revoke
 * or evaluate DW authority even if a caller asks it to.
 */
export class FounderReviewStore {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock
    this.revisions = []
    this.attempts = []
  }

  tenantRevisions(tenantId, reviewKey = null) {
    return this.revisions.filter(
      (row) => row.tenantId === tenantId && (reviewKey == null || row.reviewKey === reviewKey),
    )
  }

  audit(entry) {
    const row = freeze({ kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_ATTEMPT_V0', ...entry })
    this.attempts.push(row)
    return row
  }

  /**
   * Records one explicit founder review decision about one review item.
   *
   * It never grants authority, never resolves a G3 conflict, never executes,
   * and never overwrites an earlier decision: each accepted call appends a new
   * revision that explicitly supersedes its predecessor.
   */
  recordReviewDecision({
    actor, tenantId, item, action, expectedRevision, subjectFingerprint,
    reviewedValue, reason = null, idempotencyKey, ...rest
  } = {}) {
    assertFounder(actor, tenantId)
    rejectAuthorityMutationFields(rest)
    if (item?.kind !== 'COMPANY_BRAIN_FOUNDER_REVIEW_ITEM_V0') throw new Error('founder review item required')
    if (item.tenantId !== tenantId) throw new Error('founder review item tenant mismatch')
    const normalizedAction = text(action, 'founder review action').toUpperCase()
    if (!REVIEW_ACTIONS.has(normalizedAction)) throw new Error('unknown founder review action')
    const key = text(idempotencyKey, 'founder review idempotency key')
    const fingerprint = text(subjectFingerprint, 'reviewed subject fingerprint')
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('founder review expectedRevision required')
    }
    if (normalizedAction === REVIEW_ACTION.EDIT) {
      if (reviewedValue === undefined) throw new Error('edited understanding requires an explicit corrected value')
    } else if (reviewedValue !== undefined) {
      throw new Error('only an edit may carry a corrected value')
    }

    const requestFingerprint = hash({
      tenantId,
      reviewKey: item.reviewKey,
      action: normalizedAction,
      expectedRevision,
      subjectFingerprint: fingerprint,
      reviewedValue: reviewedValue ?? null,
      reason,
    })

    const prior = this.revisions.find((row) => row.tenantId === tenantId && row.idempotencyKey === key)
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) {
        this.audit({
          tenantId, actorId: actor.id, reviewKey: item.reviewKey, idempotencyKey: key,
          outcome: REVIEW_ATTEMPT_OUTCOME.REJECTED_IDEMPOTENCY_CONFLICT,
          requestFingerprint, attemptedAt: this.clock(),
        })
        throw new Error('founder review idempotency conflict')
      }
      this.audit({
        tenantId, actorId: actor.id, reviewKey: item.reviewKey, idempotencyKey: key,
        outcome: REVIEW_ATTEMPT_OUTCOME.IDEMPOTENT_REPLAY, requestFingerprint,
        revisionId: prior.id, attemptedAt: this.clock(),
      })
      return prior
    }

    if (!item.reviewableActions.includes(normalizedAction)) {
      this.audit({
        tenantId, actorId: actor.id, reviewKey: item.reviewKey, idempotencyKey: key,
        outcome: REVIEW_ATTEMPT_OUTCOME.REJECTED_ACTION_UNAVAILABLE, requestFingerprint,
        attemptedAt: this.clock(),
      })
      throw new Error(`founder review action '${normalizedAction}' is unavailable for this item`)
    }

    const existing = this.tenantRevisions(tenantId, item.reviewKey)
    const actualRevision = existing.length
    if (expectedRevision !== actualRevision) {
      this.audit({
        tenantId, actorId: actor.id, reviewKey: item.reviewKey, idempotencyKey: key,
        outcome: REVIEW_ATTEMPT_OUTCOME.REJECTED_STALE_REVISION, requestFingerprint,
        expectedRevision, actualRevision, attemptedAt: this.clock(),
      })
      throw new Error('stale founder review revision')
    }
    if (fingerprint !== item.subjectFingerprint) {
      this.audit({
        tenantId, actorId: actor.id, reviewKey: item.reviewKey, idempotencyKey: key,
        outcome: REVIEW_ATTEMPT_OUTCOME.REJECTED_SUBJECT_CHANGED, requestFingerprint,
        attemptedAt: this.clock(),
      })
      throw new Error('founder review subject changed since it was opened')
    }

    const decidedAt = timestamp(this.clock(), 'founder review decision time')
    const predecessor = existing.at(-1) || null
    const revision = freeze({
      kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_REVISION_V0',
      id: `founder-review-${hash({ tenantId, key }).slice(0, 32)}`,
      tenantId,
      reviewKey: item.reviewKey,
      category: item.category,
      itemType: item.itemType,
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      revision: actualRevision + 1,
      action: normalizedAction,
      status: STATUS_BY_ACTION[normalizedAction],
      subjectFingerprint: fingerprint,
      proposedValue: structuredClone(item.proposedValue ?? null),
      reviewedValue: normalizedAction === REVIEW_ACTION.EDIT ? structuredClone(reviewedValue) : null,
      reason: reason == null ? null : text(reason, 'founder review reason'),
      actorId: actor.id,
      actorRole: 'FOUNDER',
      decidedAt,
      supersedesRevisionId: predecessor?.id ?? null,
      evidenceClaimIds: freeze(item.claims.map((row) => row.claimId)),
      evidenceSourceVersionIds: freeze(item.evidence.map((row) => row.sourceVersionId)),
      idempotencyKey: key,
      requestFingerprint,
      // A rejection refuses the proposition; it never asserts its inverse.
      assertsInverseProposition: false,
      inferredOppositeValue: null,
      resolvesConflict: false,
      // Structurally false on every review revision, for every action, forever.
      authorityGranted: false,
      authorityImpact: 'NONE',
      canonicalMoneyMutated: false,
      executed: false,
      boundaries: REVIEW_BOUNDARIES,
    })
    this.revisions.push(revision)
    this.audit({
      tenantId, actorId: actor.id, reviewKey: item.reviewKey, idempotencyKey: key,
      outcome: REVIEW_ATTEMPT_OUTCOME.ACCEPTED, requestFingerprint,
      revisionId: revision.id, attemptedAt: decidedAt,
    })
    return revision
  }

  readHistory({ actor, tenantId, reviewKey = null } = {}) {
    assertActor(actor, tenantId)
    return freeze({
      kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_HISTORY_V0',
      tenantId,
      revisions: this.tenantRevisions(tenantId, reviewKey)
        .slice()
        .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.id.localeCompare(b.id)),
      attempts: this.attempts.filter(
        (row) => row.tenantId === tenantId && (reviewKey == null || row.reviewKey === reviewKey),
      ),
      boundaries: READ_MODEL_BOUNDARIES,
    })
  }
}

// ── derivation of current review state ────────────────────────────────────────

function reviewLineage(revisions) {
  const sorted = revisions.slice().sort(
    (a, b) => a.revision - b.revision || a.decidedAt.localeCompare(b.decidedAt) || a.id.localeCompare(b.id),
  )
  const supersededIds = new Set(sorted.map((row) => row.supersedesRevisionId).filter(Boolean))
  const superseded = sorted.filter((row) => supersededIds.has(row.id))
  const tips = sorted.filter((row) => !supersededIds.has(row.id))
  // A predecessor that an explicit successor replaced never returns to current
  // truth, even when the successor is later found stale.
  return { sorted, superseded: freeze(superseded), tip: tips.at(-1) || null }
}

function resolveItemState(item, revisions) {
  const { sorted, superseded, tip } = reviewLineage(revisions)
  if (!tip) {
    return {
      status: item.conflictStatus === 'CONFLICTED' ? REVIEW_STATUS.REVIEW_REQUIRED : REVIEW_STATUS.PENDING,
      reviewRequiredReason: item.conflictStatus === 'CONFLICTED'
        ? REVIEW_REQUIRED_REASON.CONFLICT_UNRESOLVED
        : REVIEW_REQUIRED_REASON.NEVER_REVIEWED,
      changedSinceReview: false,
      currentRevision: null,
      revisionNumber: 0,
      supersededRevisions: superseded,
      history: freeze(sorted),
    }
  }
  const changedSinceReview = tip.subjectFingerprint !== item.subjectFingerprint
  let status = tip.status
  let reviewRequiredReason = null
  if (changedSinceReview) {
    status = REVIEW_STATUS.REVIEW_REQUIRED
    reviewRequiredReason = REVIEW_REQUIRED_REASON.SUBJECT_CHANGED_SINCE_REVIEW
  } else if (item.supportingSourceRevoked) {
    status = REVIEW_STATUS.REVIEW_REQUIRED
    reviewRequiredReason = REVIEW_REQUIRED_REASON.SUPPORTING_SOURCE_REVOKED
  } else if (item.conflictStatus === 'CONFLICTED') {
    reviewRequiredReason = REVIEW_REQUIRED_REASON.CONFLICT_UNRESOLVED
  }
  return {
    status,
    reviewRequiredReason,
    changedSinceReview,
    currentRevision: tip,
    revisionNumber: sorted.length,
    supersededRevisions: superseded,
    history: freeze(sorted),
  }
}

function orphanItem({ tenantId, reviewKey, revisions, generatedAt, asOfDate }) {
  const { sorted, superseded, tip } = reviewLineage(revisions)
  return freeze({
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_RESOLVED_ITEM_V0',
    reviewKey,
    tenantId,
    category: REVIEW_CATEGORY.SOURCE_FRESHNESS,
    itemType: REVIEW_ITEM_TYPE.STALE_OR_CHANGED_ITEM,
    subjectType: tip?.subjectType ?? null,
    subjectId: tip?.subjectId ?? null,
    subject: tip?.subjectId ?? null,
    proposition: null,
    proposedValue: null,
    why: 'A previously reviewed understanding no longer has current supporting evidence in the Company Brain.',
    scope: scopeIdentity({}),
    clientId: null,
    roleId: null,
    confidence: null,
    conflictStatus: 'NONE',
    conflictKeys: freeze([]),
    unresolvedReason: REVIEW_REQUIRED_REASON.REVIEWED_SUBJECT_NO_LONGER_PRESENT,
    evidence: freeze([]),
    claims: freeze([]),
    supportingSourceRevoked: true,
    subjectFingerprint: null,
    reviewableActions: freeze([]),
    resolutionPath: REVIEW_RESOLUTION_PATH.G6_FOUNDER_REVIEW,
    authorityImpact: 'NONE',
    authorityProposalId: null,
    authorityGrantId: null,
    authorityStatus: null,
    temporalState: null,
    operatingState: null,
    policyResolutionStatus: null,
    sourceStatementIds: freeze([]),
    generatedAt,
    asOfDate,
    reviewStatus: REVIEW_STATUS.REVIEW_REQUIRED,
    reviewRequiredReason: REVIEW_REQUIRED_REASON.REVIEWED_SUBJECT_NO_LONGER_PRESENT,
    changedSinceReview: true,
    currentReviewRevision: tip,
    reviewRevisionNumber: sorted.length,
    supersededReviewRevisions: superseded,
    reviewHistory: freeze(sorted),
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

/**
 * Canonical current founder-review state: item + its current revision, lineage,
 * supersession, changed-since-review and no-resurrection semantics.
 */
export function deriveFounderReviewState({ actor, tenantId, store, items = [], generatedAt, asOfDate } = {}) {
  assertActor(actor, tenantId)
  if (!(store instanceof FounderReviewStore)) throw new Error('founder review store required')
  const tenantItems = items.filter((item) => item?.tenantId === tenantId)
  const at = timestamp(generatedAt, 'founder review state generatedAt')
  const byKey = new Map()
  for (const revision of store.tenantRevisions(tenantId)) {
    if (!byKey.has(revision.reviewKey)) byKey.set(revision.reviewKey, [])
    byKey.get(revision.reviewKey).push(revision)
  }

  const resolved = tenantItems.map((item) => {
    const state = resolveItemState(item, byKey.get(item.reviewKey) || [])
    return freeze({
      kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_RESOLVED_ITEM_V0',
      ...item,
      reviewStatus: state.status,
      reviewRequiredReason: state.reviewRequiredReason,
      changedSinceReview: state.changedSinceReview,
      currentReviewRevision: state.currentRevision,
      reviewRevisionNumber: state.revisionNumber,
      supersededReviewRevisions: state.supersededRevisions,
      reviewHistory: state.history,
      reviewedValue: state.currentRevision?.reviewedValue ?? null,
      // Independent of review status, always, for every item.
      authorityImpact: 'NONE',
      boundaries: READ_MODEL_BOUNDARIES,
    })
  })

  const presentKeys = new Set(tenantItems.map((item) => item.reviewKey))
  const orphaned = [...byKey.keys()]
    .filter((reviewKey) => !presentKeys.has(reviewKey))
    .sort()
    .map((reviewKey) => orphanItem({
      tenantId, reviewKey, revisions: byKey.get(reviewKey), generatedAt: at, asOfDate: asOfDate ?? null,
    }))

  return freeze({
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_STATE_V0',
    tenantId,
    generatedAt: at,
    asOfDate: asOfDate ?? null,
    items: freeze([...resolved, ...orphaned].sort((a, b) => a.reviewKey.localeCompare(b.reviewKey))),
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

// ── read models ───────────────────────────────────────────────────────────────

function requireState(state, tenantId) {
  if (state?.kind !== 'COMPANY_BRAIN_FOUNDER_REVIEW_STATE_V0') throw new Error('founder review state required')
  if (state.tenantId !== tenantId) throw new Error('founder review state tenant mismatch')
  return state
}

export function listFounderReviewItems({ actor, tenantId, state, category = null, itemType = null } = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  return freeze(state.items.filter((item) =>
    (category == null || item.category === category) &&
    (itemType == null || item.itemType === itemType),
  ))
}

export function getFounderReviewItem({ actor, tenantId, state, reviewKey } = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  return state.items.find((item) => item.reviewKey === text(reviewKey, 'reviewKey')) || null
}

/** Current, founder-confirmed company understanding. Approved or corrected only. */
export function getCurrentCompanyUnderstanding({ actor, tenantId, state } = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  const understandingTypes = new Set([
    REVIEW_ITEM_TYPE.UNDERSTANDING, REVIEW_ITEM_TYPE.POLICY_OR_RULE,
    REVIEW_ITEM_TYPE.ROLE_OR_RESPONSIBILITY, REVIEW_ITEM_TYPE.DELEGATION,
  ])
  return freeze({
    kind: 'COMPANY_BRAIN_CURRENT_UNDERSTANDING_V0',
    tenantId,
    generatedAt: state.generatedAt,
    confirmed: freeze(state.items.filter((item) =>
      understandingTypes.has(item.itemType) && RESOLVING_STATUSES.has(item.reviewStatus),
    ).map((item) => freeze({
      reviewKey: item.reviewKey,
      itemType: item.itemType,
      subject: item.subject,
      scope: item.scope,
      clientId: item.clientId,
      status: item.reviewStatus,
      // A correction is the founder's value; an approval keeps DW's proposal.
      currentValue: item.reviewStatus === REVIEW_STATUS.EDITED
        ? structuredClone(item.reviewedValue)
        : structuredClone(item.proposedValue),
      founderCorrected: item.reviewStatus === REVIEW_STATUS.EDITED,
      evidence: item.evidence,
      reviewedAt: item.currentReviewRevision?.decidedAt ?? null,
    }))),
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

export function getPendingFounderDecisions({ actor, tenantId, state } = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  const pending = state.items.filter((item) =>
    item.reviewStatus === REVIEW_STATUS.PENDING || item.reviewStatus === REVIEW_STATUS.REVIEW_REQUIRED,
  )
  return freeze({
    kind: 'COMPANY_BRAIN_PENDING_FOUNDER_DECISIONS_V0',
    tenantId,
    generatedAt: state.generatedAt,
    count: pending.length,
    items: freeze(pending),
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

export function getChangedSinceReview({ actor, tenantId, state } = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  const changed = state.items.filter((item) => item.changedSinceReview || item.supportingSourceRevoked)
  return freeze({
    kind: 'COMPANY_BRAIN_CHANGED_SINCE_REVIEW_V0',
    tenantId,
    generatedAt: state.generatedAt,
    count: changed.length,
    items: freeze(changed.map((item) => freeze({
      reviewKey: item.reviewKey,
      subject: item.subject,
      category: item.category,
      itemType: item.itemType,
      reason: item.reviewRequiredReason,
      supportingSourceRevoked: item.supportingSourceRevoked,
      evidence: item.evidence,
      reviewedAt: item.currentReviewRevision?.decidedAt ?? null,
      // Authority freshness stays governed by the G5 dependency semantics.
      authorityImpact: 'GOVERNED_BY_G5_MATERIAL_DEPENDENCIES',
    }))),
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

/**
 * Founder-facing view of G5 authority. It is a projection of the G5 read model
 * and adds no capability of its own.
 */
export function getAuthorityReviewState({ actor, tenantId, authorityReadModel } = {}) {
  assertActor(actor, tenantId)
  if (authorityReadModel?.kind !== 'DW_AUTHORITY_READ_MODEL_V0') throw new Error('G5 authority read model required')
  if (authorityReadModel.tenantId !== tenantId) throw new Error('authority read model tenant mismatch')
  return freeze({
    kind: 'COMPANY_BRAIN_AUTHORITY_REVIEW_STATE_V0',
    tenantId,
    evaluatedAt: authorityReadModel.evaluatedAt,
    currentAuthorityGrants: authorityReadModel.currentAuthorityGrants,
    proposedAuthority: authorityReadModel.proposedAuthority,
    revokedAuthority: authorityReadModel.revokedAuthority,
    staleAuthority: authorityReadModel.staleAuthority,
    supersededAuthority: authorityReadModel.supersededAuthority,
    invalidatedAuthority: authorityReadModel.invalidatedAuthority,
    activeGrantCount: authorityReadModel.currentAuthorityGrants.length,
    proposalCount: authorityReadModel.proposedAuthority.length,
    // Zero standing authority is a legitimate, complete configuration.
    noStandingAuthorityConfigured: authorityReadModel.currentAuthorityGrants.length === 0,
    grantPath: REVIEW_RESOLUTION_PATH.G5_EXPLICIT_AUTHORITY_GRANT,
    revocationPath: REVIEW_RESOLUTION_PATH.G5_EXPLICIT_AUTHORITY_REVOCATION,
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

export function getFounderReviewSummary({ actor, tenantId, state, authorityReadModel = null } = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  const counted = state.items
  const byStatus = (status) => counted.filter((item) => item.reviewStatus === status).length
  const conflicts = counted.filter((item) => item.itemType === REVIEW_ITEM_TYPE.CONFLICT)
  const understanding = counted.filter((item) => item.category === REVIEW_CATEGORY.COMPANY_UNDERSTANDING)
  const reviewable = counted.filter((item) => item.reviewableActions.length > 0)
  const reviewed = reviewable.filter((item) => RESOLVING_STATUSES.has(item.reviewStatus))
  return freeze({
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_SUMMARY_V0',
    tenantId,
    generatedAt: state.generatedAt,
    totalItems: counted.length,
    understandingItems: understanding.length,
    understandingReviewed: understanding.filter((item) => RESOLVING_STATUSES.has(item.reviewStatus)).length,
    needsReview: byStatus(REVIEW_STATUS.PENDING) + byStatus(REVIEW_STATUS.REVIEW_REQUIRED),
    approved: byStatus(REVIEW_STATUS.APPROVED),
    edited: byStatus(REVIEW_STATUS.EDITED),
    rejected: byStatus(REVIEW_STATUS.REJECTED),
    held: byStatus(REVIEW_STATUS.HELD),
    deferred: byStatus(REVIEW_STATUS.DEFERRED),
    conflictsTotal: conflicts.length,
    conflictsUnresolved: conflicts.filter((item) => item.conflictStatus === 'CONFLICTED').length,
    changedSinceReview: counted.filter((item) => item.changedSinceReview).length,
    authorityProposals: authorityReadModel ? authorityReadModel.proposedAuthority.length : 0,
    activeAuthorityGrants: authorityReadModel ? authorityReadModel.currentAuthorityGrants.length : 0,
    revokedAuthorityGrants: authorityReadModel ? authorityReadModel.revokedAuthority.length : 0,
    // Grounded in real reviewable items; never a decorative percentage.
    reviewableItems: reviewable.length,
    reviewedItems: reviewed.length,
    reviewedFraction: reviewable.length === 0
      ? null
      : freeze({ reviewed: reviewed.length, of: reviewable.length }),
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

/**
 * Honest bootstrap readiness. Reviewing the Company Brain never requires the
 * founder to grant DW any authority, and clicking through screens never
 * completes anything on its own.
 */
export function getBootstrapReadiness({ actor, tenantId, state, authorityReadModel = null } = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  const summary = getFounderReviewSummary({ actor, tenantId, state, authorityReadModel })
  const understandingComplete = summary.reviewableItems > 0 && summary.needsReview === 0
  return freeze({
    kind: 'COMPANY_BRAIN_BOOTSTRAP_READINESS_V0',
    tenantId,
    generatedAt: state.generatedAt,
    hasCompanyBrainMaterial: summary.totalItems > 0,
    understandingReviewed: understandingComplete,
    itemsAwaitingReview: summary.needsReview,
    conflictsRemaining: summary.conflictsUnresolved,
    sourcesChangedSinceReview: summary.changedSinceReview,
    authorityConfigured: summary.activeAuthorityGrants > 0,
    authorityProposalsAwaitingDecision: summary.authorityProposals,
    // These two are reported separately and are never combined into one claim.
    companyBrainReviewComplete: understandingComplete && summary.conflictsUnresolved === 0,
    dwStandingAuthorityConfigured: summary.activeAuthorityGrants > 0,
    zeroAuthorityIsValidCompletion: true,
    autopilotReady: false,
    autopilotReadinessReason: 'G6 reviews and controls the Company Brain; it never declares execution readiness.',
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

/** Single deeply-frozen model for the founder-review surface. */
export function buildFounderReviewReadModel({
  actor, tenantId, state, authorityReadModel = null, store = null, consumer = 'GENERIC',
} = {}) {
  assertActor(actor, tenantId)
  requireState(state, tenantId)
  return freeze({
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0',
    consumer,
    tenantId,
    generatedAt: state.generatedAt,
    asOfDate: state.asOfDate,
    summary: getFounderReviewSummary({ actor, tenantId, state, authorityReadModel }),
    items: state.items,
    pendingDecisions: getPendingFounderDecisions({ actor, tenantId, state }),
    currentUnderstanding: getCurrentCompanyUnderstanding({ actor, tenantId, state }),
    changedSinceReview: getChangedSinceReview({ actor, tenantId, state }),
    authority: authorityReadModel
      ? getAuthorityReviewState({ actor, tenantId, authorityReadModel })
      : null,
    readiness: getBootstrapReadiness({ actor, tenantId, state, authorityReadModel }),
    history: store ? store.readHistory({ actor, tenantId }) : null,
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

/**
 * Read-only seam a later gate may consume. It exposes exactly the frozen G6
 * read model and no mutation, evaluation or answering capability of any kind.
 */
export function toFounderReviewReadContext(input = {}) {
  const model = buildFounderReviewReadModel({ ...input, consumer: 'READ_ONLY_SEAM' })
  return freeze({
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_CONTEXT_V0',
    model,
    boundaries: READ_MODEL_BOUNDARIES,
  })
}

export const FOUNDER_REVIEW_INTERNALS = Object.freeze({
  RESOLVING_STATUSES: Object.freeze([...RESOLVING_STATUSES]),
  UNRESOLVED_STATUSES: Object.freeze([...UNRESOLVED_STATUSES]),
  AUTHORITY_MUTATION_FIELDS,
})
