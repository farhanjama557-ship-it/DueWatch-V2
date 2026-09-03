/**
 * G8-CP2 — the shared deterministic attention primitive.
 *
 * Ask DW asks "what should I look at today?"; DW Intelligence asks "what
 * deserves the founder's attention now?". Those are the same question from two
 * directions, and answering them from two implementations is how the lanes
 * drift. This module owns the answer once.
 *
 * It is deliberately not a ranker. There is no score, no model, no learned
 * weight and no confidence: an entry is present because a deterministic
 * condition is positively supported, and it ranks where its REASON ranks. The
 * ordering is a fixed, reviewable policy, and every entry carries the exact
 * reason and the refs behind it, so a founder can audit the queue rather than
 * trust it.
 *
 * What it may never do:
 *   - invent urgency from model confidence, tone, "important customer"
 *     language, conversational pressure, provider capability or repetition;
 *   - decide anything about permission — G5 owns that, and an entry saying DW
 *     is blocked on a missing grant is a statement about the ABSENCE of one;
 *   - move canonical money, or resolve a conflict it reports.
 */

/** Ordered highest to lowest. Founder judgement always outranks collection work. */
export const DW_ATTENTION_REASON = Object.freeze({
  FOUNDER_DECISION_REQUIRED: 'FOUNDER_DECISION_REQUIRED',
  UNRESOLVED_CONFLICT: 'UNRESOLVED_CONFLICT',
  SUPPORTING_SOURCE_REVOKED: 'SUPPORTING_SOURCE_REVOKED',
  CHANGED_SINCE_REVIEW: 'CHANGED_SINCE_REVIEW',
  BLOCKED_ON_MISSING_AUTHORITY: 'BLOCKED_ON_MISSING_AUTHORITY',
  NEEDS_FOUNDER_ANSWER: 'NEEDS_FOUNDER_ANSWER',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
})

const REASON_RANK = Object.freeze({
  [DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED]: 0,
  [DW_ATTENTION_REASON.UNRESOLVED_CONFLICT]: 1,
  [DW_ATTENTION_REASON.SUPPORTING_SOURCE_REVOKED]: 2,
  [DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW]: 3,
  [DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY]: 4,
  [DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER]: 5,
  [DW_ATTENTION_REASON.AWAITING_REVIEW]: 6,
})

const REASON_EXPLANATION = Object.freeze({
  [DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED]: 'DW is holding this until you decide.',
  [DW_ATTENTION_REASON.UNRESOLVED_CONFLICT]: 'Evidence disagrees and no rule says which governs.',
  [DW_ATTENTION_REASON.SUPPORTING_SOURCE_REVOKED]: 'A source behind something you approved was revoked.',
  [DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW]: 'This changed after you reviewed it.',
  [DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY]: 'DW cannot act here without an explicit grant.',
  [DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER]: 'DW needs an answer from you to continue.',
  [DW_ATTENTION_REASON.AWAITING_REVIEW]: 'Waiting for your review.',
})

/** What is standing between DW and progress. Never a permission verdict. */
export const DW_ATTENTION_BLOCKER = Object.freeze({
  FOUNDER_DECISION: 'FOUNDER_DECISION',
  FOUNDER_ANSWER: 'FOUNDER_ANSWER',
  MISSING_AUTHORITY: 'MISSING_AUTHORITY',
  UNRESOLVED_CONFLICT: 'UNRESOLVED_CONFLICT',
  FOUNDER_REVIEW: 'FOUNDER_REVIEW',
})

const REASON_BLOCKER = Object.freeze({
  [DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED]: DW_ATTENTION_BLOCKER.FOUNDER_DECISION,
  [DW_ATTENTION_REASON.UNRESOLVED_CONFLICT]: DW_ATTENTION_BLOCKER.UNRESOLVED_CONFLICT,
  [DW_ATTENTION_REASON.SUPPORTING_SOURCE_REVOKED]: DW_ATTENTION_BLOCKER.FOUNDER_REVIEW,
  [DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW]: DW_ATTENTION_BLOCKER.FOUNDER_REVIEW,
  [DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY]: DW_ATTENTION_BLOCKER.MISSING_AUTHORITY,
  [DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER]: DW_ATTENTION_BLOCKER.FOUNDER_ANSWER,
  [DW_ATTENTION_REASON.AWAITING_REVIEW]: DW_ATTENTION_BLOCKER.FOUNDER_REVIEW,
})

export const DW_ATTENTION_VERSION = 'DW_ATTENTION_V0'

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Reads whether a case is held up by the ABSENCE of authority. This is not an
 * authority evaluation: the case's own authority summary already carries G5's
 * answer, and all that happens here is noticing it said no.
 */
function blockedOnMissingAuthority(item) {
  const authority = item?.authority
  if (!authority) return false
  if (authority.canActAutomatically === true) return false
  return authority.policyAuthorized === false ||
    authority.actual === 'NOT_GRANTED' ||
    authority.actual === 'REVOKED' ||
    authority.actual === 'EXPIRED'
}

function entry({
  source, reason, subject, clientId = null, invoiceId = null,
  detail = null, refs = [], needsFounder = true,
}) {
  return {
    source,
    reason,
    reasonRank: REASON_RANK[reason],
    why: REASON_EXPLANATION[reason],
    subject,
    clientId,
    invoiceId,
    detail,
    supportingRefs: [...refs].filter(Boolean),
    needsFounder,
    blockedBy: REASON_BLOCKER[reason] ?? null,
    // Ranking is a reading of existing state; it authorises nothing.
    authorityImpact: 'NONE',
    directlyExecutable: false,
  }
}

/**
 * The identity a demand on founder attention actually has. An event burst or a
 * replayed proof produces several rows about ONE invoice, and three rows do not
 * mean three decisions — they mean one decision observed three times.
 */
function attentionIdentity(item) {
  return [item.reason, item.clientId ?? '', item.invoiceId ?? '', item.subject ?? ''].join('|')
}

/**
 * Builds the ordered attention list from already-projected state.
 *
 * @param {object} input.needsYouReadModel   projectNeedsYouReadModel output
 * @param {object} input.companyBrainContext read-only Company Brain context
 * @param {object} input.governance          CP1 governance envelope (references only)
 */
export function buildDwAttention({
  tenantId, needsYouReadModel = null, companyBrainContext = null,
  governance = null, limit = 5,
} = {}) {
  const tenant = String(tenantId || '').trim()
  if (!tenant) throw new Error('DW attention tenantId required')

  const entries = []
  const degraded = []

  // Canonical AR cases that already need the founder. That projection owns the
  // judgement; this module does not second-guess it, only reads its reasons.
  if (needsYouReadModel) {
    for (const item of safeArray(needsYouReadModel.items)) {
      const reason = blockedOnMissingAuthority(item)
        ? DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY
        : item.state === 'APPROVAL'
          ? DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED
          : DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER
      entries.push(entry({
        source: 'DW_INTELLIGENCE',
        reason,
        subject: item.clientId || item.invoiceId || 'AR case',
        clientId: item.clientId ?? null,
        invoiceId: item.invoiceId ?? null,
        detail: item.why ?? null,
        refs: [item.runId],
      }))
    }
  } else {
    // Say what is missing rather than implying the queue is empty.
    degraded.push('DW_INTELLIGENCE_NEEDS_YOU_UNAVAILABLE')
  }

  if (companyBrainContext?.available) {
    for (const conflict of safeArray(companyBrainContext.conflicts)) {
      if (conflict.conflictStatus !== 'CONFLICTED') continue
      entries.push(entry({
        source: 'COMPANY_BRAIN',
        reason: DW_ATTENTION_REASON.UNRESOLVED_CONFLICT,
        subject: conflict.subject,
        clientId: conflict.clientId ?? null,
        detail: conflict.why ?? null,
        refs: [conflict.reviewKey],
      }))
    }
    for (const item of safeArray(companyBrainContext.changedSinceReview)) {
      entries.push(entry({
        source: 'COMPANY_BRAIN',
        reason: item.supportingSourceRevoked
          ? DW_ATTENTION_REASON.SUPPORTING_SOURCE_REVOKED
          : DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW,
        subject: item.subject,
        clientId: item.clientId ?? null,
        detail: item.why ?? null,
        refs: [item.reviewKey],
      }))
    }
    for (const item of safeArray(companyBrainContext.pendingFounderDecisions)) {
      if (item.itemType === 'CONFLICT') continue
      if (item.changedSinceReview || item.supportingSourceRevoked) continue
      entries.push(entry({
        source: 'COMPANY_BRAIN',
        reason: DW_ATTENTION_REASON.AWAITING_REVIEW,
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
      String(a.supportingRefs[0] ?? '').localeCompare(String(b.supportingRefs[0] ?? '')))

  // Collapse repeated observations of one demand, keeping every ref so nothing
  // is hidden — the founder is asked once, and can still see all the proof.
  const byIdentity = new Map()
  let duplicatesSuppressed = 0
  for (const item of ordered) {
    const identity = attentionIdentity(item)
    const existing = byIdentity.get(identity)
    if (!existing) {
      byIdentity.set(identity, { ...item, supportingRefs: [...item.supportingRefs] })
      continue
    }
    duplicatesSuppressed += 1
    for (const ref of item.supportingRefs) {
      if (!existing.supportingRefs.includes(ref)) existing.supportingRefs.push(ref)
    }
  }
  const deduped = [...byIdentity.values()]

  return freeze({
    schemaVersion: DW_ATTENTION_VERSION,
    tenantId: tenant,
    // Degraded reads are surfaced, never smoothed over: "nothing needs you" is
    // only sayable when everything that decides that was actually readable.
    complete: degraded.length === 0,
    degradedInputs: degraded,
    total: deduped.length,
    duplicatesSuppressed,
    items: deduped.slice(0, limit),
    remaining: Math.max(0, deduped.length - limit),
    // Reference only, carried so a reader can see which governance state this
    // queue was read against. It confers nothing.
    governanceRef: governance
      ? { fingerprint: governance.authority?.fingerprint ?? null, evaluatedAt: governance.authority?.evaluatedAt ?? null }
      : null,
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
export function dwCanSayNothingNeedsAttention(attention) {
  return Boolean(attention && attention.complete === true && attention.total === 0)
}
