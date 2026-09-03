import {
  ASK_DW_OPERATION_MODE,
  classifyAskDwReadOnlyOperation,
  extractDirectAskDwOperationPhrase,
  recognizeRegisteredAskDwReadOnlyJob,
} from './askDwOperationStructure.js'

export { extractDirectAskDwOperationPhrase } from './askDwOperationStructure.js'

export const ASK_DW_JOB = Object.freeze({
  EXPLAIN: 'EXPLAIN',
  INVESTIGATE: 'INVESTIGATE',
  PREDICT: 'PREDICT',
  DECIDE: 'DECIDE',
  ACT: 'ACT',
})

export const ASK_DW_SCOPE = Object.freeze({
  INVOICE: 'INVOICE',
  CLIENT: 'CLIENT',
  PORTFOLIO: 'PORTFOLIO',
})

export const ASK_DW_INTENT_CONFIDENCE = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
})

function normalizedText(value) {
  return String(value || '').trim().toLowerCase()
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term))
}

function isMarkPaidCommand(text) {
  // Distinguish an imperative/action request ("mark this invoice paid")
  // from a status/investigation question ("why is this invoice marked paid?").
  // Past-tense "marked paid" is never an execution command.
  if (/\bmarked\s+(?:as\s+)?paid\b/.test(text)) return false
  return /\bmark\s+(?:(?:this|the)\s+)?(?:invoice\s+|it\s+)?(?:as\s+)?paid\b/.test(text)
}

const ACT_TERMS = Object.freeze([
  'send ', 'email ', 'remind ', 'pause ', 'resume ', 'apply cash', 'write off',
  'issue credit', 'do it', 'take care of',
])
const DECIDE_TERMS = Object.freeze([
  'what should', 'should we', 'best next', 'next action', 'what do we do',
])
const PREDICT_TERMS = Object.freeze([
  'when will', 'likely to pay', 'cash this week', 'cash this month',
])
const INVESTIGATE_TERMS = Object.freeze([
  'why ', 'what happened', 'unusual', 'are you sure',
])

export function isCompleteKnownReadOnlyModelOperation({ operationPhrase } = {}) {
  return classifyAskDwReadOnlyOperation({
    text: `I will ${String(operationPhrase || '')}`,
    mode: ASK_DW_OPERATION_MODE.MODEL_COMMITMENT,
  }).readOnly
}

function positivelyRecognizedJob(value) {
  if (hasAny(value, ACT_TERMS) || isMarkPaidCommand(value)) return ASK_DW_JOB.ACT
  if (hasAny(value, DECIDE_TERMS)) return ASK_DW_JOB.DECIDE
  if (hasAny(value, PREDICT_TERMS)) return ASK_DW_JOB.PREDICT
  if (hasAny(value, INVESTIGATE_TERMS)) return ASK_DW_JOB.INVESTIGATE
  return recognizeRegisteredAskDwReadOnlyJob(value)?.job ?? null
}

/**
 * The single positive proof that a prompt names a known non-side-effect Ask DW
 * job. Returning null is meaningful: it says "not positively recognized", not
 * EXPLAIN. Authority routing consumes this helper so its safety decision can
 * never rely on classifyAskDwIntent's usability fallback.
 */
export function recognizeKnownReadOnlyAskDwJob({ text, knownEntities = [] } = {}) {
  const value = normalizedText(text)
  if (!value) return null
  const operationPhrase = extractDirectAskDwOperationPhrase(text)
  const structural = operationPhrase == null ? null : classifyAskDwReadOnlyOperation({
    text,
    mode: ASK_DW_OPERATION_MODE.FOUNDER_REQUEST,
    knownEntities,
  })
  const job = operationPhrase == null ? positivelyRecognizedJob(value) : structural.job
  if (!job || job === ASK_DW_JOB.ACT) return null
  return Object.freeze({
    job,
    actionIntent: false,
    predictionIntent: job === ASK_DW_JOB.PREDICT,
    source: 'deterministic_positive_read_only_recognizer',
  })
}

/**
 * Deterministic bootstrap classifier for the runtime seam.
 *
 * This is intentionally conservative. A future model adapter may propose an
 * intent, but the runtime still validates the proposed job/scope before any
 * authority or execution path is considered.
 */
export function classifyAskDwIntent({ text, context = {} } = {}) {
  const value = normalizedText(text)
  if (!value) throw new Error('Ask DW text required')

  const recognizedJob = positivelyRecognizedJob(value)
  const job = recognizedJob ?? ASK_DW_JOB.EXPLAIN
  const confidence = recognizedJob && recognizedJob !== ASK_DW_JOB.EXPLAIN
    ? ASK_DW_INTENT_CONFIDENCE.HIGH
    : ASK_DW_INTENT_CONFIDENCE.MEDIUM

  let scope = ASK_DW_SCOPE.PORTFOLIO
  if (context.invoiceId || hasAny(value, ['invoice', 'inv-'])) scope = ASK_DW_SCOPE.INVOICE
  else if (context.clientId || hasAny(value, ['client', 'customer', 'account'])) scope = ASK_DW_SCOPE.CLIENT

  return Object.freeze({
    job,
    scope,
    confidence,
    actionIntent: job === ASK_DW_JOB.ACT,
    predictionIntent: job === ASK_DW_JOB.PREDICT,
    source: 'deterministic_bootstrap',
  })
}

export function validateProposedAskDwIntent(proposed = {}) {
  const job = String(proposed.job || '').toUpperCase()
  const scope = String(proposed.scope || '').toUpperCase()
  const validJob = Object.values(ASK_DW_JOB).includes(job)
  const validScope = Object.values(ASK_DW_SCOPE).includes(scope)

  return Object.freeze({
    valid: validJob && validScope,
    job: validJob ? job : null,
    scope: validScope ? scope : null,
    actionIntent: job === ASK_DW_JOB.ACT,
    predictionIntent: job === ASK_DW_JOB.PREDICT,
  })
}
