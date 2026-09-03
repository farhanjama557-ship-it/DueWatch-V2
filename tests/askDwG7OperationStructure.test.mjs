import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_OPERATION_COMPONENT,
  ASK_DW_OPERATION_MODE,
  ASK_DW_OPERATION_PRESENTATION,
  ASK_DW_OPERATION_SAFETY,
  ASK_DW_OPERATION_TARGET_PRESENTATION,
  ASK_DW_READ_ONLY_OPERATION_REGISTRY,
  classifyAskDwReadOnlyOperation,
  extractAskDwOperationStructure,
  inspectAskDwFounderOperationPresentation,
  validateAskDwOperationStructure,
} from '../src/lib/dwIntelligence/askDwOperationStructure.js'

const ENTITIES = Object.freeze([
  { id: 'atlas', name: 'Atlas', aliases: ['Atlas'] },
  { id: 'cedar', name: 'Cedar', aliases: ['Cedar'] },
])

const ACTIVE_CASE_CONTEXT = Object.freeze({
  focus: Object.freeze({
    clientRef: Object.freeze({ kind: 'client', id: 'atlas' }),
    invoiceRef: Object.freeze({ kind: 'invoice', id: 'inv-atlas-1' }),
  }),
})

const readOnly = (text, options = {}) => classifyAskDwReadOnlyOperation({
  text,
  knownEntities: ENTITIES,
  ...options,
})

const clone = (value) => structuredClone(value)

test('G7-OS1 registered operations are the only reachable READ_ONLY operation IDs', () => {
  const registered = new Set(ASK_DW_READ_ONLY_OPERATION_REGISTRY.map((entry) => entry.id))
  for (const text of [
    'Can you explain the Atlas balance?',
    'Can you investigate why Atlas is late?',
    'Can you forecast cash this week?',
    'Can you recommend what to do next?',
    'Can you explain and summarize the Atlas history?',
    'Can you investigate and recommend the next step?',
    'Can you compare Atlas and Cedar and explain the difference?',
  ]) {
    const result = readOnly(text)
    assert.equal(result.status, ASK_DW_OPERATION_SAFETY.READ_ONLY, text)
    assert.ok(result.operations.every((operation) => registered.has(operation)), text)
  }
})

test('G7-OS2 hostile extractor labels cannot turn incompatible source into read-only work', () => {
  for (const text of ['Can you reimburse Atlas?', 'Can you explain Atlas and reimburse Cedar?']) {
    const wrapper = extractAskDwOperationStructure({ text })?.components[0]
    const start = wrapper.sourceEnd
    const end = text.length - 1
    const proposal = {
      version: 'ASK_DW_OPERATION_STRUCTURE_V1', mode: ASK_DW_OPERATION_MODE.FOUNDER_REQUEST,
      sourceLength: text.length,
      components: [wrapper, {
        kind: ASK_DW_OPERATION_COMPONENT.OPERATION,
        sourceStart: start, sourceEnd: end, sourceText: text.slice(start, end),
        operationId: 'EXPLAIN', job: 'EXPLAIN', surface: 'explain',
      }],
    }
    assert.equal(classifyAskDwReadOnlyOperation({
      text, knownEntities: ENTITIES, extractor: () => proposal,
    }).readOnly, false, text)
  }
})

test('G7-OS3 omitted tails and giant safe spans leave verifiable structural failures', () => {
  const text = 'Can you explain Atlas and reimburse Cedar?'
  const extracted = clone(extractAskDwOperationStructure({ text }))

  const dropped = clone(extracted)
  const argument = dropped.components.find((item) => item.kind === ASK_DW_OPERATION_COMPONENT.ARGUMENT)
  argument.sourceEnd = argument.sourceStart + 'Atlas'.length
  argument.sourceText = 'Atlas'
  assert.ok(validateAskDwOperationStructure({ text, proposal: dropped, knownEntities: ENTITIES }).issues.includes('UNCOVERED_SOURCE'))

  const swallowed = clone(extracted)
  const operation = swallowed.components.find((item) => item.kind === ASK_DW_OPERATION_COMPONENT.OPERATION)
  operation.sourceEnd = text.length - 1
  operation.sourceText = text.slice(operation.sourceStart, operation.sourceEnd)
  assert.ok(validateAskDwOperationStructure({ text, proposal: swallowed, knownEntities: ENTITIES }).issues.includes('OPERATION_SURFACE_INVALID'))

  const giantClause = clone(extracted)
  giantClause.components[1].sourceStart = giantClause.components[0].sourceEnd
  giantClause.components[1].sourceEnd = text.length - 1
  giantClause.components[1].sourceText = text.slice(giantClause.components[1].sourceStart, giantClause.components[1].sourceEnd)
  giantClause.components[1].sourceSpan = [giantClause.components[1].sourceStart, giantClause.components[1].sourceEnd]
  assert.ok(validateAskDwOperationStructure({ text, proposal: giantClause, knownEntities: ENTITIES }).issues.includes('COMPONENT_SCHEMA_INVALID'))
})

test('G7-OS4 unsafe operations cannot hide inside typed arguments', () => {
  const text = 'Can you explain Atlas and reimburse Cedar?'
  const result = readOnly(text)
  assert.equal(result.readOnly, false)
  assert.ok(result.issues.includes('ARGUMENT_INVALID'))
})

test('G7-OS5 compare validates exact tenant entity operands without capitalization shortcuts', () => {
  assert.equal(readOnly('Can you compare Atlas and Cedar?').readOnly, true)
  assert.equal(readOnly('Can you compare Atlas and Reimburse Cedar?').readOnly, false)
  assert.equal(readOnly('Can you compare Atlas and Reimburse Cedar?', {
    knownEntities: [...ENTITIES, { id: 'reimburse-cedar', name: 'Reimburse Cedar' }],
  }).readOnly, true)
})

test('G7-OS6 overlapping, duplicate, out-of-range and source-mismatching spans fail closed', () => {
  const text = 'Can you explain the evidence?'
  const original = extractAskDwOperationStructure({ text })
  const mutations = []

  const overlap = clone(original)
  overlap.components.find((item) => item.kind === ASK_DW_OPERATION_COMPONENT.ARGUMENT).sourceStart -= 2
  overlap.components.find((item) => item.kind === ASK_DW_OPERATION_COMPONENT.ARGUMENT).sourceText =
    text.slice(overlap.components[2].sourceStart, overlap.components[2].sourceEnd)
  mutations.push(overlap)

  const duplicate = clone(original)
  duplicate.components.push(clone(duplicate.components[1]))
  mutations.push(duplicate)

  const range = clone(original)
  range.components[1].sourceEnd = text.length + 1
  mutations.push(range)

  const mismatch = clone(original)
  mismatch.components[1].sourceText = 'summarize'
  mutations.push(mismatch)

  for (const proposal of mutations) {
    assert.equal(validateAskDwOperationStructure({ text, proposal, knownEntities: ENTITIES }).readOnly, false)
  }
})

test('G7-OS7 malformed Unicode offsets and extraction failures never default to EXPLAIN', () => {
  const text = 'Can you explain 💰?'
  const proposal = clone(extractAskDwOperationStructure({ text }))
  proposal.components[1].sourceEnd = text.indexOf('💰') + 1
  proposal.components[1].sourceText = text.slice(proposal.components[1].sourceStart, proposal.components[1].sourceEnd)
  assert.equal(validateAskDwOperationStructure({ text, proposal }).readOnly, false)

  for (const extractor of [
    () => null,
    () => ({}),
    () => { throw new Error('timeout') },
    () => ({ version: 'ASK_DW_OPERATION_STRUCTURE_V1', mode: ASK_DW_OPERATION_MODE.FOUNDER_REQUEST,
      sourceLength: text.length, components: [] }),
  ]) {
    const result = classifyAskDwReadOnlyOperation({ text, extractor })
    assert.equal(result.status, ASK_DW_OPERATION_SAFETY.FAIL_CLOSED_CLARIFY)
  }
})

test('G7-OS8 generated prefix/suffix compositions cannot inherit READ_ONLY from a safe prefix', () => {
  const safe = 'explain the evidence'
  const unsafe = [
    'reimburse Atlas', 'forgive the late fee', 'ping Atlas', 'return the payment', 'write down the balance',
  ]
  const joiners = [' and ', ' & ', ' + ', ' plus ', ' as well as ', ' while ', ' before ', ' / ', ' :: ', ' → ']
  for (const operation of unsafe) {
    assert.equal(readOnly(`Can you ${operation}?`).readOnly, false, operation)
    for (const joiner of joiners) {
      const text = `Can you ${safe}${joiner}${operation}?`
      assert.equal(readOnly(text).readOnly, false, text)
    }
  }
})

test('G7-OS9 less extractor certainty can only preserve or reduce capability', () => {
  const text = 'Can you investigate why Atlas is late?'
  const valid = extractAskDwOperationStructure({ text })
  assert.equal(validateAskDwOperationStructure({ text, proposal: valid, knownEntities: ENTITIES }).readOnly, true)
  for (let length = valid.components.length - 1; length >= 0; length -= 1) {
    const partial = clone(valid)
    partial.components = partial.components.slice(0, length)
    assert.equal(validateAskDwOperationStructure({ text, proposal: partial, knownEntities: ENTITIES }).readOnly, false)
  }
})

test('G7-OS10 model commitments use the same complete structural accounting', () => {
  for (const text of [
    'I will explain the evidence.',
    'I can summarize the account history.',
    'I will show the admitted facts.',
    'I can keep watching the account.',
  ]) {
    assert.equal(readOnly(text, { mode: ASK_DW_OPERATION_MODE.MODEL_COMMITMENT }).readOnly, true, text)
  }
  for (const text of [
    'I will explain and reimburse Atlas.',
    'I will explain & reimburse Atlas.',
    'I can summarize the account and forgive the late fee.',
    'I will compare Atlas and Reimburse Cedar.',
  ]) {
    assert.equal(readOnly(text, { mode: ASK_DW_OPERATION_MODE.MODEL_COMMITMENT }).readOnly, false, text)
  }
})

test('G7-OS11 imperatives use the same structure without a fabricated modal wrapper', () => {
  const plain = extractAskDwOperationStructure({
    text: 'Explain the Atlas balance.', knownEntities: ENTITIES,
  })
  assert.ok(plain)
  assert.equal(plain.components.some((item) => item.kind === ASK_DW_OPERATION_COMPONENT.WRAPPER), false)
  assert.equal(readOnly('Explain the Atlas balance.').readOnly, true)
  assert.equal(inspectAskDwFounderOperationPresentation({
    text: 'Explain the Atlas balance.', knownEntities: ENTITIES,
  }).presentation, ASK_DW_OPERATION_PRESENTATION.IMPERATIVE)

  const polite = extractAskDwOperationStructure({
    text: 'Please explain the Atlas balance.', knownEntities: ENTITIES,
  })
  const wrappers = polite.components.filter((item) => item.kind === ASK_DW_OPERATION_COMPONENT.WRAPPER)
  assert.equal(wrappers.length, 1)
  assert.equal(wrappers[0].sourceText, 'Please ')
  assert.equal(readOnly('Please explain the Atlas balance.').readOnly, true)
})

test('G7-OS12 safe imperative families are completely accounted for', () => {
  for (const text of [
    'Explain the Atlas balance.',
    'Please explain the Atlas balance.',
    'Investigate why Atlas is late.',
    'Please investigate Atlas.',
    'Forecast cash this week.',
    'Recommend what to do next.',
    'Compare Atlas and Cedar.',
    'Calculate DSO.',
    'Explain and summarize the Atlas history.',
    'Compare Atlas and Cedar and explain the difference.',
  ]) {
    const result = readOnly(text)
    assert.equal(result.status, ASK_DW_OPERATION_SAFETY.READ_ONLY, text)
    assert.equal(result.readOnly, true, text)
  }
})

test('G7-OS13 unknown and mixed imperatives fail closed under structural accounting', () => {
  for (const text of [
    'Reimburse Atlas.',
    'Please reimburse Atlas.',
    'Forgive the late fee.',
    'Ping Atlas tomorrow.',
    'Return the payment to Atlas.',
    "Write down Atlas's balance.",
    'Explain Atlas and reimburse Cedar.',
    'Please explain Atlas and reimburse Cedar.',
    'Investigate Atlas and reimburse Cedar.',
    'Forecast cash this week and reimburse Atlas.',
    'Recommend what to do next and reimburse Atlas.',
    'Explain Atlas & reimburse Cedar.',
    'Explain Atlas plus reimburse Cedar.',
    'Compare Atlas and Cedar and reimburse Atlas.',
  ]) {
    const result = readOnly(text)
    assert.equal(result.status, ASK_DW_OPERATION_SAFETY.FAIL_CLOSED_CLARIFY, text)
    assert.equal(result.readOnly, false, text)
  }
})

test('G7-OS14 presentation form cannot increase operation capability', () => {
  const structures = [
    ['explain the Atlas balance', true],
    ['investigate why Atlas is late', true],
    ['forecast cash this week', true],
    ['recommend what to do next', true],
    ['compare Atlas and Cedar and explain the difference', true],
    ['reimburse Atlas', false],
    ['forgive the late fee', false],
    ['explain Atlas and reimburse Cedar', false],
    ['investigate Atlas and reimburse Cedar', false],
    ['compare Atlas and Cedar and reimburse Atlas', false],
  ]
  for (const [operation, expected] of structures) {
    for (const text of [`Can you ${operation}?`, `${operation[0].toUpperCase()}${operation.slice(1)}.`,
      `Please ${operation}.`]) {
      assert.equal(readOnly(text).readOnly, expected, text)
    }
  }
})

test('G7-OS15 contextual references enter the same closed structure without proving operation safety', () => {
  for (const text of [
    'Reimburse them.', 'Reimburse it.', 'Refund them.', 'Forgive it.',
    'Ping them.', 'Pursue them.', 'Escalate it.', 'Reach out to them.',
    'Waive it.', 'Reimburse this.', 'Reimburse that.',
    'Reimburse this one.', 'Reimburse that one.',
  ]) {
    const presentation = inspectAskDwFounderOperationPresentation({
      text, knownEntities: ENTITIES, caseContext: ACTIVE_CASE_CONTEXT,
    })
    assert.equal(presentation?.presentation, ASK_DW_OPERATION_PRESENTATION.IMPERATIVE, text)
    assert.equal(presentation?.targetPresentation,
      ASK_DW_OPERATION_TARGET_PRESENTATION.CONTEXTUAL_REFERENCE, text)
    const result = readOnly(text, { caseContext: ACTIVE_CASE_CONTEXT })
    assert.equal(result.status, ASK_DW_OPERATION_SAFETY.FAIL_CLOSED_CLARIFY, text)
    assert.equal(result.readOnly, false, text)
  }
})

test('G7-OS16 active focus supplies only an omitted target, never a safe operation', () => {
  for (const text of ['Escalate.', 'Pursue.', 'Reach out.']) {
    assert.equal(inspectAskDwFounderOperationPresentation({ text, knownEntities: ENTITIES }), null, text)
    const presentation = inspectAskDwFounderOperationPresentation({
      text, knownEntities: ENTITIES, caseContext: ACTIVE_CASE_CONTEXT,
      allowContextualEllipsis: true,
    })
    assert.equal(presentation?.targetPresentation,
      ASK_DW_OPERATION_TARGET_PRESENTATION.ACTIVE_FOCUS_ELLIPSIS, text)
    const result = readOnly(text, {
      caseContext: ACTIVE_CASE_CONTEXT, allowContextualEllipsis: true,
    })
    assert.equal(result.status, ASK_DW_OPERATION_SAFETY.FAIL_CLOSED_CLARIFY, text)
  }

  assert.equal(readOnly('Explain it.', { caseContext: ACTIVE_CASE_CONTEXT }).readOnly, true)
  assert.equal(readOnly('Explain it.').readOnly, false,
    'an unresolved contextual reference is not a closed read-only argument')
})

test('G7-OS17 reference presentation cannot increase an unknown operation capability', () => {
  const variants = [
    ['Reimburse Atlas.', {}],
    ['Reimburse them.', { caseContext: ACTIVE_CASE_CONTEXT }],
    ['Reimburse the client.', { caseContext: ACTIVE_CASE_CONTEXT }],
    ['Reimburse.', { caseContext: ACTIVE_CASE_CONTEXT, allowContextualEllipsis: true }],
  ]
  for (const [text, options] of variants) {
    const result = readOnly(text, options)
    assert.equal(result.status, ASK_DW_OPERATION_SAFETY.FAIL_CLOSED_CLARIFY, text)
    assert.equal(result.readOnly, false, text)
  }
})
