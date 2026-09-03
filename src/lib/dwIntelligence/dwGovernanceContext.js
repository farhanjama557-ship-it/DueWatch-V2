/**
 * G8-CP1 — shared governance envelope.
 *
 * Company Brain state, unresolved conflicts, review/stale/revoked state and G5
 * grant identity were available to Ask DW and invisible to proactive DW
 * Intelligence. This module builds the governance facts BOTH lanes need, from
 * one implementation, so the two cannot hold different views of the same
 * tenant's governing state.
 *
 * What this module is NOT:
 *
 *   - It is not a conversation layer. Turn classification, founder utterance
 *     ownership, authority-answer rendering, greetings and response shaping
 *     stay with Ask DW, because they are properties of a founder asking, not
 *     properties of the tenant's governance. Proactive DW Intelligence must
 *     not inherit them.
 *   - It is not a truth owner. The Phase 2B engine still owns the financial
 *     and intelligence proof; G5 still owns authority; G6 still owns review.
 *   - It is not an authority, and it holds no CONCLUSIONS. The envelope
 *     carries identity references and observed timestamps only — grant ids,
 *     review keys, conflict ids, generatedAt/evaluatedAt. There is no
 *     canExecute field, no standing-authority verdict, no "no authority is
 *     configured" summary, no completeness claim, no copied policy value and
 *     no cached governing decision. A derived conclusion goes stale exactly
 *     like a verdict does: a cached "no authority exists" misleads after a
 *     grant is created just as a cached "authority exists" misleads after one
 *     is revoked. So a stale envelope has nothing with which to govern, and
 *     nothing with which to deny.
 *
 * Authority must still be re-evaluated by G5 at the real use seam. The
 * envelope exists to make both lanes ask the same question, not to answer it.
 * This module therefore offers no helper that interprets a grant's status,
 * window or conditions: deciding that a grant governs is G5's alone.
 */

/** Stable, dependency-free digest, matching the repository's FNV-1a convention. */
function stableFingerprint(parts) {
  const text = JSON.stringify(parts)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function refsOf(items) {
  return safeArray(items).map((item) => item?.reviewKey).filter(Boolean)
}

/**
 * Builds the governance envelope for one tenant.
 *
 * @param {object}  input.companyBrainContext  an already-built Company Brain context
 * @param {Array}   input.knownEntities        resolved entity references, if the caller has them
 */
export function buildDwGovernanceContext({
  tenantId = null,
  companyBrainContext = null,
  knownEntities = [],
} = {}) {
  const available = companyBrainContext?.available === true
  const authority = companyBrainContext?.authority ?? null

  // Grant IDENTITY only. Never a status verdict, never a governing decision:
  // whether a grant governs is G5's answer at the moment of use, not a value
  // that can be carried forward inside an envelope.
  const currentGrantIds = safeArray(authority?.currentGrants)
    .map((grant) => grant?.grantId ?? grant?.id)
    .filter(Boolean)
    .sort()

  const conflicts = safeArray(companyBrainContext?.conflicts).map((conflict) => ({
    reviewKey: conflict?.reviewKey ?? null,
    conflictStatus: conflict?.conflictStatus ?? null,
  })).filter((conflict) => conflict.reviewKey)

  const companyBrain = {
    available,
    unavailableReason: companyBrainContext?.unavailableReason ?? null,
    generatedAt: companyBrainContext?.generatedAt ?? null,
    // Review keys, not reviewed values: a copied policy value would survive a
    // revocation or a later founder edit invisibly.
    understandingRefs: refsOf(companyBrainContext?.understanding),
    roleRefs: refsOf(companyBrainContext?.roles),
    pendingFounderDecisionRefs: refsOf(companyBrainContext?.pendingFounderDecisions),
    changedSinceReviewRefs: refsOf(companyBrainContext?.changedSinceReview),
    supportingSourceRevokedRefs: safeArray(companyBrainContext?.understanding)
      .filter((item) => item?.supportingSourceRevoked === true)
      .map((item) => item.reviewKey)
      .filter(Boolean),
  }

  // IDENTITY ONLY. noStandingAuthorityConfigured was a derived authority
  // CONCLUSION, not a reference: cached in an envelope it goes stale, and a
  // stale "no authority exists" is just as wrong as a stale "authority
  // exists". revokedCount and staleCount were snapshot summaries of the same
  // kind. None of them is needed to name a grant, so none of them is here.
  const authorityRefs = {
    evaluatedAt: authority?.evaluatedAt ?? null,
    currentGrantIds,
    fingerprint: stableFingerprint({
      evaluatedAt: authority?.evaluatedAt ?? null,
      currentGrantIds,
    }),
  }

  return freeze({
    kind: 'DW_GOVERNANCE_ENVELOPE_V0',
    tenantId: tenantId ?? companyBrainContext?.tenantId ?? null,
    companyBrain,
    conflicts,
    authority: authorityRefs,
    entities: {
      knownEntityRefs: safeArray(knownEntities)
        .map((entity) => (typeof entity === 'string' ? entity : entity?.id))
        .filter(Boolean)
        .sort(),
    },
    // WHAT IS KNOWN, and nothing more. A readable Company Brain proves only
    // that it was readable: not that its sources are complete, not that its
    // review is current, not that authority is fresh, and not that no support
    // was revoked. Equating available with complete asserted all four. There
    // is no deterministic completeness proof at this seam, so none is claimed
    // — a later G8 seam may evaluate freshness under source-specific policy.
    sourceState: {
      companyBrainAvailable: available,
      companyBrainGeneratedAt: companyBrain.generatedAt,
      authorityEvaluatedAt: authorityRefs.evaluatedAt,
    },
    // Structural, not advisory. There is no field from which a caller could
    // read permission, and re-evaluation is not optional.
    governs: false,
    authorityMustBeReEvaluatedAtUse: true,
  })
}
