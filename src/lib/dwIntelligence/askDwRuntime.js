import { runPhase2BWorkflow } from './phase2bEngine.js'
import {
  ASK_DW_MODE,
  ASK_DW_RISK,
  buildAskDwModePolicy,
  compareAskDwModes,
  validateReasoningTrail,
} from './askDwModes.js'
import {
  ASK_DW_JOB,
  classifyAskDwIntent,
  validateProposedAskDwIntent,
} from './askDwIntent.js'

const HIGH_RISK_ACTIONS = new Set([
  'mark_paid',
  'apply_cash',
  'issue_credit',
  'write_off',
  'legal_escalation',
])

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function freeze(value) {
  if (!value || typeof value !== 'object') return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function evidenceRefsFromProof(proof) {
  return safeArray(proof?.evidence?.records)
    .map((record) => record.id ?? record.sourceEvidenceId ?? null)
    .filter(Boolean)
}

function deriveRisk({ intent, intelligenceInput, intelligenceResult }) {
  const action = intelligenceInput?.authorityEvaluation?.recommendation?.action ?? null
  if (intent.job === ASK_DW_JOB.ACT && HIGH_RISK_ACTIONS.has(action)) return ASK_DW_RISK.CRITICAL
  if (intent.job === ASK_DW_JOB.ACT) return ASK_DW_RISK.HIGH
  if (intent.job === ASK_DW_JOB.PREDICT) return ASK_DW_RISK.HIGH
  if (intelligenceResult?.proof?.reconciliation?.blocksCustomerContact) return ASK_DW_RISK.HIGH
  if (intelligenceResult?.state === 'INVESTIGATING' || intelligenceResult?.state === 'UNCERTAIN') return ASK_DW_RISK.HIGH
  return ASK_DW_RISK.MEDIUM
}

function materialContradictionFrom(result) {
  const ar = result?.proof?.arState
  return Boolean(
    ar?.reconciliation?.requiresPaymentReconciliation ||
    ar?.reconciliation?.requiresDisputeResolution ||
    result?.state === 'INVESTIGATING'
  )
}

function reasoningEvents(result, policy) {
  const proof = result.proof || {}
  const events = []
  const push = (type, summary, meta = {}) => events.push({
    type,
    observable: true,
    summary,
    ...meta,
  })

  if (proof.scope?.invoiceId || proof.scope?.clientId) {
    push('ENTITY_RESOLUTION', `Resolved scoped AR entities for ${proof.scope?.invoiceId ? `invoice ${proof.scope.invoiceId}` : `client ${proof.scope.clientId}`}.`)
  }

  if (proof.canonicalFacts) {
    push('CANONICAL_TRUTH_READ', `Read canonical invoice state ${proof.canonicalFacts.canonicalStatus ?? 'unknown'} with balance ${proof.canonicalFacts.balance ?? 'unknown'}.`)
  }

  const evidenceCount = safeArray(proof.evidence?.records).length
  push('EVIDENCE_RETRIEVAL', `Reviewed ${evidenceCount} evidence record${evidenceCount === 1 ? '' : 's'} available to this run.`)

  if (evidenceCount > 0) {
    const quarantined = safeArray(proof.evidence?.records).filter((x) => x.status === 'QUARANTINED_INSTRUCTION').length
    push('EVIDENCE_ADMISSION', `Applied evidence admission controls${quarantined ? `; quarantined ${quarantined} instruction-bearing record${quarantined === 1 ? '' : 's'}` : ''}.`)
  }

  if (proof.reconciliation?.requiresPaymentReconciliation || proof.reconciliation?.requiresDisputeResolution) {
    push('CONTRADICTION_CHECK', `Detected a material reconciliation condition: payment=${Boolean(proof.reconciliation.requiresPaymentReconciliation)}, dispute=${Boolean(proof.reconciliation.requiresDisputeResolution)}.`)
  }

  if (safeArray(proof.precedent?.checked).length > 0) {
    push('PRECEDENT_SEARCH', `Checked ${proof.precedent.checked.length} candidate precedent${proof.precedent.checked.length === 1 ? '' : 's'} and retained ${safeArray(proof.precedent?.applicable).length} structurally applicable case${safeArray(proof.precedent?.applicable).length === 1 ? '' : 's'}.`)
  }

  if (proof.uncertainty) {
    push('UNCERTAINTY_ASSESSMENT', `Assessed prediction quality; actionable=${proof.uncertainty.actionable === true}.`)
  }

  if (policy.internalDepth === 'deep') {
    push('HYPOTHESIS_TEST', 'Deep analysis requires competing explanations to be tested against admitted evidence before synthesis.', { status: 'REQUIRED_NOT_FABRICATED' })
    push('VERIFICATION_PASS', 'Deep analysis requires an independent/fresh-context verification pass before final synthesis.', { status: 'REQUIRED_NOT_FABRICATED' })
  } else {
    push('VERIFICATION_PASS', 'Standard analysis preserves the same material truth and safety verification floor.', { status: 'REQUIRED' })
  }

  if (proof.authority) {
    push('AUTHORITY_CHECK', `Checked execution authority; actual=${proof.authority.actual ?? 'NOT_GRANTED'}, policyAuthorized=${proof.authority.policyAuthorized === true}.`)
  }

  if (result.execution?.sideEffect === true || result.execution?.outcome) {
    push('EXECUTION_RECEIPT', `Execution boundary outcome: ${result.execution.outcome ?? 'unknown'}; real side effect=${result.execution.sideEffect === true}.`)
  }

  if (!validateReasoningTrail(events)) throw new Error('Ask DW reasoning trail integrity failure')
  return events
}

function hardSafetyOutcome(result) {
  if (safeArray(result?.hardViolations).length > 0) return 'HARD_VIOLATION'
  if (result?.execution?.sideEffect === true) return 'EXECUTED_WITH_SIDE_EFFECT'
  if (result?.state === 'BLOCKED') return 'BLOCKED'
  if (result?.state === 'APPROVAL') return 'APPROVAL_REQUIRED'
  return 'NO_UNAUTHORIZED_SIDE_EFFECT'
}

function answerContract({ mode, intent, result, policy }) {
  const proof = result.proof || {}
  const reconciliation = proof.reconciliation || {}
  const needsYou = result.state === 'APPROVAL' || proof.founderQuestion?.asked === true

  return {
    mode,
    requestedMode: policy.requestedMode,
    internalDepth: policy.internalDepth,
    autoEscalated: policy.autoEscalated,
    job: intent.job,
    responseShape: policy.responseContract,
    executiveState: result.state,
    canonicalFacts: proof.canonicalFacts ?? null,
    arState: proof.arState ?? null,
    evidenceRefs: evidenceRefsFromProof(proof),
    claims: safeArray(proof.claims),
    precedent: proof.precedent ?? null,
    uncertainty: proof.uncertainty ?? null,
    recommendation: proof.policy ?? null,
    constraints: proof.constraints ?? null,
    authority: proof.authority ?? null,
    hardSafetyOutcome: hardSafetyOutcome(result),
    needsYou: {
      required: needsYou,
      reason: result.state === 'APPROVAL'
        ? 'founder_approval_required'
        : proof.founderQuestion?.asked === true
          ? 'bounded_founder_question'
          : null,
      question: proof.founderQuestion?.question ?? null,
    },
    safeguards: {
      canonicalMutationFromConversation: false,
      directProviderExecutionFromConversation: false,
      rawChainOfThoughtVisible: false,
      reconciliationHold: Boolean(reconciliation.blocksCustomerContact),
      serverRevalidationRequired: Boolean(proof.constraints?.requiresServerRevalidation || result.stagedAction?.requiresServerRevalidation),
    },
  }
}

function buildWorkManifest({ policy, result }) {
  const proof = result.proof || {}
  const corePerformed = safeArray(proof.analysisPlan?.performed)
  const deepRequired = policy.internalDepth === 'deep'
    ? [
        'competing_hypothesis_analysis',
        'disconfirming_evidence_search',
        'challenge_first_recommendation',
        'independent_verification',
      ]
    : []

  return {
    completedDeterministicWork: corePerformed,
    requiredModelOrToolWork: deepRequired,
    completedModelOrToolWork: [],
    truthfullyPending: deepRequired,
  }
}

/**
 * Ask DW deterministic core.
 *
 * This is not a fake chat model. It runs the existing governed DW Intelligence
 * workflow, produces the shared Normal/Deep truth packet, and states which
 * semantic/model passes are still required. Provider/model execution is a
 * later adapter seam and cannot bypass the authority boundary here.
 */
export function runAskDwDeterministicCore({
  mode = ASK_DW_MODE.NORMAL,
  text,
  context = {},
  proposedIntent = null,
  intelligenceInput = {},
} = {}) {
  const proposed = proposedIntent ? validateProposedAskDwIntent(proposedIntent) : null
  if (proposedIntent && !proposed.valid) throw new Error('Invalid proposed Ask DW intent')

  const intent = proposedIntent
    ? freeze({ ...proposed, confidence: 'MODEL_PROPOSED_VALIDATED', source: 'validated_proposal' })
    : classifyAskDwIntent({ text, context })

  const preparedInput = {
    ...intelligenceInput,
    predictionRequired: intelligenceInput.predictionRequired === true || intent.predictionIntent === true,
    sandboxTransport: intelligenceInput.sandboxTransport !== false,
  }

  const intelligenceResult = runPhase2BWorkflow(preparedInput)
  const risk = deriveRisk({ intent, intelligenceInput: preparedInput, intelligenceResult })
  const policy = buildAskDwModePolicy({
    mode,
    risk,
    actionIntent: intent.actionIntent,
    materialContradiction: materialContradictionFrom(intelligenceResult),
    predictionCritical: intent.predictionIntent,
  })

  const packet = answerContract({ mode, intent, result: intelligenceResult, policy })
  const reasoningTrail = reasoningEvents(intelligenceResult, policy)
  const workManifest = buildWorkManifest({ policy, result: intelligenceResult })

  return freeze({
    intent,
    risk,
    policy,
    intelligence: intelligenceResult,
    packet,
    reasoningTrail,
    workManifest,
  })
}

export function compareAskDwRuntimeModes({ normal, deep } = {}) {
  if (!normal?.packet || !deep?.packet) throw new Error('normal and deep runtime results required')
  return compareAskDwModes({
    normalResult: {
      canonicalFacts: normal.packet.canonicalFacts,
      authority: normal.packet.authority,
      hardSafetyOutcome: normal.packet.hardSafetyOutcome,
    },
    deepResult: {
      canonicalFacts: deep.packet.canonicalFacts,
      authority: deep.packet.authority,
      hardSafetyOutcome: deep.packet.hardSafetyOutcome,
    },
  })
}
