import { runPhase2BWorkflow } from './dwIntelligencePhase2bEngine.js'

export const PHASE2B_SERVER_OUTCOME = Object.freeze({
  COMPLETED: 'completed',
  BLOCKED_SCOPE: 'blocked_scope',
  PERSISTENCE_FAILED: 'persistence_failed',
})

function validScope({ userId, invoiceId, invoice, client }) {
  return Boolean(
    typeof userId === 'string' && userId &&
    typeof invoiceId === 'string' && invoiceId &&
    invoice && invoice.id === invoiceId && invoice.user_id === userId &&
    client && client.user_id === userId && invoice.client_id === client.id
  )
}

function proofSummary(result) {
  return {
    state: result.state,
    hard_violations: result.hardViolations ?? [],
    execution_mode: result.execution?.mode ?? 'none',
    execution_outcome: result.execution?.outcome ?? null,
    real_side_effect: result.execution?.sideEffect === true,
    founder_question_asked: result.proof?.founderQuestion?.asked === true,
    evidence_records: result.proof?.evidence?.records?.length ?? 0,
    independent_strong_roots: result.proof?.evidence?.independentStrongRoots?.length ?? 0,
  }
}

function buildRunCreate({ userId, clientId, invoiceId, engineVersion, inputFingerprint }) {
  return {
    userId,
    clientId,
    invoiceId,
    workflow: 'overdue_invoice_triage_friendly_reminder',
    engineVersion,
    transport: 'sandbox',
    productionExecutionAuthorized: false,
    inputFingerprint: inputFingerprint ?? null,
  }
}

function buildEvidencePersistence({ userId, runId, invoice, client, result, rawEvidence }) {
  const byId = new Map((rawEvidence || []).map((item) => [item.id, item]))
  return (result.proof?.evidence?.records || []).map((record, index) => {
    const rejected = record.status === 'REJECTED_TENANT' || record.status === 'REJECTED_SCOPE'
    const raw = !rejected && record.id != null ? (byId.get(record.id) || {}) : {}
    return {
      userId,
      runId,
      clientId: client.id,
      invoiceId: invoice.id,
      // Source-provided identifiers are not assumed to be UUIDs. They are
      // run-scoped evidence keys; rejected foreign/out-of-scope sources get a
      // local opaque key so their original identifier never crosses the proof
      // persistence boundary.
      evidenceKey: rejected ? `redacted_${index}` : record.id,
      sourceType: rejected ? 'redacted_rejected' : (raw.sourceType ?? raw.source_type ?? 'unknown'),
      sourceRef: rejected ? null : (raw.sourceRef ?? raw.source_ref ?? null),
      trust: rejected ? null : record.trust,
      admissionStatus: record.status,
      admissionReason: record.reason ?? null,
      claimType: rejected ? null : (record.claimType ?? null),
      derivedFromKey: rejected ? null : (record.derivedFrom ?? null),
      contentDigest: rejected ? null : (raw.contentDigest ?? raw.content_digest ?? null),
      provenance: rejected ? { redacted: true, admission_reason: record.reason ?? null } : (raw.provenance ?? {}),
    }
  })
}

function buildProofPersistence({ userId, runId, invoice, client, result }) {
  return {
    userId,
    runId,
    clientId: client.id,
    invoiceId: invoice.id,
    sequenceNo: 0,
    eventType: 'phase2b_workflow_evaluated',
    operationalState: result.state,
    proof: result.proof,
    realSideEffect: false,
  }
}

/**
 * Pure orchestration over injected I/O.
 *
 * Required io methods:
 *   fetchCaseInputs({ userId, invoiceId })
 *   createRun(runCreate) -> { id }
 *   persistEvidence(records)
 *   persistProofEvent(event)
 *   finalizeRun({ runId, userId, status, summary })
 *
 * Required evaluateAuthority function:
 *   the existing Duewatch evaluateNextActionAuthority contract, injected by
 *   the server adapter. This core never invents policy/authority itself.
 *
 * There is intentionally NO sendEmail/provider/HTTP callback in this I/O
 * contract. Phase 2B server proof ends at sandbox proof persistence.
 */
export async function runPhase2BServerProof({
  userId,
  invoiceId,
  engineVersion = 'phase2b-v0.2-local',
  inputFingerprint = null,
  now = new Date(),
  evaluateAuthority,
  io,
} = {}) {
  if (typeof evaluateAuthority !== 'function') throw new Error('evaluateAuthority is required')
  if (!io || typeof io.fetchCaseInputs !== 'function') throw new Error('io.fetchCaseInputs is required')

  const inputs = await io.fetchCaseInputs({ userId, invoiceId })
  const invoice = inputs?.invoice ?? null
  const client = inputs?.client ?? invoice?.clients ?? null

  // Fail before creating any persisted run if the requested object scope is
  // not proven to belong to the caller. A blocked cross-tenant read must not
  // itself create durable rows tied to another tenant's object ids.
  if (!validScope({ userId, invoiceId, invoice, client })) {
    return {
      outcome: PHASE2B_SERVER_OUTCOME.BLOCKED_SCOPE,
      persisted: false,
      result: null,
    }
  }

  let run = null
  try {
    run = await io.createRun(buildRunCreate({ userId, clientId: client.id, invoiceId: invoice.id, engineVersion, inputFingerprint }))
    if (!run?.id) throw new Error('createRun did not return a run id')

    const authorityEvaluation = evaluateAuthority({
      userId,
      invoice,
      rules: inputs.rules ?? [],
      autopilotSettings: inputs.autopilotSettings ?? null,
      events: inputs.events ?? [],
      // Preserve execution-history evidence exactly as fetched. The existing
      // authority engine deliberately distinguishes a real Set (including an
      // empty Set meaning the caller checked and found none) from missing or
      // malformed state meaning the caller never established that fact. Never
      // coerce unknown history into an empty Set here.
      handledKeys: inputs.handledKeys,
      pendingInvoiceIds: inputs.pendingInvoiceIds,
      now,
    })

    const result = runPhase2BWorkflow({
      tenantId: userId,
      invoice,
      client,
      now,
      evidence: inputs.evidence ?? [],
      memory: inputs.memory ?? [],
      tombstones: inputs.tombstones ?? [],
      precedents: inputs.precedents ?? [],
      pooling: inputs.pooling ?? null,
      prediction: inputs.prediction ?? null,
      predictionRequired: inputs.predictionRequired === true,
      authorityEvaluation,
      founderApproved: false,
      question: inputs.question ?? null,
      preferenceEvents: inputs.preferenceEvents ?? [],
      disputed: inputs.disputed === true,
      identificationStatus: inputs.identificationStatus ?? null,
      rejectStagedAction: inputs.rejectStagedAction === true,
      sandboxTransport: true,
    })

    const evidenceRows = buildEvidencePersistence({
      userId,
      runId: run.id,
      invoice,
      client,
      result,
      rawEvidence: inputs.evidence ?? [],
    })

    if (evidenceRows.length) await io.persistEvidence(evidenceRows)
    await io.persistProofEvent(buildProofPersistence({ userId, runId: run.id, invoice, client, result }))

    const summary = proofSummary(result)
    await io.finalizeRun({
      runId: run.id,
      userId,
      status: result.hardViolations?.length ? 'failed' : 'completed',
      summary,
    })

    return {
      outcome: PHASE2B_SERVER_OUTCOME.COMPLETED,
      persisted: true,
      runId: run.id,
      result,
      summary,
    }
  } catch (error) {
    if (run?.id && typeof io.finalizeRun === 'function') {
      try {
        await io.finalizeRun({
          runId: run.id,
          userId,
          status: 'failed',
          summary: { persistence_error: error instanceof Error ? error.message : String(error) },
        })
      } catch {
        // The original persistence failure remains the truthful primary error.
      }
    }
    return {
      outcome: PHASE2B_SERVER_OUTCOME.PERSISTENCE_FAILED,
      persisted: Boolean(run?.id),
      runId: run?.id ?? null,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
