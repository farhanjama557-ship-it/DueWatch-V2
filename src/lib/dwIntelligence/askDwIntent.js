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

  let job = ASK_DW_JOB.EXPLAIN
  let confidence = ASK_DW_INTENT_CONFIDENCE.MEDIUM

  if (hasAny(value, ['send ', 'email ', 'remind ', 'pause ', 'resume ', 'apply cash', 'write off', 'issue credit', 'do it', 'take care of']) || isMarkPaidCommand(value)) {
    job = ASK_DW_JOB.ACT
    confidence = ASK_DW_INTENT_CONFIDENCE.HIGH
  } else if (hasAny(value, ['what should', 'should we', 'recommend', 'best next', 'next action', 'what do we do'])) {
    job = ASK_DW_JOB.DECIDE
    confidence = ASK_DW_INTENT_CONFIDENCE.HIGH
  } else if (hasAny(value, ['when will', 'predict', 'forecast', 'likely to pay', 'cash this week', 'cash this month'])) {
    job = ASK_DW_JOB.PREDICT
    confidence = ASK_DW_INTENT_CONFIDENCE.HIGH
  } else if (hasAny(value, ['why ', 'investigate', 'what happened', 'unusual', 'dig into', 'find out', 'are you sure'])) {
    job = ASK_DW_JOB.INVESTIGATE
    confidence = ASK_DW_INTENT_CONFIDENCE.HIGH
  }

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
