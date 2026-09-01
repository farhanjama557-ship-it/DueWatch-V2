/**
 * M2G-G6 founder-review presentation adapter.
 *
 * Pure and deterministic: it shapes the frozen G6 read model for the review
 * surface and nothing else. It performs no I/O, decides no facts, and — like
 * every other G6 module — cannot grant, revoke or evaluate DW authority, and
 * cannot execute accounts-receivable work.
 *
 * Understanding and authority are presented as two separate decisions, with
 * two separate controls, in two separate sections. That separation is the
 * point of the surface, so it is expressed structurally here rather than left
 * to a component's layout.
 */

import {
  REVIEW_ACTION,
  REVIEW_CATEGORY,
  REVIEW_ITEM_TYPE,
  REVIEW_STATUS,
  REVIEW_REQUIRED_REASON,
} from './founderReview.js'

export const REVIEW_TAB = Object.freeze({
  OVERVIEW: 'OVERVIEW',
  UNDERSTANDING: 'UNDERSTANDING',
  CONFLICTS: 'CONFLICTS',
  OPERATING_MODEL: 'OPERATING_MODEL',
  ROLES: 'ROLES',
  AUTHORITY: 'AUTHORITY',
  HISTORY: 'HISTORY',
})

export const REVIEW_SURFACE_STATE = Object.freeze({
  LOADING: 'LOADING',
  ERROR: 'ERROR',
  EMPTY: 'EMPTY',
  READY: 'READY',
})

/**
 * Button labels say exactly what the button does. "Approve understanding" and
 * "Grant authority" are never the same control, never bundled, and never
 * pre-selected.
 */
export const REVIEW_ACTION_LABEL = Object.freeze({
  [REVIEW_ACTION.APPROVE]: 'Approve understanding',
  [REVIEW_ACTION.EDIT]: 'Edit understanding',
  [REVIEW_ACTION.REJECT]: 'Reject understanding',
  [REVIEW_ACTION.HOLD]: 'Hold',
  [REVIEW_ACTION.DEFER]: 'Decide later',
})

export const AUTHORITY_ACTION_LABEL = Object.freeze({
  GRANT: 'Grant authority',
  EDIT_PROPOSAL: 'Edit proposal',
  REJECT_PROPOSAL: 'Reject proposal',
  HOLD_PROPOSAL: 'Hold proposal',
  REVOKE: 'Revoke authority',
})

/** Status is never communicated by colour alone: each carries its own words. */
export const REVIEW_STATUS_LABEL = Object.freeze({
  [REVIEW_STATUS.PENDING]: 'Needs your review',
  [REVIEW_STATUS.APPROVED]: 'Approved by you',
  [REVIEW_STATUS.EDITED]: 'Corrected by you',
  [REVIEW_STATUS.REJECTED]: 'Rejected by you',
  [REVIEW_STATUS.HELD]: 'On hold',
  [REVIEW_STATUS.DEFERRED]: 'Deferred',
  [REVIEW_STATUS.SUPERSEDED]: 'Superseded',
  [REVIEW_STATUS.STALE]: 'Stale',
  [REVIEW_STATUS.REVIEW_REQUIRED]: 'Needs review again',
})

export const REVIEW_REQUIRED_LABEL = Object.freeze({
  [REVIEW_REQUIRED_REASON.NEVER_REVIEWED]: 'You have not reviewed this yet.',
  [REVIEW_REQUIRED_REASON.SUBJECT_CHANGED_SINCE_REVIEW]: 'The supporting evidence changed after your review.',
  [REVIEW_REQUIRED_REASON.SUPPORTING_SOURCE_REVOKED]: 'A source supporting this was revoked.',
  [REVIEW_REQUIRED_REASON.REVIEWED_SUBJECT_NO_LONGER_PRESENT]: 'What you reviewed no longer has current supporting evidence.',
  [REVIEW_REQUIRED_REASON.CONFLICT_UNRESOLVED]: 'Evidence conflicts and no safe current instruction exists.',
})

const TAB_CATEGORY = Object.freeze({
  [REVIEW_TAB.UNDERSTANDING]: REVIEW_CATEGORY.COMPANY_UNDERSTANDING,
  [REVIEW_TAB.CONFLICTS]: REVIEW_CATEGORY.CONFLICTS,
  [REVIEW_TAB.OPERATING_MODEL]: REVIEW_CATEGORY.OPERATING_MODEL,
  [REVIEW_TAB.ROLES]: REVIEW_CATEGORY.ROLES,
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function titleCase(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b[a-z]/g, (character) => character.toUpperCase())
}

/** Human-readable, evidence-derived label. It invents no facts. */
export function describeReviewSubject(item) {
  if (!item) return 'Review item'
  const topic = titleCase(item.subject || item.itemType)
  if (item.clientId) return `${topic} — ${item.clientId}`
  if (item.roleId) return `${topic} — ${item.roleId}`
  return topic
}

export function describeScope(scope) {
  if (!scope) return 'Company-wide'
  if (scope.level === 'CLIENT' && scope.clientId) return `Client: ${scope.clientId}`
  if (scope.level === 'ROLE' && scope.roleId) return `Role: ${scope.roleId}`
  if (scope.level === 'COMPANY') return 'Company-wide'
  return titleCase(scope.level || 'Company')
}

/** Renders a structured value for display without pretending it is prose. */
export function describeValue(value) {
  if (value == null) return 'No safe current value'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(describeValue).join(', ')
  return Object.entries(value)
    .filter(([, entry]) => entry != null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${titleCase(key)}: ${describeValue(entry)}`)
    .join(' · ')
}

export function describeEvidence(entry) {
  if (!entry) return null
  const state = entry.tombstoned
    ? 'Revoked (tombstoned)'
    : !entry.present
      ? 'No longer present'
      : entry.active ? 'Current' : 'Revoked'
  return freeze({
    sourceVersionId: entry.sourceVersionId,
    sourceType: entry.sourceType,
    trustZone: entry.trustZone,
    recordedAt: entry.sourceTimestamp,
    version: entry.sourceVersion,
    state,
    // Revoked material stays visible as history and is never shown as current.
    presentedAsCurrentEvidence: entry.active === true && !entry.tombstoned,
  })
}

/**
 * The exact G5 dimensions of a grant or proposal, each named, each shown, none
 * collapsed. A missing dimension reads as "not specified", never as "any".
 */
export function describeAuthorityDimensions(source = {}) {
  const configuration = source.proposedConfiguration || source
  const scope = source.scope || configuration.scope || null
  const limits = configuration.limits || source.limits || null
  const window = configuration.effectiveWindow || source.effectiveWindow || null
  const conditions = configuration.conditions || source.conditions || null
  const notSpecified = 'Not specified — no authority is implied'
  return freeze([
    { dimension: 'ACTION', label: 'Action', value: source.action ? titleCase(source.action) : notSpecified },
    { dimension: 'SCOPE', label: 'Scope', value: scope ? describeScope(scope) : notSpecified },
    { dimension: 'CLIENT', label: 'Client', value: scope?.clientId || (scope?.level === 'COMPANY' ? 'All clients in scope' : notSpecified) },
    {
      dimension: 'AMOUNT',
      label: 'Amount',
      value: limits?.maxAmountMinor == null
        ? 'Not applicable to this action'
        : `Up to ${limits.maxAmountMinor} (minor units)`,
    },
    { dimension: 'CURRENCY', label: 'Currency', value: limits?.currency || 'Not applicable to this action' },
    {
      dimension: 'CONDITION',
      label: 'Conditions',
      value: conditions && Object.keys(conditions).length ? describeValue(conditions) : notSpecified,
    },
    {
      dimension: 'TIME',
      label: 'Time',
      value: window?.effectiveFrom
        ? `From ${window.effectiveFrom}${window.expiresAt ? ` until ${window.expiresAt}` : ' — no expiry configured'}`
        : notSpecified,
    },
    { dimension: 'CHANNEL', label: 'Channel', value: configuration.channel || source.channel || 'Not applicable to this action' },
    {
      dimension: 'APPROVAL',
      label: 'Approval',
      value: (configuration.approvalRequirement || source.approvalRequirement) === 'FOUNDER'
        ? 'Every action needs your approval'
        : (configuration.approvalRequirement || source.approvalRequirement) === 'NONE'
          ? 'No per-action approval once granted'
          : notSpecified,
    },
  ])
}

function toCard(item) {
  return freeze({
    reviewKey: item.reviewKey,
    category: item.category,
    itemType: item.itemType,
    title: describeReviewSubject(item),
    scopeLabel: describeScope(item.scope),
    belief: describeValue(item.reviewStatus === REVIEW_STATUS.EDITED ? item.reviewedValue : item.proposedValue),
    why: item.why,
    statusLabel: REVIEW_STATUS_LABEL[item.reviewStatus] || item.reviewStatus,
    status: item.reviewStatus,
    reviewRequiredLabel: item.reviewRequiredReason
      ? REVIEW_REQUIRED_LABEL[item.reviewRequiredReason] || item.reviewRequiredReason
      : null,
    changedSinceReview: item.changedSinceReview === true,
    supportingSourceRevoked: item.supportingSourceRevoked === true,
    conflictStatus: item.conflictStatus,
    // Confidence is shown only when it exists, and never as a permission signal.
    confidence: item.confidence ?? null,
    confidenceGrantsAuthority: false,
    evidence: freeze((item.evidence || []).map(describeEvidence)),
    claims: item.claims,
    competingPositions: item.itemType === REVIEW_ITEM_TYPE.CONFLICT
      ? freeze((item.proposition?.competingPositions || []).map((position) => freeze({
        claimId: position.claimId,
        scopeLabel: describeScope(position.scope),
        value: describeValue(position.value),
      })))
      : freeze([]),
    currentResult: item.itemType === REVIEW_ITEM_TYPE.CONFLICT
      ? (item.proposition?.currentResult === 'FOUNDER_DECIDED'
        ? 'A recorded founder decision governs this.'
        : 'No safe current instruction.')
      : null,
    actions: freeze((item.reviewableActions || []).map((action) => freeze({
      action,
      label: REVIEW_ACTION_LABEL[action] || action,
      // Nothing about a review action touches authority.
      grantsAuthority: false,
      preselected: false,
    }))),
    expectedRevision: item.reviewRevisionNumber,
    subjectFingerprint: item.subjectFingerprint,
    reviewedAt: item.currentReviewRevision?.decidedAt ?? null,
    historyCount: (item.reviewHistory || []).length,
    // Shown on every card so the two decisions never blur together.
    authorityImpact: 'NONE',
    authorityNote: 'Reviewing this does not give DW permission to act.',
  })
}

function authorityPanel(authority) {
  if (!authority) {
    return freeze({
      available: false,
      activeGrantCount: 0,
      proposalCount: 0,
      noStandingAuthority: true,
      noStandingAuthorityLabel: 'No standing authority configured. This is a valid setup.',
      grants: freeze([]),
      proposals: freeze([]),
      revoked: freeze([]),
    })
  }
  return freeze({
    available: true,
    activeGrantCount: authority.activeGrantCount,
    proposalCount: authority.proposalCount,
    noStandingAuthority: authority.noStandingAuthorityConfigured === true,
    noStandingAuthorityLabel: 'No standing authority configured. This is a valid setup.',
    grants: freeze(authority.currentAuthorityGrants.map((grant) => freeze({
      grantId: grant.id,
      title: titleCase(grant.action),
      status: grant.status,
      statusLabel: titleCase(grant.status),
      grantedAt: grant.decidedAt,
      revision: grant.revision,
      dimensions: describeAuthorityDimensions(grant),
      revokeLabel: AUTHORITY_ACTION_LABEL.REVOKE,
      // Editing an active grant goes through G5 supersession, never in place.
      editPath: 'G5_SUPERSEDING_GRANT',
    }))),
    proposals: freeze(authority.proposedAuthority.map((proposal) => freeze({
      proposalId: proposal.id,
      title: titleCase(proposal.action),
      status: proposal.status,
      dimensions: describeAuthorityDimensions(proposal),
      inert: true,
      inertLabel: 'This is a proposal. DW has no permission from it.',
      grantLabel: AUTHORITY_ACTION_LABEL.GRANT,
      editLabel: AUTHORITY_ACTION_LABEL.EDIT_PROPOSAL,
      rejectLabel: AUTHORITY_ACTION_LABEL.REJECT_PROPOSAL,
      holdLabel: AUTHORITY_ACTION_LABEL.HOLD_PROPOSAL,
      grantPreselected: false,
      grantBundledWithApproval: false,
    }))),
    revoked: freeze(authority.revokedAuthority.map((entry) => freeze({
      grantId: entry.grant.id,
      title: titleCase(entry.grant.action),
      revokedAt: entry.grant.revokedAt,
      reason: entry.grant.revocationReason,
      statusLabel: 'Revoked — kept as history',
    }))),
  })
}

/**
 * Builds the whole founder-review surface view from the frozen G6 read model.
 * Loading, error and empty are explicit inputs, never inferred optimism.
 */
export function buildFounderReviewView({ readModel = null, loading = false, error = null } = {}) {
  if (loading) {
    return freeze({
      kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_VIEW_V0',
      surfaceState: REVIEW_SURFACE_STATE.LOADING,
      message: 'Loading what DW learned about your company…',
      tabs: freeze([]),
      sections: freeze({}),
      summary: null,
      authority: authorityPanel(null),
      readiness: null,
    })
  }
  if (error) {
    return freeze({
      kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_VIEW_V0',
      surfaceState: REVIEW_SURFACE_STATE.ERROR,
      // A failed read is never rendered as a completed review.
      message: typeof error === 'string' ? error : 'Company Brain review could not be loaded.',
      tabs: freeze([]),
      sections: freeze({}),
      summary: null,
      authority: authorityPanel(null),
      readiness: null,
    })
  }
  if (!readModel || readModel.kind !== 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0') {
    return freeze({
      kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_VIEW_V0',
      surfaceState: REVIEW_SURFACE_STATE.EMPTY,
      message: 'DW has not learned anything about your company yet.',
      tabs: freeze([]),
      sections: freeze({}),
      summary: null,
      authority: authorityPanel(null),
      readiness: null,
    })
  }

  const items = readModel.items || []
  const sections = {}
  for (const [tab, category] of Object.entries(TAB_CATEGORY)) {
    sections[tab] = freeze(items.filter((item) => item.category === category).map(toCard))
  }
  sections[REVIEW_TAB.AUTHORITY] = freeze(
    items
      .filter((item) => item.category === REVIEW_CATEGORY.AUTHORITY || item.category === REVIEW_CATEGORY.AUTHORITY_PROPOSALS)
      .map(toCard),
  )
  sections[REVIEW_TAB.HISTORY] = freeze((readModel.history?.revisions || []).map((revision) => freeze({
    revisionId: revision.id,
    reviewKey: revision.reviewKey,
    action: revision.action,
    actionLabel: REVIEW_ACTION_LABEL[revision.action] || revision.action,
    status: revision.status,
    statusLabel: REVIEW_STATUS_LABEL[revision.status] || revision.status,
    revision: revision.revision,
    decidedAt: revision.decidedAt,
    reason: revision.reason,
    supersedesRevisionId: revision.supersedesRevisionId,
    authorityImpact: 'NONE',
  })))
  sections[REVIEW_TAB.OVERVIEW] = freeze(items.filter((item) =>
    item.reviewStatus === REVIEW_STATUS.PENDING || item.reviewStatus === REVIEW_STATUS.REVIEW_REQUIRED,
  ).map(toCard))

  const summary = readModel.summary
  const readiness = readModel.readiness
  const surfaceState = items.length === 0 ? REVIEW_SURFACE_STATE.EMPTY : REVIEW_SURFACE_STATE.READY

  return freeze({
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_VIEW_V0',
    surfaceState,
    message: surfaceState === REVIEW_SURFACE_STATE.EMPTY
      ? 'DW has not learned anything about your company yet.'
      : null,
    generatedAt: readModel.generatedAt,
    tabs: freeze([
      { id: REVIEW_TAB.OVERVIEW, label: 'Overview', count: sections[REVIEW_TAB.OVERVIEW].length },
      { id: REVIEW_TAB.UNDERSTANDING, label: 'Understanding', count: sections[REVIEW_TAB.UNDERSTANDING].length },
      { id: REVIEW_TAB.CONFLICTS, label: 'Conflicts', count: sections[REVIEW_TAB.CONFLICTS].length },
      { id: REVIEW_TAB.OPERATING_MODEL, label: 'Operating model', count: sections[REVIEW_TAB.OPERATING_MODEL].length },
      { id: REVIEW_TAB.ROLES, label: 'Roles', count: sections[REVIEW_TAB.ROLES].length },
      { id: REVIEW_TAB.AUTHORITY, label: 'DW authority', count: sections[REVIEW_TAB.AUTHORITY].length },
      { id: REVIEW_TAB.HISTORY, label: 'Review history', count: sections[REVIEW_TAB.HISTORY].length },
    ]),
    sections: freeze(sections),
    summary: freeze({
      understandingReviewed: summary.understandingReviewed,
      needsReview: summary.needsReview,
      conflictsUnresolved: summary.conflictsUnresolved,
      authorityProposals: summary.authorityProposals,
      activeAuthorityGrants: summary.activeAuthorityGrants,
      changedSinceReview: summary.changedSinceReview,
      reviewedFraction: summary.reviewedFraction,
    }),
    changedSinceReview: readModel.changedSinceReview,
    authority: authorityPanel(readModel.authority),
    readiness: freeze({
      companyBrainReviewComplete: readiness.companyBrainReviewComplete,
      dwStandingAuthorityConfigured: readiness.dwStandingAuthorityConfigured,
      itemsAwaitingReview: readiness.itemsAwaitingReview,
      conflictsRemaining: readiness.conflictsRemaining,
      zeroAuthorityIsValidCompletion: true,
      autopilotReady: false,
      // The two statements are rendered separately; neither implies the other.
      understandingStatement: readiness.companyBrainReviewComplete
        ? 'Company understanding: reviewed'
        : `Company understanding: ${readiness.itemsAwaitingReview} item(s) still need you`,
      authorityStatement: readiness.dwStandingAuthorityConfigured
        ? 'DW standing authority: configured'
        : 'DW standing authority: 0 grants',
    }),
  })
}
