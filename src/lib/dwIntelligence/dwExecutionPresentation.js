/**
 * G8-CP3 — receipt-owned execution presentation.
 *
 * WHY THIS MODULE EXISTS
 *
 * The invariant is
 *
 *     NO COMPLETED DW EXECUTION CLAIM WITHOUT AN EXACT RECEIPT
 *
 * and until now it rested on reading English. First a regex, then a gap
 * heuristic, then a backward token walk. Each round closed the reported
 * sentences and exposed the next ones, because the thing being approximated is
 * grammar:
 *
 *   - past meaning does not require a past-form verb ("DW did send");
 *   - negation, passive and coordination are SCOPE relations, not adjacency
 *     ("DW was ready and sent it", "DW did not call but emailed Atlas");
 *   - subject nouns are an OPEN class ("we confirmed accounting emailed us"),
 *     so no closed word set can decide who owns a verb;
 *   - passive is not only `be` ("DW got contacted by Atlas").
 *
 * This repository contains no English parser — pgsql-parser is for SQL — so
 * every further rule would be one more approximation standing between a
 * founder and a false claim about their money.
 *
 * So prose stops owning the boundary. A completed-execution statement is built
 * HERE, deterministically, from an exact receipt, in words this repository
 * wrote. There is no text parameter on the builder: no sentence a model can
 * produce is an input, so no sentence a model can produce is a claim.
 *
 * WHAT A RECEIPT BUYS
 *
 * Exactly one statement, about exactly one execution identity. It is not
 * standing authority, it does not cover a second action, and it does not make
 * any other sentence true. Everything else a founder is shown remains
 * ungoverned narrative that the consumer must not render as DueWatch's work.
 *
 * WHAT THIS MODULE IS NOT
 *
 *   - It is not a runtime. Nothing here sends, schedules or persists, and no
 *     proactive runtime consumes it yet; this is the contract a future one
 *     must be built against.
 *   - It is not a second verifier. The receipt check below is the one the
 *     proactive guard uses, moved here unchanged so there is exactly one.
 *   - It is not a presentation layer. It emits a typed statement and a fixed
 *     sentence; where and how that is displayed is not decided here.
 */

import {
  ACTION_TYPE_SEND_REMINDER,
  buildIdempotencyKey,
} from '../../../supabase/functions/_shared/executionClaim.js'

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
 * The CLOSED set of actions an execution receipt can prove.
 *
 * Detection stays broad — the prose recognizer knows about refunds, waivers and
 * write-offs so it can REFUSE completed language about them. Proof stays closed:
 * only send_reminder has a canonical execution-claim contract in this
 * repository, so a fabricated { actionType: 'issue_refund', status: 'sent' }
 * must never license a sentence. An action with no execution contract fails
 * closed, which is the honest answer rather than a capability DW does not have.
 */
export const DW_PROVABLE_EXECUTION_ACTIONS = Object.freeze([ACTION_TYPE_SEND_REMINDER])

/**
 * A receipt proves ONE action, for ONE tenant, invoice and client.
 *
 * The previous check accepted any object carrying status 'succeeded' — a value
 * the real execution-claim vocabulary (in_flight | sent | send_failed |
 * uncertain) never produces — and then treated every completed-action sentence
 * in the narrative as covered by it. A receipt for another invoice, another
 * tenant or another action proved nothing about the sentence in front of it.
 *
 * The real receipt shape is { userId, invoiceId, ruleId, actionType,
 * idempotencyKey }, written beside the execution claim; a claim reaches a
 * terminal successful state as status 'sent'.
 */
const TERMINAL_SUCCESS = new Set(['sent'])

/**
 * A receipt proves execution only when the FULL canonical identity matches.
 *
 * The execution-claim contract's identity is (userId, invoiceId, ruleId,
 * actionType), and the idempotency key is deterministically derived from
 * exactly that tuple. Comparing user, invoice and action while ignoring the
 * rule — and accepting any non-empty key — let a receipt for a different rule
 * stand in for this one. The key is now recomputed and compared, so a receipt
 * must carry the key its own identity produces.
 *
 * Nothing here reads a name out of prose: tenant, invoice, rule and action all
 * come from the structured claim.
 */
export function receiptProvesExecution({ receipts, claim, action }) {
  if (!claim) return false
  // An action with no canonical execution contract can never be proved.
  if (!DW_PROVABLE_EXECUTION_ACTIONS.includes(action)) return false
  // The claim itself must cover the action the sentence asserts.
  if (claim.action !== action) return false

  return safeArray(receipts).some((receipt) => {
    if (!receipt || typeof receipt !== 'object') return false
    if (!TERMINAL_SUCCESS.has(receipt.status)) return false
    if (receipt.actionType !== action) return false
    if (String(receipt.userId ?? '') !== String(claim.tenantId ?? '')) return false
    if (String(receipt.invoiceId ?? '') !== String(claim.invoiceId ?? '')) return false
    if (String(receipt.ruleId ?? '') !== String(claim.ruleId ?? '')) return false
    if (claim.clientId != null && receipt.clientId != null &&
        String(receipt.clientId) !== String(claim.clientId)) return false
    // The key must be the one this exact identity derives, not merely present.
    const expected = buildIdempotencyKey({
      userId: receipt.userId,
      invoiceId: receipt.invoiceId,
      ruleId: receipt.ruleId,
      actionType: receipt.actionType,
    })
    return expected != null && receipt.idempotencyKey === expected
  })
}

export const DW_EXECUTION_STATEMENT_KIND = 'DW_EXECUTION_STATEMENT_V0'

/**
 * The words themselves, owned by this repository and keyed by provable action.
 *
 * A model never writes an execution sentence, so a model never gets one
 * subtly wrong. Adding a key here without a canonical execution contract for
 * that action would be adding a claim DueWatch cannot prove, which is why the
 * table is asserted against DW_PROVABLE_EXECUTION_ACTIONS in the suite.
 */
export const DW_EXECUTION_COPY = Object.freeze({
  [ACTION_TYPE_SEND_REMINDER]: 'DueWatch sent a payment reminder for this invoice.',
})

export const DW_EXECUTION_REFUSAL = Object.freeze({
  NO_CLAIM: 'NO_CLAIM',
  ACTION_NOT_PROVABLE: 'ACTION_NOT_PROVABLE',
  NO_PROVING_RECEIPT: 'NO_PROVING_RECEIPT',
  NO_OWNED_COPY: 'NO_OWNED_COPY',
})

/**
 * A seal over the statement's own content.
 *
 * It is not a secret and it is not a signature: it stops a statement from
 * being EDITED after it was issued — model text swapped into `text`, an
 * identity swapped underneath a valid-looking object — because verification
 * recomputes it from the content and, separately, re-derives the idempotency
 * key from the identity. A forged object has to be a genuine one to pass, at
 * which point it is a genuine one.
 */
function sealOf({ identity, idempotencyKey, clientId, text }) {
  const material = JSON.stringify([
    DW_EXECUTION_STATEMENT_KIND,
    identity.userId, identity.invoiceId, identity.ruleId, identity.actionType,
    idempotencyKey, clientId ?? null, text,
  ])
  let hash = 2166136261
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Builds the one statement an exact receipt licenses, or refuses and says why.
 *
 * Note what is NOT a parameter: narrative, headline, model output, confidence,
 * Company Brain state, conversation, provider capability, a G5 grant, a
 * recommendation or a staged action. Callers may pass them; they are ignored,
 * and the suite proves that by passing all of them at once with no receipt.
 *
 * @param {object|Array} input.receipt an execution receipt, or several
 * @param {object} input.claim  the canonical execution claim being presented
 */
export function buildDwExecutionStatement({ receipt = null, claim = null } = {}) {
  const refuse = (refusal) => freeze({ issued: false, statement: null, refusal })

  if (!claim || !claim.action) return refuse(DW_EXECUTION_REFUSAL.NO_CLAIM)
  const action = claim.action
  if (!DW_PROVABLE_EXECUTION_ACTIONS.includes(action)) {
    return refuse(DW_EXECUTION_REFUSAL.ACTION_NOT_PROVABLE)
  }
  const text = DW_EXECUTION_COPY[action]
  if (typeof text !== 'string' || text.length === 0) {
    return refuse(DW_EXECUTION_REFUSAL.NO_OWNED_COPY)
  }

  // The single verifier. Everything the receipt contract refuses, this refuses.
  const receipts = Array.isArray(receipt) ? receipt : receipt == null ? [] : [receipt]
  if (!receiptProvesExecution({ receipts, claim, action })) {
    return refuse(DW_EXECUTION_REFUSAL.NO_PROVING_RECEIPT)
  }

  // Identity comes from the CLAIM, never from a name in prose.
  const identity = {
    userId: String(claim.tenantId),
    invoiceId: String(claim.invoiceId),
    ruleId: String(claim.ruleId),
    actionType: action,
  }
  const idempotencyKey = buildIdempotencyKey(identity)
  const clientId = claim.clientId ?? null

  return freeze({
    issued: true,
    refusal: null,
    statement: {
      kind: DW_EXECUTION_STATEMENT_KIND,
      actionType: action,
      identity,
      idempotencyKey,
      clientId,
      text,
      seal: sealOf({ identity, idempotencyKey, clientId, text }),
      // Stated on the statement itself, so a consumer cannot read more into it.
      grants: {
        thisIdentityOnly: true,
        standingAuthority: false,
        otherActions: false,
      },
    },
  })
}

/**
 * Why a statement failed verification, or null when it did not.
 *
 * Each reason names ONE mechanism, so each mechanism can be shown to be
 * load-bearing on its own. A boolean cannot do that: with several checks
 * guarding the same forgery, removing any one of them leaves the others to
 * catch it, and a mutation that deletes a real control looks harmless.
 *
 * The order matters for the same reason — the seal is checked LAST, so a
 * forgery the earlier checks are supposed to catch is attributed to them.
 */
export const DW_EXECUTION_VERIFY_FAILURE = Object.freeze({
  NOT_A_STATEMENT: 'NOT_A_STATEMENT',
  ACTION_NOT_PROVABLE: 'ACTION_NOT_PROVABLE',
  IDENTITY_ACTION_MISMATCH: 'IDENTITY_ACTION_MISMATCH',
  GRANTS_OVERREACH: 'GRANTS_OVERREACH',
  KEY_NOT_DERIVED: 'KEY_NOT_DERIVED',
  SEAL_MISMATCH: 'SEAL_MISMATCH',
})

/**
 * Inspects a statement and says precisely what is wrong with it.
 *
 * Note what is NOT checked here: that `text` equals the owned copy. The seal
 * covers the text, so a substituted sentence already fails as SEAL_MISMATCH,
 * and a second comparison would be a control no test could distinguish from
 * the first — decorative rather than load-bearing. The copy table itself is
 * locked structurally instead, against the provable-action set.
 */
export function inspectDwExecutionStatement(statement) {
  const fail = (failure) => freeze({ valid: false, failure })
  if (!statement || typeof statement !== 'object') return fail(DW_EXECUTION_VERIFY_FAILURE.NOT_A_STATEMENT)
  if (statement.kind !== DW_EXECUTION_STATEMENT_KIND) return fail(DW_EXECUTION_VERIFY_FAILURE.NOT_A_STATEMENT)

  const { actionType, identity, idempotencyKey, clientId = null, text, seal, grants } = statement
  if (!identity || typeof identity !== 'object') return fail(DW_EXECUTION_VERIFY_FAILURE.NOT_A_STATEMENT)
  if (!DW_PROVABLE_EXECUTION_ACTIONS.includes(actionType)) {
    return fail(DW_EXECUTION_VERIFY_FAILURE.ACTION_NOT_PROVABLE)
  }
  if (identity.actionType !== actionType) return fail(DW_EXECUTION_VERIFY_FAILURE.IDENTITY_ACTION_MISMATCH)

  // Deliberately outside the seal, so this stays a control in its own right:
  // a receipt licenses one statement, never standing authority.
  if (!grants || grants.thisIdentityOnly !== true ||
      grants.standingAuthority !== false || grants.otherActions !== false) {
    return fail(DW_EXECUTION_VERIFY_FAILURE.GRANTS_OVERREACH)
  }

  const derived = buildIdempotencyKey({
    userId: identity.userId,
    invoiceId: identity.invoiceId,
    ruleId: identity.ruleId,
    actionType: identity.actionType,
  })
  if (derived == null || derived !== idempotencyKey) {
    return fail(DW_EXECUTION_VERIFY_FAILURE.KEY_NOT_DERIVED)
  }

  if (seal !== sealOf({ identity, idempotencyKey, clientId, text })) {
    return fail(DW_EXECUTION_VERIFY_FAILURE.SEAL_MISMATCH)
  }
  return freeze({ valid: true, failure: null })
}

/**
 * Whether a statement is one this module issued and nothing has edited since.
 *
 * Consumers verify rather than trust: a statement arriving from anywhere —
 * another module, a cached payload, a model asked to "format the output" —
 * must still recompute to the same seal and the same derived key.
 */
export function verifyDwExecutionStatement(statement) {
  return inspectDwExecutionStatement(statement).valid === true
}
