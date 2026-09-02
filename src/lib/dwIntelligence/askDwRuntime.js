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
import {
  askDwTurnToJob,
  classifyAskDwConversationalTurn,
} from './askDwConversationalTurn.js'
import { ASK_DW_READ_TOOL } from './askDwToolRuntime.js'

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

function assertScopedReadEnvelope({ output, name, scope, tenantId, canonicalAuthority }) {
  if (
    !output ||
    output.name !== name ||
    output.scope !== scope ||
    output.tenantId !== tenantId ||
    output.canonicalAuthority !== canonicalAuthority ||
    output.readOnly !== true ||
    output.sideEffect !== false ||
    !output.result ||
    typeof output.result !== 'object'
  ) {
    throw new Error(`Ask DW scoped snapshot ${name} provenance invalid`)
  }
}

function runScopedConversationCore({
  mode,
  text,
  context,
  snapshot,
}) {
  if (!snapshot || snapshot.tenantId !== context.tenantId) {
    throw new Error('Ask DW scoped snapshot tenant mismatch')
  }
  if (!['CLIENT', 'PORTFOLIO'].includes(snapshot.scope)) {
    throw new Error('Ask DW scoped snapshot scope invalid')
  }
  if (snapshot.scope === 'CLIENT' && (!snapshot.clientId || snapshot.clientId !== context.clientId)) {
    throw new Error('Ask DW scoped snapshot client mismatch')
  }
  if (context.asOf && snapshot.asOf !== context.asOf) {
    throw new Error('Ask DW scoped snapshot freshness mismatch')
  }
  assertScopedReadEnvelope({
    output: snapshot.canonicalState,
    name: ASK_DW_READ_TOOL.CANONICAL_STATE,
    scope: snapshot.scope,
    tenantId: snapshot.tenantId,
    canonicalAuthority: true,
  })
  assertScopedReadEnvelope({
    output: snapshot.portfolioSummary,
    name: ASK_DW_READ_TOOL.PORTFOLIO_SUMMARY,
    scope: snapshot.scope,
    tenantId: snapshot.tenantId,
    canonicalAuthority: false,
  })
  if (
    snapshot.scope === 'CLIENT' &&
    snapshot.canonicalState.result.found === true &&
    snapshot.canonicalState.result.client?.id !== snapshot.clientId
  ) {
    throw new Error('Ask DW scoped snapshot canonical client mismatch')
  }

  const turn = classifyAskDwConversationalTurn({ text, context })
  const mapped = askDwTurnToJob(turn)
  const intent = freeze({
    job: mapped.job,
    scope: snapshot.scope,
    actionIntent: mapped.actionIntent === true,
    predictionIntent: false,
    confidence: 'DETERMINISTIC_CONVERSATION_SCOPE',
    source: 'scoped_conversation_core',
  })
  const blockedAction = intent.actionIntent === true
  const policy = buildAskDwModePolicy({
    mode,
    risk: blockedAction ? ASK_DW_RISK.HIGH : ASK_DW_RISK.MEDIUM,
    actionIntent: blockedAction,
  })
  const canonicalFacts = freeze({
    tenantId: snapshot.tenantId,
    scope: snapshot.scope,
    clientId: snapshot.clientId ?? null,
    canonicalState: snapshot.canonicalState.result,
    portfolioSummary: snapshot.portfolioSummary.result,
    asOf: snapshot.asOf,
  })
  const authority = freeze({
    actual: 'NOT_GRANTED',
    policyAuthorized: false,
    canActAutomatically: false,
    basis: blockedAction ? 'invoice_reference_required_for_action' : 'read_only_scoped_conversation',
  })
  const executiveState = blockedAction ? 'BLOCKED' : 'WATCH'
  const hardSafety = blockedAction ? 'BLOCKED' : 'NO_UNAUTHORIZED_SIDE_EFFECT'
  const packet = freeze({
    mode,
    requestedMode: policy.requestedMode,
    internalDepth: policy.internalDepth,
    autoEscalated: policy.autoEscalated,
    job: intent.job,
    responseShape: policy.responseContract,
    executiveState,
    canonicalFacts,
    arState: null,
    evidenceRefs: [],
    claims: [],
    precedent: null,
    uncertainty: snapshot.portfolioSummary.result?.complete === false
      ? { actionable: false, reasons: ['BOUNDED_SCOPE_INCOMPLETE'] }
      : null,
    recommendation: null,
    constraints: {
      readOnly: true,
      invoiceRequiredForAction: true,
      scopedActionBlocked: blockedAction,
    },
    authority,
    hardSafetyOutcome: hardSafety,
    needsYou: { required: false, reason: null, question: null },
    safeguards: {
      canonicalMutationFromConversation: false,
      directProviderExecutionFromConversation: false,
      rawChainOfThoughtVisible: false,
      serverRevalidationRequired: true,
    },
  })
  const reasoningTrail = [
    freeze({
      type: 'ENTITY_RESOLUTION',
      observable: true,
      summary: snapshot.scope === 'CLIENT'
        ? `Resolved tenant-scoped client ${snapshot.clientId}.`
        : 'Resolved the authenticated tenant portfolio.',
    }),
    freeze({
      type: 'CANONICAL_TRUTH_READ',
      observable: true,
      summary: `Read current ${snapshot.scope.toLowerCase()} canonical state through the bounded read-only registry.`,
    }),
    freeze({
      type: 'AUTHORITY_CHECK',
      observable: true,
      summary: 'Scoped conversation granted no execution authority.',
    }),
  ]

  return freeze({
    intent,
    risk: blockedAction ? ASK_DW_RISK.HIGH : ASK_DW_RISK.MEDIUM,
    policy,
    intelligence: {
      state: executiveState,
      execution: { mode: 'none', sideEffect: false, outcome: blockedAction ? 'BLOCKED_INVOICE_REQUIRED' : 'NO_ACTION' },
      hardViolations: [],
    },
    packet,
    reasoningTrail,
    workManifest: {
      completedDeterministicWork: ['tenant_scope', 'canonical_scoped_read', 'authority_non_escalation'],
      requiredModelOrToolWork: policy.internalDepth === 'deep'
        ? ['competing_hypothesis_analysis', 'independent_verification']
        : [],
      completedModelOrToolWork: [],
      truthfullyPending: policy.internalDepth === 'deep',
    },
  })
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
  if (intelligenceInput?.conversationScopeSnapshot) {
    return runScopedConversationCore({
      mode,
      text,
      context,
      snapshot: intelligenceInput.conversationScopeSnapshot,
    })
  }
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
