/**
 * M2G-G7 conversational turn classification.
 *
 * This layer sits ABOVE the existing EXPLAIN / INVESTIGATE / PREDICT / DECIDE /
 * ACT accounts-receivable job taxonomy in askDwIntent.js. That taxonomy is
 * unchanged and still owns AR work; this module only recognises the kinds of
 * turn a founder actually types — "hi", "what should I do today?", "why?",
 * "anything else?" — so an ordinary sentence is no longer forced into a fake
 * invoice lookup.
 *
 * It is deterministic and decides nothing about truth or permission. A turn
 * classification never selects an entity, never grants authority and never
 * causes execution.
 */

import { ASK_DW_JOB, ASK_DW_SCOPE, classifyAskDwIntent } from './askDwIntent.js'

export const ASK_DW_TURN = Object.freeze({
  GREETING: 'GREETING',
  ACKNOWLEDGEMENT: 'ACKNOWLEDGEMENT',
  DAILY_PRIORITIES: 'DAILY_PRIORITIES',
  PORTFOLIO_STATUS: 'PORTFOLIO_STATUS',
  NEEDS_FOUNDER: 'NEEDS_FOUNDER',
  WHAT_CHANGED: 'WHAT_CHANGED',
  FOLLOW_UP: 'FOLLOW_UP',
  EVIDENCE_REQUEST: 'EVIDENCE_REQUEST',
  CORRECTION: 'CORRECTION',
  CHALLENGE: 'CHALLENGE',
  COMPANY_BRAIN_QUESTION: 'COMPANY_BRAIN_QUESTION',
  AUTHORITY_QUESTION: 'AUTHORITY_QUESTION',
  AR_JOB: 'AR_JOB',
})

/** What kind of thing the founder is correcting. These are not equivalent. */
export const ASK_DW_CORRECTION_KIND = Object.freeze({
  REFERENT: 'REFERENT',
  NEW_EVIDENCE: 'NEW_EVIDENCE',
  CHALLENGE: 'CHALLENGE',
  UNDERSTANDING: 'UNDERSTANDING',
})

const GREETINGS = new Set([
  'hi', 'hey', 'hello', 'yo', 'morning', 'good morning', 'good afternoon',
  'good evening', 'hi dw', 'hey dw', 'hello dw', 'hiya', 'howdy',
])

const ACKNOWLEDGEMENTS = new Set([
  'thanks', 'thank you', 'thx', 'ty', 'got it', 'gotcha', 'ok', 'okay', 'k',
  'cool', 'nice', 'perfect', 'great', 'sounds good', 'understood', 'right',
  'makes sense', 'fair enough', 'alright',
])

const DAILY_PRIORITY_PHRASES = [
  'what should i do today', 'what should i do', 'what do i do today',
  'what should we do today', 'where should i start', 'who should i look at first',
  'what should i focus on', 'what is the priority', "what's the priority",
  'priorities today', 'my priorities', 'what would you do first',
  'what needs doing', 'what is most urgent', "what's most urgent",
  'anything urgent', 'anything important', 'what is the biggest issue',
  "what's the biggest issue", 'top priority',
]

const PORTFOLIO_STATUS_PHRASES = [
  'how are things', 'how is ar', "how's ar", 'how are we doing', 'are we good',
  'how is everything', "how's everything", 'portfolio status', 'how is the portfolio',
  'give me a status', 'status update', 'where do we stand', 'how do we look',
  'what are you watching', 'what is the state of ar', 'overall status',
]

const NEEDS_FOUNDER_PHRASES = [
  'what needs me', 'what needs my attention', 'anything need me',
  'anything that needs me', 'what requires me', 'what needs a decision',
  'what am i forgetting', 'what is waiting on me', "what's waiting on me",
  'what do you need from me', 'anything blocked on me', 'what is blocked on me',
]

const WHAT_CHANGED_PHRASES = [
  'what changed', 'what has changed', "what's changed", 'what happened overnight',
  'what happened since', 'anything new', 'what is new', "what's new",
  'what moved', 'any updates', 'what updated', 'changed since i reviewed',
  'changed since my review',
]

const FOLLOW_UP_PHRASES = new Set([
  'why', 'why not', 'how so', 'how come', 'and',
  'anything else', 'what else', 'and then', 'then what',
  'go on', 'continue', 'more', 'next', 'keep going', 'what about them',
  'what about that', 'that one', 'the other one', 'again', 'so',
  'okay then what would you do', 'what would you do', 'and you',
])

const EVIDENCE_PHRASES = [
  'show me', 'show me why', 'evidence', 'the evidence', 'proof', 'prove it',
  'where does it say', 'what is your source', "what's your source", 'source',
  'cite', 'citation', 'how do you know', 'based on what', 'show your work',
  'show the evidence', 'let me see',
]

// Unambiguous anywhere in the turn: "no, you're wrong" is still a challenge.
const CHALLENGE_PHRASES = [
  "you're wrong", 'you are wrong', 'that is wrong', "that's wrong",
  'you got that wrong', 'i disagree', 'you are mistaken', "you're mistaken",
  'that is incorrect', "that's incorrect", 'that is not right', "that's not right",
]

// Short and ambiguous, so only an exact turn counts. "What went wrong on
// Atlas?" is an investigation, not a challenge.
const CHALLENGE_EXACT = new Set([
  'wrong', 'really', 'are you sure', 'you sure', 'are you certain',
  'sure about that', 'are you positive', 'no', 'nope',
])

const REFERENT_CORRECTION_PHRASES = [
  'i meant', 'no i meant', 'the second', 'the first', 'the other one',
  'other invoice', 'not that one', 'no not that one', 'the second invoice',
  'the first invoice', 'second one', 'first one', 'back to',
]

const COMPANY_BRAIN_PHRASES = [
  'what does our policy say', 'our policy', 'company policy', 'what is our policy',
  'what did i tell you', 'what did you learn', 'what do you know about our',
  'what does the contract say', 'the contract say', 'which one governs',
  'which governs', 'what conflicts', 'unresolved conflict', 'what did i approve',
  'what did i already approve', 'what did i reject', 'what do we usually do',
  'what do we normally do', 'who normally owns', 'who owns this',
  'what did i decide', 'what have i decided', 'our sop', 'the sop',
  'operating model', 'what do you think you know',
]

const AUTHORITY_PHRASES = [
  'what authority do you have', 'what are you allowed', 'are you allowed',
  'can you handle it', 'can you handle this', 'can you do it', 'can you send',
  'what can you do', "what can't you do", 'what cant you do',
  'why can you not', "why can't you", 'why cant you', 'do you have permission',
  'are you authorized', 'are you authorised', 'what authority',
  "what authority don't you have", 'am i letting you',
]

const NEW_EVIDENCE_PHRASES = [
  'emailed us', 'they emailed', 'they called', 'they paid', 'i just got',
  'we received', 'they sent', 'i spoke to', 'they told me', 'i got a',
  'came in today', 'just came in', 'they confirmed',
]

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    // Trailing punctuation carries no meaning here, and leaving a '?' attached
    // silently defeated every exact-phrase match.
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ')
}

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase))
}

function startsWithAny(text, phrases) {
  return phrases.some((phrase) => text === phrase || text.startsWith(`${phrase} `))
}

/**
 * Classifies one founder turn.
 *
 * Ordering matters: the most specific and least destructive readings are tried
 * first, so a short conversational turn is never mistaken for an AR command.
 * Anything not recognised falls through to the existing AR job classifier,
 * which keeps that taxonomy authoritative for real AR work.
 */
export function classifyAskDwConversationalTurn({ text, context = {}, caseContext = null } = {}) {
  const value = normalize(text)
  if (!value) throw new Error('Ask DW turn text required')

  const hasActiveSubject = Boolean(
    caseContext?.focus?.clientRef || caseContext?.focus?.invoiceRef ||
    context.clientId || context.invoiceId,
  )

  const result = (turnType, extra = {}) => Object.freeze({
    turnType,
    // Every conversational turn is inert with respect to truth and permission.
    grantsAuthority: false,
    mutatesCompanyBrain: false,
    mutatesCanonicalMoney: false,
    requiresActiveSubject: false,
    correctionKind: null,
    source: 'deterministic_turn_classifier',
    ...extra,
  })

  if (GREETINGS.has(value)) return result(ASK_DW_TURN.GREETING)
  if (ACKNOWLEDGEMENTS.has(value)) return result(ASK_DW_TURN.ACKNOWLEDGEMENT)

  // A challenge is checked before evidence/follow-up: "are you sure" is
  // pressure on a prior answer, not a new AR investigation.
  if (CHALLENGE_EXACT.has(value) || includesAny(value, CHALLENGE_PHRASES)) {
    return result(ASK_DW_TURN.CHALLENGE, {
      correctionKind: ASK_DW_CORRECTION_KIND.CHALLENGE,
      // Pressure is not evidence. Tone may adapt; truth may not.
      founderPressure: true,
    })
  }

  if (includesAny(value, NEW_EVIDENCE_PHRASES)) {
    return result(ASK_DW_TURN.CORRECTION, {
      correctionKind: ASK_DW_CORRECTION_KIND.NEW_EVIDENCE,
      // Asserted in conversation is not admitted evidence; it must still go
      // through a real evidence path before it can move canonical truth.
      requiresEvidencePath: true,
    })
  }

  if (includesAny(value, REFERENT_CORRECTION_PHRASES)) {
    return result(ASK_DW_TURN.CORRECTION, {
      correctionKind: ASK_DW_CORRECTION_KIND.REFERENT,
      requiresActiveSubject: true,
    })
  }

  if (includesAny(value, AUTHORITY_PHRASES)) return result(ASK_DW_TURN.AUTHORITY_QUESTION)
  if (includesAny(value, COMPANY_BRAIN_PHRASES)) return result(ASK_DW_TURN.COMPANY_BRAIN_QUESTION)
  if (includesAny(value, WHAT_CHANGED_PHRASES)) return result(ASK_DW_TURN.WHAT_CHANGED)
  if (includesAny(value, NEEDS_FOUNDER_PHRASES)) return result(ASK_DW_TURN.NEEDS_FOUNDER)
  if (includesAny(value, DAILY_PRIORITY_PHRASES)) return result(ASK_DW_TURN.DAILY_PRIORITIES)
  if (includesAny(value, PORTFOLIO_STATUS_PHRASES)) return result(ASK_DW_TURN.PORTFOLIO_STATUS)
  if (includesAny(value, EVIDENCE_PHRASES)) {
    return result(ASK_DW_TURN.EVIDENCE_REQUEST, { requiresActiveSubject: true })
  }

  // "what about Atlas?" / "and Riverbend?" continue the thread rather than
  // starting a new one, but only when a subject is actually active.
  if (/^(what about|how about|and)\b/.test(value) || FOLLOW_UP_PHRASES.has(value)) {
    return result(ASK_DW_TURN.FOLLOW_UP, { requiresActiveSubject: !FOLLOW_UP_PHRASES.has(value) ? false : true })
  }

  const arIntent = classifyAskDwIntent({ text, context })
  return result(ASK_DW_TURN.AR_JOB, {
    job: arIntent.job,
    scope: arIntent.scope,
    actionIntent: arIntent.actionIntent,
    predictionIntent: arIntent.predictionIntent,
    requiresActiveSubject: arIntent.scope !== ASK_DW_SCOPE.PORTFOLIO && !hasActiveSubject,
  })
}

/**
 * Maps a conversational turn onto the AR job taxonomy for the deterministic
 * core, which still expects a job. Conversational turns that are not AR work
 * map to EXPLAIN at portfolio scope: they read and explain, never act.
 */
export function askDwTurnToJob(turn) {
  if (!turn?.turnType) throw new Error('Ask DW turn required')
  if (turn.turnType === ASK_DW_TURN.AR_JOB) {
    return Object.freeze({ job: turn.job, scope: turn.scope, actionIntent: turn.actionIntent === true })
  }
  const scope = [
    ASK_DW_TURN.DAILY_PRIORITIES, ASK_DW_TURN.PORTFOLIO_STATUS,
    ASK_DW_TURN.NEEDS_FOUNDER, ASK_DW_TURN.WHAT_CHANGED, ASK_DW_TURN.GREETING,
    ASK_DW_TURN.ACKNOWLEDGEMENT,
  ].includes(turn.turnType) ? ASK_DW_SCOPE.PORTFOLIO : ASK_DW_SCOPE.CLIENT
  // DECIDE, not ACT: recommending a priority order is not permission to work it.
  const job = turn.turnType === ASK_DW_TURN.DAILY_PRIORITIES ? ASK_DW_JOB.DECIDE : ASK_DW_JOB.EXPLAIN
  return Object.freeze({ job, scope, actionIntent: false })
}

/** Turns that never need canonical AR retrieval to answer well. */
export function askDwTurnIsSmallTalk(turn) {
  return turn?.turnType === ASK_DW_TURN.GREETING || turn?.turnType === ASK_DW_TURN.ACKNOWLEDGEMENT
}
