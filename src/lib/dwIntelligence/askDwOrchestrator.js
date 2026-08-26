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

function buildPlannerInput({ text, context, core }) {
  return {
    question: String(text || ''),
    requestedMode: core.policy?.requestedMode,
    internalDepth: core.policy?.internalDepth,
    job: core.intent?.job,
    scope: core.intent?.scope,
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

function buildSynthesisInput({ text, core, plan, toolRuns }) {
  return {
    question: String(text || ''),
    requestedMode: core.policy?.requestedMode,
    internalDepth: core.policy?.internalDepth,
    job: core.intent?.job,
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

function buildVerificationInput({ core, candidate, plan, toolRuns }) {
  return {
    verificationMode: 'FRESH_CONTEXT',
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

      const scopedContext = freeze({
        tenantId,
        invoiceId: context.invoiceId ?? intelligenceInput.invoice?.id ?? null,
        clientId: context.clientId ?? intelligenceInput.client?.id ?? null,
        asOf: context.asOf ?? intelligenceInput.now ?? null,
      })

      const core = await deterministicCore({ mode, text, context, proposedIntent, intelligenceInput })
      const truthLock = lockTruth(core)
      const plan = await primaryModel.plan(buildPlannerInput({ text, context: scopedContext, core }))
      const toolRuns = await executeRequests({ requests: plan.toolRequests, registry: toolRegistry, context: scopedContext })
      const candidate = await primaryModel.synthesize(buildSynthesisInput({ text, core, plan, toolRuns }))
      const modelVerification = await verifierModel.verify(buildVerificationInput({ core, candidate, plan, toolRuns }))
      const verification = hardenVerification({
        verification: modelVerification,
        candidate,
        toolRuns,
      })

      const answer = verification.verdict === 'PASS' ? candidate : answerFallback(core)
      const reasoningTrail = buildReasoningTrail({ core, plan, toolRuns, verification })
      const workManifest = buildWorkManifest({ core, plan, toolRuns, verification })

      return freeze({
        core,
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
          rawChainOfThoughtVisible: false,
        }),
      })
    },
  })
}
