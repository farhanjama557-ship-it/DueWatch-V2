/**
 * Closed-world read-only operation accounting for Ask DW.
 *
 * This module does not infer authority and cannot execute anything. Its only
 * positive result is that every source span in a direct founder request or a
 * first-person DW proposition belongs to a registered read-only operation,
 * one of that operation's typed arguments, a typed relation between two
 * independently valid operations, or the finite wrapper grammar below.
 * Extracted structure is untrusted: validateAskDwOperationStructure always
 * rechecks source offsets, surfaces, arguments, ordering and total coverage.
 */

import {
  findAskDwContextualReferenceSuffix,
  hasAskDwVerifiedActiveSubject,
  isAskDwContextualReference,
} from './askDwReferenceGrammar.js'

export const ASK_DW_OPERATION_MODE = Object.freeze({
  FOUNDER_REQUEST: 'FOUNDER_REQUEST',
  MODEL_COMMITMENT: 'MODEL_COMMITMENT',
})

export const ASK_DW_OPERATION_PRESENTATION = Object.freeze({
  MODAL_DIRECT: 'MODAL_DIRECT',
  IMPERATIVE: 'IMPERATIVE',
  MODEL_COMMITMENT: 'MODEL_COMMITMENT',
})

export const ASK_DW_OPERATION_TARGET_PRESENTATION = Object.freeze({
  EXPLICIT: 'EXPLICIT',
  CONTEXTUAL_REFERENCE: 'CONTEXTUAL_REFERENCE',
  ACTIVE_FOCUS_ELLIPSIS: 'ACTIVE_FOCUS_ELLIPSIS',
})

export const ASK_DW_OPERATION_SAFETY = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  FAIL_CLOSED_CLARIFY: 'FAIL_CLOSED_CLARIFY',
})

export const ASK_DW_OPERATION_COMPONENT = Object.freeze({
  WRAPPER: 'WRAPPER',
  OPERATION: 'OPERATION',
  ARGUMENT: 'ARGUMENT',
  RELATION: 'RELATION',
})

const MAX_OPERATIONS = 8
const STRUCTURE_VERSION = 'ASK_DW_OPERATION_STRUCTURE_V1'

const OPERATION_DEFINITIONS = Object.freeze([
  { id: 'EXPLAIN', job: 'EXPLAIN', surfaces: ['explain'] },
  { id: 'SUMMARIZE', job: 'EXPLAIN', surfaces: ['summarise', 'summarize'] },
  { id: 'SHOW', job: 'EXPLAIN', surfaces: ['show'] },
  { id: 'DESCRIBE', job: 'EXPLAIN', surfaces: ['describe'] },
  { id: 'LIST', job: 'EXPLAIN', surfaces: ['list'] },
  { id: 'COMPARE', job: 'EXPLAIN', surfaces: ['compare'] },
  { id: 'ANALYZE', job: 'EXPLAIN', surfaces: ['analyse', 'analyze'] },
  { id: 'CLARIFY', job: 'EXPLAIN', surfaces: ['clarify'] },
  { id: 'REVIEW', job: 'EXPLAIN', surfaces: ['review'] },
  { id: 'INSPECT', job: 'EXPLAIN', surfaces: ['inspect'] },
  { id: 'READ', job: 'EXPLAIN', surfaces: ['read'] },
  { id: 'CALCULATE', job: 'EXPLAIN', surfaces: ['calculate'] },
  { id: 'WATCH', job: 'EXPLAIN', surfaces: ['keep watching', 'keep monitoring', 'watch', 'monitor'] },
  { id: 'LOOK_UP', job: 'EXPLAIN', surfaces: ['look up'] },
  { id: 'CHECK', job: 'EXPLAIN', surfaces: ['check'] },
  { id: 'HELP_UNDERSTAND', job: 'EXPLAIN', surfaces: ['help me understand', 'help us understand'] },
  { id: 'TELL_ABOUT', job: 'EXPLAIN', surfaces: ['tell me about', 'tell us about'] },
  { id: 'INVESTIGATE', job: 'INVESTIGATE', surfaces: ['investigate'] },
  { id: 'DIG_INTO', job: 'INVESTIGATE', surfaces: ['dig into'] },
  { id: 'FIND_OUT', job: 'INVESTIGATE', surfaces: ['find out'] },
  { id: 'FORECAST', job: 'PREDICT', surfaces: ['forecast'] },
  { id: 'PREDICT', job: 'PREDICT', surfaces: ['predict'] },
  { id: 'RECOMMEND', job: 'DECIDE', surfaces: ['recommend'] },
  { id: 'DECIDE', job: 'DECIDE', surfaces: ['decide'] },
])

export const ASK_DW_READ_ONLY_OPERATION_REGISTRY = Object.freeze(
  OPERATION_DEFINITIONS.map((definition) => Object.freeze({
    id: definition.id,
    job: definition.job,
    surfaces: Object.freeze([...definition.surfaces]),
  })),
)

const BY_ID = new Map(OPERATION_DEFINITIONS.map((definition) => [definition.id, definition]))
const SURFACES = Object.freeze(OPERATION_DEFINITIONS.flatMap((definition) =>
  definition.surfaces.map((surface) => Object.freeze({ definition, surface })))
  .sort((left, right) => right.surface.length - left.surface.length))

export function recognizeRegisteredAskDwReadOnlyJob(text) {
  const source = String(text || '')
  const jobs = new Set()
  for (const entry of SURFACES) {
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(entry.surface)}(?=$|[^\\p{L}\\p{N}_])`, 'iu')
    if (pattern.test(source)) jobs.add(entry.definition.job)
  }
  const job = ['DECIDE', 'PREDICT', 'INVESTIGATE', 'EXPLAIN'].find((candidate) => jobs.has(candidate))
  return job ? Object.freeze({ job, source: 'ask_dw_read_only_operation_registry' }) : null
}

// Relations are typed only when they sit BETWEEN two independently validated
// operation components. They are never globally ignored and never make an
// otherwise-invalid argument safe.
const RELATION_SUFFIX = /(?:,\s*)?(?:and\s+then|and|then|but\s+also)\s*$/i
const RELATION_FULL = /^(?:,\s*)?(?:and\s+then|and|then|but\s+also)\s*$/i
const IGNORABLE_GAP = /^[\s.!?]*$/u
const CLOSED_DOMAIN_NOUN = '(?:account(?: history)?|accounts?|balance|balances|evidence|facts?|history|invoice|invoices|payment|payments|status|difference|changes?)'

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function entityForms(knownEntities) {
  const forms = []
  for (const entity of Array.isArray(knownEntities) ? knownEntities : []) {
    const candidates = typeof entity === 'string'
      ? [entity]
      : [entity?.id, entity?.name, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) forms.push(candidate.trim())
    }
  }
  return [...new Set(forms)].sort((a, b) => b.length - a.length)
}

function exactEntity(value, knownEntities) {
  const normalized = String(value || '').trim().toLocaleLowerCase('en-US')
  return entityForms(knownEntities).some((form) => form.toLocaleLowerCase('en-US') === normalized)
}

function exactEntityReference(value, knownEntities) {
  const reference = String(value || '').trim()
  if (exactEntity(reference, knownEntities)) return true
  const typed = /^(?:the\s+)?(?:client|customer|account)\s+(.+)$/i.exec(reference)
  return Boolean(typed && exactEntity(typed[1], knownEntities))
}

function entityPattern(knownEntities) {
  const forms = entityForms(knownEntities)
  return forms.length ? `(?:${forms.map(escapeRegex).join('|')})` : '(?!)'
}

function isClosedArgument(operationId, value, knownEntities, caseContext, mode) {
  const argument = String(value || '').trim()
  if (!argument) return operationId !== 'COMPARE' && operationId !== 'CALCULATE'
  if (!['COMPARE', 'CALCULATE'].includes(operationId) && isAskDwContextualReference(argument)) {
    // Founder input may use a contextual argument only when CP5 supplied a
    // verified active subject. Model-output checking preserves the narrower
    // pre-existing read-only doctrine (for example, "I will review it") and
    // does not use a missing input focus to manufacture an operational claim.
    return mode === ASK_DW_OPERATION_MODE.MODEL_COMMITMENT ||
      hasAskDwVerifiedActiveSubject(caseContext)
  }
  const entity = entityPattern(knownEntities)
  const domain = new RegExp(`^(?:the\\s+)?(?:${entity}\\s+)?${CLOSED_DOMAIN_NOUN}$`, 'iu')
  const entityOnly = exactEntityReference(argument, knownEntities)

  switch (operationId) {
    case 'COMPARE': {
      const operands = /^(.*?)\s+and\s+(.*?)$/iu.exec(argument)
      return Boolean(operands && exactEntity(operands[1], knownEntities) &&
        exactEntity(operands[2], knownEntities))
    }
    case 'CALCULATE':
      return /^(?:the\s+)?(?:dso|days\s+sales\s+outstanding)$/i.test(argument)
    case 'INVESTIGATE':
    case 'DIG_INTO':
    case 'FIND_OUT':
      return entityOnly || domain.test(argument) ||
        new RegExp(`^why\\s+(?:${entity}|the\\s+(?:invoice|account))\\s+is\\s+(?:late|overdue|unpaid)$`, 'iu').test(argument) ||
        /^(?:why|how|what)\s+(?:the\s+)?(?:invoice|account|payment|balance)\b(?:\s+(?:is|was|became|changed|moved|failed|late|overdue|unpaid))*$/i.test(argument)
    case 'FORECAST':
      return /^(?:the\s+)?cash(?:flow)?(?:\s+(?:this|next)\s+(?:week|month|quarter))?$/i.test(argument)
    case 'PREDICT':
      return new RegExp(`^(?:when\\s+(?:${entity}|the\\s+(?:client|customer))\\s+will\\s+pay|(?:the\\s+)?payment\\s+(?:date|timing))$`, 'iu').test(argument)
    case 'RECOMMEND':
      return /^(?:what\s+to\s+do\s+next|(?:the\s+)?best\s+next\s+step|(?:the\s+)?next\s+(?:step|action)|what\s+i\s+should\s+(?:do|focus\s+on))$/i.test(argument)
    case 'DECIDE':
      return /^(?:what\s+i\s+should\s+focus\s+on|what\s+(?:to\s+do|comes)\s+next|(?:the\s+)?best\s+next\s+step)$/i.test(argument)
    case 'SHOW':
      if (/^me(?:\s+why)?$/i.test(argument)) return true
      return /^(?:me\s+)?(?:what\s+changed|the\s+(?:evidence|balance|history|admitted\s+facts)|(?:the\s+)?facts|(?:the\s+)?difference)$/i.test(argument) || domain.test(argument) || entityOnly
    case 'SUMMARIZE':
      return /^(?:the\s+)?(?:evidence|account\s+history|history|facts)$/i.test(argument) || domain.test(argument) ||
        new RegExp(`^(?:the\\s+)?${entity}\\s+history$`, 'iu').test(argument)
    case 'WATCH':
      return /^(?:the\s+|this\s+)?(?:account|invoice|portfolio|payment|balance)$/i.test(argument) || entityOnly
    case 'CHECK':
      return new RegExp(`^(?:(?:whether|if)\\s+(?:${entity}|the\\s+(?:invoice|account|payment|balance))\\s+(?:is|was|has|changed|moved|arrived|paid|late|overdue|unpaid)|(?:what|which|when|where|why|how)\\s+(?:the\\s+)?(?:invoice|account|payment|balance)\\b(?:\\s+(?:is|was|changed|moved|arrived|paid|late|overdue|unpaid))*)$`, 'iu').test(argument) || domain.test(argument) || entityOnly
    case 'TELL_ABOUT':
    case 'HELP_UNDERSTAND':
      return domain.test(argument) || entityOnly
    default:
      return domain.test(argument) || entityOnly ||
        /^(?:the\s+)?(?:evidence|admitted\s+facts|what\s+changed|difference)$/i.test(argument)
  }
}

function surfaceAt(source, start) {
  const tail = source.slice(start)
  for (const entry of SURFACES) {
    const pattern = new RegExp(`^${escapeRegex(entry.surface)}(?=$|[^\\p{L}\\p{N}_])`, 'iu')
    const match = pattern.exec(tail)
    if (match) return { ...entry, start, end: start + match[0].length, text: match[0] }
  }
  return null
}

function nextSurfaceCandidates(source, from, end) {
  const candidates = []
  for (let index = from; index < end; index += 1) {
    const prior = index === 0 ? '' : source[index - 1]
    if (prior && /[\p{L}\p{N}_]/u.test(prior)) continue
    const found = surfaceAt(source, index)
    if (found && found.end <= end) candidates.push(found)
  }
  return candidates
}

function trimSpan(source, start, end) {
  while (start < end && /\s/u.test(source[start])) start += 1
  while (end > start && /\s/u.test(source[end - 1])) end -= 1
  return { start, end }
}

function wrapperFor(source, mode) {
  const leading = /^\s*/u.exec(source)[0].length
  const tail = source.slice(leading)
  const pattern = mode === ASK_DW_OPERATION_MODE.FOUNDER_REQUEST
    ? /^(?:(?:so|and|but|ok(?:ay)?|hey)\s*,?\s+)*(?:(?:can|may|could|would|will|should|shall)\s+(?:you|dw|due\s?watch)\s+|(?:are|is)\s+(?:you|dw|due\s?watch)\s+going\s+to\s+|(?:do|does)\s+(?:you|dw|due\s?watch)\s+(?:plan|intend|mean)\s+to\s+)/i
    : /^(?:(?:i|we|dw|due\s?watch)\s+(?:can|may|could|might|will|would|should|shall)\s+|(?:i|we)'(?:ll|d)\s+|(?:i(?:'m|\s+am)|we(?:'re|\s+are)|dw\s+is|due\s?watch\s+is)\s+going\s+to\s+)/i
  const match = pattern.exec(tail)
  if (!match) return null
  return { start: leading, end: leading + match[0].length, text: match[0] }
}

const NON_IMPERATIVE_OPENING = /^(?:what|which|when|where|who|whom|whose|why|how|may|might|can|could|should|would|will|shall|must|do|does|did|are|is|am|was|were|have|has|had|i|we|you|he|she|they|it|this|that|these|those|there|and|or|but|company|our|policy|portfolio|status|daily|top|anything)\b/i
const OPERATIONAL_DOMAIN_TARGET = /\b(?:late\s+fees?|payments?|balances?|invoices?|accounts?|clients?|customers?|reminders?)\b/i

function targetPresentationFor(operationPhrase, { caseContext = null, allowContextualEllipsis = false } = {}) {
  const referenceForm = findAskDwContextualReferenceSuffix(operationPhrase)
  if (referenceForm) {
    return { targetPresentation: ASK_DW_OPERATION_TARGET_PRESENTATION.CONTEXTUAL_REFERENCE, referenceForm }
  }
  const normalized = String(operationPhrase || '').trim().replace(/[.!?]+$/u, '').trim()
  if (allowContextualEllipsis && hasAskDwVerifiedActiveSubject(caseContext) &&
      /^(?:[\p{L}][\p{L}\p{M}'-]*)(?:\s+[\p{L}][\p{L}\p{M}'-]*){0,2}$/u.test(normalized)) {
    return { targetPresentation: ASK_DW_OPERATION_TARGET_PRESENTATION.ACTIVE_FOCUS_ELLIPSIS, referenceForm: null }
  }
  return { targetPresentation: ASK_DW_OPERATION_TARGET_PRESENTATION.EXPLICIT, referenceForm: null }
}

function wrapperlessImperativeStart(source, knownEntities = [], {
  caseContext = null, allowContextualEllipsis = false,
} = {}) {
  const leading = /^\s*/u.exec(source)[0].length
  const tail = source.slice(leading)
  if (!tail || NON_IMPERATIVE_OPENING.test(tail)) return null

  const polite = /^please\s+/i.exec(tail)
  if (polite) {
    const wrapper = { start: leading, end: leading + polite[0].length, text: polite[0] }
    return {
      operationStart: wrapper.end,
      wrappers: [wrapper],
      ...targetPresentationFor(source.slice(wrapper.end), { caseContext, allowContextualEllipsis }),
    }
  }

  // A registered predicate is positive proof of an imperative presentation.
  // Unknown predicates are claimed only when their complement is visibly in
  // the AR domain, names an admitted tenant entity, or uses the shared CP5
  // contextual-reference grammar. A single residual predicate may also borrow
  // an omitted target from verified active focus after conversational forms
  // have had precedence. This is a target grammar, not an unsafe-verb list:
  // the operation remains unknown and can therefore only fail closed.
  const target = targetPresentationFor(tail, { caseContext, allowContextualEllipsis })
  if (surfaceAt(source, leading)) return { operationStart: leading, wrappers: [], ...target }
  const firstWord = /^[\p{L}][\p{L}\p{M}'-]*/u.exec(tail)
  if (!firstWord) return null
  const complement = tail.slice(firstWord[0].length)
  const namesKnownEntity = entityForms(knownEntities).some((form) =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(form)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(complement))
  const namesUnresolvedProperTarget = /(?:^|\s)[A-Z][\p{L}\p{M}\p{N}&.'-]*(?=\s|[.!?]|$)/u.test(complement)
  const contextual = target.targetPresentation === ASK_DW_OPERATION_TARGET_PRESENTATION.CONTEXTUAL_REFERENCE
  const elliptical = target.targetPresentation === ASK_DW_OPERATION_TARGET_PRESENTATION.ACTIVE_FOCUS_ELLIPSIS
  if (!namesKnownEntity && !namesUnresolvedProperTarget && !OPERATIONAL_DOMAIN_TARGET.test(complement) &&
      !contextual && !elliptical) return null
  return { operationStart: leading, wrappers: [], ...target }
}

function operationPresentationFor(source, mode, knownEntities = [], {
  caseContext = null, allowContextualEllipsis = false,
} = {}) {
  const modalWrapper = wrapperFor(source, mode)
  if (modalWrapper) {
    const wrappers = [modalWrapper]
    let operationStart = modalWrapper.end
    if (mode === ASK_DW_OPERATION_MODE.FOUNDER_REQUEST) {
      const polite = /^please\s+/i.exec(source.slice(operationStart))
      if (polite) {
        const wrapper = { start: operationStart, end: operationStart + polite[0].length, text: polite[0] }
        wrappers.push(wrapper)
        operationStart = wrapper.end
      }
    }
    return {
      presentation: mode === ASK_DW_OPERATION_MODE.FOUNDER_REQUEST
        ? ASK_DW_OPERATION_PRESENTATION.MODAL_DIRECT
        : ASK_DW_OPERATION_PRESENTATION.MODEL_COMMITMENT,
      operationStart,
      wrappers,
      ...targetPresentationFor(source.slice(operationStart), { caseContext, allowContextualEllipsis }),
    }
  }
  if (mode !== ASK_DW_OPERATION_MODE.FOUNDER_REQUEST) return null
  const imperative = wrapperlessImperativeStart(source, knownEntities, { caseContext, allowContextualEllipsis })
  return imperative ? { presentation: ASK_DW_OPERATION_PRESENTATION.IMPERATIVE, ...imperative } : null
}

export function inspectAskDwFounderOperationPresentation({
  text, knownEntities = [], caseContext = null, allowContextualEllipsis = false,
} = {}) {
  const source = String(text || '')
  const presentation = operationPresentationFor(source, ASK_DW_OPERATION_MODE.FOUNDER_REQUEST, knownEntities, {
    caseContext, allowContextualEllipsis,
  })
  if (!presentation) return null
  return Object.freeze({
    presentation: presentation.presentation,
    operationPhrase: source.slice(presentation.operationStart).trim(),
    targetPresentation: presentation.targetPresentation,
    referenceForm: presentation.referenceForm,
  })
}

export function extractDirectAskDwOperationPhrase(text, {
  knownEntities = [], caseContext = null, allowContextualEllipsis = false,
} = {}) {
  return inspectAskDwFounderOperationPresentation({
    text, knownEntities, caseContext, allowContextualEllipsis,
  })?.operationPhrase ?? null
}

function component(kind, start, end, source, extra = {}) {
  return Object.freeze({ kind, sourceStart: start, sourceEnd: end, sourceText: source.slice(start, end), ...extra })
}

/**
 * Deterministic extractor. Its output has no authority by itself and is fed
 * through the same validator as an injected/model-proposed structure.
 */
export function extractAskDwOperationStructure({
  text, mode = ASK_DW_OPERATION_MODE.FOUNDER_REQUEST, knownEntities = [],
  caseContext = null, allowContextualEllipsis = false,
} = {}) {
  const source = String(text || '')
  const presentation = operationPresentationFor(source, mode, knownEntities, {
    caseContext, allowContextualEllipsis,
  })
  if (!presentation) return null
  let phraseEnd = source.length
  while (phraseEnd > presentation.operationStart && /[\s.!?]/u.test(source[phraseEnd - 1])) phraseEnd -= 1
  let cursor = presentation.operationStart
  while (cursor < phraseEnd && /\s/u.test(source[cursor])) cursor += 1
  const components = presentation.wrappers.map((wrapper) =>
    component(ASK_DW_OPERATION_COMPONENT.WRAPPER, wrapper.start, wrapper.end, source))

  let operation = surfaceAt(source, cursor)
  if (!operation) {
    return Object.freeze({ version: STRUCTURE_VERSION, mode, sourceLength: source.length, components: Object.freeze(components) })
  }

  let count = 0
  while (operation && count < MAX_OPERATIONS) {
    const operationIndex = count
    components.push(component(ASK_DW_OPERATION_COMPONENT.OPERATION,
      operation.start, operation.end, source, {
        operationId: operation.definition.id,
        job: operation.definition.job,
        surface: operation.surface,
      }))
    count += 1

    let next = null
    let relation = null
    for (const candidate of nextSurfaceCandidates(source, operation.end, phraseEnd)) {
      const between = source.slice(operation.end, candidate.start)
      const match = RELATION_SUFFIX.exec(between)
      if (!match) continue
      const relationStart = operation.end + match.index
      next = candidate
      relation = { start: relationStart, end: candidate.start }
      break
    }
    const rawArgumentEnd = relation ? relation.start : phraseEnd
    const argumentSpan = trimSpan(source, operation.end, rawArgumentEnd)
    if (argumentSpan.end > argumentSpan.start) {
      components.push(component(ASK_DW_OPERATION_COMPONENT.ARGUMENT,
        argumentSpan.start, argumentSpan.end, source, { operationIndex }))
    }
    if (!next) break
    components.push(component(ASK_DW_OPERATION_COMPONENT.RELATION,
      relation.start, relation.end, source, { leftOperationIndex: operationIndex, rightOperationIndex: count }))
    operation = next
  }

  return Object.freeze({
    version: STRUCTURE_VERSION,
    mode,
    sourceLength: source.length,
    components: Object.freeze(components),
  })
}

function validBoundary(source, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return false
  if (offset === 0 || offset === source.length) return true
  const before = source.charCodeAt(offset - 1)
  const after = source.charCodeAt(offset)
  return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF)
}

const KEYS = Object.freeze({
  WRAPPER: ['kind', 'sourceStart', 'sourceEnd', 'sourceText'],
  OPERATION: ['kind', 'sourceStart', 'sourceEnd', 'sourceText', 'operationId', 'job', 'surface'],
  ARGUMENT: ['kind', 'sourceStart', 'sourceEnd', 'sourceText', 'operationIndex'],
  RELATION: ['kind', 'sourceStart', 'sourceEnd', 'sourceText', 'leftOperationIndex', 'rightOperationIndex'],
})

function exactKeys(value, allowed) {
  return value && typeof value === 'object' &&
    Object.keys(value).sort().join('|') === [...allowed].sort().join('|')
}

function failed(issues, proposal = null) {
  return Object.freeze({
    status: ASK_DW_OPERATION_SAFETY.FAIL_CLOSED_CLARIFY,
    readOnly: false,
    job: null,
    operations: Object.freeze([]),
    issues: Object.freeze(issues),
    proposal,
  })
}

/** Revalidates an untrusted structure against the exact original source. */
export function validateAskDwOperationStructure({
  text, proposal, mode = ASK_DW_OPERATION_MODE.FOUNDER_REQUEST, knownEntities = [],
  caseContext = null, allowContextualEllipsis = false,
} = {}) {
  const source = String(text || '')
  const issues = []
  if (!proposal || typeof proposal !== 'object') return failed(['EXTRACTION_MISSING'])
  if (proposal.version !== STRUCTURE_VERSION || proposal.mode !== mode ||
      proposal.sourceLength !== source.length || !Array.isArray(proposal.components)) {
    return failed(['STRUCTURE_SCHEMA_INVALID'], proposal)
  }
  if (!exactKeys(proposal, ['version', 'mode', 'sourceLength', 'components'])) {
    return failed(['STRUCTURE_SCHEMA_INVALID'], proposal)
  }
  if (proposal.components.length === 0 || proposal.components.length > (MAX_OPERATIONS * 3 + 2)) {
    return failed(['STRUCTURE_BOUNDS_INVALID'], proposal)
  }

  const spans = []
  const operations = []
  const argumentsByOperation = new Map()
  const relations = []
  for (const item of proposal.components) {
    const allowed = KEYS[item?.kind]
    if (!allowed || !exactKeys(item, allowed)) { issues.push('COMPONENT_SCHEMA_INVALID'); continue }
    const { sourceStart: start, sourceEnd: end } = item
    if (!validBoundary(source, start) || !validBoundary(source, end) || start >= end) {
      issues.push('COMPONENT_RANGE_INVALID'); continue
    }
    if (source.slice(start, end) !== item.sourceText) issues.push('COMPONENT_SOURCE_MISMATCH')
    spans.push({ start, end, kind: item.kind })
    if (item.kind === ASK_DW_OPERATION_COMPONENT.OPERATION) operations.push(item)
    if (item.kind === ASK_DW_OPERATION_COMPONENT.ARGUMENT) {
      if (argumentsByOperation.has(item.operationIndex)) issues.push('DUPLICATE_ARGUMENT')
      argumentsByOperation.set(item.operationIndex, item)
    }
    if (item.kind === ASK_DW_OPERATION_COMPONENT.RELATION) relations.push(item)
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index].start < spans[index - 1].end) issues.push('OVERLAPPING_COVERAGE')
    if (spans[index].start === spans[index - 1].start && spans[index].end === spans[index - 1].end) {
      issues.push('DUPLICATE_COVERAGE')
    }
  }
  let coveredUntil = 0
  for (const span of spans) {
    if (span.start > coveredUntil && !IGNORABLE_GAP.test(source.slice(coveredUntil, span.start))) {
      issues.push('UNCOVERED_SOURCE')
    }
    coveredUntil = Math.max(coveredUntil, span.end)
  }
  if (coveredUntil < source.length && !IGNORABLE_GAP.test(source.slice(coveredUntil))) issues.push('UNCOVERED_SOURCE')

  const expectedPresentation = operationPresentationFor(source, mode, knownEntities, {
    caseContext, allowContextualEllipsis,
  })
  const expectedWrappers = expectedPresentation?.wrappers ?? []
  const wrapperItems = proposal.components.filter((item) => item.kind === ASK_DW_OPERATION_COMPONENT.WRAPPER)
  if (!expectedPresentation || wrapperItems.length !== expectedWrappers.length ||
      wrapperItems.some((item, index) => item.sourceStart !== expectedWrappers[index]?.start ||
        item.sourceEnd !== expectedWrappers[index]?.end || item.sourceText !== expectedWrappers[index]?.text)) {
    issues.push('WRAPPER_INVALID')
  }
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) issues.push('OPERATION_COUNT_INVALID')

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]
    if (index > 0 && operation.sourceStart <= operations[index - 1].sourceStart) issues.push('OPERATION_ORDER_INVALID')
    const definition = BY_ID.get(operation.operationId)
    if (!definition || definition.job !== operation.job || !definition.surfaces.includes(operation.surface) ||
        operation.sourceText.toLocaleLowerCase('en-US') !== operation.surface.toLocaleLowerCase('en-US')) {
      issues.push('OPERATION_SURFACE_INVALID')
      continue
    }
    const argument = argumentsByOperation.get(index)
    const argumentText = argument?.sourceText ?? ''
    if (!isClosedArgument(operation.operationId, argumentText, knownEntities, caseContext, mode)) {
      issues.push('ARGUMENT_INVALID')
    }
    const relation = relations.find((item) => item.leftOperationIndex === index)
    const nextOperation = operations[index + 1]
    const ownedEnd = relation?.sourceStart ?? (nextOperation?.sourceStart ?? source.length)
    if (argument && (argument.sourceStart < operation.sourceEnd || argument.sourceEnd > ownedEnd)) {
      issues.push('ARGUMENT_POSITION_INVALID')
    }
    const afterOperation = source.slice(operation.sourceEnd, argument?.sourceStart ?? ownedEnd)
    const afterArgument = source.slice(argument?.sourceEnd ?? operation.sourceEnd, ownedEnd)
    const closedGap = relation ? /^\s*$/u : IGNORABLE_GAP
    if (!closedGap.test(afterOperation) || !closedGap.test(afterArgument)) issues.push('CLAUSE_RESIDUE')
  }
  for (const [index] of argumentsByOperation) {
    if (!Number.isInteger(index) || index < 0 || index >= operations.length) issues.push('ARGUMENT_OWNER_INVALID')
  }
  for (const relation of relations) {
    if (relation.leftOperationIndex + 1 !== relation.rightOperationIndex ||
        relation.rightOperationIndex >= operations.length || !RELATION_FULL.test(relation.sourceText) ||
        relation.sourceStart < operations[relation.leftOperationIndex]?.sourceEnd ||
        relation.sourceEnd > operations[relation.rightOperationIndex]?.sourceStart) {
      issues.push('RELATION_INVALID')
    }
  }
  if (relations.length !== Math.max(0, operations.length - 1)) issues.push('RELATION_COUNT_INVALID')

  if (issues.length) return failed([...new Set(issues)], proposal)
  const jobs = [...new Set(operations.map((operation) => operation.job))]
  const job = jobs.length === 1 ? jobs[0]
    : jobs.includes('DECIDE') ? 'DECIDE'
      : jobs.includes('PREDICT') ? 'PREDICT'
        : jobs.includes('INVESTIGATE') ? 'INVESTIGATE' : 'EXPLAIN'
  return Object.freeze({
    status: ASK_DW_OPERATION_SAFETY.READ_ONLY,
    readOnly: true,
    job,
    operations: Object.freeze(operations.map((operation) => operation.operationId)),
    issues: Object.freeze([]),
    proposal,
  })
}

export function classifyAskDwReadOnlyOperation({
  text, mode = ASK_DW_OPERATION_MODE.FOUNDER_REQUEST, knownEntities = [], caseContext = null,
  allowContextualEllipsis = false, extractor = extractAskDwOperationStructure,
} = {}) {
  let proposal = null
  try {
    proposal = extractor({ text, mode, knownEntities, caseContext, allowContextualEllipsis })
  } catch {
    return failed(['EXTRACTION_FAILED'])
  }
  return validateAskDwOperationStructure({
    text, proposal, mode, knownEntities, caseContext, allowContextualEllipsis,
  })
}
