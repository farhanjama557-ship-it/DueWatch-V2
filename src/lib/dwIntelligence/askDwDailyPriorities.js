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
 *
 * G8-CP2: the ordering policy itself now lives in dwAttentionPriority.js, which
 * both this lane and proactive DW Intelligence read. This module is the Ask DW
 * projection of that one answer, not a second implementation of it.
 */

import { DW_ATTENTION_REASON, buildDwAttention } from './dwAttentionPriority.js'

const PRIORITIES_VERSION = 'ASK_DW_DAILY_PRIORITIES_V0'

/**
 * The Ask DW-facing name for the shared attention vocabulary, ordered highest
 * to lowest. It is an alias, not a second list: two lists would be two
 * orderings waiting to disagree.
 */
export const ASK_DW_PRIORITY_REASON = DW_ATTENTION_REASON

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
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
  // CP2: one implementation, two projections. The attention primitive is
  // lane-neutral -- it already consumed DW Intelligence's needs-you read model
  // and the Company Brain context -- so Ask DW reads it rather than keeping a
  // second copy of the same ordering policy. The Ask DW contract is unchanged.
  const attention = buildDwAttention({
    tenantId, needsYouReadModel, companyBrainContext, limit,
  })
  return freeze({
    schemaVersion: PRIORITIES_VERSION,
    tenantId: attention.tenantId,
    complete: attention.complete,
    degradedInputs: [...attention.degradedInputs],
    total: attention.total,
    items: attention.items.map((item) => ({
      source: item.source,
      reason: item.reason,
      reasonRank: item.reasonRank,
      why: item.why,
      subject: item.subject,
      clientId: item.clientId,
      invoiceId: item.invoiceId,
      detail: item.detail,
      refs: [...item.supportingRefs],
      authorityImpact: item.authorityImpact,
      directlyExecutable: item.directlyExecutable,
    })),
    remaining: attention.remaining,
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
