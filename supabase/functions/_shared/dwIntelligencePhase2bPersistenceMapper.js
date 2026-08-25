/**
 * Pure camelCase -> database-row mapping for the Phase 2B proof tables.
 * No Supabase/network imports. This module makes the server-core persistence
 * contract explicit before any database adapter is deployed.
 */

function requireString(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`)
  return value
}

export function mapRunInsert(input = {}) {
  return {
    user_id: requireString(input.userId, 'userId'),
    client_id: requireString(input.clientId, 'clientId'),
    invoice_id: requireString(input.invoiceId, 'invoiceId'),
    workflow: input.workflow ?? 'overdue_invoice_triage_friendly_reminder',
    engine_version: requireString(input.engineVersion, 'engineVersion'),
    // Caller input cannot widen the Phase 2B execution posture.
    transport: 'sandbox',
    production_execution_authorized: false,
    input_fingerprint: input.inputFingerprint ?? null,
  }
}

export function mapEvidenceInsert(input = {}) {
  const admissionStatus = requireString(input.admissionStatus, 'admissionStatus')
  const rejected = admissionStatus === 'REJECTED_TENANT' || admissionStatus === 'REJECTED_SCOPE'
  return {
    user_id: requireString(input.userId, 'userId'),
    run_id: requireString(input.runId, 'runId'),
    client_id: requireString(input.clientId, 'clientId'),
    invoice_id: requireString(input.invoiceId, 'invoiceId'),
    evidence_key: requireString(input.evidenceKey, 'evidenceKey'),
    source_type: requireString(input.sourceType, 'sourceType'),
    source_ref: rejected ? null : (input.sourceRef ?? null),
    trust: rejected ? null : requireString(input.trust, 'trust'),
    admission_status: admissionStatus,
    admission_reason: input.admissionReason ?? null,
    claim_type: rejected ? null : (input.claimType ?? null),
    derived_from_key: rejected ? null : (input.derivedFromKey ?? null),
    content_digest: rejected ? null : (input.contentDigest ?? null),
    provenance: input.provenance ?? {},
  }
}

export function mapProofEventInsert(input = {}) {
  return {
    user_id: requireString(input.userId, 'userId'),
    run_id: requireString(input.runId, 'runId'),
    client_id: requireString(input.clientId, 'clientId'),
    invoice_id: requireString(input.invoiceId, 'invoiceId'),
    sequence_no: Number.isInteger(input.sequenceNo) ? input.sequenceNo : 0,
    event_type: requireString(input.eventType, 'eventType'),
    operational_state: input.operationalState ?? null,
    proof: input.proof ?? {},
    // Phase 2B mapper refuses to translate any caller request into a real side
    // effect. The SQL constraint independently enforces false as well.
    real_side_effect: false,
  }
}

export function mapRunFinalize(input = {}) {
  const status = requireString(input.status, 'status')
  if (!['completed', 'failed'].includes(status)) throw new Error(`unsupported final status: ${status}`)
  return {
    status,
    summary: input.summary ?? {},
    completed_at: input.completedAt ?? new Date().toISOString(),
  }
}

export function assertPhase2BWriteContract({ runInsert, evidenceRows = [], proofEvent, runFinalize } = {}) {
  if (!runInsert || runInsert.production_execution_authorized !== false) throw new Error('run must be structurally non-production')
  if (!['sandbox', 'stub', 'none'].includes(runInsert.transport)) throw new Error('transport is not Phase 2B-safe')
  if (!proofEvent || proofEvent.real_side_effect !== false) throw new Error('proof event must be side-effect false')
  if (runFinalize && !['completed', 'failed'].includes(runFinalize.status)) throw new Error('invalid final run status')

  const scope = `${runInsert.user_id}`
  for (const row of evidenceRows) {
    if (row.user_id !== scope) throw new Error('evidence tenant does not match run tenant')
    if (row.client_id !== runInsert.client_id || row.invoice_id !== runInsert.invoice_id) throw new Error('evidence object scope does not match run scope')
  }
  if (proofEvent.user_id !== scope) throw new Error('proof tenant does not match run tenant')
  if (proofEvent.client_id !== runInsert.client_id || proofEvent.invoice_id !== runInsert.invoice_id) throw new Error('proof object scope does not match run scope')
  return true
}
