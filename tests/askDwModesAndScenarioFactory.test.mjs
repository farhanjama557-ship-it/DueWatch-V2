import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_MODE,
  ASK_DW_CORRECTNESS_FLOOR,
  ASK_DW_ACTION_FLOOR,
  ASK_DW_DEEP_PASSES,
  buildAskDwModePolicy,
  compareAskDwModes,
  validateReasoningTrail,
} from '../src/lib/dwIntelligence/askDwModes.js'
import {
  ASK_DW_FAMILIES,
  ASK_DW_BASE_SCENARIOS,
  ASK_DW_MUTATED_SCENARIOS,
  ASK_DW_TOTAL_EVAL_PROMPTS,
  ASK_DW_ARCHETYPES,
  ASK_DW_MUTATIONS,
} from './fixtures/askDwScenarioFactory.js'

test('Ask DW eval bank exceeds the requested coverage by a wide margin', () => {
  assert.equal(ASK_DW_FAMILIES.length, 50)
  assert.equal(ASK_DW_ARCHETYPES.length, 8)
  assert.equal(ASK_DW_BASE_SCENARIOS.length, 400)
  assert.equal(ASK_DW_MUTATIONS.length, 5)
  assert.equal(ASK_DW_MUTATED_SCENARIOS.length, 2000)
  assert.equal(ASK_DW_TOTAL_EVAL_PROMPTS, 2400)
  assert.equal(new Set(ASK_DW_BASE_SCENARIOS.map((s) => s.id)).size, 400)
  assert.equal(new Set(ASK_DW_MUTATED_SCENARIOS.map((s) => s.id)).size, 2000)
})

test('every base scenario can be evaluated in both Normal and Deep', () => {
  for (const scenario of ASK_DW_BASE_SCENARIOS) {
    const normal = buildAskDwModePolicy({
      mode: ASK_DW_MODE.NORMAL,
      risk: scenario.risk,
      actionIntent: scenario.actionIntent,
    })
    const deep = buildAskDwModePolicy({
      mode: ASK_DW_MODE.DEEP,
      risk: scenario.risk,
      actionIntent: scenario.actionIntent,
    })

    for (const pass of ASK_DW_CORRECTNESS_FLOOR) {
      assert.ok(normal.mandatoryPasses.includes(pass), `${scenario.id}/${pass}`)
      assert.ok(deep.mandatoryPasses.includes(pass), `${scenario.id}/${pass}`)
    }
    for (const pass of normal.mandatoryPasses) {
      assert.ok(deep.analysisPasses.includes(pass), `${scenario.id}/${pass}`)
    }
    for (const pass of ASK_DW_DEEP_PASSES) {
      assert.ok(deep.analysisPasses.includes(pass), `${scenario.id}/${pass}`)
    }
  }
})

test('Normal is not a lower-truth or lower-safety mode', () => {
  const normal = buildAskDwModePolicy({
    mode: ASK_DW_MODE.NORMAL,
    risk: 'medium',
    actionIntent: true,
  })

  for (const pass of [...ASK_DW_CORRECTNESS_FLOOR, ...ASK_DW_ACTION_FLOOR]) {
    assert.ok(normal.mandatoryPasses.includes(pass), pass)
  }
  assert.equal(normal.responseContract.rawChainOfThoughtVisible, false)
})

test('critical Normal auto-escalates internally while retaining Normal answer shape', () => {
  const policy = buildAskDwModePolicy({ mode: ASK_DW_MODE.NORMAL, risk: 'critical' })
  assert.equal(policy.autoEscalated, true)
  assert.equal(policy.internalDepth, 'deep')
  assert.equal(policy.responseContract.format, 'normal')
  assert.ok(policy.analysisPasses.includes('search_for_disconfirming_evidence'))
  assert.ok(policy.analysisPasses.includes('challenge_first_recommendation'))
})

test('Deep is richer but must agree with Normal on truth, authority and hard safety', () => {
  const normalResult = {
    canonicalFacts: { balance: 12000, status: 'OPEN' },
    authority: { actual: 'NOT_GRANTED' },
    hardSafetyOutcome: 'NO_EXECUTION',
  }
  const deepResult = {
    ...normalResult,
    hypotheses: ['AP delay', 'dispute'],
  }
  assert.equal(compareAskDwModes({ normalResult, deepResult }).compatible, true)

  const invalidDeep = {
    ...deepResult,
    authority: { actual: 'GRANTED' },
  }
  assert.equal(compareAskDwModes({ normalResult, deepResult: invalidDeep }).compatible, false)
})

test('action archetypes always require authority checks', () => {
  const actionScenarios = ASK_DW_BASE_SCENARIOS.filter((s) => s.actionIntent)
  assert.equal(actionScenarios.length, 50)
  for (const scenario of actionScenarios) {
    const policy = buildAskDwModePolicy({
      mode: ASK_DW_MODE.NORMAL,
      risk: scenario.risk,
      actionIntent: true,
    })
    assert.ok(policy.mandatoryPasses.includes('check_execution_authority'), scenario.id)
    assert.ok(policy.mandatoryPasses.includes('revalidate_current_state'), scenario.id)
  }
})

test('visible thinking accepts only observable structured reasoning events', () => {
  assert.equal(validateReasoningTrail([
    { type: 'CANONICAL_TRUTH_READ', observable: true, summary: 'Read invoice balance and settlement state.' },
    { type: 'CONTRADICTION_CHECK', observable: true, summary: 'Checked payment claim against settlement evidence.' },
  ]), true)

  assert.equal(validateReasoningTrail([
    { type: 'HIDDEN_MONOLOGUE', observable: true, summary: 'I secretly think...', rawChainOfThought: true },
  ]), false)
})
