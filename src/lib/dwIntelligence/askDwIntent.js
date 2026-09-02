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
  'what should', 'should we', 'recommend', 'best next', 'next action',
  'what do we do', 'decide',
])
const PREDICT_TERMS = Object.freeze([
  'when will', 'predict', 'forecast', 'likely to pay', 'cash this week',
  'cash this month',
])
const INVESTIGATE_TERMS = Object.freeze([
  'why ', 'investigate', 'what happened', 'unusual', 'dig into', 'find out',
  'are you sure',
])

/**
 * Positive recognition for known explanation/read-only work. These predicates
 * describe bounded analysis of admitted state; an arbitrary unknown verb does
 * not match merely because classifyAskDwIntent would otherwise default it to
 * EXPLAIN.
 */
const EXPLAIN_PREDICATE = /\b(?:explain|summari[sz]e|show|describe|list|compare|analy[sz]e|clarify|review|inspect|read|calculate|watch|monitor)\b|\blook\s+up\b|\bcheck\s+(?:whether|if|the|this|that|what|which|when|where|why|how)\b|\bhelp\s+(?:me|us)\s+understand\b|\btell\s+(?:me|us)\s+(?:about|why|how|what|which|when|where|who|whether)\b/i

const LEADING_READ_ONLY_JOB = Object.freeze([
  [ASK_DW_JOB.DECIDE, /^(?:please\s+)?(?:recommend|decide)\b/i],
  [ASK_DW_JOB.PREDICT, /^(?:please\s+)?(?:forecast|predict)\b/i],
  [ASK_DW_JOB.INVESTIGATE, /^(?:please\s+)?(?:investigate|dig\s+into|find\s+out)\b/i],
  [ASK_DW_JOB.EXPLAIN, /^(?:please\s+)?(?:explain|summari[sz]e|show|describe|list|compare|analy[sz]e|clarify|review|inspect|read|calculate|watch|monitor|look\s+up|check\s+(?:whether|if|the|this|that|what|which|when|where|why|how)|help\s+(?:me|us)\s+understand|tell\s+(?:me|us)\s+(?:about|why|how|what|which|when|where|who|whether))\b/i],
])

// Model output keeps the pre-existing narrower promise vocabulary. It is
// deliberately distinct from founder input: recognizing an analysis request
// must not teach the model a new future/background commitment.
const LEADING_SAFE_MODEL_OUTPUT = /^(?:please\s+)?(?:explain|summari[sz]e|show|describe|list|compare|analy[sz]e|clarify|review|inspect|read|find|look\s+up|check\s+(?:whether|if|the|this|that|what|which|when|where|why|how)|calculate|watch|monitor|keep\s+(?:watching|monitoring)|help\s+(?:me|us)\s+understand|tell\s+(?:me|us)\s+(?:about|why|how|what|which|when|where|who|whether))\b/i

const SEQUENCED_OPERATION = /\s*(?:,\s*)?\b(?:and\s+then|then|but\s+also)\b\s*/i
const COORDINATED_OPERATION = /\s+\b(?:and|but|or)\b\s+/i
const NON_OPERATION_CONTINUATION = /^(?:why|how|what|which|when|where|who|whether)\b/i

function closedCompareObject(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^(?:the|this|that|these|those|my|our|their|its)\s+[\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,4}$/iu.test(text)) return true
  return /^[\p{Lu}][\p{L}\p{N}'-]*(?:\s+[\p{Lu}][\p{L}\p{N}'-]*){0,3}$/u.test(text)
}

function isClosedComparePair(value) {
  const match = /^(?:please\s+)?compare\s+(.+?)\s+and\s+(.+)$/i.exec(value)
  return Boolean(match && closedCompareObject(match[1]) && closedCompareObject(match[2]))
}

/**
 * Proves the whole operation phrase, not merely its first verb. Sequenced or
 * coordinated work is safe only when every operation component is positively
 * known. The sole noun-coordinate exception is a closed two-object comparison.
 */
function completeReadOnlyJob(operationPhrase, recognizeLeading) {
  const text = String(operationPhrase || '').trim().replace(/[.!?]+$/g, '').trim()
  const leadingJob = recognizeLeading(text)
  if (!leadingJob) return null

  const sequenced = text.split(SEQUENCED_OPERATION).map((part) => part.trim())
  if (sequenced.length > 1) {
    const jobs = sequenced.map((part) => completeReadOnlyJob(part, recognizeLeading))
    return jobs.every(Boolean) ? leadingJob : null
  }

  // An unparsed punctuation boundary cannot be proof of one bounded operation.
  if (/[,;.!?]/.test(text)) return null
  const coordinated = text.split(COORDINATED_OPERATION).map((part) => part.trim())
  if (coordinated.length === 1) return leadingJob
  if (coordinated.length === 2 && isClosedComparePair(text)) return leadingJob

  for (let index = 1; index < coordinated.length; index += 1) {
    const part = coordinated[index]
    if (NON_OPERATION_CONTINUATION.test(part)) continue
    if (!recognizeLeading(part)) return null
  }
  return leadingJob
}

/** The shared structural owner for a direct operation aimed at DW. */
export function extractDirectAskDwOperationPhrase(text) {
  const value = String(text || '').trim()
  const direct = /^(?:so\s+|and\s+|but\s+|ok(?:ay)?,?\s+|hey,?\s+)*(?:can|may|could|would|will|should|shall)\s+(?:you|dw|due\s?watch)\s+(.+)$/i.exec(value)
  if (direct) return direct[1]
  const going = /^(?:so\s+|and\s+|but\s+)*(?:are|is)\s+(?:you|dw|due\s?watch)\s+going\s+to\s+(.+)$/i.exec(value)
  if (going) return going[1]
  const planned = /^(?:so\s+|and\s+|but\s+)*(?:do|does)\s+(?:you|dw|due\s?watch)\s+(?:plan|intend|mean)\s+to\s+(.+)$/i.exec(value)
  return planned ? planned[1] : null
}

function leadingReadOnlyJob(value) {
  for (const [job, predicate] of LEADING_READ_ONLY_JOB) {
    if (predicate.test(value)) return job
  }
  return null
}

function leadingSafeModelOutput(value) {
  return LEADING_SAFE_MODEL_OUTPUT.test(value) ? ASK_DW_JOB.EXPLAIN : null
}

export function isCompleteKnownReadOnlyModelOperation({ operationPhrase } = {}) {
  return completeReadOnlyJob(operationPhrase, leadingSafeModelOutput) != null
}

function positivelyRecognizedJob(value) {
  if (hasAny(value, ACT_TERMS) || isMarkPaidCommand(value)) return ASK_DW_JOB.ACT
  if (hasAny(value, DECIDE_TERMS)) return ASK_DW_JOB.DECIDE
  if (hasAny(value, PREDICT_TERMS)) return ASK_DW_JOB.PREDICT
  if (hasAny(value, INVESTIGATE_TERMS)) return ASK_DW_JOB.INVESTIGATE
  if (EXPLAIN_PREDICATE.test(value)) return ASK_DW_JOB.EXPLAIN
  return null
}

/**
 * The single positive proof that a prompt names a known non-side-effect Ask DW
 * job. Returning null is meaningful: it says "not positively recognized", not
 * EXPLAIN. Authority routing consumes this helper so its safety decision can
 * never rely on classifyAskDwIntent's usability fallback.
 */
export function recognizeKnownReadOnlyAskDwJob({ text } = {}) {
  const value = normalizedText(text)
  if (!value) return null
  const operationPhrase = extractDirectAskDwOperationPhrase(text)
  const job = operationPhrase == null
    ? positivelyRecognizedJob(value)
    : completeReadOnlyJob(operationPhrase, leadingReadOnlyJob)
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
