import { buildAskDwCompanyBrainContext } from './askDwCompanyBrainContext.js'
import { classifyAskDwConversationalTurn } from './askDwConversationalTurn.js'
import { buildAskDwDailyPriorities } from './askDwDailyPriorities.js'
import { ASK_DW_TURN } from './askDwConversationalTurn.js'
import { buildAskDwAuthorityAnswer, renderAskDwAuthority } from './askDwAuthorityRenderer.js'
import { collectAskDwKnownEntities } from './askDwAuthorityProposition.js'
import { buildDwGovernanceContext } from './dwGovernanceContext.js'
import { enforceAskDwGrounding } from './askDwGroundingGuard.js'
import {
  DW_EPISTEMIC_LADDER,
  DW_RESPONSE_SHAPE,
  DW_STYLE_EXAMPLES,
  dwCharacterInstructions,
} from './askDwCharacterSpec.js'

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function plainClone(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

const FORBIDDEN_CASE_CONTEXT_KEYS = new Set([
  'amount',
  'amount_paid',
  'balance',
  'paid',
  'currency',
  'due_date',
  'inv_date',
  'invoice_date',
  'canonicalFacts',
  'canonical_facts',
  'rawToolResponse',
  'raw_tool_response',
  'toolOutput',
  'tool_output',
  'truthLock',
  'arState',
  'authority',
  'authoritySnapshot',
  'authority_snapshot',
  'authorized',
  'executionAuthorized',
  'canActAutomatically',
  'permissions',
])

function inspectCaseContext(value, path = '$caseContext') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectCaseContext(item, path + '[' + index + ']'))
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CASE_CONTEXT_KEYS.has(key)) {
      throw new Error('Ask DW forbidden case context field at ' + path + '.' + key)
    }
    inspectCaseContext(nested, path + '.' + key)
  }
}

function sanitizeCaseContext(value) {
  if (value == null) return null
  const cloned = plainClone(value)
  inspectCaseContext(cloned)
  return freeze(cloned)
}

/**
 * The Company Brain context is built and frozen here, from the G6 read model
 * the caller supplies. It travels beside caseContext rather than inside it, so
 * the existing "no money truth, no authority in conversational reference"
 * split is preserved exactly. Its own builder rejects canonical-money fields.
 */
function buildConversationLayer({ tenantId, text, caseContext, context }) {
  // The Company Brain is built FIRST. Authority-request routing and scope
  // resolution both run against the tenant's real known entities, so the turn
  // classifier cannot be asked to recognise a permission question before the
  // reference data that boundary depends on exists.
  const companyBrain = buildAskDwCompanyBrainContext({
    readModel: context.companyBrainReadModel ?? null,
    tenantId,
    focus: context.clientId ? { clientId: context.clientId } : null,
  })
  const knownEntities = collectAskDwKnownEntities({
    authorityProjection: companyBrain?.authority ?? null,
    companyBrainContext: companyBrain,
    caseContext,
  })
  const turn = classifyAskDwConversationalTurn({ text, context, caseContext, knownEntities })
  const priorities = buildAskDwDailyPriorities({
    tenantId,
    needsYouReadModel: context.needsYouReadModel ?? null,
    companyBrainContext: companyBrain,
  })
  // An explicit authority question is answered from the G5 -> G6 -> G7
  // projection, deterministically. The model may naturalise the explanation
  // around it; it never decides or restates the permission semantics.
  const authorityRendering = turn.turnType === ASK_DW_TURN.AUTHORITY_QUESTION
    ? renderAskDwAuthority({ authorityProjection: companyBrain?.authority ?? null })
    : null
  // For an authority question the ANSWER itself is deterministic. It is built
  // here so the model cannot own, replace or answer around the permission
  // proposition, whatever it and the verifier return.
  const authorityAnswer = turn.turnType === ASK_DW_TURN.AUTHORITY_QUESTION
    ? buildAskDwAuthorityAnswer({
      question: text,
      authorityProjection: companyBrain?.authority ?? null,
      companyBrainContext: companyBrain,
      caseContext,
      knownEntities,
    })
    : null
  // The governance envelope is built from the SAME Company Brain context, by
  // the same shared builder proactive DW Intelligence uses. Turn classification
  // and authority-answer rendering stay here, where the founder's utterance is:
  // proactive must not inherit them.
  const governance = buildDwGovernanceContext({
    tenantId, companyBrainContext: companyBrain, knownEntities,
  })
  // Reported authority travels as a typed, non-governing structure beside the
  // answer, so historical permission evidence has a home that is not free
  // model prose.
  return freeze({
    turn, companyBrain, knownEntities, priorities, authorityRendering, authorityAnswer,
    governance,
    authorityQuestionSemantic: authorityAnswer?.questionSemantic ?? null,
  })
}

function toolRunId(index, request) {
  return `tool-${String(index + 1).padStart(2, '0')}-${request.name}`
}

function answerFallback(core) {
  const packet = core.packet || {}
  return Object.freeze({
    executiveConclusion: `DW Intelligence state: ${packet.executiveState ?? 'UNKNOWN'}.`,
    evidenceBasis: Object.freeze(safeArray(packet.evidenceRefs).map((ref) => `Evidence ${ref}`)),
    uncertaintyAndLimitations: Object.freeze([
      'Model synthesis was withheld because independent verification did not pass.',
    ]),
    recommendationOrNextStep: packet.needsYou?.required
      ? packet.needsYou.question || 'Founder review is required.'
      : null,
    competingExplanations: Object.freeze([]),
    citedToolRunIds: Object.freeze([]),
  })
}

function lockTruth(core) {
  return freeze({
    canonicalFacts: plainClone(core.packet?.canonicalFacts ?? null),
    arState: plainClone(core.packet?.arState ?? null),
    authority: plainClone(core.packet?.authority ?? null),
    hardSafetyOutcome: core.packet?.hardSafetyOutcome ?? null,
    executiveState: core.packet?.executiveState ?? core.intelligence?.state ?? null,
  })
}

function buildPlannerInput({ text, context, core, caseContext = null, conversation = null }) {
  return {
    question: String(text || ''),
    requestedMode: core.policy?.requestedMode,
    internalDepth: core.policy?.internalDepth,
    job: core.intent?.job,
    scope: core.intent?.scope,
    caseContext,
    conversationalTurn: conversation?.turn ?? null,
    companyBrainContext: conversation?.companyBrain ?? null,
    authorityRendering: conversation?.authorityRendering ?? null,
    dailyPriorities: conversation?.priorities ?? null,
    truthPacket: {
      canonicalFacts: core.packet?.canonicalFacts ?? null,
      arState: core.packet?.arState ?? null,
      claims: core.packet?.claims ?? [],
      evidenceRefs: core.packet?.evidenceRefs ?? [],
      precedent: core.packet?.precedent ?? null,
      uncertainty: core.packet?.uncertainty ?? null,
      constraints: core.packet?.constraints ?? null,
      authority: core.packet?.authority ?? null,
      safeguards: core.packet?.safeguards ?? null,
    },
    scopedContext: {
      tenantId: context.tenantId,
      invoiceId: context.invoiceId ?? null,
      clientId: context.clientId ?? null,
      asOf: context.asOf ?? null,
    },
  }
}

async function executeRequests({ requests, registry, context }) {
  const runs = []
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]
    const output = await registry.execute({
      name: request.name,
      scope: request.scope,
      input: request.input,
      context,
    })
    runs.push(freeze({
      id: toolRunId(index, request),
      request,
      output,
      observable: true,
    }))
  }
  return Object.freeze(runs)
}

/**
 * DW's voice is carried in the synthesis INPUT rather than the edge function's
 * system instructions, because supabase/functions/_shared/askDwOpenAiContract.js
 * and ask-dw-model/index.ts are hash-locked M2D replay sources. Changing them
 * would break that lock, which is an earlier gate's artifact and not G7's to
 * re-cut. The model still receives the character spec on every synthesis; see
 * the G7 validation record for the mismatch this works around.
 */
function answerStyleFor(core) {
  const deep = core.policy?.internalDepth === 'deep' || core.policy?.requestedMode === 'deep'
  return freeze({
    character: dwCharacterInstructions(),
    epistemicLadder: [...DW_EPISTEMIC_LADDER],
    shape: deep ? DW_RESPONSE_SHAPE.DEEP : DW_RESPONSE_SHAPE.NORMAL,
    styleExamples: DW_STYLE_EXAMPLES.map((example) => ({
      founder: example.founder, dw: example.dw, demonstrates: example.demonstrates,
    })),
    // Style shapes wording only. It cannot widen what may be said.
    canChangeTruth: false,
    canGrantAuthority: false,
  })
}

function buildSynthesisInput({ text, core, plan, toolRuns, caseContext = null, conversation = null }) {
  return {
    answerStyle: answerStyleFor(core),
    question: String(text || ''),
    requestedMode: core.policy?.requestedMode,
    internalDepth: core.policy?.internalDepth,
    job: core.intent?.job,
    caseContext,
    conversationalTurn: conversation?.turn ?? null,
    companyBrainContext: conversation?.companyBrain ?? null,
    authorityRendering: conversation?.authorityRendering ?? null,
    dailyPriorities: conversation?.priorities ?? null,
    truthLock: lockTruth(core),
    claims: core.packet?.claims ?? [],
    uncertainty: core.packet?.uncertainty ?? null,
    constraints: core.packet?.constraints ?? null,
    needsYou: core.packet?.needsYou ?? null,
    hypotheses: plan.hypotheses,
    toolRuns: toolRuns.map((run) => ({
      id: run.id,
      name: run.output.name,
      scope: run.output.scope,
      sourceClass: run.output.sourceClass,
      canonicalAuthority: run.output.canonicalAuthority,
      result: run.output.result,
    })),
  }
}

function buildVerificationInput({ core, candidate, plan, toolRuns, caseContext = null, conversation = null }) {
  return {
    verificationMode: 'FRESH_CONTEXT',
    caseContext,
    conversationalTurn: conversation?.turn ?? null,
    companyBrainContext: conversation?.companyBrain ?? null,
    authorityRendering: conversation?.authorityRendering ?? null,
    truthLock: lockTruth(core),
    candidate,
    hypotheses: plan.hypotheses,
    admittedToolRuns: toolRuns.map((run) => ({
      id: run.id,
      name: run.output.name,
      sourceClass: run.output.sourceClass,
      canonicalAuthority: run.output.canonicalAuthority,
      result: run.output.result,
    })),
    requiredChecks: [
      'canonical_fact_consistency',
      'unsupported_material_claims',
      'contradiction_handling',
      'authority_non_escalation',
      'reconciliation_hold_respected',
      // G7: a Company Brain claim must trace to the supplied read context, and
      // conversational pressure is never a reason to move canonical truth.
      'company_brain_claims_supported',
      'founder_pressure_did_not_change_truth',
      'conversation_memory_not_treated_as_evidence',
    ],
  }
}

function hardenVerification({ verification, candidate, toolRuns }) {
  const admittedIds = new Set(toolRuns.map((run) => run.id))
  const citedIds = safeArray(candidate?.citedToolRunIds)
  const unknownIds = citedIds.filter((id) => !admittedIds.has(id))
  if (unknownIds.length === 0) return verification

  return freeze({
    verdict: verification?.verdict === 'BLOCK' ? 'BLOCK' : 'REVISE',
    issues: [
      ...safeArray(verification?.issues),
      `Candidate cited unknown tool run IDs: ${unknownIds.join(', ')}`,
    ],
    checkedClaims: [
      ...safeArray(verification?.checkedClaims),
      'cited tool run IDs validated deterministically',
    ],
  })
}
function buildReasoningTrail({ core, plan, toolRuns, verification }) {
  const trail = [...safeArray(core.reasoningTrail)]
  for (const run of toolRuns) {
    trail.push(freeze({
      type: run.output.name === 'precedent_search' ? 'PRECEDENT_SEARCH' : 'EVIDENCE_RETRIEVAL',
      observable: true,
      summary: `Executed read-only tool ${run.output.name} in ${run.output.scope} scope; canonicalAuthority=${run.output.canonicalAuthority}.`,
      toolRunId: run.id,
    }))
  }
  if (plan.hypotheses.length > 0) {
    trail.push(freeze({
      type: 'HYPOTHESIS_TEST',
      observable: true,
      summary: `Tracked ${plan.hypotheses.length} structured competing hypothesis${plan.hypotheses.length === 1 ? '' : 'es'} without exposing raw chain-of-thought.`,
    }))
  }
  trail.push(freeze({
    type: 'VERIFICATION_PASS',
    observable: true,
    summary: `Fresh-context verification verdict: ${verification.verdict}.`,
    status: verification.verdict,
  }))
  return Object.freeze(trail)
}

function buildWorkManifest({ core, plan, toolRuns, verification }) {
  const completed = [
    ...(plan.hypotheses.length > 0 ? ['competing_hypothesis_analysis'] : []),
    ...(toolRuns.length > 0 ? ['read_only_tool_retrieval'] : []),
    ...(toolRuns.some((run) => run.output.name === 'precedent_search') ? ['structural_precedent_retrieval'] : []),
    'model_answer_synthesis',
    'independent_verification',
  ]
  return freeze({
    ...plainClone(core.workManifest ?? {}),
    requiredModelOrToolWork: Object.freeze(safeArray(core.workManifest?.requiredModelOrToolWork)),
    completedModelOrToolWork: Object.freeze(completed),
    truthfullyPending: verification.verdict !== 'PASS',
  })
}

/**
 * Real Ask DW orchestration boundary.
 *
 * The deterministic core owns canonical financial truth and authority. Models
 * may plan read-only retrieval, maintain structured hypotheses, synthesize a
 * candidate answer and independently verify it. Tool/model output never
 * overwrites the truth lock and never gains execution authority.
 */
export function createAskDwOrchestrator({
  deterministicCore,
  primaryModel,
  verifierModel,
  toolRegistry,
} = {}) {
  if (typeof deterministicCore !== 'function') throw new Error('Ask DW deterministicCore required')
  if (!primaryModel?.plan || !primaryModel?.synthesize) throw new Error('Ask DW primaryModel required')
  if (!verifierModel?.verify) throw new Error('Ask DW verifierModel required')
  if (!toolRegistry?.execute) throw new Error('Ask DW toolRegistry required')

  return freeze({
    async run({ mode, text, context = {}, proposedIntent = null, intelligenceInput = {} } = {}) {
      const tenantId = String(context.tenantId || intelligenceInput.tenantId || '').trim()
      if (!tenantId) throw new Error('Ask DW orchestration tenantId required')
      const caseContext = sanitizeCaseContext(context.caseContext ?? null)

      const scopedContext = freeze({
        tenantId,
        invoiceId: context.invoiceId ?? intelligenceInput.invoice?.id ?? null,
        clientId: context.clientId ?? intelligenceInput.client?.id ?? null,
        asOf: context.asOf ?? intelligenceInput.now ?? null,
      })

      const conversation = buildConversationLayer({
        tenantId, text, caseContext, context,
      })

      const core = await deterministicCore({ mode, text, context, proposedIntent, intelligenceInput })
      const truthLock = lockTruth(core)
      const plan = await primaryModel.plan(buildPlannerInput({
        text,
        context: scopedContext,
        core,
        caseContext,
        conversation,
      }))
      const toolRuns = await executeRequests({
        requests: plan.toolRequests,
        registry: toolRegistry,
        context: scopedContext,
      })
      const candidate = await primaryModel.synthesize(buildSynthesisInput({
        text,
        core,
        plan,
        toolRuns,
        caseContext,
        conversation,
      }))
      const modelVerification = await verifierModel.verify(buildVerificationInput({
        core,
        candidate,
        plan,
        toolRuns,
        caseContext,
        conversation,
      }))
      // Two independent gates, in order: the existing deterministic tool-run
      // citation check, then the G7 grounding guard. Both may only downgrade a
      // verdict, so a model verifier saying PASS is never the last word.
      const citationChecked = hardenVerification({
        verification: modelVerification,
        candidate,
        toolRuns,
      })
      const verification = enforceAskDwGrounding({
        candidate,
        verification: citationChecked,
        truthLock,
        toolRuns,
        companyBrainContext: conversation.companyBrain,
        conversationalTurn: conversation.turn,
        caseContext,
      })

      // Answer ownership. An authority question is answered by deterministic
      // code even when the model and the verifier agree with each other: a
      // colluding "Yes." cannot become the permission answer.
      const answer = conversation.authorityAnswer
        ? conversation.authorityAnswer
        : verification.verdict === 'PASS' ? candidate : answerFallback(core)
      const reasoningTrail = buildReasoningTrail({ core, plan, toolRuns, verification })
      const workManifest = buildWorkManifest({ core, plan, toolRuns, verification })

      return freeze({
        core,
        conversation,
        truthLock,
        plan,
        toolRuns,
        candidate,
        verification,
        answer,
        reasoningTrail,
        workManifest,
        safeguards: freeze({
          modelCanMutateCanonicalTruth: false,
          modelCanGrantAuthority: false,
          toolsReadOnly: true,
          directProviderExecution: false,
          verificationRequiredBeforeModelNarrative: true,
          caseContextReferenceOnly: caseContext != null,
          rawChainOfThoughtVisible: false,
          // G7 additions. The Company Brain travels as read-only context and
          // no conversational turn can create permission.
          companyBrainReadOnly: true,
          companyBrainMutableFromConversation: false,
          conversationCanGrantAuthority: false,
          conversationMemoryIsEvidence: false,
          conversationMemoryCanOverrideLiveReads: false,
          prioritiesOrderedDeterministically: true,
          authorityRenderedDeterministically: conversation.authorityRendering != null,
          authorityAnswerOwnedByDeterministicCode: conversation.authorityAnswer != null,
          modelCanOwnAuthorityProposition: false,
          // The question's semantic kind is preserved rather than collapsed to
          // a governing/not-governing boolean, and the actor is validated
          // before any G5 grant is read.
          authorityQuestionSemanticPreserved: conversation.authorityQuestionSemantic != null,
          authorityQuestionActorValidatedBeforeResolution: true,
          quotedAuthorityCanGovern: false,
          // G8-CP1: both entry points admit input through one gate and read
          // one governance envelope, which references state and never owns it.
          sharedInvestigationAdmission: true,
          governanceEnvelopeIsReferenceOnly: conversation.governance?.governs === false,
          authorityPropositionsCheckedPerProposition: true,
          deterministicGroundingEnforced: true,
        }),
      })
    },
  })
}
