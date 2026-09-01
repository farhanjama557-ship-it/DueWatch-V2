/**
 * M2G-G7 deterministic daily priorities.
 *
 * "What should I do today?" must not be answered by a language model deciding
 * what matters. This module composes projections that already exist -- the
 * canonical needs-you read model from phase2bReadModel, the G6 founder-review
 * read model, and the G5 authority projection -- into one ordered, inspectable
 * list. It adds no new judgement about money and no new permission.
 *
 * Every entry carries the exact reason it ranked where it did, so a founder can
 * ask "why is Atlas first?" and get a real answer rather than a restatement.
 */

const PRIORITIES_VERSION = 'ASK_DW_DAILY_PRIORITIES_V0'

/**
 * Ordered highest to lowest. The ordering is a fixed, reviewable policy, not a
 * score a model can talk its way around.
 */
export const ASK_DW_PRIORITY_REASON = Object.freeze({
  FOUNDER_DECISION_REQUIRED: 'FOUNDER_DECISION_REQUIRED',
  UNRESOLVED_CONFLICT: 'UNRESOLVED_CONFLICT',
  SUPPORTING_SOURCE_REVOKED: 'SUPPORTING_SOURCE_REVOKED',
  CHANGED_SINCE_REVIEW: 'CHANGED_SINCE_REVIEW',
  BLOCKED_ON_MISSING_AUTHORITY: 'BLOCKED_ON_MISSING_AUTHORITY',
  NEEDS_FOUNDER_ANSWER: 'NEEDS_FOUNDER_ANSWER',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
})

const REASON_RANK = Object.freeze({
  [ASK_DW_PRIORITY_REASON.FOUNDER_DECISION_REQUIRED]: 0,
  [ASK_DW_PRIORITY_REASON.UNRESOLVED_CONFLICT]: 1,
  [ASK_DW_PRIORITY_REASON.SUPPORTING_SOURCE_REVOKED]: 2,
  [ASK_DW_PRIORITY_REASON.CHANGED_SINCE_REVIEW]: 3,
  [ASK_DW_PRIORITY_REASON.BLOCKED_ON_MISSING_AUTHORITY]: 4,
  [ASK_DW_PRIORITY_REASON.NEEDS_FOUNDER_ANSWER]: 5,
  [ASK_DW_PRIORITY_REASON.AWAITING_REVIEW]: 6,
})

const REASON_EXPLANATION = Object.freeze({
  [ASK_DW_PRIORITY_REASON.FOUNDER_DECISION_REQUIRED]: 'DW is holding this until you decide.',
  [ASK_DW_PRIORITY_REASON.UNRESOLVED_CONFLICT]: 'Evidence disagrees and no rule says which governs.',
  [ASK_DW_PRIORITY_REASON.SUPPORTING_SOURCE_REVOKED]: 'A source behind something you approved was revoked.',
  [ASK_DW_PRIORITY_REASON.CHANGED_SINCE_REVIEW]: 'This changed after you reviewed it.',
  [ASK_DW_PRIORITY_REASON.BLOCKED_ON_MISSING_AUTHORITY]: 'DW cannot act here without an explicit grant.',
  [ASK_DW_PRIORITY_REASON.NEEDS_FOUNDER_ANSWER]: 'DW needs an answer from you to continue.',
  [ASK_DW_PRIORITY_REASON.AWAITING_REVIEW]: 'Waiting for your review.',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function entry({ source, reason, subject, clientId = null, invoiceId = null, detail = null, refs = [] }) {
  return {
    source,
    reason,
    reasonRank: REASON_RANK[reason],
    // The founder-facing sentence for this reason, kept deterministic.
    why: REASON_EXPLANATION[reason],
    subject,
    clientId,
    invoiceId,
    detail,
    refs: [...refs],
    // Ranking is a reading of existing state; it authorises nothing.
    authorityImpact: 'NONE',
    directlyExecutable: false,
  }
}

/**
 * Builds the ordered priority list.
 *
 * @param {object} input.needsYouReadModel  canonical projectNeedsYouReadModel output
 * @param {object} input.companyBrainContext read-only G7 Company Brain context
 * @param {string} input.tenantId
 */
export function buildAskDwDailyPriorities({
  tenantId, needsYouReadModel = null, companyBrainContext = null, limit = 5,
} = {}) {
  const tenant = String(tenantId || '').trim()
  if (!tenant) throw new Error('Ask DW daily priorities tenantId required')

  const entries = []
  const degraded = []

  // Canonical AR cases that already need the founder. This projection is the
  // existing owner of that judgement; G7 does not second-guess it.
  if (needsYouReadModel) {
    for (const item of safeArray(needsYouReadModel.items)) {
      entries.push(entry({
        source: 'DW_INTELLIGENCE',
        reason: item.state === 'APPROVAL'
          ? ASK_DW_PRIORITY_REASON.FOUNDER_DECISION_REQUIRED
          : ASK_DW_PRIORITY_REASON.NEEDS_FOUNDER_ANSWER,
        subject: item.clientId || item.invoiceId || 'AR case',
        clientId: item.clientId ?? null,
        invoiceId: item.invoiceId ?? null,
        detail: item.why ?? null,
        refs: [item.runId].filter(Boolean),
      }))
    }
  } else {
    // Say what is missing rather than implying the queue is empty.
    degraded.push('DW_INTELLIGENCE_NEEDS_YOU_UNAVAILABLE')
  }

  if (companyBrainContext?.available) {
    for (const conflict of companyBrainContext.conflicts) {
      if (conflict.conflictStatus !== 'CONFLICTED') continue
      entries.push(entry({
        source: 'COMPANY_BRAIN',
        reason: ASK_DW_PRIORITY_REASON.UNRESOLVED_CONFLICT,
        subject: conflict.subject,
        clientId: conflict.clientId ?? null,
        detail: conflict.why ?? null,
        refs: [conflict.reviewKey],
      }))
    }
    for (const item of companyBrainContext.changedSinceReview) {
      entries.push(entry({
        source: 'COMPANY_BRAIN',
        reason: item.supportingSourceRevoked
          ? ASK_DW_PRIORITY_REASON.SUPPORTING_SOURCE_REVOKED
          : ASK_DW_PRIORITY_REASON.CHANGED_SINCE_REVIEW,
        subject: item.subject,
        clientId: item.clientId ?? null,
        detail: item.why ?? null,
        refs: [item.reviewKey],
      }))
    }
    for (const item of companyBrainContext.pendingFounderDecisions) {
      if (item.itemType === 'CONFLICT') continue
      if (item.changedSinceReview || item.supportingSourceRevoked) continue
      entries.push(entry({
        source: 'COMPANY_BRAIN',
        reason: ASK_DW_PRIORITY_REASON.AWAITING_REVIEW,
        subject: item.subject,
        clientId: item.clientId ?? null,
        detail: item.why ?? null,
        refs: [item.reviewKey],
      }))
    }
  } else if (companyBrainContext) {
    degraded.push('COMPANY_BRAIN_UNAVAILABLE')
  }

  const ordered = entries
    .sort((a, b) =>
      a.reasonRank - b.reasonRank ||
      String(a.subject).localeCompare(String(b.subject)) ||
      String(a.refs[0] ?? '').localeCompare(String(b.refs[0] ?? '')))

  return freeze({
    schemaVersion: PRIORITIES_VERSION,
    tenantId: tenant,
    // Degraded reads are surfaced, never smoothed over: "nothing needs you" is
    // only sayable when everything that decides that was actually readable.
    complete: degraded.length === 0,
    degradedInputs: degraded,
    total: ordered.length,
    items: ordered.slice(0, limit),
    remaining: Math.max(0, ordered.length - limit),
    boundaries: freeze({
      derivedFromExistingProjections: true,
      modelChoseOrder: false,
      canGrantAuthority: false,
      canExecute: false,
      canonicalMoneyWritable: false,
    }),
  })
}

/** Whether DW may honestly say nothing needs the founder right now. */
export function askDwCanSayNothingNeedsYou(priorities) {
  return priorities?.complete === true && priorities.total === 0
}
