/**
 * G8-CP2 — grounding for proactive narrative.
 *
 * Ask DW's answers pass enforceAskDwGrounding before a founder sees them.
 * Proactive output — a Pulse headline, a Needs You line, a "why this matters"
 * sentence — had no such gate at all. This module closes that, and does it by
 * reusing the existing OUTPUT grounding seam rather than by inventing a second
 * one.
 *
 * What it deliberately does NOT do is run proactive text through founder
 * OPERATION parsing. askDwOperationStructure reads founder command language;
 * an email, a contract or an SOP is not a founder issuing a command, and
 * treating retrieved company content as though it were is precisely how
 * injected text becomes an instruction. Retrieved material stays DATA here:
 * it is checked as a CLAIM, never interpreted as a request.
 *
 * The proactive-specific rules on top of the shared claim checks:
 *
 *   - No completed-action language without a real execution receipt. A
 *     recommendation is not an execution, a staged action is not an execution,
 *     a grant is not an execution, and provider capability is not an execution.
 *   - No "all clear" while an input the answer depends on was unreadable.
 *   - No urgency that is not carried by a typed attention reason.
 */

import { ASK_DW_GROUNDING_ISSUE, enforceAskDwGrounding } from './askDwGroundingGuard.js'

export const DW_PROACTIVE_ISSUE = Object.freeze({
  UNGROUNDED_AMOUNT: 'UNGROUNDED_AMOUNT',
  UNGROUNDED_IDENTIFIER: 'UNGROUNDED_IDENTIFIER',
  UNSUPPORTED_PAYMENT_CLAIM: 'UNSUPPORTED_PAYMENT_CLAIM',
  UNGROUNDED_DAY_COUNT: 'UNGROUNDED_DAY_COUNT',
  UNSUPPORTED_PROMISE_CLAIM: 'UNSUPPORTED_PROMISE_CLAIM',
  CLAIMED_AUTHORITY_WITHOUT_GRANT: 'CLAIMED_AUTHORITY_WITHOUT_GRANT',
  EXECUTION_WITHOUT_RECEIPT: 'EXECUTION_WITHOUT_RECEIPT',
  ALL_CLEAR_WHILE_DEGRADED: 'ALL_CLEAR_WHILE_DEGRADED',
  INJECTED_INSTRUCTION_IN_NARRATIVE: 'INJECTED_INSTRUCTION_IN_NARRATIVE',
  UNSUPPORTED_URGENCY: 'UNSUPPORTED_URGENCY',
  RESOLVED_AN_UNRESOLVED_CONFLICT: 'RESOLVED_AN_UNRESOLVED_CONFLICT',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Completed-action language. Present tense intent ("DW will send") is not here:
 * this is about output that claims something ALREADY HAPPENED.
 */
const COMPLETED_ACTION = new RegExp([
  '\\b(?:dw|duewatch|i|we)\\s+(?:just\\s+|already\\s+|has\\s+|have\\s+)?',
  '(?:sent|emailed|texted|messaged|contacted|called|chased|nudged|reminded',
  '|escalated|scheduled|queued|dispatched|delivered|completed|finished',
  '|applied|charged|waived|settled|refunded|wrote\\s+off|written\\s+off)\\b',
].join(''), 'i')

/**
 * A payment assertion in proactive prose. The shared guard covers the Ask DW
 * phrasings; proactive copy names the client ("Atlas already paid") and slips
 * past them, so the same claim is checked here against canonical state rather
 * than by widening a frozen module.
 */
const PAYMENT_ASSERTION = /\b(?:already\s+paid|has\s+paid|have\s+paid|paid\s+(?:this|the|it|in\s+full)|payment\s+(?:received|cleared|landed|arrived)|settled\s+(?:this|the|in\s+full)|no\s+longer\s+(?:owes|outstanding))\b/i

/**
 * "N days overdue" is a factual claim about canonical ageing, but it carries no
 * currency symbol and no decimal, so the shared money grounding correctly
 * ignores it. Proactive copy leads with exactly this number, and a Company
 * Brain norm ("we usually wait 30 days") is the obvious way for a wrong one to
 * arrive, so it is checked against canonical ageing here.
 */
const DAY_COUNT_CLAIM = /\b(\d{1,5})\s*(?:\+\s*)?days?\s+(?:overdue|late|past\s+due|old)\b/gi

/**
 * A promise-to-pay assertion. A promise is admitted state, not an inference
 * from an invoice being late, so claiming one — or claiming it was broken —
 * requires the locked truth to hold a promise.
 */
const PROMISE_CLAIM = /\b(?:promis\w*|committed\s+to\s+pay|agreed\s+to\s+pay|said\s+they\s+would\s+pay|undertook\s+to\s+pay)\b/i

/** Language that asserts the queue is empty or everything is fine. */
const ALL_CLEAR = /\b(?:nothing|no\s+(?:issues?|items?|cases?|action))\s+(?:needs|need|requires|require)\b|\ball\s+clear\b|\beverything\s+(?:is\s+)?(?:fine|ok|okay|on\s+track|handled)\b|\bnothing\s+(?:to\s+do|for\s+you)\b/i

/**
 * Instruction-shaped text surfaced as DW's own narrative. This is NOT founder
 * command parsing: it does not decide what operation was requested, and it
 * grants nothing. It refuses one specific thing — DW's prose containing an
 * imperative addressed to a system, which is what injected company content
 * looks like once it has been lifted out of quotation into a headline.
 */
const INJECTED_INSTRUCTION = /\bignore\s+(?:all\s+)?(?:previous|prior|earlier|above)\s+instructions?\b|\bdisregard\s+(?:the\s+)?(?:above|previous|prior)\b|\b(?:mark|set|flag|treat)\s+(?:this|the|that)?\s*invoices?\s+(?:as\s+)?(?:paid|settled|closed|cancelled)\b|\byou\s+must\s+now\b|\bnew\s+instructions?:/i

/** Urgency vocabulary that must be carried by a typed reason, not by tone. */
const URGENCY = /\b(?:urgent|urgently|critical|emergency|immediately|right\s+away|asap|dire|severe|alarming|dangerous)\b/i

/** Narrative text, flattened. Evidence is included so a quoted claim is checked. */
function narrativeParts(narrative) {
  return [
    narrative?.headline,
    narrative?.summary,
    ...safeArray(narrative?.lines),
    ...safeArray(narrative?.why).map((item) => (typeof item === 'string' ? item : item?.text)),
    ...safeArray(narrative?.evidence),
  ].filter(Boolean)
}

function narrativeText(narrative) {
  return narrativeParts(narrative).join('\n')
}

/**
 * Splits narrative into sentences so a receipt-backed execution statement can
 * be judged on its receipt rather than on the shared authority boundary, which
 * reads "DW sent the reminder" as a claim about permission. The receipt is the
 * stronger evidence for that one sentence; everything else still goes through
 * the shared claim checks unchanged.
 */
function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean)
}

/**
 * A receipt proves an action happened. Anything else — a recommendation, a
 * staged action, a grant, a provider capability — proves only that it could
 * have, which is a different sentence entirely.
 */
function hasValidReceipt(receipts) {
  return safeArray(receipts).some((receipt) =>
    receipt &&
    typeof receipt.claimId === 'string' && receipt.claimId.trim() !== '' &&
    typeof receipt.actionType === 'string' && receipt.actionType.trim() !== '' &&
    receipt.status === 'succeeded')
}

/**
 * Checks one proactive narrative against the deterministic state it claims to
 * describe.
 *
 * @param {object} input.narrative   the proactive copy about to be shown
 * @param {object} input.truthLock   the locked deterministic truth
 * @param {object} input.governance  the CP1 governance envelope (references only)
 * @param {Array}  input.executionReceipts real execution claims/receipts
 * @param {object} input.attention   the typed attention result, when there is one
 */
export function enforceDwProactiveGrounding({
  narrative = null,
  truthLock = null,
  governance = null,
  executionReceipts = [],
  attention = null,
  companyBrainContext = null,
  toolRuns = [],
} = {}) {
  const text = narrativeText(narrative)
  const issues = []
  const add = (code, detail) => issues.push({ code, detail, severity: 'BLOCK' })

  // The shared claim checks, reused rather than reimplemented. The narrative is
  // adapted into the candidate shape the guard already understands; nothing
  // here parses it as a founder command.
  const receiptBacked = hasValidReceipt(executionReceipts)
  // A sentence whose claim a receipt already proves is not re-judged as a
  // permission claim; the receipt outranks an inference about authority.
  const keep = (value) => sentencesOf(value)
    .filter((sentence) => !(receiptBacked && COMPLETED_ACTION.test(sentence)))
    .join(' ')
    .trim() || null

  const shared = enforceAskDwGrounding({
    candidate: {
      executiveConclusion: keep(narrative?.headline),
      evidenceBasis: [
        keep(narrative?.summary),
        ...safeArray(narrative?.lines).map(keep),
        ...safeArray(narrative?.why).map((item) => keep(typeof item === 'string' ? item : item?.text)),
        ...safeArray(narrative?.evidence).map(keep),
      ].filter(Boolean),
      uncertaintyAndLimitations: [],
      recommendationOrNextStep: null,
      competingExplanations: [],
    },
    verification: { verdict: 'PASS', issues: [], checkedClaims: [] },
    truthLock,
    toolRuns,
    companyBrainContext,
    conversationalTurn: null,
    caseContext: null,
  })
  for (const code of safeArray(shared.groundingIssues)) {
    // Execution language is re-judged below against real receipts, because a
    // receipt-backed sentence is legitimate here and the shared guard has no
    // receipts to consult.
    if (code === ASK_DW_GROUNDING_ISSUE.CLAIMED_EXECUTION) continue
    if (DW_PROACTIVE_ISSUE[code]) add(DW_PROACTIVE_ISSUE[code], `Shared grounding refused this claim: ${code}`)
    else add(code, `Shared grounding refused this claim: ${code}`)
  }

  // A completed action needs a receipt. Nothing else will do.
  if (COMPLETED_ACTION.test(text) && !receiptBacked) {
    add(DW_PROACTIVE_ISSUE.EXECUTION_WITHOUT_RECEIPT,
      'Narrative claims an action was performed without a valid execution receipt.')
  }

  // "Nothing needs you" is only sayable when everything that decides it was
  // readable. A degraded input makes silence a guess, not an answer.
  if (ALL_CLEAR.test(text)) {
    const brainUnavailable = governance != null &&
      governance.companyBrain?.available !== true
    const attentionIncomplete = attention != null && attention.complete !== true
    if (brainUnavailable || attentionIncomplete) {
      add(DW_PROACTIVE_ISSUE.ALL_CLEAR_WHILE_DEGRADED,
        'Narrative reports nothing outstanding while an input it depends on was unreadable.')
    }
  }

  // A day count is a claim about canonical ageing, and must match it.
  const canonicalDays = Number(truthLock?.canonicalFacts?.daysOverdue)
  DAY_COUNT_CLAIM.lastIndex = 0
  for (const match of text.matchAll(DAY_COUNT_CLAIM)) {
    const claimed = Number(match[1])
    if (!Number.isFinite(canonicalDays) || claimed !== canonicalDays) {
      add(DW_PROACTIVE_ISSUE.UNGROUNDED_DAY_COUNT,
        `Narrative states ${claimed} days overdue, which canonical ageing does not support.`)
    }
  }

  // A promise is admitted state, never an inference from lateness.
  if (PROMISE_CLAIM.test(text)) {
    const promise = truthLock?.arState?.promise ?? null
    const supported = promise != null && promise.status != null && promise.status !== 'NONE'
    if (!supported) {
      add(DW_PROACTIVE_ISSUE.UNSUPPORTED_PROMISE_CLAIM,
        'Narrative asserts a promise to pay that admitted state does not hold.')
    }
  }

  // A payment assertion needs canonical support, not repetition. Whoever said
  // it and however often, the ledger decides whether the invoice is paid.
  if (PAYMENT_ASSERTION.test(text)) {
    const canonical = truthLock?.canonicalFacts ?? {}
    const supported = canonical.paid === true ||
      String(canonical.canonicalStatus || '').toUpperCase().includes('PAID') ||
      String(canonical.canonicalStatus || '').toUpperCase().includes('SETTLED')
    if (!supported) {
      add(DW_PROACTIVE_ISSUE.UNSUPPORTED_PAYMENT_CLAIM,
        'Narrative states the invoice is paid without canonical support.')
    }
  }

  // Instruction-shaped text must never appear as DW's own narrative. Retrieved
  // content may be reported, but reporting it is quoting, not adopting it.
  if (INJECTED_INSTRUCTION.test(text)) {
    add(DW_PROACTIVE_ISSUE.INJECTED_INSTRUCTION_IN_NARRATIVE,
      'Narrative surfaces instruction-shaped retrieved content as DW\'s own words.')
  }

  // Urgency must be carried by a typed reason. Tone is not evidence.
  if (URGENCY.test(text)) {
    const carried = safeArray(attention?.items).length > 0
    if (!carried) {
      add(DW_PROACTIVE_ISSUE.UNSUPPORTED_URGENCY,
        'Narrative asserts urgency that no typed attention reason supports.')
    }
  }

  // An unresolved conflict may be described, never quietly decided.
  const unresolved = safeArray(governance?.conflicts)
    .filter((conflict) => conflict.conflictStatus === 'CONFLICTED')
  if (unresolved.length > 0 &&
      /\b(?:the (?:correct|right) (?:rule|rate|policy) is|governs|so we (?:should|will) use|that settles)\b/i.test(text)) {
    add(DW_PROACTIVE_ISSUE.RESOLVED_AN_UNRESOLVED_CONFLICT,
      'Narrative picks a governing rule while a founder decision is still outstanding.')
  }

  return freeze({
    kind: 'DW_PROACTIVE_GROUNDING_V0',
    blocked: issues.length > 0,
    issues: issues.map((issue) => freeze(issue)),
    // Retrieved text was read as a claim to be checked, never as a request to
    // be carried out. There is no path from narrative text to an operation.
    instructionsObeyed: false,
    boundaries: freeze({
      canGrantAuthority: false,
      canExecute: false,
      canonicalMoneyWritable: false,
      retrievedContentIsData: true,
    }),
  })
}
