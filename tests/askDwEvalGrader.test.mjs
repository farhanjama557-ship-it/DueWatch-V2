import test from 'node:test'
import assert from 'node:assert/strict'

import { gradeAskDwRun } from '../src/lib/dwIntelligence/askDwEvalGrader.js'
import { buildAskDwModePolicy } from '../src/lib/dwIntelligence/askDwModes.js'
import { ASK_DW_BASE_SCENARIOS } from './fixtures/askDwScenarioFactory.js'

function referencePassingRun(scenario, mode) {
  const policy = buildAskDwModePolicy({
    mode,
    risk: scenario.risk,
    actionIntent: scenario.actionIntent,
  })

  return {
    finalAnswer: 'Evidence-grounded AR answer.',
    sufficientReason: 'Canonical truth and admitted evidence support the conclusion.',
    materialClaims: [{ kind: 'FACT', provenance: ['invoice:demo'] }],
    evidenceRefs: ['invoice:demo'],
    canonicalMoneyInvented: false,
    materialFabrication: false,
    hardViolations: [],
    rawChainOfThoughtVisible: false,
    reasoningTrail: [{
      type: 'CANONICAL_TRUTH_READ',
      observable: true,
      summary: 'Read canonical invoice truth.',
    }],
    authorityChecked: scenario.actionIntent,
    selfGrantedAuthority: false,
    executed: false,
    completedPasses: policy.mandatoryPasses,
    contradictionSearchPerformed: mode === 'deep',
    challengePassPerformed: mode === 'deep',
    independentVerificationPerformed: mode === 'deep',
    competingHypothesesRelevant: mode === 'deep',
    competingHypotheses: mode === 'deep' ? ['payment delay', 'dispute'] : [],
    uncertaintyRelevant: mode === 'deep',
    uncertaintyAssessment: mode === 'deep' ? { level: 'moderate' } : null,
  }
}

test('reference passing runs satisfy all 400 base scenarios in both modes', () => {
  for (const scenario of ASK_DW_BASE_SCENARIOS) {
    for (const mode of ['normal','deep']) {
      const graded = gradeAskDwRun({
        scenario,
        mode,
        run: referencePassingRun(scenario, mode),
      })
      assert.equal(graded.passed, true, `${scenario.id}/${mode}: ${JSON.stringify(graded.failed)}`)
    }
  }
})

test('grader rejects invented money and fake/raw reasoning transparency', () => {
  const scenario = ASK_DW_BASE_SCENARIOS.find((s) => s.actionIntent)
  const run = referencePassingRun(scenario, 'normal')
  run.canonicalMoneyInvented = true
  run.rawChainOfThoughtVisible = true
  run.reasoningTrail = [{
    type: 'HIDDEN_MONOLOGUE',
    observable: true,
    summary: 'fake thought',
    rawChainOfThought: true,
  }]

  const graded = gradeAskDwRun({ scenario, mode: 'normal', run })
  assert.equal(graded.passed, false)
  const ids = graded.failed.map((x) => x.id)
  assert.ok(ids.includes('canonical_money_not_invented'))
  assert.ok(ids.includes('raw_chain_of_thought_not_exposed'))
  assert.ok(ids.includes('reasoning_trail_integrity'))
})
