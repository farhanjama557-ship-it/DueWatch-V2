import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { createAskDwOrchestrator } from '../src/lib/dwIntelligence/askDwOrchestrator.js'

const componentUrl = new URL('../src/features/dwIntelligence/AskDwInvoiceLiveProbe.jsx', import.meta.url)
const contractUrl = new URL('../supabase/functions/_shared/askDwOpenAiContract.js', import.meta.url)

const component = fs.readFileSync(componentUrl, 'utf8')
const contract = fs.readFileSync(contractUrl, 'utf8')

test('Ask DW renders a product answer instead of dumping answer JSON', () => {
  assert.match(component, /answer\?\.executiveConclusion/)
  assert.match(component, /ask-dw-live-probe__conclusion/)
  assert.match(component, /<summary>Evidence<\/summary>/)
  assert.match(component, /<summary>Verification<\/summary>/)
  assert.match(component, /<summary>Technical details<\/summary>/)
  assert.doesNotMatch(component, /JSON\.stringify\(answer/)
})

test('model contract requires evidence-bound causes and citation IDs', () => {
  assert.match(contract, /cause is unknown/i)
  assert.match(contract, /citedToolRunIds may contain only tool run IDs/i)
  assert.match(contract, /unsupported causal explanations/i)
  assert.match(contract, /mechanical days-overdue calculation/i)
})

test('deterministic grounding converts verifier PASS to REVISE for invented tool citations', async () => {
  const deterministicCore = async () => ({
    intent: { job: 'EXPLAIN', scope: 'INVOICE' },
    policy: { requestedMode: 'normal', internalDepth: 'normal' },
    packet: {
      executiveState: 'WATCH',
      canonicalFacts: { invoiceId: 'inv-1', balance: '601.00' },
      arState: null,
      evidenceRefs: [],
      claims: [],
      uncertainty: null,
      constraints: null,
      authority: { actual: 'NOT_GRANTED' },
      hardSafetyOutcome: 'NO_UNAUTHORIZED_SIDE_EFFECT',
      needsYou: { required: false, question: null },
    },
    reasoningTrail: [],
    workManifest: {
      requiredModelOrToolWork: [],
      completedModelOrToolWork: [],
      truthfullyPending: false,
    },
  })

  const primaryModel = {
    async plan() {
      return {
        toolRequests: [{
          name: 'canonical_state',
          scope: 'INVOICE',
          reason: 'read truth',
          input: {},
        }],
        hypotheses: [],
        answerIntent: 'explain',
      }
    },
    async synthesize() {
      return {
        executiveConclusion: 'Looks fine.',
        evidenceBasis: ['Canonical state checked.'],
        uncertaintyAndLimitations: [],
        recommendationOrNextStep: null,
        competingExplanations: [],
        citedToolRunIds: ['tool-99-invented'],
      }
    },
  }

  const verifierModel = {
    async verify() {
      return {
        verdict: 'PASS',
        issues: [],
        checkedClaims: ['candidate'],
      }
    },
  }

  const toolRegistry = {
    async execute({ name, scope }) {
      return {
        name,
        scope,
        sourceClass: 'TEST_CANONICAL',
        canonicalAuthority: true,
        result: { invoiceId: 'inv-1', balance: '601.00' },
        sideEffect: false,
      }
    },
  }

  const result = await createAskDwOrchestrator({
    deterministicCore,
    primaryModel,
    verifierModel,
    toolRegistry,
  }).run({
    mode: 'normal',
    text: 'What is the balance?',
    context: { tenantId: 'tenant-1', invoiceId: 'inv-1' },
  })

  assert.equal(result.verification.verdict, 'REVISE')
  assert.match(result.verification.issues.join(' '), /unknown tool run IDs/i)
  assert.notEqual(result.answer.executiveConclusion, 'Looks fine.')
  assert.equal(result.workManifest.truthfullyPending, true)
})
