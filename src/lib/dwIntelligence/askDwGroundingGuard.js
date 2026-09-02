/**
 * M2G-G7 deterministic grounding guard.
 *
 * A verifier model alone is not sufficient. This module checks a candidate
 * answer against the deterministic packet WITHOUT asking a model anything, so
 * the classes of claim that are cheap to check mechanically -- money figures,
 * identities, payment status, permission, Company Brain assertions -- are
 * checked mechanically.
 *
 * It only ever downgrades a verdict. It can turn PASS into REVISE or BLOCK; it
 * can never turn REVISE or BLOCK into PASS.
 */

export const ASK_DW_GROUNDING_ISSUE = Object.freeze({
  UNGROUNDED_AMOUNT: 'UNGROUNDED_AMOUNT',
  UNGROUNDED_IDENTIFIER: 'UNGROUNDED_IDENTIFIER',
  UNSUPPORTED_PAYMENT_CLAIM: 'UNSUPPORTED_PAYMENT_CLAIM',
  CLAIMED_AUTHORITY_WITHOUT_GRANT: 'CLAIMED_AUTHORITY_WITHOUT_GRANT',
  CLAIMED_EXECUTION: 'CLAIMED_EXECUTION',
  RESOLVED_AN_UNRESOLVED_CONFLICT: 'RESOLVED_AN_UNRESOLVED_CONFLICT',
  COMPANY_BRAIN_CLAIM_UNAVAILABLE: 'COMPANY_BRAIN_CLAIM_UNAVAILABLE',
  SYCOPHANTIC_REVERSAL: 'SYCOPHANTIC_REVERSAL',
})

const MONEY_PATTERN = /(?:[$£€]\s?)(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*\.\d{2})\b/g
// The match must contain a digit after the INV/INVOICE prefix, so ordinary
// prose ("the invoice is still open") is not mistaken for an identifier.
const IDENTIFIER_PATTERN = /\bINV(?:OICE)?[-\s#]?[A-Z0-9]*\d[A-Z0-9-]*\b/gi

// Phrased as "I <verb> ... <object>" with a short gap, so a determiner or a
// noun in between cannot slip an execution claim past the guard.
const EXECUTION_ADVERB = "(?:just |already |now |today |(?:went|gone|go) ahead and )?"
// "I <adverb?> <verb>" covers "I sent", "I've already emailed", "I went ahead
// and issued", so a filler word cannot slip an execution claim past the guard.
const EXECUTION_CLAIMS = [
  new RegExp(`\\bi(?:'ve| have| just)?\\s+${EXECUTION_ADVERB}(?:sent|emailed|issued|charged|processed|reconciled|refunded|applied|cancelled|canceled)\\b`, 'i'),
  new RegExp(`\\bi(?:'ve| have| just)?\\s+${EXECUTION_ADVERB}marked\\b[^.]{0,40}\\bpaid\\b`, 'i'),
  new RegExp(`\\bi(?:'ve| have| just)?\\s+${EXECUTION_ADVERB}(?:wrote|written)\\b[^.]{0,20}\\boff\\b`, 'i'),
  new RegExp(`\\bi(?:'ve| have| just)?\\s+${EXECUTION_ADVERB}updated\\b[^.]{0,30}\\binvoice\\b`, 'i'),
]

const PAID_CLAIMS = [
  /\b(?:is|was|has been) (?:now )?paid\b/i, /\bpayment (?:is )?confirmed\b/i,
  /\bthey (?:have )?paid\b/i, /\bfully settled\b/i, /\bpaid in full\b/i,
]

const CONFLICT_RESOLUTION_CLAIMS = [
  /\bthe contract governs\b/i, /\bcompany policy governs\b/i, /\bwe should use the\b/i,
  /\bthe (?:correct|right) rate is\b/i, /\bthat settles\b/i, /\bso the answer is\b/i,
]

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function candidateText(candidate) {
  return [
    candidate?.executiveConclusion,
    ...safeArray(candidate?.evidenceBasis),
    ...safeArray(candidate?.uncertaintyAndLimitations),
    candidate?.recommendationOrNextStep,
    ...safeArray(candidate?.competingExplanations),
  ].filter(Boolean).join('\n')
}

function normalizeNumber(value) {
  return String(value).replace(/[,\s]/g, '').replace(/^0+(?=\d)/, '')
}

/** Every number the deterministic layer actually supports the model saying. */
function groundedNumbers({ truthLock, toolRuns }) {
  const values = new Set()
  const walk = (node) => {
    if (node == null) return
    if (typeof node === 'number') { values.add(normalizeNumber(node)); return }
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\d[\d,]*(?:\.\d+)?/g)) values.add(normalizeNumber(match[0]))
      return
    }
    if (typeof node !== 'object') return
    for (const nested of Object.values(node)) walk(nested)
  }
  walk(truthLock)
  for (const run of safeArray(toolRuns)) walk(run?.output?.result ?? run?.result ?? null)
  return values
}

function groundedIdentifiers({ truthLock, toolRuns, caseContext }) {
  const ids = new Set()
  const walk = (node) => {
    if (node == null) return
    if (typeof node === 'string') { ids.add(node.toUpperCase()); return }
    if (typeof node !== 'object') return
    for (const nested of Object.values(node)) walk(nested)
  }
  walk(truthLock)
  walk(caseContext)
  for (const run of safeArray(toolRuns)) walk(run?.output?.result ?? run?.result ?? null)
  return ids
}

function downgrade(verdict, target) {
  if (verdict === 'BLOCK') return 'BLOCK'
  if (target === 'BLOCK') return 'BLOCK'
  return 'REVISE'
}

function activeFocus(caseContext) {
  return {
    clientId: caseContext?.focus?.clientRef?.id ?? null,
    invoiceId: caseContext?.focus?.invoiceRef?.id ?? null,
  }
}

function hasMaterialDimensions(value) {
  if (value == null || value === '') return false
  if (Array.isArray(value)) return value.some(hasMaterialDimensions)
  if (typeof value === 'object') return Object.values(value).some(hasMaterialDimensions)
  return true
}

function grantIsCurrentAt(grant, evaluatedAt) {
  const at = Date.parse(evaluatedAt)
  if (!Number.isFinite(at)) return false
  const from = Date.parse(grant?.effectiveFrom)
  if (!Number.isFinite(from)) return false
  const hasExpiry = grant?.expiresAt != null
  const expires = hasExpiry ? Date.parse(grant.expiresAt) : null
  if (hasExpiry && !Number.isFinite(expires)) return false
  if (at < from) return false
  if (expires != null && at >= expires) return false
  return true
}

function grantMatchesFocus(grant, caseContext, evaluatedAt) {
  if (grant?.status !== 'GRANTED') return false
  if (!grantIsCurrentAt(grant, evaluatedAt)) return false
  if (grant?.approvalRequirement !== 'NONE') return false
  if (hasMaterialDimensions(grant?.conditions) || hasMaterialDimensions(grant?.limits)) return false
  const focus = activeFocus(caseContext)
  const level = String(grant?.scope?.level || '').toUpperCase()
  if (level === 'COMPANY') return true
  if (level === 'CLIENT') {
    return Boolean(focus.clientId && grant?.scope?.clientId === focus.clientId)
  }
  if (level === 'ENTITY') {
    return Boolean(
      focus.invoiceId &&
      String(grant?.scope?.entityType || '').toUpperCase() === 'INVOICE' &&
      grant?.scope?.entityId === focus.invoiceId
    )
  }
  return false
}

function authorityClauses(text) {
  return String(text || '')
    .split(/(?:[.!?;\n]+|\bbut\b|\bhowever\b)/i)
    .map((clause) => clause.trim().toLowerCase())
    .filter(Boolean)
}

function clauseClaimsAuthority(clause) {
  if (/\b(?:no|not|never|without|cannot|can't|isn't|aren't|doesn't|didn't|hasn't|haven't)\b/.test(clause)) {
    return false
  }
  return [
    /\b(?:i(?:'m|\s+am)|we(?:'re|\s+are)|(?:dw|duewatch)\s+is)\s+(?:currently\s+)?(?:authori[sz]ed|allowed|permitted)\b/,
    /\b(?:i|we|dw|duewatch)\s+(?:have|has)\s+(?:the\s+)?(?:permission|authority)\b/,
    /\b(?:i|we|dw|duewatch)\s+can\s+(?:go ahead(?:\s+and)?|send|email|text|apply|waive|settle|write|issue|refund|charge|process|reconcile|handle|act|do)\b/,
    /\b(?:(?:the|this|a)\s+)?(?:(?:current|active|standing|explicit)\s+)?(?:authority\s+)?grant\s+(?:currently\s+)?(?:covers|allows|permits|authori[sz]es|includes)\b/,
    /\b(?:permission|authority)\s+(?:currently\s+)?(?:covers|allows|permits|authori[sz]es|includes|exists|(?:has been|was|is) granted)\b/,
    /\byou\s+(?:(?:have|'ve)\s+)?(?:granted|given|gave)\s+(?:(?:me|us|dw|duewatch)\s+)?(?:permission|authority)\b/,
    /\byou(?:'ve|\s+have)?\s+authori[sz]ed\s+(?:me|us|dw|duewatch)\b/,
  ].some((pattern) => pattern.test(clause))
}

function claimsAuthority(text) {
  return authorityClauses(text).some(clauseClaimsAuthority)
}

function claimedAction(text) {
  const actions = new Set()
  if (/\bcollection\s+(?:message|notice|email)s?\b/i.test(text)) actions.add('SEND_COLLECTION_MESSAGE')
  if (/\breminder(?:s|\s+(?:email|message)s?)?\b/i.test(text) &&
      !/\bcollection\s+reminder/i.test(text)) actions.add('SEND_REMINDER')
  if (/\bapply\b[^.]{0,24}\blate fee\b/i.test(text)) actions.add('APPLY_LATE_FEE')
  if (/\bwaive\b[^.]{0,24}\blate fee\b/i.test(text)) actions.add('WAIVE_LATE_FEE')
  if (/\bsettle\b/i.test(text)) actions.add('SETTLE_INVOICE')
  if (/\bwrite(?:-| )?off\b/i.test(text)) actions.add('WRITE_OFF_INVOICE')
  if (/\brefund\b/i.test(text)) actions.add('ISSUE_REFUND')
  return actions.size === 1 ? [...actions][0] : null
}

function claimedChannel(text) {
  const channels = new Set()
  if (/\be-?mail\b/i.test(text)) channels.add('EMAIL')
  if (/\b(?:sms|text(?:\s+message)?)\b/i.test(text)) channels.add('SMS')
  if (/\bwhats(?:app)?\b/i.test(text)) channels.add('WHATSAPP')
  if (/\b(?:phone|telephone|call)\b/i.test(text)) channels.add('PHONE')
  if (/\b(?:postal|post|letter)\b/i.test(text)) channels.add('POSTAL')
  if (/\bportal\b/i.test(text)) channels.add('PORTAL')
  return channels.size === 1 ? [...channels][0] : null
}

function authorityClaimSupported({ text, grants, caseContext, evaluatedAt }) {
  const action = claimedAction(text)
  const channel = claimedChannel(text)
  // An authority assertion must identify one exact G5 action. Vague or
  // multi-action wording cannot borrow the breadth of any current grant.
  if (!action) return false
  return grants.some((grant) => {
    if (!grantMatchesFocus(grant, caseContext, evaluatedAt)) return false
    if (grant.action !== action) return false
    // Channel-bound grants must be described with one exact named channel.
    // Missing, unrecognized, or multi-channel prose is deliberately inert.
    if (grant.channel != null && (!channel || grant.channel !== channel)) return false
    if (grant.channel == null && channel != null) return false
    return true
  })
}

/**
 * Checks a candidate answer deterministically.
 *
 * @param {object} input.candidate    the synthesized answer
 * @param {object} input.verification the model verifier's verdict
 * @param {object} input.truthLock    the locked deterministic truth
 * @param {Array}  input.toolRuns     admitted read-only tool runs
 * @param {object} input.companyBrainContext read-only G7 Company Brain context
 * @param {object} input.conversationalTurn  the classified founder turn
 */
export function enforceAskDwGrounding({
  candidate, verification, truthLock = null, toolRuns = [],
  companyBrainContext = null, conversationalTurn = null, caseContext = null,
} = {}) {
  const text = candidateText(candidate)
  const issues = []
  const add = (code, detail, severity = 'REVISE') => issues.push({ code, detail, severity })

  // Money and identifiers must trace to something deterministic.
  const numbers = groundedNumbers({ truthLock, toolRuns })
  for (const match of text.matchAll(MONEY_PATTERN)) {
    const value = normalizeNumber(match[1] ?? match[2])
    if (!numbers.has(value)) {
      add(ASK_DW_GROUNDING_ISSUE.UNGROUNDED_AMOUNT, `Amount ${match[0].trim()} is not in the locked truth or admitted tool results.`, 'BLOCK')
    }
  }
  const identifiers = groundedIdentifiers({ truthLock, toolRuns, caseContext })
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const raw = match[0].toUpperCase().replace(/\s/g, '-')
    const bare = raw.replace(/^INV(?:OICE)?[-#]?/, '')
    const known = [...identifiers].some((id) => id.includes(bare) || id.includes(raw))
    if (!known) {
      add(ASK_DW_GROUNDING_ISSUE.UNGROUNDED_IDENTIFIER, `Identifier ${match[0]} does not appear in admitted state.`, 'BLOCK')
    }
  }

  // Claiming an action happened, or that permission exists, is never the
  // model's to assert: both come from the deterministic layer.
  if (EXECUTION_CLAIMS.some((pattern) => pattern.test(text))) {
    add(ASK_DW_GROUNDING_ISSUE.CLAIMED_EXECUTION, 'Candidate claims an action was performed.', 'BLOCK')
  }
  if (claimsAuthority(text)) {
    const grants = safeArray(companyBrainContext?.authority?.currentGrants)
    if (!authorityClaimSupported({
      text,
      grants,
      caseContext,
      evaluatedAt: companyBrainContext?.authority?.evaluatedAt,
    })) {
      add(ASK_DW_GROUNDING_ISSUE.CLAIMED_AUTHORITY_WITHOUT_GRANT,
        'Candidate claims authority without a current grant matching the active scope, action, and channel.', 'BLOCK')
    }
  }

  // A payment assertion needs canonical support, not conversational pressure.
  if (PAID_CLAIMS.some((pattern) => pattern.test(text))) {
    const canonical = truthLock?.canonicalFacts ?? {}
    const supported = canonical.paid === true ||
      String(canonical.canonicalStatus || '').toUpperCase().includes('PAID') ||
      String(canonical.canonicalStatus || '').toUpperCase().includes('SETTLED')
    if (!supported) {
      add(ASK_DW_GROUNDING_ISSUE.UNSUPPORTED_PAYMENT_CLAIM, 'Candidate states the invoice is paid without canonical support.', 'BLOCK')
    }
  }

  // An unresolved conflict may be described, never quietly decided.
  if (companyBrainContext?.available) {
    const unresolved = safeArray(companyBrainContext.conflicts)
      .filter((conflict) => conflict.conflictStatus === 'CONFLICTED')
    if (unresolved.length > 0 && CONFLICT_RESOLUTION_CLAIMS.some((pattern) => pattern.test(text))) {
      add(ASK_DW_GROUNDING_ISSUE.RESOLVED_AN_UNRESOLVED_CONFLICT,
        'Candidate picks a governing rule while a founder decision is still outstanding.', 'BLOCK')
    }
  } else if (/\b(?:our|company) policy\b|\byou (?:approved|decided|told me)\b/i.test(text)) {
    add(ASK_DW_GROUNDING_ISSUE.COMPANY_BRAIN_CLAIM_UNAVAILABLE,
      'Candidate asserts Company Brain content while the Company Brain read was unavailable.', 'BLOCK')
  }

  // Under explicit founder pressure, a reversal must come from evidence.
  if (conversationalTurn?.founderPressure === true) {
    const reversal = /\byou'?re (?:absolutely )?right\b|\byou are (?:absolutely )?right\b|\bmy mistake\b/i
    if (reversal.test(text)) {
      add(ASK_DW_GROUNDING_ISSUE.SYCOPHANTIC_REVERSAL,
        'Candidate concedes under pressure without new admitted evidence.', 'BLOCK')
    }
  }

  if (issues.length === 0) return freeze({ ...verification, groundingIssues: [] })

  const worst = issues.some((issue) => issue.severity === 'BLOCK') ? 'BLOCK' : 'REVISE'
  return freeze({
    verdict: downgrade(verification?.verdict, worst),
    issues: [
      ...safeArray(verification?.issues),
      ...issues.map((issue) => `${issue.code}: ${issue.detail}`),
    ],
    checkedClaims: [
      ...safeArray(verification?.checkedClaims),
      'deterministic grounding guard applied',
    ],
    groundingIssues: issues.map((issue) => issue.code),
  })
}
