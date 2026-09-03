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

import { resolveAskDwAuthority } from './askDwAuthorityRenderer.js'

/** Ordered highest to lowest. Founder judgement always outranks collection work. */
export const DW_ATTENTION_REASON = Object.freeze({
  FOUNDER_DECISION_REQUIRED: 'FOUNDER_DECISION_REQUIRED',
  UNRESOLVED_CONFLICT: 'UNRESOLVED_CONFLICT',
  SUPPORTING_SOURCE_REVOKED: 'SUPPORTING_SOURCE_REVOKED',
  CHANGED_SINCE_REVIEW: 'CHANGED_SINCE_REVIEW',
  BLOCKED_ON_MISSING_AUTHORITY: 'BLOCKED_ON_MISSING_AUTHORITY',
  BLOCKED_ON_OPERATIONAL_POLICY: 'BLOCKED_ON_OPERATIONAL_POLICY',
  NEEDS_FOUNDER_ANSWER: 'NEEDS_FOUNDER_ANSWER',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
})

const REASON_RANK = Object.freeze({
  [DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED]: 0,
  [DW_ATTENTION_REASON.UNRESOLVED_CONFLICT]: 1,
  [DW_ATTENTION_REASON.SUPPORTING_SOURCE_REVOKED]: 2,
  [DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW]: 3,
  [DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY]: 4,
  [DW_ATTENTION_REASON.BLOCKED_ON_OPERATIONAL_POLICY]: 5,
  [DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER]: 6,
  [DW_ATTENTION_REASON.AWAITING_REVIEW]: 7,
})

const REASON_EXPLANATION = Object.freeze({
  [DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED]: 'DW is holding this until you decide.',
  [DW_ATTENTION_REASON.UNRESOLVED_CONFLICT]: 'Evidence disagrees and no rule says which governs.',
  [DW_ATTENTION_REASON.SUPPORTING_SOURCE_REVOKED]: 'A source behind something you approved was revoked.',
  [DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW]: 'This changed after you reviewed it.',
  [DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY]: 'DW cannot act here without an explicit grant.',
  [DW_ATTENTION_REASON.BLOCKED_ON_OPERATIONAL_POLICY]: "DW's operating rules do not clear this without you.",
  [DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER]: 'DW needs an answer from you to continue.',
  [DW_ATTENTION_REASON.AWAITING_REVIEW]: 'Waiting for your review.',
})

/** What is standing between DW and progress. Never a permission verdict. */
export const DW_ATTENTION_BLOCKER = Object.freeze({
  FOUNDER_DECISION: 'FOUNDER_DECISION',
  FOUNDER_ANSWER: 'FOUNDER_ANSWER',
  MISSING_AUTHORITY: 'MISSING_AUTHORITY',
  OPERATIONAL_POLICY: 'OPERATIONAL_POLICY',
  UNRESOLVED_CONFLICT: 'UNRESOLVED_CONFLICT',
  FOUNDER_REVIEW: 'FOUNDER_REVIEW',
})

const REASON_BLOCKER = Object.freeze({
  [DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED]: DW_ATTENTION_BLOCKER.FOUNDER_DECISION,
  [DW_ATTENTION_REASON.UNRESOLVED_CONFLICT]: DW_ATTENTION_BLOCKER.UNRESOLVED_CONFLICT,
  [DW_ATTENTION_REASON.SUPPORTING_SOURCE_REVOKED]: DW_ATTENTION_BLOCKER.FOUNDER_REVIEW,
  [DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW]: DW_ATTENTION_BLOCKER.FOUNDER_REVIEW,
  [DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY]: DW_ATTENTION_BLOCKER.MISSING_AUTHORITY,
  [DW_ATTENTION_REASON.BLOCKED_ON_OPERATIONAL_POLICY]: DW_ATTENTION_BLOCKER.OPERATIONAL_POLICY,
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

/** Reads a tenant label off any of the shapes the callers pass. */
function tenantOf(value) {
  if (!value || typeof value !== 'object') return null
  return value.tenantId ?? value.userId ?? null
}

/**
 * OPERATIONAL policy, which is not G5 authority.
 *
 * item.authority comes from the Phase 2B proof, which carries
 * evaluateNextActionAuthority's answer: whether DW's own operating RULES clear
 * this action right now. That is a different question from whether the founder
 * has granted DW standing authority under G5, and conflating them produces
 * false sentences in both directions — "DW has no explicit grant" when a grant
 * exists, and "DW is permitted" when only an operating rule matched.
 *
 * So this reads operational state only, and says so in its name.
 */
function blockedOnOperationalPolicy(item) {
  const authority = item?.authority
  if (!authority) return false
  if (authority.canActAutomatically === true) return false
  // Only an explicit policy DENIAL counts. `actual` cannot carry this weight:
  // phase2bReadModel's authoritySummary collapses it to GRANTED/NOT_GRANTED,
  // so an ordinary case merely awaiting approval also reads NOT_GRANTED there.
  // Treating that as an operational block masked FOUNDER_DECISION_REQUIRED on
  // every approval case — the highest-ranked reason there is.
  return authority.policyAuthorized === false
}

/**
 * Whether G5 itself says no. This is NOT a second evaluator: it hands a fully
 * typed request to the existing G5-owned resolver and reads the answer. A
 * request that cannot be built deterministically — no action, no scope, no
 * channel — yields null, and the queue then says nothing about grants at all
 * rather than reporting an absence it cannot see.
 */
function g5DeniesRequest({ item, authorityProjection, evaluatedAt }) {
  const request = item?.g5Request
  if (!request || !authorityProjection) return null
  if (!request.canonicalAction || !request.scopeType) return null
  const resolution = resolveAskDwAuthority({ authorityProjection, request, evaluatedAt })
  return resolution.governing === false
}

function entry({
  source, reason, subject, clientId = null, invoiceId = null,
  detail = null, refs = [], needsFounder = true, observedAt = null,
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
    // The observation THIS entry was built from, set before any merge. After
    // dedupe it names which event is current, so a consumer never has to guess
    // that from a merged ref list.
    currentRef: [...refs].filter(Boolean)[0] ?? null,
    observedAt,
    needsFounder,
    blockedBy: REASON_BLOCKER[reason] ?? null,
    // Ranking is a reading of existing state; it authorises nothing.
    authorityImpact: 'NONE',
    directlyExecutable: false,
  }
}

/**
 * The identity a demand on founder attention actually has: the CASE, not the
 * reason. An event burst or a replayed proof produces several rows about one
 * invoice, and three rows do not mean three decisions — they mean one decision
 * observed three times. Keying on the reason as well meant a case whose reason
 * changed between proof events (approval, then a question) still interrupted
 * the founder twice about the same invoice.
 */
function attentionIdentity(item) {
  // A Company Brain item's case identity is its REVIEW KEY, not its subject:
  // an unresolved conflict and a changed-since-review item can share a subject
  // while being two genuinely different things the founder must look at.
  if (item.source === 'COMPANY_BRAIN') {
    return ['COMPANY_BRAIN', item.supportingRefs[0] ?? item.subject ?? ''].join('|')
  }
  return [item.source, item.clientId ?? '', item.invoiceId ?? ''].join('|')
}

/**
 * Which of several observations of one case is CURRENT.
 *
 * Currentness is read from the observation timestamps the projection already
 * carries. It is never inferred from severity: an older approval must not
 * outrank a newer state just because approval ranks higher. When the events
 * disagree and no timestamp can order them, currentness is not guessed —
 * the ambiguity is reported and the queue stops calling itself complete.
 */
function chooseCurrent(existing, candidate) {
  const a = Date.parse(existing.observedAt ?? '')
  const b = Date.parse(candidate.observedAt ?? '')
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return { current: b > a ? candidate : existing, ambiguous: false }
  }
  if (Number.isFinite(b)) return { current: candidate, ambiguous: false }
  if (Number.isFinite(a)) return { current: existing, ambiguous: false }
  // No ordering evidence at all. Identical observations are a replay, which is
  // not ambiguous; genuinely different ones are.
  const differs = existing.reason !== candidate.reason
  return { current: existing, ambiguous: differs }
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
  governance = null, authorityProjection = null, limit = 5,
} = {}) {
  const tenant = String(tenantId || '').trim()
  if (!tenant) throw new Error('DW attention tenantId required')

  // NESTED tenant identity, not just a label. Validating only that tenantId is
  // non-empty let a projection belonging to one tenant be presented as
  // another's: the caller supplied the label, and nothing checked that the
  // data underneath it agreed. Foreign input fails closed rather than being
  // relabelled, so no foreign subject, ref, id or fingerprint can appear.
  for (const [name, value] of [
    ['needs-you read model', needsYouReadModel],
    ['Company Brain context', companyBrainContext],
    ['governance envelope', governance],
  ]) {
    const owner = tenantOf(value)
    if (value != null && owner != null && String(owner) !== tenant) {
      throw new Error(`DW attention ${name} tenant mismatch: refusing to relabel another tenant's state`)
    }
  }

  const entries = []
  const degraded = []

  // Canonical AR cases that already need the founder. That projection owns the
  // judgement; this module does not second-guess it, only reads its reasons.
  if (needsYouReadModel) {
    for (const item of safeArray(needsYouReadModel.items)) {
      const g5Denied = g5DeniesRequest({
        item,
        authorityProjection,
        evaluatedAt: authorityProjection?.evaluatedAt ?? null,
      })
      const reason = g5Denied === true
        ? DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY
        : blockedOnOperationalPolicy(item)
          ? DW_ATTENTION_REASON.BLOCKED_ON_OPERATIONAL_POLICY
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
        observedAt: item.at ?? item.lastUpdatedAt ?? null,
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
  } else {
    // Absent and unreadable are the same thing here: CP2's queue depends on
    // Company Brain governance, so no read means the answer is unknown, not
    // clean. Treating a missing context as complete let "nothing needs you"
    // be said without ever having looked.
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
  let currentnessAmbiguous = false
  for (const item of ordered) {
    const identity = attentionIdentity(item)
    const existing = byIdentity.get(identity)
    if (!existing) {
      byIdentity.set(identity, { ...item, supportingRefs: [...item.supportingRefs] })
      continue
    }
    duplicatesSuppressed += 1
    const { current, ambiguous } = chooseCurrent(existing, item)
    if (ambiguous) currentnessAmbiguous = true
    // Every observed event stays inspectable; only the interruption collapses.
    const refs = [...existing.supportingRefs]
    for (const ref of item.supportingRefs) if (!refs.includes(ref)) refs.push(ref)
    // currentRef comes from the winning observation, not from the merged list.
    byIdentity.set(identity, { ...current, supportingRefs: refs, currentRef: current.currentRef })
  }
  if (currentnessAmbiguous) degraded.push('CASE_CURRENTNESS_AMBIGUOUS')
  const deduped = [...byIdentity.values()]
    .sort((a, b) =>
      a.reasonRank - b.reasonRank ||
      String(a.subject).localeCompare(String(b.subject)) ||
      String(a.supportingRefs[0] ?? '').localeCompare(String(b.supportingRefs[0] ?? '')))

  return freeze({
    schemaVersion: DW_ATTENTION_VERSION,
    tenantId: tenant,
    // Degraded reads are surfaced, never smoothed over: "nothing needs you" is
    // only sayable when everything that decides that was actually readable.
    complete: degraded.length === 0,
    degradedInputs: [...degraded],
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
