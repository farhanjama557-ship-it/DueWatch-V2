const FORBIDDEN_MODEL_KEYS = new Set([
  'authorityGranted',
  'canExecute',
  'executeNow',
  'canonicalMutation',
  'providerSend',
  'sideEffect',
  'rawChainOfThought',
])

const VERDICTS = new Set(['PASS', 'REVISE', 'BLOCK'])
const HYPOTHESIS_STATUS = new Set(['OPEN', 'SUPPORTED', 'WEAKENED', 'REJECTED'])

export const ASK_DW_G7_LANGUAGE_CONTRACT_VERSION = 'ASK_DW_G7_MODEL_CONTRACT_V1'

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
  const serialized = JSON.stringify(value)
  if (serialized == null) throw new Error('Ask DW model output must be JSON-serializable')
  return JSON.parse(serialized)
}

function inspectForbiddenKeys(value, path = '$') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectForbiddenKeys(item, `${path}[${index}]`))
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_MODEL_KEYS.has(key)) {
      throw new Error(`Ask DW model attempted to emit forbidden field at ${path}.${key}`)
    }
    inspectForbiddenKeys(nested, `${path}.${key}`)
  }
}

function validateToolRequests(requests, maxToolRequests) {
  const safe = safeArray(requests)
  if (safe.length > maxToolRequests) throw new Error('Ask DW model requested too many tools')
  return safe.map((request, index) => {
    if (!request || typeof request !== 'object') throw new Error(`Invalid Ask DW tool request at index ${index}`)
    const name = String(request.name || '').trim()
    const scope = String(request.scope || '').trim().toUpperCase()
    if (!name || !scope) throw new Error(`Ask DW tool request ${index} requires name and scope`)
    return Object.freeze({
      name,
      scope,
      reason: String(request.reason || '').trim() || 'material_answer_support',
      input: freeze(plainClone(request.input ?? {})),
    })
  })
}

function validateHypotheses(hypotheses) {
  return safeArray(hypotheses).slice(0, 8).map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Invalid Ask DW hypothesis at index ${index}`)
    const status = String(item.status || 'OPEN').toUpperCase()
    if (!HYPOTHESIS_STATUS.has(status)) throw new Error(`Invalid Ask DW hypothesis status: ${status}`)
    return Object.freeze({
      id: String(item.id || `H${index + 1}`),
      label: String(item.label || '').trim(),
      status,
      supportingEvidenceRefs: Object.freeze(safeArray(item.supportingEvidenceRefs).map(String)),
      refutingEvidenceRefs: Object.freeze(safeArray(item.refutingEvidenceRefs).map(String)),
    })
  })
}

function validatePlan(output, maxToolRequests) {
  const value = plainClone(output)
  inspectForbiddenKeys(value)
  return freeze({
    toolRequests: Object.freeze(validateToolRequests(value.toolRequests, maxToolRequests)),
    hypotheses: Object.freeze(validateHypotheses(value.hypotheses)),
    answerIntent: String(value.answerIntent || '').trim() || null,
  })
}

function validateSynthesis(output) {
  const value = plainClone(output)
  inspectForbiddenKeys(value)
  return freeze({
    executiveConclusion: String(value.executiveConclusion || '').trim(),
    evidenceBasis: Object.freeze(safeArray(value.evidenceBasis).map((item) => String(item))),
    uncertaintyAndLimitations: Object.freeze(safeArray(value.uncertaintyAndLimitations).map((item) => String(item))),
    recommendationOrNextStep: value.recommendationOrNextStep == null ? null : String(value.recommendationOrNextStep),
    competingExplanations: Object.freeze(safeArray(value.competingExplanations).map((item) => String(item))),
    citedToolRunIds: Object.freeze(safeArray(value.citedToolRunIds).map(String)),
  })
}

function validateVerification(output) {
  const value = plainClone(output)
  inspectForbiddenKeys(value)
  const verdict = String(value.verdict || '').toUpperCase()
  if (!VERDICTS.has(verdict)) throw new Error(`Invalid Ask DW verification verdict: ${verdict}`)
  return freeze({
    verdict,
    issues: Object.freeze(safeArray(value.issues).map((item) => String(item))),
    checkedClaims: Object.freeze(safeArray(value.checkedClaims).map((item) => String(item))),
  })
}

/**
 * Provider-agnostic model adapter. The injected invoke() may call a frontier
 * model, local model, or deterministic fixture. Its outputs are schema-checked
 * and cannot grant authority, execute side effects, or expose raw CoT.
 */
export function createAskDwModelAdapter({
  name = 'ask-dw-model',
  invoke,
  maxToolRequests = 12,
} = {}) {
  if (typeof invoke !== 'function') throw new Error('Ask DW model invoke function required')

  async function call(stage, input) {
    const raw = await invoke(freeze({
      stage,
      contract: Object.freeze({
        languageContract: ASK_DW_G7_LANGUAGE_CONTRACT_VERSION,
        financialTruthAuthority: 'DW_CONTROLLED_STATE_ONLY',
        executionAuthority: 'NEVER_GRANTED_BY_MODEL',
        rawChainOfThoughtVisible: false,
        toolsAreReadOnly: true,
      }),
      input: freeze(plainClone(input)),
    }))
    if (raw == null || typeof raw !== 'object') throw new Error(`Ask DW model ${name} returned invalid ${stage} output`)
    return raw
  }

  return freeze({
    name,
    async plan(input) {
      return validatePlan(await call('PLAN', input), maxToolRequests)
    },
    async synthesize(input) {
      return validateSynthesis(await call('SYNTHESIZE', input))
    },
    async verify(input) {
      return validateVerification(await call('VERIFY', input))
    },
  })
}
