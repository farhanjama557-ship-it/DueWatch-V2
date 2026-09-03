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
import {
  DW_PROVABLE_EXECUTION_ACTIONS,
  receiptProvesExecution,
  verifyDwExecutionStatement,
} from './dwExecutionPresentation.js'

// Re-exported, not redefined: the closed set of provable actions is owned by
// the execution-presentation contract, and existing importers keep working.
export { DW_PROVABLE_EXECUTION_ACTIONS }

/**
 * The role of the prose detector below, declared rather than assumed.
 *
 * It is DEFENSE IN DEPTH: a best-effort reader that refuses suspicious-looking
 * completed-action prose. It is NOT an English parser and it is NOT what makes
 * the execution invariant true — dwExecutionPresentation is, by being the only
 * producer of a statement DueWatch will present as its own completed work.
 *
 * Its blind spots are real and are recorded in the suite ("DW did send the
 * reminder", "we confirmed accounting emailed us"). They cost a missed warning
 * or an unnecessary one; they cannot produce a trusted execution claim,
 * because prose is not a path to one.
 */
export const DW_PROSE_DETECTION_ROLE = 'DEFENSE_IN_DEPTH'

export const DW_PROACTIVE_ISSUE = Object.freeze({
  UNGROUNDED_AMOUNT: 'UNGROUNDED_AMOUNT',
  UNGROUNDED_IDENTIFIER: 'UNGROUNDED_IDENTIFIER',
  UNSUPPORTED_PAYMENT_CLAIM: 'UNSUPPORTED_PAYMENT_CLAIM',
  UNGROUNDED_DAY_COUNT: 'UNGROUNDED_DAY_COUNT',
  UNSUPPORTED_PROMISE_CLAIM: 'UNSUPPORTED_PROMISE_CLAIM',
  CLAIMED_AUTHORITY_WITHOUT_GRANT: 'CLAIMED_AUTHORITY_WITHOUT_GRANT',
  EXECUTION_WITHOUT_RECEIPT: 'EXECUTION_WITHOUT_RECEIPT',
  EXECUTION_STATEMENT_NOT_RECEIPT_BACKED: 'EXECUTION_STATEMENT_NOT_RECEIPT_BACKED',
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
 * Completed-action language — WHO the sentence says did it.
 *
 * Present-tense intent ("DW will send") is not here: this is about output that
 * claims something ALREADY HAPPENED, and that DW is the one it happened by.
 *
 * Two earlier shapes both failed, in opposite directions:
 *
 *   1. One fused actor+verb phrase with a handful of hard-coded fillers. Any
 *      ordinary modifier walked straight through it ("DW has already emailed
 *      Atlas", "DW also waived the late fee").
 *   2. Actor and verb as anchors with a word-budget gap and a determiner
 *      blacklist. That moved the boundary rather than removing it: "DW, after
 *      the review, sent the reminder" escaped because "the" was in the list,
 *      a longer adjunct escaped because of the budget, and "We confirmed Atlas
 *      emailed us" was ATTRIBUTED TO DW because Atlas was not in the list.
 *
 * Both were the same mistake: measuring the DISTANCE between an actor and a
 * verb, when the question is which noun phrase is that verb's SUBJECT.
 *
 * So attribution is now resolved by walking LEFT from the verb to the nearest
 * subject position, exactly as English word order puts it, and reading who is
 * standing there. Nothing is counted and no filler is enumerated; the walk
 * classifies tokens by CLOSED grammatical classes only and skips everything
 * else, however long. It stops at the first of:
 *
 *   - an actor (dw / duewatch / i / we)      → DW claimed the execution;
 *   - another subject head                   → someone else's action;
 *   - modality, futurity, intent or negation → it did not happen;
 *   - a passive `be` auxiliary               → the subject is the patient, so
 *                                              the sentence names no actor;
 *   - a clause boundary or the sentence start → no actor at all.
 *
 * Three structural rules make the walk safe, and none of them is a word list:
 *
 *   - A comma-delimited aside cannot contain the subject of the verb that
 *     follows it, so such a span is stepped over WHOLE. That is what makes an
 *     adjunct's length and its internal determiners irrelevant.
 *   - A noun phrase governed by a preposition is that preposition's object,
 *     never the following verb's subject, so it is stepped over too.
 *   - A subject head reached only AFTER crossing a coordinator belongs to the
 *     coordinated verb phrase's own clause, not to this verb, whose subject is
 *     shared from before it. Reaching a subject head BEFORE any coordinator
 *     means it is this verb's subject.
 *
 * KNOWN LIMIT, stated rather than hidden: this is a token walk, not a parser.
 * A comma-less participial adjunct whose object sits directly against the verb
 * ("DW after reviewing the account sent the reminder") reads as a foreign
 * subject, and a foreign subject that is neither capitalised nor
 * determiner-headed ("we confirmed atlas emailed us") reads as DW. Detection
 * stays deliberately broad and PROOF stays narrow and unchanged, so an
 * over-reading costs a receipt the genuine case already has.
 */

/** Verbs that assert a completed action. Past forms only. */
const COMPLETED_ACTION_VERBS = new Set([
  'sent', 'emailed', 'texted', 'messaged', 'contacted', 'called', 'chased',
  'nudged', 'reminded', 'escalated', 'scheduled', 'queued', 'dispatched',
  'delivered', 'completed', 'finished', 'applied', 'charged', 'waived',
  'settled', 'refunded',
])

/** "wrote off" / "written off": completed only with the particle. */
const COMPLETED_ACTION_PARTICLE_VERBS = new Set(['wrote', 'written'])

const COMPLETED_ACTORS = new Set(['dw', 'duewatch', 'i', 'we'])

/** Modality, futurity, intent and negation: the verb did not happen. */
const NOT_YET_DONE = new Set([
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'cannot', 'if', 'unless', 'whether', 'never', 'not', 'no', 'nor',
  'plan', 'plans', 'planning', 'intend', 'intends', 'intending',
  'going', 'about', 'want', 'wants', 'need', 'needs',
  'try', 'tries', 'trying', 'attempt', 'attempts', 'attempting',
  'propose', 'proposes', 'recommend', 'recommends', 'suggest', 'suggests',
  'hope', 'hopes', 'expect', 'expects',
])

/**
 * A `be` auxiliary directly governing the participle makes the clause passive:
 * its subject is what the action was done TO. "DW was contacted by Atlas" is
 * not DW executing anything, and an agentless "the reminder was sent" names no
 * actor to hold to a receipt. Perfect `have` is active and keeps the walk going.
 */
const PASSIVE_BE = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being'])
const PERFECT_HAVE = new Set(['has', 'have', 'had'])

const COORDINATORS = new Set(['and', 'or', 'nor', 'but', 'then', 'plus'])

/** Prepositions: a closed class. Their objects are never the next verb's subject. */
const PREPOSITIONS = new Set([
  'after', 'before', 'during', 'since', 'until', 'till', 'on', 'in', 'at',
  'to', 'from', 'with', 'without', 'by', 'for', 'of', 'about', 'under',
  'over', 'per', 'via', 'through', 'throughout', 'regarding', 'upon',
  'following', 'despite', 'including', 'among', 'between', 'across', 'into',
  'onto', 'against', 'toward', 'towards', 'within', 'behind', 'beside', 'near',
])

/** Determiners and possessives: a closed class that heads a noun phrase. */
const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'each', 'every', 'any', 'some', 'another', 'both', 'either', 'neither',
])

/** Third-person pronouns: a closed class that can stand as a subject. */
const THIRD_PERSON = new Set([
  'he', 'she', 'it', 'they', 'him', 'them', 'someone', 'somebody',
  'everyone', 'everybody', 'anyone', 'nobody', 'who', 'whoever',
])

/** Words and clause punctuation, in order, with their positions. */
function tokenize(sentence) {
  return [...String(sentence || '').matchAll(/[A-Za-z][A-Za-z'’]*|[,;:]/g)]
    .map((match) => match[0])
}

/** Lowercased, apostrophes kept so a negated contraction stays visible. */
function normalize(token) {
  return token.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z']/g, '')
}

/** "DW's" is still DW; "Atlas's" is still Atlas. */
function possessiveStem(word) {
  return word.endsWith("'s") ? word.slice(0, -2) : word
}

/** The comma that opens the aside closed by the comma at `index`, if any. */
function openingComma(tokens, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor] === ';' || tokens[cursor] === ':') return null
    if (tokens[cursor] === ',') return cursor
  }
  return null
}

const ATTRIBUTION = Object.freeze({
  DW: 'DW', FOREIGN: 'FOREIGN', NOT_COMPLETED: 'NOT_COMPLETED', NONE: 'NONE',
})

/**
 * Who the completed verb at `verbIndex` belongs to.
 *
 * This is the whole attribution rule. It reads left, token by token, and
 * returns at the first token that answers the question.
 */
function attributionOf(tokens, verbIndex) {
  let index = verbIndex - 1
  let crossedCoordinator = false

  while (index >= 0) {
    const token = tokens[index]

    if (token === ';' || token === ':') return ATTRIBUTION.NONE
    if (token === ',') {
      // Step over the whole aside: its contents cannot be this verb's subject.
      const opening = openingComma(tokens, index)
      index = opening == null ? index - 1 : opening - 1
      continue
    }

    const word = normalize(token)
    if (!word) { index -= 1; continue }

    if (NOT_YET_DONE.has(word) || word.endsWith("n't")) return ATTRIBUTION.NOT_COMPLETED
    if (PASSIVE_BE.has(word)) return ATTRIBUTION.NOT_COMPLETED
    if (PERFECT_HAVE.has(word)) { index -= 1; continue }
    if (COORDINATORS.has(word)) { crossedCoordinator = true; index -= 1; continue }

    const stem = possessiveStem(word)
    if (COMPLETED_ACTORS.has(stem)) return ATTRIBUTION.DW

    const sentenceInitial = index === 0
    const properNoun = !sentenceInitial && /^[A-Z]/.test(token)
    if (DETERMINERS.has(stem) || THIRD_PERSON.has(stem) || properNoun) {
      // Governed by a preposition: an object, not a subject.
      const governor = index > 0 ? normalize(tokens[index - 1]) : ''
      if (PREPOSITIONS.has(governor)) { index -= 1; continue }
      // Reached only after a coordinator: it belongs to the coordinated verb
      // phrase's clause, and this verb's subject is shared from before it.
      if (crossedCoordinator) { index -= 1; continue }
      return ATTRIBUTION.FOREIGN
    }

    index -= 1
  }
  return ATTRIBUTION.NONE
}

/** Whether a sentence claims DW itself already performed an action. */
function claimsCompletedAction(sentence) {
  const tokens = tokenize(sentence)
  for (let index = 0; index < tokens.length; index += 1) {
    const word = normalize(tokens[index])
    const isVerb = COMPLETED_ACTION_VERBS.has(word) ||
      (COMPLETED_ACTION_PARTICLE_VERBS.has(word) && normalize(tokens[index + 1] ?? '') === 'off')
    if (!isVerb) continue
    if (attributionOf(tokens, index) === ATTRIBUTION.DW) return true
  }
  return false
}

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

/** A promise DW may describe: admitted, and not merely asserted by someone. */
const PROMISE_ABSENT = 'NONE'
const ADMITTED_PROMISE = new Set([
  'PROPOSED', 'CONFIRMED', 'DUE_TODAY', 'PARTIAL', 'FULFILLED', 'BROKEN',
  'RENEGOTIATED', 'CANCELLED',
])

/** Saying the promise failed. Only a BROKEN promise supports it. */
const BROKEN_PROMISE_LANGUAGE = /\b(?:broke|broken|breaking|failed\s+to\s+(?:keep|honou?r)|did\s+not\s+(?:keep|honou?r)|reneged)\b/i

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
 * The action a completed-action sentence actually claims. Prose is NEVER a
 * security identifier — this only says WHICH action was asserted, so a send
 * receipt cannot silently cover a refund sentence. Tenant, invoice and client
 * come from the structured claim, never from a name in the text.
 */
const ACTION_VOCABULARY = Object.freeze([
  [/\b(?:sent|send|sending|emailed|texted|messaged|contacted|called|chased|nudged|reminded)\b/i, 'send_reminder'],
  [/\b(?:escalated|escalating)\b/i, 'send_collection_message'],
  [/\b(?:refunded|refunding)\b/i, 'issue_refund'],
  [/\b(?:waived|waiving)\b/i, 'waive_late_fee'],
  [/\b(?:charged|charging|applied)\b/i, 'apply_late_fee'],
  [/\b(?:settled|settling)\b/i, 'settle_invoice'],
  [/\bwrote\s+off|\bwritten\s+off\b/i, 'write_off_invoice'],
])

function assertedActions(sentence) {
  const actions = new Set()
  for (const [pattern, action] of ACTION_VOCABULARY) {
    if (pattern.test(sentence)) actions.add(action)
  }
  return [...actions]
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
  executionClaim = null,
  attention = null,
  companyBrainContext = null,
  toolRuns = [],
  executionStatements = [],
} = {}) {
  const text = narrativeText(narrative)
  const issues = []
  const add = (code, detail) => issues.push({ code, detail, severity: 'BLOCK' })

  // The ONLY execution surface. A statement is admitted because it verifies
  // against the receipt contract that issued it, not because it arrived here
  // looking plausible. Anything that fails is refused and named.
  const presentableExecution = []
  for (const statement of safeArray(executionStatements)) {
    if (verifyDwExecutionStatement(statement)) presentableExecution.push(statement)
    else add(DW_PROACTIVE_ISSUE.EXECUTION_STATEMENT_NOT_RECEIPT_BACKED,
      'An execution statement was supplied that no exact receipt licenses.')
  }

  // The shared claim checks, reused rather than reimplemented. The narrative is
  // adapted into the candidate shape the guard already understands; nothing
  // here parses it as a founder command.
  // Each completed-action sentence is judged on ITS OWN action against the
  // structured claim. One valid receipt never blankets the narrative.
  const proven = (sentence) => {
    if (!claimsCompletedAction(sentence)) return false
    const actions = assertedActions(sentence)
    if (actions.length === 0) return false
    return actions.every((action) => receiptProvesExecution({
      receipts: executionReceipts, claim: executionClaim, action,
    }))
  }
  const unprovenExecution = []
  for (const part of narrativeParts(narrative)) {
    for (const sentence of sentencesOf(part)) {
      if (claimsCompletedAction(sentence) && !proven(sentence)) unprovenExecution.push(sentence)
    }
  }
  // A sentence a receipt already proves is not re-judged as a permission claim;
  // the receipt outranks an inference about authority.
  const keep = (value) => sentencesOf(value)
    .filter((sentence) => !proven(sentence))
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

  // A completed action needs a receipt for THAT action. Nothing else will do.
  for (const sentence of unprovenExecution) {
    add(DW_PROACTIVE_ISSUE.EXECUTION_WITHOUT_RECEIPT,
      `Narrative claims an action was performed without a matching execution receipt: "${sentence}"`)
  }

  // "Nothing needs you" is only sayable when everything that decides it was
  // readable. A degraded input makes silence a guess, not an answer.
  if (ALL_CLEAR.test(text)) {
    // Absent is not clean. Saying nothing needs the founder requires that the
    // things which decide that were actually read; a missing governance
    // envelope or a missing attention result is an unread input, not an empty
    // queue, so unknown fails closed exactly like degraded does.
    const brainUnavailable = governance == null ||
      governance.companyBrain?.available !== true
    const attentionIncomplete = attention == null || attention.complete !== true
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

  // A promise is admitted state, and the SPECIFIC thing said about it must
  // match that state. "Some promise exists" is not enough: a fulfilled promise
  // cannot be narrated as broken, and an unverified claim is not a promise.
  //
  // The vocabulary is phase2bArControl's PROMISE_STATE: NONE, PROPOSED,
  // CONFIRMED, DUE_TODAY, PARTIAL, FULFILLED, BROKEN, RENEGOTIATED, CANCELLED,
  // CLAIMED_UNVERIFIED.
  if (PROMISE_CLAIM.test(text)) {
    const status = truthLock?.arState?.promise?.status ?? PROMISE_ABSENT
    const admitted = ADMITTED_PROMISE.has(status)
    if (!admitted) {
      add(DW_PROACTIVE_ISSUE.UNSUPPORTED_PROMISE_CLAIM,
        `Narrative asserts a promise that admitted state does not hold (status: ${status}).`)
    } else if (BROKEN_PROMISE_LANGUAGE.test(text) && status !== 'BROKEN') {
      add(DW_PROACTIVE_ISSUE.UNSUPPORTED_PROMISE_CLAIM,
        `Narrative says the promise was broken, but admitted state is ${status}.`)
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

  // Urgency is severity, and a typed attention reason proves only that
  // attention is warranted. Letting any queued item license "EMERGENCY" meant
  // an ordinary AWAITING_REVIEW could justify alarm — invented severity.
  //
  // No typed severity state exists in the repository yet, so extreme urgency
  // vocabulary is refused outright rather than inferred from balance, customer
  // importance, tone or the mere presence of work. The deterministic
  // alternative, "this needs your attention", is always available and always
  // true when a typed reason exists.
  if (URGENCY.test(text)) {
    add(DW_PROACTIVE_ISSUE.UNSUPPORTED_URGENCY,
      'Narrative asserts urgency or severity that no typed severity state supports.')
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
    // Receipt-backed statements, in this repository's own words. A consumer
    // renders completed execution from HERE and from nowhere else; narrative
    // prose is never promoted into this list, however confident it sounds.
    presentableExecution: presentableExecution.map((statement) => freeze(statement)),
    // Retrieved text was read as a claim to be checked, never as a request to
    // be carried out. There is no path from narrative text to an operation.
    instructionsObeyed: false,
    boundaries: freeze({
      canGrantAuthority: false,
      canExecute: false,
      canonicalMoneyWritable: false,
      retrievedContentIsData: true,
      // The ownership contract, stated in the output a consumer already reads.
      executionStatementOwner: 'RECEIPT',
      narrativeMayStateExecution: false,
      proseDetectionRole: DW_PROSE_DETECTION_ROLE,
    }),
  })
}
