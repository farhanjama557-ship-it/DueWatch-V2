/**
 * M2G-G7 authority proposition parser — a CLOSED typed boundary.
 *
 * The previous guard recognised authority prose with a growing regex catalog
 * and then extracted the action and channel from the whole flattened answer.
 * That let one clause borrow another clause's specifics:
 *
 *   "I am authorized. This email reminder is only a draft."
 *
 * read as a supported EMAIL/SEND_REMINDER authority claim.
 *
 * This module inverts the design. It is deliberately NOT an attempt to
 * recognise every English sentence:
 *
 *   - the TRIGGER is broad, because over-triggering is safe: a triggered
 *     proposition that cannot be mapped exactly is blocked;
 *   - the ACCEPT is narrow and closed: every dimension must map onto an exact
 *     G5 value from a fixed vocabulary, parsed from THAT proposition alone.
 *
 * Nothing is ever borrowed across a sentence, a coordinated clause, a
 * quotation or an answer field. G5 remains the sole owner of authority; this
 * module only decides whether a sentence may be said.
 */

import {
  ASK_DW_OPERATION_PRESENTATION,
  inspectAskDwFounderOperationPresentation,
  isCompleteKnownReadOnlyModelOperation,
  recognizeAskDwControlledActionJob,
  recognizeKnownReadOnlyAskDwJob,
} from './askDwIntent.js'

/** Exactly the seven G5 actions. Never widened, never collapsed. */
export const G5_ACTIONS = Object.freeze([
  'SEND_REMINDER', 'SEND_COLLECTION_MESSAGE', 'APPLY_LATE_FEE', 'WAIVE_LATE_FEE',
  'SETTLE_INVOICE', 'WRITE_OFF_INVOICE', 'ISSUE_REFUND',
])

export const ASK_DW_POLARITY = Object.freeze({
  POSITIVE: 'POSITIVE',
  NEGATIVE: 'NEGATIVE',
  AMBIGUOUS: 'AMBIGUOUS',
})

/** How a span is being read: as an assertion DW made, or as a founder question. */
export const ASK_DW_PARSE_MODE = Object.freeze({
  ASSERTION: 'ASSERTION',
  QUESTION: 'QUESTION',
})

export const ASK_DW_ACTOR = Object.freeze({
  DW: 'DW',
  // The subject is the grant/permission itself ("the current grant covers...").
  // G5 grants are always to DW, so the grantee is determinate.
  GRANT_SUBJECT: 'GRANT_SUBJECT',
  OTHER: 'OTHER',
  UNKNOWN: 'UNKNOWN',
})

export const ASK_DW_SCOPE_ASSERTION = Object.freeze({
  COMPANY: 'COMPANY',
  CLIENT: 'CLIENT',
  ENTITY: 'ENTITY',
  // No scope cue at all: the conversation's focus may stand in.
  UNSPECIFIED: 'UNSPECIFIED',
  // A scope IS asserted but cannot be resolved. Focus must never stand in.
  UNKNOWN: 'UNKNOWN',
  AMBIGUOUS: 'AMBIGUOUS',
})

/** Sentinels. Any of these on a positive proposition means fail closed. */
export const UNMAPPABLE = Object.freeze({
  ACTION_UNKNOWN: 'ACTION_UNKNOWN',
  ACTION_AMBIGUOUS: 'ACTION_AMBIGUOUS',
  CHANNEL_UNKNOWN: 'CHANNEL_UNKNOWN',
  CHANNEL_AMBIGUOUS: 'AMBIGUOUS_CHANNEL',
})

// ── normalisation ────────────────────────────────────────────────────────────

/**
 * Formatting must not be able to hide or fabricate a claim. Dashes, smart
 * quotes, Markdown emphasis and non-breaking spaces are normalised; sentence
 * structure is preserved so segmentation stays honest.
 */
export function normalizeAuthorityText(value) {
  return String(value || '')
    .replace(/ | | /g, ' ')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—―]/g, ' - ')
    .replace(/\*\*|\*|__|_|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A discourse marker inside a clause ("I am, however, authorized") must not
// split the proposition; a coordinator between clauses must.
const COORDINATORS = /\s+(?:and|or|nor|yet|but|however|although|though|while|whereas)\s+/gi
const TERMINATORS = /[.!?;\n]+/

function stripDiscourseCommas(value) {
  return value.replace(/,\s*(?:however|therefore|though|nevertheless|nonetheless|in fact|indeed)\s*,/gi, ' ')
}

/**
 * Splits one field into propositions. Quoted spans become their own
 * propositions carrying their attribution, so reported speech can never be
 * read as the assistant asserting anything.
 */
export function segmentPropositions(fieldText, { field = 'unknown' } = {}) {
  const normalized = normalizeAuthorityText(fieldText)
  if (!normalized) return []
  const propositions = []
  let cursor = 0
  const quotePattern = /"([^"]*)"/g

  const pushPlain = (text, attribution) => {
    const cleaned = stripDiscourseCommas(text)
    for (const sentence of cleaned.split(TERMINATORS)) {
      const clauses = sentence.split(COORDINATORS)
      const fullSelfOperation = parseDwSelfOperation(sentence.trim())
      const inheritSelfController = clauses.length > 1 && fullSelfOperation &&
        !isCompleteKnownReadOnlyModelOperation({ operationPhrase: fullSelfOperation.phrase })
      for (let index = 0; index < clauses.length; index += 1) {
        let trimmed = clauses[index].trim()
        // Coordinators elide the matrix subject/modal: in "I will explain and
        // reimburse", the second operation is still "I will reimburse".
        // Preserve that controller only when the complete phrase was not
        // positively proved read-only. This adds a fail-closed proposition;
        // it never joins evidence or authority dimensions across clauses.
        if (index > 0 && inheritSelfController &&
          !/^(?:i|we|you|dw|due\s?watch)\b/i.test(trimmed)) {
          trimmed = `${fullSelfOperation.prefix}${trimmed}`
        }
        if (trimmed) {
          propositions.push({ field, text: trimmed, quoted: false, attributedTo: attribution })
        }
      }
    }
  }

  for (const match of normalized.matchAll(quotePattern)) {
    const before = normalized.slice(cursor, match.index)
    // Attribution is whatever introduced the quotation, e.g. `Atlas wrote:`.
    const attribution = /\b(\w[\w\s]*?)\s+(?:wrote|said|says|states|stated|writes|claims|claimed)\s*:?\s*$/i
      .exec(before.trim())
    pushPlain(before, null)
    const inner = stripDiscourseCommas(match[1])
    for (const sentence of inner.split(TERMINATORS)) {
      for (const clause of sentence.split(COORDINATORS)) {
        const trimmed = clause.trim()
        if (trimmed) {
          propositions.push({
            field,
            text: trimmed,
            quoted: true,
            // null, not a placeholder: an unattributed quotation cannot be
            // told apart from the assistant asserting it, and must fail closed.
            attributedTo: attribution ? attribution[1].trim() : null,
          })
        }
      }
    }
    cursor = match.index + match[0].length
  }
  pushPlain(normalized.slice(cursor), null)
  return propositions
}

// ── closed vocabularies ──────────────────────────────────────────────────────

/**
 * Broad trigger. Over-triggering is safe: anything caught here must then map
 * exactly or be blocked.
 */
const AUTHORITY_TRIGGER = new RegExp([
  'authoris|authoriz|permission|permitted|allowed|entitled|licen[cs]ed',
  'authority|mandate|clearance|cleared to|green ?light|free to|good to go',
  '\\bgrant\\b|\\bgrants\\b|\\bgranted\\b|standing authority',
  // A bare modal is handled separately: modality alone is not an authority
  // claim ("I cannot confirm a payment" is not about permission).
  'nothing (?:is )?(?:prevent|stopp|block)',
  '\\bapprovals?\\b|\\bask\\s+(?:you\\s+)?first\\b',
  "don'?t need to ask|do not need to ask|without asking|without approval",
  'covers|covered by|applies to|extends to|encompasses|falls within|pursuant to|within (?:the )?(?:scope|grant)',
].join('|'), 'i')

/**
 * Action vocabulary. Each entry maps to exactly one G5 action. Terms that are
 * genuinely ambiguous between two G5 actions map to ACTION_AMBIGUOUS and are
 * never collapsed — "chase", "nudge", "follow up", "dunning" and "collection
 * reminder" could each mean SEND_REMINDER or SEND_COLLECTION_MESSAGE.
 */
const ACTION_TERMS = Object.freeze([
  // Ambiguous first: these must win over a narrower substring match.
  [/\bcollections?\s+reminders?\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bdunning\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bchase\b|\bchasing\b|\bchased\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bnudge\b|\bnudging\b|\bnudged\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bfollow(?:s|ed|ing)?[- ]ups?\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bcollections?\s+(?:message|notice|letter|email|communication)s?\b/i, 'SEND_COLLECTION_MESSAGE'],
  [/\bcollection\s+messag(?:e|es|ing)\b/i, 'SEND_COLLECTION_MESSAGE'],
  [/\breminders?\b/i, 'SEND_REMINDER'],
  [/\bremind(?:s|ed|ing)?\b/i, 'SEND_REMINDER'],
  [/\bwaiv(?:e|es|ed|ing)\b[^.]{0,24}\blate\s+fees?\b/i, 'WAIVE_LATE_FEE'],
  [/\blate\s+fees?\b[^.]{0,24}\bwaiv(?:e|es|ed|ing|er)\b/i, 'WAIVE_LATE_FEE'],
  [/\b(?:appl(?:y|ies|ied|ying)|charg(?:e|es|ed|ing)|add(?:s|ed|ing)?)\b[^.]{0,24}\blate\s+fees?\b/i, 'APPLY_LATE_FEE'],
  // A bare late-fee noun does not say whether the operation applies or waives
  // it. The verb must establish one exact G5 action; otherwise the request is
  // unmappable and the deterministic boundary asks for clarification.
  [/\bsettl(?:e|es|ed|ing|ement)\b/i, 'SETTLE_INVOICE'],
  [/\bwrit(?:e|es|ing|ten)[- ]offs?\b|\bwrote[- ]off\b|\bwrite\s+off\b/i, 'WRITE_OFF_INVOICE'],
  [/\brefunds?\b|\brefund(?:s|ed|ing)\b/i, 'ISSUE_REFUND'],
])

/**
 * Channel vocabulary. Only deliberate, unambiguous aliases normalise. A
 * provider name is NOT a channel: treating Gmail or Teams as a channel is the
 * provider-capability-to-authority leap this gate forbids, so they are
 * recognised and refused rather than silently mapped.
 */
const CHANNEL_TERMS = Object.freeze([
  [/\be-?mails?\b|\be-?mailing\b|\be-?mailed\b/i, 'EMAIL'],
  [/\bsms\b|\btext\s+messages?\b|\btexting\b/i, 'SMS'],
  [/\bwhats\s?app\b/i, 'WHATSAPP'],
  [/\bphone\b|\btelephone\b|\bphone\s+calls?\b/i, 'PHONE'],
  [/\bpostal?\b|\bletters?\b|\bmail\s+merge\b/i, 'POSTAL'],
  [/\bportals?\b/i, 'PORTAL'],
  [/\bgmail\b|\boutlook\b|\bteams\b|\bslack\b|\btwilio\b|\bsendgrid\b/i, UNMAPPABLE.CHANNEL_UNKNOWN],
])

// First person includes object pronouns: "no approval is needed for me to send".
const DW_ACTOR = /\b(?:i|i'm|me|my|myself|we|we're|us|our|ourselves|dw|duewatch|due\s?watch)\b/i

// Named or generic third parties. Permission attributed to any of these is not
// DW's permission, whatever a grant happens to say.
const OTHER_ACTOR = /\b(?:the\s+(?:system|assistant|agent|bot|platform|tool|service|provider|customer|client|vendor|partner|team)|automation|gmail|stripe|quickbooks|someone|somebody|anyone|anybody|everyone|they|he|she|third\s+part(?:y|ies))\b/i

// The subject is a grant/permission noun rather than an actor.
const GRANT_SUBJECT = /^(?:the|this|that|a|an|our|your)?\s*(?:current|active|standing|explicit)?\s*(?:grant|permission|authori[sz]ation|authority|clearance)\b|\b(?:grant|permission|authori[sz]ation|authority)\s+(?:currently\s+)?(?:covers|allows|permits|authori[sz]es|includes|exists|extends|gives|applies)/i

// A capitalised subject that is neither DW nor a grant noun: "Atlas is allowed
// to send email reminders."
const NAMED_SUBJECT = /^(?:the\s+)?([A-Z][A-Za-z0-9&.'-]*)\s+(?:is|are|was|were|may|can|could|might|will|has|have|holds?|gets?)\b/

// Negation that scopes over an authority predicate.
// Every negator is word-bounded on BOTH sides. Without the trailing boundary
// "no" matched inside "notices" and silently flipped a positive claim's
// polarity, which let an ambiguous action through. The un- stem is matched
// separately because it is a prefix, not a word.
const NEGATORS = /\b(?:not|never|no|none|cannot|can't|cant|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|lacks|lack|lacking|absent|without|unable|incapable)\b|\bun(?:authoris|authoriz)/gi
const DOUBLE_NEGATION_HINT = /\bnot\s+un(?:authoris|authoriz)|\bnot\s+true\s+that\b|\bnot\s+absent\b|\bnever\s+not\b|\bno\s+longer\s+un/i

// ── per-proposition parsing ──────────────────────────────────────────────────

/**
 * A modal only raises an authority question when it governs an accounts-
 * receivable act. This is a closed verb list, not a sentence blacklist: it
 * keeps "I cannot confirm a payment" out while keeping "I cannot contact
 * Atlas" in, so an unmapped denial about a real AR act still fails closed.
 */
const MODAL = /\b(?:can|cannot|can't|cant|may|could|might|able\s+to|unable\s+to|capable\s+of|allowed\s+to|permitted\s+to)\b/i
const AR_ACT = /\b(?:send|sends|sending|sent|email|emails|emailing|text|texts|texting|message|messages|messaging|contact|contacts|contacting|chase|chasing|nudge|nudging|remind|reminds|reminding|reminder|reminders|follow[- ]up|call|calls|calling|apply|applies|applying|waive|waives|waiving|settle|settles|settling|write[- ]?off|wrote[- ]?off|refund|refunds|refunding|charge|charges|charging|collect|collects|collecting|escalate|escalating|dunning|act|acts|acting|handle|handles|handling|do\s+(?:this|that|it))\b/i

/**
 * SAFE-BY-DEFAULT OWNERSHIP.
 *
 * AR_ACT remains the closed canonical-action vocabulary. It is not the owner
 * of the routing decision: an unknown operational verb must not become model
 * work merely because that verb is absent from AR_ACT. Direct founder prompts
 * aimed at DW and first-person DW commitments are claimed structurally first.
 * Only a small, closed family of clearly read-only predicates stays with the
 * model. Everything else must map exactly to G5 or fail closed.
 */
function isSafeReadOnlyModelOutput(phrase) {
  return isCompleteKnownReadOnlyModelOperation({ operationPhrase: phrase })
}

function parseDwSelfOperation(text) {
  const value = String(text || '').trim()
  const modal = /^((?:i|we|dw|due\s?watch)\s+(?:can|may|could|might|will|would|should|shall)\s+)(.+)$/i.exec(value)
  if (modal) return { prefix: modal[1], phrase: modal[2] }
  const contracted = /^((?:i|we)'(?:ll|d)\s+)(.+)$/i.exec(value)
  if (contracted) return { prefix: contracted[1], phrase: contracted[2] }
  const going = /^((?:i(?:'m|\s+am)|we(?:'re|\s+are)|dw\s+is|due\s?watch\s+is)\s+going\s+to\s+)(.+)$/i.exec(value)
  return going ? { prefix: going[1], phrase: going[2] } : null
}

function dwSelfOperationPhrase(text) {
  return parseDwSelfOperation(text)?.phrase ?? null
}

function ownsUnknownOperationalLanguage(text, mode, knownEntities = []) {
  const founderPresentation = mode === ASK_DW_PARSE_MODE.QUESTION
    ? inspectAskDwFounderOperationPresentation({ text, knownEntities })
    : null
  const phrase = founderPresentation?.operationPhrase ??
    (mode === ASK_DW_PARSE_MODE.QUESTION ? null : dwSelfOperationPhrase(text))
  if (phrase == null) return false
  const knownReadOnlyQuestion = mode === ASK_DW_PARSE_MODE.QUESTION &&
    recognizeKnownReadOnlyAskDwJob({ text, knownEntities }) != null
  if (knownReadOnlyQuestion) return false
  // Existing exact controlled imperatives already enter the G5-controlled ACT
  // path. Structural ownership closes only the unknown/mixed fallback seam; it
  // must not replace that established activation path with an authority query.
  if (founderPresentation?.presentation === ASK_DW_OPERATION_PRESENTATION.IMPERATIVE &&
      (G5_ACTIONS.includes(parseAction(text)) || recognizeAskDwControlledActionJob({ text }))) return false
  // Output is deliberately stricter than input. Recognising a founder's
  // request for analysis does not permit the model to promise future or
  // background work; only the already-established output predicates survive.
  return mode === ASK_DW_PARSE_MODE.QUESTION || !isSafeReadOnlyModelOutput(phrase)
}

/**
 * TYPED FRAMES.
 *
 * The previous design collapsed four unrelated things into one boolean
 * SAFE_FRAME and exempted a proposition if any of them appeared. A CONDITION
 * was therefore treated as evidence that no authority was being asserted, so
 * "I send email reminders when invoices are overdue." — a standing commitment
 * to act, conditioned on a trigger — walked straight through.
 *
 * A condition is a DIMENSION of an authority claim, not an exemption from it.
 * Only three frames genuinely place a controlled act outside DW's own
 * authority, and each is typed here so it can be reasoned about separately:
 *
 *   RECOMMENDATION  DW proposes an act for the founder to choose.
 *   DEFERRAL        DW explicitly routes the act back to the founder.
 *   PAST_EXECUTION  the act is claimed as already done, which the execution
 *                   guard owns rather than this one.
 *
 * CONDITION and HYPOTHETICAL are recorded but exempt nothing. Ambiguous
 * self-capability ("I would send ...") fails closed by design.
 */
export const ASK_DW_FRAME = Object.freeze({
  RECOMMENDATION: 'RECOMMENDATION',
  DEFERRAL: 'DEFERRAL',
  PAST_EXECUTION: 'PAST_EXECUTION',
  CONDITION: 'CONDITION',
  HYPOTHETICAL: 'HYPOTHETICAL',
})

const FRAME_PATTERNS = Object.freeze([
  [ASK_DW_FRAME.RECOMMENDATION, new RegExp([
    '\\b(?:recommend|recommends|recommending|suggest|suggests|suggesting',
    '|advise|advises|advising|propose|proposes|proposing)\\b',
    '|\\bmy\\s+recommendation\\b|\\bworth\\s+(?:a\\s+)?\\w+ing\\b',
    "|\\b(?:i'?d|i\\s+would|we'?d|we\\s+would)\\s+(?:recommend|suggest|advise|propose)\\b",
  ].join(''), 'i')],
  [ASK_DW_FRAME.DEFERRAL, new RegExp([
    '\\bwould\\s+need\\b|\\bwould\\s+have\\s+to\\b|\\bwould\\s+first\\b',
    '|\\b(?:you|founder)\\s+(?:can|could|may|might|would)\\s+(?:ask|tell|have)\\s+me\\b',
    '|\\bsay\\s+the\\s+word\\b|\\bon\\s+your\\s+(?:go|say[- ]so)\\b',
    '|\\bif\\s+you\\s+(?:ask|tell|want|would\\s+like)\\b',
    '|\\bonly\\s+(?:if|once|when)\\s+you\\b|\\bnot\\s+without\\s+you\\b',
  ].join(''), 'i')],
  [ASK_DW_FRAME.PAST_EXECUTION, new RegExp(
    "\\bi(?:'ve| have)?\\s+(?:just\\s+|already\\s+)?(?:sent|emailed|issued|applied|charged|processed|refunded|wrote|written|marked)\\b", 'i')],
  [ASK_DW_FRAME.CONDITION, /\b(?:if|once|when|whenever|unless|after|provided|assuming|as\s+soon\s+as)\b/i],
  [ASK_DW_FRAME.HYPOTHETICAL, /\b(?:i'?d|i\s+would|we'?d|we\s+would|hypothetically|in\s+theory)\b/i],
])

/** The set of typed frames present in one proposition. */
function parseFrames(text) {
  const frames = new Set()
  for (const [frame, pattern] of FRAME_PATTERNS) {
    if (pattern.test(text)) frames.add(frame)
  }
  return frames
}

/**
 * Only these frames place a controlled act outside DW's own authority. A
 * CONDITION never does, and a HYPOTHETICAL never does on its own — an
 * ambiguous self-capability claim must fail closed, not be exempted.
 */
const EXEMPTING_FRAMES = Object.freeze([
  ASK_DW_FRAME.RECOMMENDATION, ASK_DW_FRAME.DEFERRAL, ASK_DW_FRAME.PAST_EXECUTION,
])

/**
 * Deontic language splits in two, and the split is load-bearing.
 *
 * EXPLICIT names permission itself. It is authority-bearing on its own,
 * because "I am authorized." is an authority claim even with no act attached —
 * it is exactly the sentence that borrowed its specifics from a neighbour.
 *
 * MODAL is bare modality. Modality alone says nothing about permission ("I
 * cannot confirm a payment", "that may be a duplicate record"), so it is only
 * authority-bearing when it governs a controlled AR act, a grant subject or an
 * approval requirement.
 */
const EXPLICIT_DEONTIC = new RegExp([
  'authoris|authoriz|permission|permitted|allowed|entitled|licen[cs]ed',
  'authority|mandate|\\bremit\\b|clearance|cleared\\s+to|green ?light|free to|good to go',
  'discretion|empowered|delegated|the right to|rights? to|go[- ]ahead|leeway|latitude',
  '\\bgrant\\b|\\bgrants\\b|\\bgranted\\b|standing authority',
  'nothing (?:is )?(?:prevent|stopp|block)',
  '\\bapprovals?\\b|\\bsign[- ]?off\\b|\\bsignoff\\b|\\bconsent\\b',
].join('|'), 'i')

const MODAL_DEONTIC = new RegExp([
  '\\beligible\\b',
  '\\bget to\\b|\\bgets to\\b|\\bokay to\\b|\\bok to\\b|\\bfine to\\b|\\bsafe to\\b',
  '\\bcan\\b|\\bcannot\\b|\\bcan\'t\\b|\\bmay\\b|\\bcould\\b|\\bmight\\b',
  '\\bable to\\b|\\bunable to\\b|\\bcapable of\\b|\\bin a position to\\b',
  'covers|covered by|applies to|extends to|encompasses|falls within|within (?:the )?(?:scope|grant|remit)|includes',
].join('|'), 'i')

function matchVocabulary(text, table) {
  const found = new Set()
  for (const [pattern, value] of table) {
    if (pattern.test(text)) found.add(value)
  }
  return found
}

function parseAction(text) {
  const found = matchVocabulary(text, ACTION_TERMS)
  // "waive late fees" is uniquely WAIVE_LATE_FEE; the bare "late fees" term
  // must not also register APPLY_LATE_FEE and make it look ambiguous.
  if (found.has('WAIVE_LATE_FEE')) found.delete('APPLY_LATE_FEE')
  if (found.has(UNMAPPABLE.ACTION_AMBIGUOUS)) return UNMAPPABLE.ACTION_AMBIGUOUS
  const actions = [...found].filter((value) => G5_ACTIONS.includes(value))
  if (actions.length === 0) return UNMAPPABLE.ACTION_UNKNOWN
  if (actions.length > 1) return UNMAPPABLE.ACTION_AMBIGUOUS
  return actions[0]
}

function parseChannel(text) {
  const found = matchVocabulary(text, CHANNEL_TERMS)
  if (found.has(UNMAPPABLE.CHANNEL_UNKNOWN)) return UNMAPPABLE.CHANNEL_UNKNOWN
  const channels = [...found]
  if (channels.length === 0) return null
  if (channels.length > 1) return UNMAPPABLE.CHANNEL_AMBIGUOUS
  return channels[0]
}

/**
 * PERSPECTIVE. "I" does not mean the same thing in both directions, and
 * reading it as DW in both is what let a founder's own question be answered
 * out of DW's grant.
 *
 *   ASSERTION (model-authored prose): DW is the speaker, so I/we/DW = DW and
 *   "you" is the founder.
 *   QUESTION (founder-authored turn):  the founder is the speaker, so you/DW =
 *   DW and I/we/me/us = the founder, who holds no G5 grant.
 *
 * A G5 grant is always to DW. Any other actor therefore has no authority under
 * it, whatever the grant says.
 */
const FIRST_PERSON = /^(?:i|i'm|me|my|myself|mine|we|we're|us|our|ours|ourselves)$/i
const SECOND_PERSON = /^(?:you|you're|your|yours|yourself|yourselves)$/i
/**
 * Only a NOMINATIVE form can be the subject of a verb. "my" in "your approval
 * to send" is a possessor, not the sender; reading it as the actor made an
 * approval question look as though the founder were the one acting.
 */
const OBLIQUE = /^(?:me|us|my|mine|our|ours|your|yours|their|theirs|his|her|hers|its|him|them|myself|ourselves|yourself|yourselves)$/i
const DW_NAME = /^(?:dw|duewatch|due\s?watch)$/i
const GRANT_NOUN = /^(?:grant|grants|permission|permissions|authorisation|authorization|authority|clearance|mandate)$/i
const GENERIC_OTHER = /^(?:system|assistant|agent|bot|platform|tool|service|provider|customer|client|vendor|partner|team|automation|gmail|stripe|quickbooks|someone|somebody|anyone|anybody|everyone|they|them|he|she|it|staff|ops)$/i

/** Maps one surface actor token onto a G5 role under the reading perspective. */
/**
 * Function words are never actors. Without this the capitalised-name branch
 * read a sentence-initial "The" or "No" as a named third party, which silently
 * made "The current grant covers email reminders." somebody else's permission.
 */
const FUNCTION_WORD = /^(?:the|a|an|this|that|these|those|no|not|any|some|all|every|each|both|either|neither|and|or|but|so|if|when|once|after|before|while|because|current|active|standing|explicit|only|still|also|just|now|today|there|here|do|does|did|is|are|am|was|were|be|been|being|have|has|had|can|cannot|could|may|might|must|shall|should|will|would|to|for|of|on|in|at|by|from|with|about|regarding|per|as|than|then|yes)$/i

function actorRoleFor(token, mode, { sentenceInitial = false } = {}) {
  const bare = String(token || '').replace(/^(?:the|a|an|our|your|their|this|that)\s+/i, '').trim()
  if (!bare) return null
  if (FUNCTION_WORD.test(bare)) return null
  if (DW_NAME.test(bare)) return ASK_DW_ACTOR.DW
  if (GRANT_NOUN.test(bare)) return ASK_DW_ACTOR.GRANT_SUBJECT
  if (FIRST_PERSON.test(bare)) {
    // The speaker. DW in its own prose; the founder in the founder's question.
    return mode === ASK_DW_PARSE_MODE.QUESTION ? ASK_DW_ACTOR.OTHER : ASK_DW_ACTOR.DW
  }
  if (SECOND_PERSON.test(bare)) {
    // The addressee. The founder in DW's prose; DW in the founder's question.
    return mode === ASK_DW_PARSE_MODE.QUESTION ? ASK_DW_ACTOR.DW : ASK_DW_ACTOR.OTHER
  }
  if (GENERIC_OTHER.test(bare)) return ASK_DW_ACTOR.OTHER
  // Capitalisation identifies a proper name only away from the start of a
  // sentence, where a capital is orthography rather than nominal. A
  // sentence-initial name is still caught by the NAMED_SUBJECT fallback, which
  // requires a following copula or modal; without this guard the imperative
  // "Keep collection contact on hold." read "Keep" as a third-party actor.
  if (!sentenceInitial && /^[A-Z][A-Za-z0-9&.'-]*$/.test(bare)) return ASK_DW_ACTOR.OTHER
  return null
}

/**
 * Every token position that can name an actor. Determiners are captured with
 * the head noun so "the system" resolves as one actor.
 */
const ACTOR_TOKEN = /\b((?:the|a|an|our|your|their|this|that)\s+)?([A-Za-z][A-Za-z0-9&.'-]*)\b/gi

/**
 * VERB forms of a controlled act. Only verbs, because the actor of an act is
 * the subject of its verb; "reminders" as a bare noun has no subject and falls
 * back to the sentence-level reading.
 */
const AR_ACT_VERB = /\b(?:send|sends|sending|sent|email|emails|emailing|emailed|text|texts|texting|texted|message|messages|messaging|messaged|contact|contacts|contacting|contacted|chase|chasing|chased|nudge|nudging|nudged|remind|reminds|reminding|reminded|call|calls|calling|called|apply|applies|applying|applied|waive|waives|waiving|waived|settle|settles|settling|settled|write|writes|writing|wrote|written|refund|refunds|refunding|refunded|charge|charges|charging|charged|collect|collects|collecting|collected|escalate|escalates|escalating|escalated|handle|handles|handling|handled|perform|performs|performing|issue|issues|issuing|issued)\b/gi

/**
 * The actor of the CONTROLLED ACTION, not merely a pronoun somewhere in the
 * sentence. English is subject-initial, and the controller of an infinitival
 * or participial complement is the nearest preceding nominal, so the actor is
 * the last actor token that ends before the first controlled-act verb.
 *
 * This is what keeps "May I let you send email reminders?" reading as DW —
 * "you" is nearer to "send" than "I" is — while "Can I send email reminders
 * for Atlas?" reads as the founder, and "I am authorized to send Atlas an
 * email reminder." still reads as DW because Atlas follows the verb.
 */
function parseActionActor(text, mode) {
  AR_ACT_VERB.lastIndex = 0
  const verb = AR_ACT_VERB.exec(text)
  if (!verb) return null
  const controlledActor = parseEmbeddedControllerActor(text.slice(0, verb.index), mode)
  if (controlledActor) return controlledActor
  ACTOR_TOKEN.lastIndex = 0
  let nominative = null
  let oblique = null
  let grantNoun = null
  for (const match of text.matchAll(ACTOR_TOKEN)) {
    if (match.index >= verb.index) break
    const token = `${match[1] ?? ''}${match[2]}`
    const candidate = actorRoleFor(token, mode, { sentenceInitial: match.index === 0 })
    if (!candidate) continue
    if (candidate === ASK_DW_ACTOR.GRANT_SUBJECT) grantNoun = candidate
    else if (OBLIQUE.test(match[2])) oblique = candidate
    else nominative = candidate
  }
  // Preference order is grammatical, not positional: a subject outranks a
  // possessor or object, and a grant noun in object position is not the actor
  // of the verb at all -- in "Do you lack permission to send ...", DW is who
  // would send, not the permission.
  return nominative ?? oblique ?? grantNoun
}

/**
 * Resolve the controller of an embedded controlled-action infinitive before
 * considering the matrix subject. In `you ask me to send`, `me` sends; in
 * `I ask you to send`, `you` sends. The same relation covers bare-infinitive
 * causatives (`have/get/let/make`) and named third parties.
 */
function parseEmbeddedControllerActor(prefix, mode) {
  const match = /\b(?:ask(?:s|ed|ing)?|tell(?:s|ing)?|told|allow(?:s|ed|ing)?|have|has|had|having|get|gets|got|getting|let|lets|letting|make|makes|made|making)\s+((?:the\s+)?[A-Za-z][A-Za-z0-9&.'-]*)\s+(?:to\s+)?$/i.exec(prefix)
  if (!match) return null
  const role = actorRoleFor(match[1], mode, { sentenceInitial: false })
  const bare = match[1].replace(/^the\s+/i, '')
  if (!role && FUNCTION_WORD.test(bare)) return null
  // An explicit but unfamiliar controller is a third party, never DW by
  // fallback. This is fail-closed and does not invent authority for that actor.
  return role ?? ASK_DW_ACTOR.OTHER
}

/**
 * Sentence-level actor, used when no controlled-act VERB anchors an actor
 * (for example "Permission was not granted for SMS reminders.").
 *
 * Exported as resolveAskDwActionActor because the ROUTING decision must be
 * able to ask "whose act is this?" independently of whether the span already
 * counts as authority-bearing. Reading the actor off a parsed proposition made
 * routing depend on that same judgement, so the two could never disagree and
 * the routing clause protected nothing.
 */
export function resolveAskDwActionActor(text, mode = ASK_DW_PARSE_MODE.QUESTION) {
  return parseActor(normalizeAuthorityText(text), mode)
}

function parseActor(text, mode = ASK_DW_PARSE_MODE.ASSERTION) {
  const bound = parseActionActor(text, mode)
  if (bound) return bound
  if (GRANT_SUBJECT.test(text)) return ASK_DW_ACTOR.GRANT_SUBJECT
  if (OTHER_ACTOR.test(text)) return ASK_DW_ACTOR.OTHER
  const named = NAMED_SUBJECT.exec(text)
  if (named && !/^(?:i|we|dw|duewatch)$/i.test(named[1]) &&
      !/^(?:the|this|that|a|an|our|your|current|active|standing|explicit|grant|permission|authori[sz]ation|authority|clearance|email|sms|sending|no|permission)$/i.test(named[1])) {
    return ASK_DW_ACTOR.OTHER
  }
  if (mode === ASK_DW_PARSE_MODE.QUESTION) {
    if (/\byou\b|\byour\b|\bdw\b|\bduewatch\b/i.test(text)) return ASK_DW_ACTOR.DW
    if (DW_ACTOR.test(text)) return ASK_DW_ACTOR.OTHER
  } else if (DW_ACTOR.test(text)) {
    return ASK_DW_ACTOR.DW
  }
  return ASK_DW_ACTOR.UNKNOWN
}

/**
 * Scope asserted BY THE TEXT, which is not the same as the conversation's
 * focus. An Atlas grant must not support "for Globex" or "company-wide".
 */
/**
 * Words that follow a preposition without naming a scope target. "for SMS
 * reminders" and "for me to send" assert no scope; "for globex" does.
 */
const NON_SCOPE_TOKENS = new Set([
  'email', 'e-mail', 'emails', 'sms', 'text', 'texts', 'whatsapp', 'phone', 'postal',
  'portal', 'reminder', 'reminders', 'message', 'messages', 'notice', 'notices',
  'collection', 'collections', 'fee', 'fees', 'refund', 'refunds', 'approval',
  'permission', 'authority', 'authorisation', 'authorization', 'grant', 'grants',
  'me', 'us', 'you', 'them', 'it', 'this', 'that', 'these', 'those', 'now', 'today',
  'anything', 'something', 'nothing', 'sending', 'emailing', 'texting', 'asking',
  'each', 'every', 'any', 'both',
  // Verbs and function words that can follow a preposition without ever
  // naming a scope target: "to send", "for applying", "to act".
  'send', 'sends', 'sending', 'apply', 'applying', 'waive', 'waiving', 'settle',
  'settling', 'write', 'writing', 'issue', 'issuing', 'charge', 'charging',
  'chase', 'chasing', 'nudge', 'contact', 'contacting', 'remind', 'reminding',
  'do', 'act', 'acting', 'handle', 'handling', 'proceed', 'go', 'be', 'have',
  'a', 'an', 'the', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
  // Domain nouns and modifiers that can sit in object position without ever
  // naming a scope target: "waive late fees", "settle the invoice".
  'late', 'overdue', 'outstanding', 'unpaid', 'final', 'first', 'second',
  'third', 'gentle', 'friendly', 'polite', 'firm', 'formal', 'another',
  'invoice', 'invoices', 'inv', 'payment', 'payments', 'balance', 'balances',
  'statement', 'statements', 'bill', 'bills', 'amount', 'amounts', 'off',
  'out', 'up', 'back', 'all', 'one', 'two', 'three', 'draft', 'copy', 'letter',
  'letters', 'chaser', 'chasers', 'dunning', 'no', 'not', 'never', 'only',
])

/**
 * A token in DIRECT OBJECT or DATIVE position after a controlled act. This is
 * how "send Atlas an email reminder" names Atlas: no preposition, no "client"
 * head noun, just word order.
 *
 * It is deliberately the INVERSE of a target-name catalogue. Nothing here
 * knows any entity name; a token is a candidate scope target unless it is in
 * the closed non-scope vocabulary above. An unrecognised token therefore
 * becomes an unresolved entity and fails closed, rather than being silently
 * dropped so the conversation's focus can fill the gap.
 */
const DIRECT_OBJECT_CUE = /\b(?:send|sends|sending|email|emails|emailing|text|texts|texting|message|messages|messaging|contact|contacts|contacting|chase|chasing|nudge|nudging|remind|reminds|reminding|call|calls|calling|charge|charges|charging|invoice|invoicing|settle|settles|settling|refund|refunds|refunding|waive|waives|waiving|apply|applies|applying|collect|collects|collecting|escalate|escalates|escalating)\s+(?:the\s+|our\s+|their\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9&.'-]*)/gi

// Broader-than-client scope, however it is phrased. Any of these must stop a
// client-focus fallback: "everywhere" cannot be satisfied by one client grant.
const COMPANY_SCOPE = /\bcompany[- ]wide\b|\bacross\s+(?:the|our|all)\s+(?:company|business|organi[sz]ation|portfolio|book|accounts?|clients?)\b|\bthroughout\s+(?:the|our)\s+(?:company|business|organi[sz]ation|portfolio|book)\b|\bportfolio[- ]wide\b|\borgani[sz]ation[- ]wide\b|\benterprise[- ]wide\b|\bgroup[- ]wide\b|\bfirm[- ]wide\b|\bbusiness[- ]wide\b|\bglobally\b|\beverywhere\b|\bcompany\s+level\b|\ball\s+clients\b|\bevery\s+client\b|\ball\s+customers\b|\ball\s+accounts\b|\bany\s+client\b/i

// An explicitly OTHER target names a scope that by construction is not the one
// in hand, so it can never resolve.
const OTHER_SCOPE = /\b(?:another|other|a\s+different|some\s+other|different)\s+(?:client|customer|account|entity|company)\b|\bother\s+clients\b/i

// A token position that could be naming an entity. Used only to decide whether
// a scope was ASSERTED; resolution itself is done against known entities.
const ENTITY_CUE = /\b(?:for|to|on|against|regarding|about|re|with|at)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9&.'-]*)|\b(?:client|customer|account)\s+([A-Za-z][A-Za-z0-9&.'-]*)/gi

/** Every surface form a known entity can be named by. */
function entityForms(entity) {
  if (typeof entity === 'string') return [entity]
  return [entity?.id, entity?.name, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])]
    .filter((value) => typeof value === 'string' && value.trim())
}

/**
 * Scope asserted BY THE TEXT, resolved against the tenant's actual known
 * entities rather than by guessing at syntax. "send Atlas an email reminder"
 * names Atlas as surely as "for Atlas" does, and neither may be answered with
 * a Globex grant because the conversation happens to be focused on Globex.
 *
 * UNSPECIFIED (no entity or scope language at all) is the ONLY state in which
 * conversational focus may stand in. UNKNOWN means something was named and did
 * not resolve, which always fails closed.
 */
function parseScope(text, knownEntities = []) {
  const none = { scopeType: ASK_DW_SCOPE_ASSERTION.UNSPECIFIED, clientName: null, entityId: null }
  const entityMatch = /\b(?:invoice|inv)[-\s#]?([A-Za-z0-9][A-Za-z0-9-]*\d[A-Za-z0-9-]*)\b/i.exec(text)
  const companyWide = COMPANY_SCOPE.test(text)

  if (OTHER_SCOPE.test(text)) {
    return { scopeType: ASK_DW_SCOPE_ASSERTION.UNKNOWN, clientName: null, entityId: null }
  }

  // Resolve any known entity named anywhere in the proposition, in any
  // syntactic position: direct object, dative, prepositional phrase.
  const named = new Map()
  for (const entity of knownEntities) {
    for (const form of entityForms(entity)) {
      const pattern = new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-_]/g, '[-_ ]')}\\b`, 'i')
      if (pattern.test(text)) {
        named.set(typeof entity === 'string' ? entity : entity.id, true)
        break
      }
    }
  }
  if (named.size > 1) return { scopeType: ASK_DW_SCOPE_ASSERTION.AMBIGUOUS, clientName: null, entityId: null }
  if (named.size === 1) {
    const id = [...named.keys()][0]
    if (companyWide) return { scopeType: ASK_DW_SCOPE_ASSERTION.AMBIGUOUS, clientName: null, entityId: null }
    return { scopeType: ASK_DW_SCOPE_ASSERTION.CLIENT, clientName: id, entityId: null }
  }

  if (companyWide && entityMatch) {
    return { scopeType: ASK_DW_SCOPE_ASSERTION.AMBIGUOUS, clientName: null, entityId: null }
  }
  if (companyWide) return { scopeType: ASK_DW_SCOPE_ASSERTION.COMPANY, clientName: null, entityId: null }
  if (entityMatch) return { scopeType: ASK_DW_SCOPE_ASSERTION.ENTITY, clientName: null, entityId: entityMatch[1] }

  // Nothing known was named. If the prose nonetheless appears to name a target,
  // it is an unresolved entity and must fail closed rather than borrow focus.
  ENTITY_CUE.lastIndex = 0
  for (const match of text.matchAll(ENTITY_CUE)) {
    const token = (match[1] ?? match[2] ?? '').trim()
    if (!token || NON_SCOPE_TOKENS.has(token.toLowerCase())) continue
    return { scopeType: ASK_DW_SCOPE_ASSERTION.UNKNOWN, clientName: token, entityId: null }
  }
  DIRECT_OBJECT_CUE.lastIndex = 0
  for (const match of text.matchAll(DIRECT_OBJECT_CUE)) {
    const token = (match[1] ?? '').trim()
    if (!token || NON_SCOPE_TOKENS.has(token.toLowerCase())) continue
    return { scopeType: ASK_DW_SCOPE_ASSERTION.UNKNOWN, clientName: token, entityId: null }
  }
  if (/\b(?:client|customer|account)\b/i.test(text)) {
    return { scopeType: ASK_DW_SCOPE_ASSERTION.UNKNOWN, clientName: null, entityId: null }
  }
  return none
}

/**
 * Polarity. A single scoping negator makes the proposition negative; nested or
 * doubled negation is reported AMBIGUOUS rather than being resolved, because
 * "DW is not unauthorized" must never become a positive claim by arithmetic.
 */
// "No approval is needed" negates the APPROVAL requirement, not the
// authority. It is an authority-bearing POSITIVE claim, and it is validated
// against the grant's approvalRequirement separately.
// Approval, sign-off and consent are ONE dimension. Negating a requirement to
// ask is not negating the authority itself, so this is removed from the text
// before polarity is computed. Missing this is what let
// "I can send email reminders without your sign-off." read as a denial.
const APPROVAL_TERM = "(?:approval|approvals|sign[- ]?off|signoff|consent|authorisation|authorization|permission\\s+slip|the\\s+ok|okay)"
const APPROVAL_NEGATION = new RegExp([
  `\\bno\\s+${APPROVAL_TERM}`,
  `\\b${APPROVAL_TERM}\\s+(?:is|was|are)\\s+not\\s+(?:needed|required|necessary)`,
  `\\bwithout\\s+(?:your\\s+|my\\s+|the\\s+|any\\s+|first\\s+)?(?:asking|checking|needing\\s+)?${APPROVAL_TERM}`,
  '\\bwithout\\s+(?:asking|checking|clearing\\s+it)',
  `\\bdo(?:es)?\\s+not\\s+(?:need|require)\\s+(?:your\\s+|my\\s+|any\\s+)?${APPROVAL_TERM}`,
  `\\bdon'?t\\s+(?:need|require)\\s+(?:your\\s+|my\\s+|any\\s+)?${APPROVAL_TERM}`,
  "\\bdo(?:es)?\\s+not\\s+need\\s+to\\s+ask",
  "\\bdon'?t\\s+need\\s+to\\s+ask",
  "\\bneed\\s+not\\s+ask",
].join('|'), 'gi')

function parsePolarity(text, approvalState) {
  if (DOUBLE_NEGATION_HINT.test(text)) return ASK_DW_POLARITY.AMBIGUOUS
  // Asserting that approval IS required is a statement that DW cannot act
  // unilaterally, which is a negative authority claim.
  if (approvalState === 'FOUNDER') return ASK_DW_POLARITY.NEGATIVE
  const scoped = String(text).replace(APPROVAL_NEGATION, ' ')
  const negators = scoped.match(NEGATORS) || []
  if (negators.length === 0) return ASK_DW_POLARITY.POSITIVE
  if (negators.length === 1) return ASK_DW_POLARITY.NEGATIVE
  return ASK_DW_POLARITY.AMBIGUOUS
}

function parseApproval(text) {
  // Asserting that no approval is needed is a POSITIVE claim about acting
  // alone, so it is detected before polarity and validated against the
  // grant's approvalRequirement.
  APPROVAL_NEGATION.lastIndex = 0
  if (APPROVAL_NEGATION.test(text)) return 'NONE'
  if (new RegExp(`\\b${APPROVAL_TERM}\\s+(?:is\\s+)?(?:needed|required|necessary)|\\b(?:need|require)s?\\s+(?:your\\s+|my\\s+)?${APPROVAL_TERM}|\\bask\\s+(?:you\\s+)?first|\\bcheck\\s+with\\s+you\\s+first`, 'i').test(text)) {
    return 'FOUNDER'
  }
  return null
}

/** Capability language that cannot be mapped onto G5 semantics at all. */
const VAGUE_CAPABILITY = /\bgreen\s?light\b|\bcleared\s+to\b|\bfree\s+to\b|\bgood\s+to\s+go\b|\bnothing\s+(?:is\s+)?(?:prevent|stopp|block)/i

/**
 * Parses ONE proposition. Every dimension comes from this proposition's own
 * text; nothing is inherited from a sibling clause, sentence or field.
 */
export function parseAuthorityProposition(proposition, { knownEntities = [], mode = ASK_DW_PARSE_MODE.ASSERTION } = {}) {
  const text = proposition.text
  const dwActor = parseActor(text, mode)
  const controlledAct = AR_ACT.test(text)
  const unknownOperationalCandidate = ownsUnknownOperationalLanguage(text, mode, knownEntities)
  const explicitDeontic = EXPLICIT_DEONTIC.test(text) || AUTHORITY_TRIGGER.test(text)
  const modalDeontic = MODAL_DEONTIC.test(text)
  // In a question, a leading wh-word is an interrogative, not the conditional
  // "when"/"if" of a hypothetical. "When may I send a reminder?" is a
  // permission question; "when I send a reminder" is a condition.
  const frameText = mode === ASK_DW_PARSE_MODE.QUESTION
    ? text.replace(/^(?:so\s+|and\s+|but\s+)?(?:what|which|when|where|who|whom|whose|why|how)\b/i, ' ')
    : text
  const frames = parseFrames(frameText)
  const exempted = EXEMPTING_FRAMES.some((frame) => frames.has(frame))
  // Authority-bearing when DW (or the grant itself) is tied to a controlled
  // accounts-receivable act in anything other than a recommendation,
  // condition, hypothetical or already-executed frame -- OR when explicit
  // deontic language appears at all. The first clause is what closes the
  // open-ended synonym problem.
  const authorityBearing =
    (controlledAct && (dwActor === ASK_DW_ACTOR.DW || dwActor === ASK_DW_ACTOR.GRANT_SUBJECT ||
      dwActor === ASK_DW_ACTOR.OTHER) && !exempted) ||
    (unknownOperationalCandidate && !exempted) ||
    explicitDeontic ||
    (modalDeontic && (controlledAct || GRANT_SUBJECT.test(text)))
  const base = {
    ...proposition,
    authorityBearing,
    polarity: null, actor: null, canonicalAction: null, scopeType: null,
    clientName: null, entityId: null, channel: null, approvalState: null,
    vagueCapability: false, grantIdentity: null,
    unknownOperationalCandidate,
    frames: Object.freeze([...frames]),
    conditional: frames.has(ASK_DW_FRAME.CONDITION),
  }
  if (!authorityBearing) return Object.freeze(base)

  const scope = parseScope(text, knownEntities)
  const approvalState = parseApproval(text)
  return Object.freeze({
    ...base,
    polarity: parsePolarity(text, approvalState),
    actor: dwActor,
    canonicalAction: parseAction(text),
    scopeType: scope.scopeType,
    clientName: scope.clientName,
    entityId: scope.entityId,
    channel: parseChannel(text),
    approvalState,
    vagueCapability: VAGUE_CAPABILITY.test(text),
    // A grant referred to by identity must still match a real current grant.
    grantIdentity: /\bgrant\b|\bauthoris|\bauthoriz|\bpermission\b/i.test(text) ? 'REFERENCED' : null,
  })
}

/**
 * Parses every model-authored field independently. Fields are never joined,
 * so a claim in one field cannot borrow specifics from another.
 */
export function parseCandidateAuthorityPropositions(candidate, { knownEntities = [] } = {}) {
  const fields = [
    ['executiveConclusion', candidate?.executiveConclusion],
    ...(Array.isArray(candidate?.evidenceBasis) ? candidate.evidenceBasis.map((v, i) => [`evidenceBasis[${i}]`, v]) : []),
    ...(Array.isArray(candidate?.uncertaintyAndLimitations) ? candidate.uncertaintyAndLimitations.map((v, i) => [`uncertaintyAndLimitations[${i}]`, v]) : []),
    ['recommendationOrNextStep', candidate?.recommendationOrNextStep],
    ...(Array.isArray(candidate?.competingExplanations) ? candidate.competingExplanations.map((v, i) => [`competingExplanations[${i}]`, v]) : []),
  ]
  const propositions = []
  for (const [field, value] of fields) {
    if (typeof value !== 'string' || !value.trim()) continue
    for (const segment of segmentPropositions(value, { field })) {
      propositions.push(parseAuthorityProposition(segment, { knownEntities }))
    }
  }
  return Object.freeze(propositions)
}


// ── the shared typed authority-request boundary ──────────────────────────────

/**
 * An interrogative or directed shape. A founder turn is only routed to the
 * deterministic authority answer when it BOTH asks something AND carries an
 * authority-bearing proposition under the same closed boundary used to police
 * DW's own sentences. There is deliberately no phrase list here: a request is
 * recognised from the controlled-act / DW-actor relationship, exactly as an
 * assertion is.
 */
const INTERROGATIVE_OPENER = /^(?:so\s+|and\s+|but\s+|ok(?:ay)?,?\s+|hey,?\s+)*(?:may|might|can|could|should|would|will|shall|must|do|does|did|are|is|am|was|were|have|has|had|what|which|when|where|who|whom|whose|why|how|tell\s+me|remind\s+me|confirm)\b/i

/**
 * A bare capability overview aimed at DW: "what can you do?", "what can't you
 * do?", "what are you able to handle?".
 *
 * This is the one shape the act/actor relationship cannot decide, because the
 * question names no act at all — its predicate is a pro-verb. Capability and
 * permission are indistinguishable here, so it FAILS CLOSED by routing to the
 * deterministic authority answer, which can only ever describe real grants.
 * It is anchored end to end so it can never widen: "what can you tell me about
 * Atlas?" names a real complement and is not this shape.
 */
const CAPABILITY_OVERVIEW = /^(?:so\s+|and\s+)?(?:what|how\s+much)\s+(?:exactly\s+)?(?:can|can'?t|cannot|cant|could|may|might|are|am)\s+(?:you|dw|duewatch|i\s+letting\s+you)\s*(?:able\s+to\s+|allowed\s+to\s+)?(?:do|handle|act\s+on|help\s+with|manage|run)?\s*$/i

/**
 * A turn that names authority itself is a request even in declarative shape:
 * "I want to know what you are allowed to do."
 */
const AUTHORITY_ENQUIRY = /\b(?:what|which|whether|if)\b[^.?!]{0,80}\b(?:authoris\w*|authoriz\w*|authority|authorities|permission|permitted|allowed|entitled|grants?|granted|approval|clearance|remit|mandate)\b/i

/**
 * Classifies one founder turn as an authority request, using the SAME typed
 * proposition boundary that governs DW's own authority sentences.
 *
 * This replaces the previous independent, sentence-shaped recogniser. Both the
 * turn classifier and the deterministic authority answer consume this one
 * boundary, so a phrase that reaches the answer path can never fail to reach
 * the routing path, and vice versa.
 */
/**
 * The SEMANTIC KIND of an authority question. Reducing every question to
 * "governing ? YES : NO" inverted the answer to any question whose surface
 * polarity was not plain: "Do you need my approval ...?" was answered from
 * whether a grant governs, which is the opposite of what was asked.
 */
export const ASK_DW_QUESTION_SEMANTIC = Object.freeze({
  AUTHORITY_OVERVIEW: 'AUTHORITY_OVERVIEW',
  CAN_ACT: 'CAN_ACT',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  NEGATED_CAPABILITY: 'NEGATED_CAPABILITY',
  FUTURE_CONTROLLED_ACTION: 'FUTURE_CONTROLLED_ACTION',
  HISTORICAL_EXECUTION: 'HISTORICAL_EXECUTION',
})

/**
 * Asks whether DW MUST OBTAIN approval, rather than whether DW may act. The
 * approval dimension already exists on the proposition; this only asks whether
 * the QUESTION is about that dimension.
 */
const ASKS_ABOUT_APPROVAL = /\b(?:need|needs|require|requires|want|get|have\s+to\s+(?:get|ask)|ask\s+(?:me|us)?\s*first|check\s+with\s+(?:me|us))\b[^?]{0,40}\b(?:approval|sign[- ]?off|signoff|consent|permission\s+from|the\s+ok|okay|go[- ]ahead)\b|\b(?:approval|sign[- ]?off|consent)\b[^?]{0,30}\b(?:needed|required|necessary)\b/i

const APPROVAL_ACT = /(?:approv(?:e|es|ed|ing)|authori[sz](?:e|es|ed|ing)|consent|sign\s*off|say\s+yes|give\s+(?:the\s+)?(?:ok|okay|go[- ]ahead))/i

/**
 * Founder authorization as a prerequisite relation, not as a sentence list.
 * The approval actor must be the founder and the governed operation must be
 * DW's. This captures verbal forms while preserving speaker perspective.
 */
function asksAboutApprovalPrerequisite(text) {
  if (!APPROVAL_ACT.test(text)) return false
  const prerequisite = /\b(?:need|require|have\s+to|must|before|prior\s+to|in\s+order\s+for)\b/i.test(text)
  if (!prerequisite) return false
  const founderApproves = new RegExp([
    '\\b(?:do|would|will|must|should)\\s+(?:i|we)\\s+(?:(?:need|have)\\s+to\\s+)?',
    `(?:${APPROVAL_ACT.source})`,
    '|\\b(?:you|dw|due\\s?watch)\\s+(?:need|require|want)\\s+(?:me|us)\\s+to\\s+',
    `(?:${APPROVAL_ACT.source})`,
  ].join(''), 'i').test(text)
  if (!founderApproves) return false
  const actionVerb = '(?:send|sending|email|emailing|text|texting|message|messaging|contact|contacting|remind|reminding|apply|applying|waive|waiving|settle|settling|write|writing|refund|refunding|issue|issuing|charge|charging|collect|collecting|act|acting|proceed|proceeding)'
  const explicitDwActor = new RegExp(`\\bbefore\\s+(?:you|dw|due\\s?watch)\\s+${actionVerb}\\b`, 'i').test(text)
  // A subjectless gerund inherits DW only from a matrix in which DW requires
  // the founder's approval act. In "Do I approve before sending?" the founder,
  // not DW, is the implied sender.
  const dwRequiresFounder = new RegExp(`\\b(?:you|dw|due\\s?watch)\\s+(?:need|require|want)\\s+(?:me|us)\\s+to\\s+(?:${APPROVAL_ACT.source})`, 'i').test(text)
  const impliedDwActor = dwRequiresFounder &&
    new RegExp(`\\bbefore\\s+${actionVerb}\\b`, 'i').test(text)
  return explicitDwActor || impliedDwActor
}

/**
 * A commitment or intention question rather than a permission question:
 * "Will you send ...?", "Do you plan to send ...?". These are answered from
 * authority too, because DW committing to a controlled action it may not
 * perform is the same escalation by another route.
 */
const FUTURE_FRAME = /^(?:so\s+|and\s+)?(?:will|would|shall|should)\b|\b(?:are|is)\s+(?:you|dw)\s+going\s+to\b|\b(?:do|does)\s+(?:you|dw)\s+(?:plan|intend|mean)\s+to\b|\bplanning\s+to\b|\babout\s+to\b/i

/**
 * PAST reference. "Did you send ...?" is a question about what happened, which
 * the deterministic execution/evidence path owns; it is not a standing
 * authority question and must not be answered as one.
 */
/**
 * A PREVENTION relation. This is a structural shape — a stative predicate
 * followed by "from" governing the controlled act — not a list of prohibition
 * words. "forbidden from sending", "prohibited from sending", "barred from
 * sending" and "restricted from sending" are one construction, and so is any
 * other participle that fills the same slot.
 */
const NEGATED_CAPABILITY_FRAME = /\b\w+(?:ed|en)\s+from\s+\w+ing\b|\b\w+(?:ed|en)\s+from\s+(?:the\s+)?\w+\s+\w+ing\b|\black(?:s|ing)?\s+(?:the\s+)?(?:permission|authority|authoris|authoriz|clearance|mandate)/i

const PAST_AUXILIARY = /^(?:so\s+|and\s+)?did\b/i
const PAST_PARTICIPLE_ACT = /\b(?:sent|emailed|texted|messaged|contacted|chased|nudged|reminded|called|charged|applied|waived|settled|refunded|collected|escalated|written\s+off|wrote\s+off)\b/i
const PERFECT_AUXILIARY = /^(?:so\s+|and\s+)?(?:have|has|had)\s+(?:you|dw|duewatch)\b/i

/** Whether a question refers to an already-performed act rather than authority. */
function refersToPastExecution(text) {
  if (PAST_AUXILIARY.test(text)) return true
  return PERFECT_AUXILIARY.test(text) && PAST_PARTICIPLE_ACT.test(text)
}

export function classifyAskDwAuthorityRequest(text, { knownEntities = [] } = {}) {
  const raw = String(text || '')
  const normalized = normalizeAuthorityText(raw)
  if (!normalized) {
    return Object.freeze({ isAuthorityRequest: false, interrogative: false, proposition: null })
  }
  const stripped = normalized.replace(/[?!.,]+$/g, '')
  const proposition = parseAuthorityProposition(
    { field: 'question', text: stripped, quoted: false, attributedTo: null },
    { knownEntities, mode: ASK_DW_PARSE_MODE.QUESTION },
  )
  const interrogative = /\?/.test(raw) || INTERROGATIVE_OPENER.test(stripped)
  const historical = refersToPastExecution(stripped)
  // ROUTING FROM THE ACTION RELATION, not from authority vocabulary. If the
  // founder asks whether DW is to perform, may perform, will perform or is
  // prevented from performing a controlled act, deterministic handling owns
  // the answer — whether the question says "allowed", "forbidden", "barred",
  // "restricted", or nothing of the kind.
  const approvalPrerequisite = asksAboutApprovalPrerequisite(stripped)
  const operationalPresentation = inspectAskDwFounderOperationPresentation({
    text: stripped, knownEntities,
  })
  // In a prerequisite question the controlled operation's actor is established
  // by the relation itself. A noun such as "email" before the embedded `send`
  // must not be mistaken for the first controlled verb and bind the founder.
  const questionActor = approvalPrerequisite ||
    operationalPresentation?.presentation === ASK_DW_OPERATION_PRESENTATION.IMPERATIVE
    ? ASK_DW_ACTOR.DW
    : parseActor(stripped, ASK_DW_PARSE_MODE.QUESTION)
  const asksAboutDwControlledAction =
    interrogative && AR_ACT.test(stripped) && questionActor === ASK_DW_ACTOR.DW
  const unknownOperationalQuestion =
    ownsUnknownOperationalLanguage(stripped, ASK_DW_PARSE_MODE.QUESTION, knownEntities)
  const overview = CAPABILITY_OVERVIEW.test(stripped) || AUTHORITY_ENQUIRY.test(stripped)
  const isAuthorityRequest = Boolean(
    !historical && (
      (proposition.authorityBearing && interrogative) ||
      asksAboutDwControlledAction ||
      unknownOperationalQuestion ||
      overview),
  )

  const semantic = !isAuthorityRequest ? (historical ? ASK_DW_QUESTION_SEMANTIC.HISTORICAL_EXECUTION : null)
    : overview && (proposition.canonicalAction == null ||
      proposition.canonicalAction === UNMAPPABLE.ACTION_UNKNOWN)
      ? ASK_DW_QUESTION_SEMANTIC.AUTHORITY_OVERVIEW
      : (ASKS_ABOUT_APPROVAL.test(stripped) || approvalPrerequisite)
        ? ASK_DW_QUESTION_SEMANTIC.APPROVAL_REQUIRED
        // Surface negation is read with the SAME polarity machinery that reads
        // DW's own sentences, so "can't you", "aren't you allowed" and "do you
        // lack permission" are one thing, not three entries in a list.
        : proposition.polarity === ASK_DW_POLARITY.NEGATIVE ||
          NEGATED_CAPABILITY_FRAME.test(stripped)
          ? ASK_DW_QUESTION_SEMANTIC.NEGATED_CAPABILITY
          : FUTURE_FRAME.test(stripped)
            ? ASK_DW_QUESTION_SEMANTIC.FUTURE_CONTROLLED_ACTION
            : ASK_DW_QUESTION_SEMANTIC.CAN_ACT

  return Object.freeze({
    isAuthorityRequest, interrogative, historical, semantic, proposition,
    // The actor is resolved from the question's own grammar, never taken from
    // a proposition that may have declined to record one.
    actor: questionActor,
  })
}

// ── known entities ───────────────────────────────────────────────────────────

/**
 * The tenant's actually-known entities, gathered from the same read-only
 * sources the answer is resolved against. This is the deterministic reference
 * seam scope resolution uses; it is NOT a catalogue of target names, and it
 * never invents an entity that does not appear in admitted state.
 */
export function collectAskDwKnownEntities({
  authorityProjection = null, companyBrainContext = null, caseContext = null,
} = {}) {
  const byId = new Map()
  const add = (id, ...names) => {
    if (id == null || String(id).trim() === '') return
    const key = String(id)
    const entry = byId.get(key) || { id: key, name: null, aliases: new Set() }
    for (const name of names) {
      if (typeof name === 'string' && name.trim()) entry.aliases.add(name.trim())
    }
    byId.set(key, entry)
  }
  const list = (value) => (Array.isArray(value) ? value : [])
  for (const grant of list(authorityProjection?.currentGrants)) {
    add(grant?.scope?.clientId ?? grant?.clientId, grant?.scope?.clientName)
  }
  for (const key of ['understanding', 'conflicts', 'roles', 'pendingFounderDecisions', 'changedSinceReview']) {
    for (const item of list(companyBrainContext?.[key])) {
      add(item?.clientId, item?.clientName, item?.scope?.clientName)
    }
  }
  const focus = caseContext?.focus ?? null
  add(focus?.clientRef?.id, focus?.clientRef?.name, focus?.clientRef?.label)
  for (const candidate of list(caseContext?.candidates)) {
    add(candidate?.id ?? candidate?.clientRef?.id, candidate?.name, candidate?.label)
  }
  return Object.freeze([...byId.values()].map((entry) => Object.freeze({
    id: entry.id, name: entry.name, aliases: Object.freeze([...entry.aliases]),
  })))
}
