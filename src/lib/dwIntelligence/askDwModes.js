export const ASK_DW_MODE = Object.freeze({
  NORMAL: 'normal',
  DEEP: 'deep',
})

export const ASK_DW_RISK = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
})

const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 })

export const ASK_DW_CORRECTNESS_FLOOR = Object.freeze([
  'resolve_relevant_entities',
  'read_canonical_financial_truth',
  'retrieve_relevant_evidence',
  'preserve_provenance',
  'separate_fact_inference_prediction_recommendation_authority',
  'abstain_on_material_missing_evidence',
  'check_answer_changing_contradictions',
  'verify_material_claims_before_finalizing',
])

export const ASK_DW_ACTION_FLOOR = Object.freeze([
  'revalidate_current_state',
  'check_execution_authority',
  'refuse_self_granted_authority',
  'route_execution_through_server_boundary',
  'produce_execution_receipt_if_executed',
])

export const ASK_DW_DEEP_PASSES = Object.freeze([
  'generate_competing_hypotheses_when_relevant',
  'search_for_disconfirming_evidence',
  'retrieve_structurally_applicable_precedent_when_relevant',
  'run_shrinkage_or_statistical_context_when_relevant',
  'assess_uncertainty_and_prediction_sharpness_when_relevant',
  'run_counterfactual_or_sensitivity_analysis_when_relevant',
  'challenge_first_recommendation',
  'perform_independent_verification_pass',
  'synthesize_executive_answer_with_limitations',
])

export const ASK_DW_VISIBLE_REASONING_EVENT_TYPES = Object.freeze([
  'ENTITY_RESOLUTION',
  'CANONICAL_TRUTH_READ',
  'EVIDENCE_RETRIEVAL',
  'EVIDENCE_ADMISSION',
  'PRECEDENT_SEARCH',
  'HYPOTHESIS_TEST',
  'CONTRADICTION_CHECK',
  'UNCERTAINTY_ASSESSMENT',
  'COUNTERFACTUAL_CHECK',
  'VERIFICATION_PASS',
  'AUTHORITY_CHECK',
  'EXECUTION_RECEIPT',
])

function unique(items) {
  return [...new Set(items)]
}

function assertMode(mode) {
  if (!Object.values(ASK_DW_MODE).includes(mode)) {
    throw new Error(`Unsupported Ask DW mode: ${mode}`)
  }
}

function assertRisk(risk) {
  if (!Object.hasOwn(RISK_RANK, risk)) {
    throw new Error(`Unsupported Ask DW risk: ${risk}`)
  }
}

/**
 * Normal and Deep share the exact same truth/safety floor.
 *
 * Requested mode controls depth and answer shape. Risk can increase internal
 * analysis even when the founder selected Normal, so "Normal" is never a
 * cheaper correctness mode.
 */
export function buildAskDwModePolicy({
  mode = ASK_DW_MODE.NORMAL,
  risk = ASK_DW_RISK.MEDIUM,
  actionIntent = false,
  materialContradiction = false,
  predictionCritical = false,
} = {}) {
  assertMode(mode)
  assertRisk(risk)

  const autoDeep =
    RISK_RANK[risk] >= RISK_RANK.high ||
    materialContradiction === true ||
    predictionCritical === true

  const deepAnalysis = mode === ASK_DW_MODE.DEEP || autoDeep
  const mandatoryPasses = unique([
    ...ASK_DW_CORRECTNESS_FLOOR,
    ...(actionIntent ? ASK_DW_ACTION_FLOOR : []),
  ])

  const analysisPasses = unique([
    ...mandatoryPasses,
    ...(deepAnalysis ? ASK_DW_DEEP_PASSES : []),
  ])

  return Object.freeze({
    requestedMode: mode,
    risk,
    actionIntent: actionIntent === true,
    internalDepth: deepAnalysis ? 'deep' : 'standard',
    autoEscalated: mode === ASK_DW_MODE.NORMAL && deepAnalysis,
    mandatoryPasses,
    analysisPasses,
    responseContract: mode === ASK_DW_MODE.DEEP
      ? Object.freeze({
          format: 'deep',
          requiredSections: Object.freeze([
            'executive_conclusion',
            'evidence_basis',
            'competing_explanations_when_relevant',
            'uncertainty_and_limitations',
            'recommendation_or_next_step',
            'authority_if_actionable',
          ]),
          reasoningTrail: 'expanded_observable_summary',
          rawChainOfThoughtVisible: false,
        })
      : Object.freeze({
          format: 'normal',
          requiredSections: Object.freeze([
            'direct_answer',
            'sufficient_reason',
            'evidence_or_basis',
            'next_step_when_relevant',
          ]),
          reasoningTrail: 'compact_observable_summary_on_demand',
          rawChainOfThoughtVisible: false,
        }),
  })
}

/**
 * Deep may be more complex, but for the same canonical snapshot it must not
 * "improve" by changing financial truth, execution authority, or hard-safety
 * outcome. Differences should be depth, uncertainty treatment and synthesis.
 */
export function compareAskDwModes({ normalResult, deepResult } = {}) {
  if (!normalResult || !deepResult) throw new Error('normalResult and deepResult required')

  const mismatches = []
  for (const field of ['canonicalFacts', 'authority', 'hardSafetyOutcome']) {
    if (JSON.stringify(normalResult[field]) !== JSON.stringify(deepResult[field])) {
      mismatches.push(field)
    }
  }

  return Object.freeze({
    compatible: mismatches.length === 0,
    mismatches,
  })
}

export function validateReasoningTrail(events = []) {
  return events.every((event) =>
    event &&
    ASK_DW_VISIBLE_REASONING_EVENT_TYPES.includes(event.type) &&
    event.observable === true &&
    typeof event.summary === 'string' &&
    event.summary.trim().length > 0 &&
    event.rawChainOfThought !== true
  )
}
