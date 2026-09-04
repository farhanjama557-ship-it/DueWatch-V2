/**
 * M2H-CP1 — freshness, invalidation and the refetch obligation.
 *
 * A provider observation is a photograph, not a live feed. The dangerous
 * failure is not having old data; it is not KNOWING the data is old, because
 * an authoritative-looking stale balance is how DueWatch chases an invoice
 * that was paid last week.
 *
 * Three separate things this module refuses to merge:
 *
 *   SOURCE_UNAVAILABLE is not "no issues". A ledger we cannot reach is an
 *   unknown, and unknown fails closed. An empty result set from a working
 *   provider means nothing outstanding; an empty result because the call
 *   failed means we have no idea.
 *
 *   INVALIDATED is not merely old. An event told us this specific observation
 *   is wrong now, so it does not govern at any age.
 *
 *   REFETCH_REQUIRED is an obligation, not a state of belief. Something
 *   changed; until we re-read the authoritative source we do not know what is
 *   true, and we must not paper over that with the last value we happened to
 *   hold.
 */

export const FRESHNESS_STATE = Object.freeze({
  FRESH: 'FRESH',
  STALE: 'STALE',
  INVALIDATED: 'INVALIDATED',
  REFETCH_REQUIRED: 'REFETCH_REQUIRED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
})

/** Only FRESH may be acted on directly. Everything else is a reason to stop or re-read. */
const GOVERNING_STATES = new Set([FRESHNESS_STATE.FRESH])

export function freshnessMayGovern(state) {
  return GOVERNING_STATES.has(state)
}

/**
 * What a provider mutation invalidates, and what must be re-read as a result.
 *
 * The canonical example, and the reason this is a set rather than a field:
 * deleting a payment invalidates the payment, the invoice balance, the invoice
 * status, the allocation relationships, and the customer's unapplied credit.
 * Re-reading only the payment leaves four wrong answers in place.
 *
 * CP1 owns the CONTRACT. CP6 productionises the lifecycle that acts on it.
 */
const MUTATION_INVALIDATION = Object.freeze({
  PAYMENT_DELETED: Object.freeze({
    dimensions: Object.freeze([
      'PAYMENT_RECEIPT_STATE', 'PAYMENT_CREDIT_ALLOCATION_STATE', 'INVOICE_AR_STATE',
    ]),
    refetch: Object.freeze(['payment', 'invoice', 'allocations', 'customer_unapplied_value']),
  }),
  PAYMENT_CREATED: Object.freeze({
    dimensions: Object.freeze([
      'PAYMENT_RECEIPT_STATE', 'PAYMENT_CREDIT_ALLOCATION_STATE', 'INVOICE_AR_STATE',
    ]),
    refetch: Object.freeze(['payment', 'invoice', 'allocations']),
  }),
  INVOICE_UPDATED: Object.freeze({
    dimensions: Object.freeze(['INVOICE_AR_STATE', 'PAYMENT_CREDIT_ALLOCATION_STATE']),
    refetch: Object.freeze(['invoice', 'allocations']),
  }),
  CREDIT_MEMO_APPLIED: Object.freeze({
    dimensions: Object.freeze(['PAYMENT_CREDIT_ALLOCATION_STATE', 'INVOICE_AR_STATE']),
    refetch: Object.freeze(['invoice', 'allocations', 'customer_unapplied_value']),
  }),
  REFUND_ISSUED: Object.freeze({
    // Deliberately NOT asserting the invoice reopens. Whether a refund reopens
    // AR is a provider- and policy-specific question this checkpoint has not
    // researched, so the honest output is "re-read it", not an assumption.
    dimensions: Object.freeze([
      'PAYMENT_RECEIPT_STATE', 'PROCESSOR_FUNDS_SETTLEMENT_STATE', 'INVOICE_AR_STATE',
    ]),
    refetch: Object.freeze(['payment', 'invoice', 'allocations']),
  }),
  DISPUTE_OPENED: Object.freeze({
    dimensions: Object.freeze([
      'PAYMENT_RECEIPT_STATE', 'PROCESSOR_FUNDS_SETTLEMENT_STATE',
    ]),
    refetch: Object.freeze(['payment', 'dispute']),
  }),
  PAYOUT_SETTLED: Object.freeze({
    dimensions: Object.freeze(['PROCESSOR_FUNDS_SETTLEMENT_STATE']),
    refetch: Object.freeze(['payout']),
  }),
  BANK_RECONCILED: Object.freeze({
    dimensions: Object.freeze(['BANK_LEDGER_RECONCILIATION_STATE']),
    refetch: Object.freeze(['bank_transaction']),
  }),
})

export const KNOWN_MUTATIONS = Object.freeze(Object.keys(MUTATION_INVALIDATION))

/**
 * The invalidation scope of a mutation.
 *
 * An unknown mutation is NOT treated as harmless. We do not know what it
 * touched, so everything about the subject is suspect and must be re-read —
 * the opposite of the convenient default.
 */
export function invalidationScope(mutationType) {
  const known = MUTATION_INVALIDATION[mutationType]
  if (known) {
    return Object.freeze({
      mutationType, known: true,
      dimensions: known.dimensions, refetch: known.refetch,
    })
  }
  return Object.freeze({
    mutationType, known: false,
    dimensions: Object.freeze([
      'INVOICE_AR_STATE', 'PAYMENT_ATTEMPT_STATE', 'PAYMENT_RECEIPT_STATE',
      'PAYMENT_CREDIT_ALLOCATION_STATE', 'PROCESSOR_FUNDS_SETTLEMENT_STATE',
      'BANK_LEDGER_RECONCILIATION_STATE',
    ]),
    refetch: Object.freeze(['invoice', 'payment', 'allocations']),
    reason: 'Unrecognised mutation: scope is unknown, so nothing is assumed intact.',
  })
}

/**
 * The freshness of one observation, given what has happened since.
 *
 * Order matters and is deliberate: unavailability and explicit invalidation
 * both outrank age, because both mean something stronger than "old".
 */
export function resolveFreshness({
  observation = null, now = null, maxAgeMs = null,
  sourceAvailable = true, invalidatedAt = null, refetchRequired = false,
} = {}) {
  const mark = (state, reason) => Object.freeze({
    state, reason, mayGovern: freshnessMayGovern(state),
  })
  if (!observation) return mark(FRESHNESS_STATE.UNKNOWN, 'No observation.')
  if (sourceAvailable === false) {
    return mark(FRESHNESS_STATE.SOURCE_UNAVAILABLE,
      'The source could not be read. This is an unknown, not an empty result.')
  }
  if (invalidatedAt) {
    return mark(FRESHNESS_STATE.INVALIDATED,
      'A later event invalidated this observation; age is irrelevant.')
  }
  if (refetchRequired) {
    return mark(FRESHNESS_STATE.REFETCH_REQUIRED,
      'Something changed. The authoritative source must be re-read before this is used.')
  }
  const observedAt = Date.parse(observation.observedAt ?? '')
  const at = Date.parse(now ?? '')
  if (!Number.isFinite(observedAt) || !Number.isFinite(at) || maxAgeMs == null) {
    return mark(FRESHNESS_STATE.UNKNOWN, 'Age cannot be established.')
  }
  if (at - observedAt > maxAgeMs) {
    return mark(FRESHNESS_STATE.STALE, 'Older than the freshness window for this source.')
  }
  return mark(FRESHNESS_STATE.FRESH, 'Within the freshness window.')
}

/**
 * Which of two readings of the SAME dimension currently governs.
 *
 * A stale observation never beats a fresh one, however authoritative its
 * source looks — "the ledger is the source of record" is a statement about
 * which source owns the dimension, not a licence for last month's copy of it.
 */
export function preferFresher(a, b) {
  const governs = (candidate) => candidate?.freshness?.mayGovern === true
  if (governs(a) && !governs(b)) return a
  if (governs(b) && !governs(a)) return b
  if (!governs(a) && !governs(b)) return null
  const at = Date.parse(a?.observation?.observedAt ?? '')
  const bt = Date.parse(b?.observation?.observedAt ?? '')
  if (!Number.isFinite(at) || !Number.isFinite(bt) || at === bt) return null
  return bt > at ? b : a
}
