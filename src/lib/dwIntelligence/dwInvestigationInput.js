/**
 * G8-CP1 — shared investigation input admission.
 *
 * Ask DW and DW Intelligence already share the Phase 2B engine: both call
 * runPhase2BWorkflow. They did NOT share how the input reaching that engine is
 * admitted, and that is where they could disagree.
 *
 *   Ask DW      bounded its Supabase read window and refused an overflow,
 *               because an incomplete truth input cannot support an answer.
 *   Proactive   accepted whatever arrays the caller supplied.
 *
 * Same tenant, same invoice, one over-window evidence set: one lane refused
 * and the other proceeded on a silently different admitted set. Same engine,
 * different facts.
 *
 * This module is the single admission gate. It is deliberately NOT a database
 * loader — callers keep their own IO. It only decides, identically for every
 * caller, whether already-read data may enter the engine at all.
 *
 * It does not evaluate authority, does not read the Company Brain, does not
 * touch canonical money, and does not re-implement anything the engine owns.
 * Tenant scope in particular stays the engine's: runPhase2BWorkflow already
 * returns a BLOCKED result on a tenant mismatch, and admission must not turn
 * that governed outcome into a thrown error.
 */

/** The bounded read window, shared by every entry point. */
export const DW_INVESTIGATION_BOUNDS = Object.freeze({
  MAX_EVIDENCE: 100,
  MAX_MEMORY: 100,
  MAX_PRECEDENTS: 100,
})

/** Where an admitted input came from. Recorded for provenance, never for trust. */
export const DW_INVESTIGATION_SOURCE = Object.freeze({
  ASK_DW: 'ASK_DW',
  DW_INTELLIGENCE: 'DW_INTELLIGENCE',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

/**
 * A bounded collection. Overflow is refused rather than truncated: a silently
 * truncated window is an incomplete truth input wearing a complete one's face.
 */
function boundedCollection(label, value, max) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected an array; refusing an unverifiable truth input`)
  }
  if (value.length > max) {
    throw new Error(`${label}: exceeds the current bounded read window; refusing an incomplete truth input`)
  }
  return value
}

/**
 * Execution history arrives as Sets. An array here would still be truthy and
 * would still reach authority evaluation, producing a different authority
 * input from the same facts, so the shape is verified rather than coerced.
 */
function requiredSet(label, value) {
  if (value == null) return new Set()
  if (!(value instanceof Set)) {
    throw new Error(`${label}: execution history could not be verified; expected a Set`)
  }
  return value
}

/**
 * Admits one already-read dataset into the Phase 2B engine.
 *
 * Every caller passes through the same bounds, the same shape checks and the
 * same fail-closed behaviour, so one input reaches one engine state whichever
 * entry point asked.
 *
 * @returns {{ intelligenceInput: object, admission: object }}
 */
export function admitDwInvestigationInput({
  source = DW_INVESTIGATION_SOURCE.DW_INTELLIGENCE,
  tenantId,
  invoice,
  client,
  now = new Date(),
  evidence = [],
  memory = [],
  tombstones = [],
  precedents = [],
  handledKeys = null,
  pendingInvoiceIds = null,
  authorityEvaluation = null,
  pooling = null,
  prediction = null,
  predictionRequired = false,
  founderApproved = false,
  question = null,
  preferenceEvents = [],
  rejectStagedAction = false,
  disputed = false,
  identificationStatus = null,
  sandboxTransport = true,
} = {}) {
  if (!Object.values(DW_INVESTIGATION_SOURCE).includes(source)) {
    throw new Error('DW investigation input requires a known source')
  }
  // Tenant scope is NOT admission's to decide. runPhase2BWorkflow already
  // returns a governed BLOCKED_TENANT_SCOPE result for a missing or mismatched
  // tenant, and throwing here would replace that governed outcome with an
  // exception — a behaviour change dressed as a safety check.

  const admittedEvidence = boundedCollection(
    'DW investigation evidence', evidence, DW_INVESTIGATION_BOUNDS.MAX_EVIDENCE)
  const admittedMemory = boundedCollection(
    'DW investigation memory', memory, DW_INVESTIGATION_BOUNDS.MAX_MEMORY)
  const admittedTombstones = boundedCollection(
    'DW investigation tombstones', tombstones, DW_INVESTIGATION_BOUNDS.MAX_MEMORY)
  const admittedPrecedents = boundedCollection(
    'DW investigation precedents', precedents, DW_INVESTIGATION_BOUNDS.MAX_PRECEDENTS)
  const admittedPreferenceEvents = boundedCollection(
    'DW investigation preference events', preferenceEvents, DW_INVESTIGATION_BOUNDS.MAX_EVIDENCE)

  // Verified, not coerced, and only when the caller supplied them: the Ask DW
  // loader builds these itself, while a proactive caller hands them in.
  if (handledKeys != null) requiredSet('DW investigation handledKeys', handledKeys)
  if (pendingInvoiceIds != null) requiredSet('DW investigation pendingInvoiceIds', pendingInvoiceIds)

  const intelligenceInput = {
    tenantId,
    invoice,
    client,
    now,
    evidence: admittedEvidence,
    memory: admittedMemory,
    tombstones: admittedTombstones,
    precedents: admittedPrecedents,
    pooling,
    prediction,
    predictionRequired,
    authorityEvaluation,
    founderApproved,
    question,
    preferenceEvents: admittedPreferenceEvents,
    rejectStagedAction,
    disputed,
    identificationStatus,
    sandboxTransport,
  }

  // A receipt of what admission actually saw. It records completeness; it is
  // never itself a fact about money, permission or freshness of the sources.
  const admission = freeze({
    source,
    bounds: DW_INVESTIGATION_BOUNDS,
    counts: {
      evidence: admittedEvidence.length,
      memory: admittedMemory.length,
      tombstones: admittedTombstones.length,
      precedents: admittedPrecedents.length,
    },
    withinBounds: true,
    executionHistoryVerified: handledKeys != null || pendingInvoiceIds != null,
  })

  return { intelligenceInput, admission }
}
