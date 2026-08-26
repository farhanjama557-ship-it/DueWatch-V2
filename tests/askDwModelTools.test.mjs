import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_READ_TOOL,
  ASK_DW_TOOL_SCOPE,
  createAskDwReadToolRegistry,
} from '../src/lib/dwIntelligence/askDwToolRuntime.js'
import { createAskDwModelAdapter } from '../src/lib/dwIntelligence/askDwModelAdapter.js'
import { createAskDwOrchestrator } from '../src/lib/dwIntelligence/askDwOrchestrator.js'

function deterministicCore() {
  return Object.freeze({
    intent: { job: 'INVESTIGATE', scope: 'INVOICE' },
    policy: { requestedMode: 'deep', internalDepth: 'deep' },
    packet: {
      executiveState: 'INVESTIGATING',
      canonicalFacts: { invoiceId: 'inv-1', balance: '1200.00', canonicalStatus: 'OPEN' },
      arState: { payment: { status: 'CLAIMED_UNVERIFIED' } },
      evidenceRefs: ['e-1'],
      claims: [{ type: 'PAYMENT_CLAIM', source: 'customer' }],
      precedent: null,
      uncertainty: null,
      constraints: { requiresServerRevalidation: true },
      authority: { actual: 'NOT_GRANTED', policyAuthorized: false },
      hardSafetyOutcome: 'NO_UNAUTHORIZED_SIDE_EFFECT',
      needsYou: { required: false, question: null },
      safeguards: { reconciliationHold: true },
    },
    reasoningTrail: [],
    workManifest: {
      requiredModelOrToolWork: ['independent_verification'],
      completedModelOrToolWork: [],
      truthfullyPending: true,
    },
  })
}

function registry() {
  return createAskDwReadToolRegistry({
    definitions: {
      [ASK_DW_READ_TOOL.PAYMENT_RECONCILIATION]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE],
        sourceClass: 'AUTHORITATIVE_PAYMENT_READ',
        canonicalAuthority: false,
        handler: async ({ context }) => ({
          invoiceId: context.invoiceId,
          settlementFound: false,
          providerReference: null,
        }),
      },
      [ASK_DW_READ_TOOL.EVIDENCE_SEARCH]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE],
        handler: async () => ({ evidenceRefs: ['e-1', 'e-2'] }),
      },
    },
  })
}

test('read-only tool registry rejects missing tenant scope', async () => {
  await assert.rejects(
    registry().execute({
      name: ASK_DW_READ_TOOL.EVIDENCE_SEARCH,
      scope: ASK_DW_TOOL_SCOPE.INVOICE,
      context: { invoiceId: 'inv-1' },
    }),
    /tenantId required/,
  )
})

test('read-only tool registry rejects unregistered/write-like tools', async () => {
  await assert.rejects(
    registry().execute({
      name: 'send_reminder',
      scope: ASK_DW_TOOL_SCOPE.INVOICE,
      context: { tenantId: 't-1', invoiceId: 'inv-1' },
    }),
    /not registered|Unsupported/,
  )
})

test('read-only tool output cannot smuggle execution authority', async () => {
  const unsafe = createAskDwReadToolRegistry({
    definitions: {
      [ASK_DW_READ_TOOL.EVIDENCE_SEARCH]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE],
        handler: async () => ({ canExecute: true }),
      },
    },
  })
  await assert.rejects(
    unsafe.execute({
      name: ASK_DW_READ_TOOL.EVIDENCE_SEARCH,
      scope: ASK_DW_TOOL_SCOPE.INVOICE,
      context: { tenantId: 't-1', invoiceId: 'inv-1' },
    }),
    /forbidden authority\/execution field/,
  )
})

test('model adapter rejects raw chain-of-thought or authority escalation fields', async () => {
  const adapter = createAskDwModelAdapter({
    invoke: async ({ stage }) => stage === 'PLAN'
      ? { toolRequests: [], rawChainOfThought: true }
      : { executiveConclusion: 'x' },
  })
  await assert.rejects(adapter.plan({}), /forbidden field/)
})

test('model adapter enforces a bounded read-tool plan', async () => {
  const adapter = createAskDwModelAdapter({
    maxToolRequests: 1,
    invoke: async () => ({
      toolRequests: [
        { name: 'evidence_search', scope: 'INVOICE' },
        { name: 'payment_reconciliation', scope: 'INVOICE' },
      ],
    }),
  })
  await assert.rejects(adapter.plan({}), /too many tools/)
})

test('orchestrator executes read-only retrieval, synthesis and fresh-context verification', async () => {
  const primaryModel = createAskDwModelAdapter({
    name: 'primary',
    invoke: async ({ stage }) => {
      if (stage === 'PLAN') {
        return {
          toolRequests: [{
            name: ASK_DW_READ_TOOL.PAYMENT_RECONCILIATION,
            scope: ASK_DW_TOOL_SCOPE.INVOICE,
            reason: 'verify customer payment claim',
            input: {},
          }],
          hypotheses: [
            { id: 'H1', label: 'Payment was sent but is not settled', status: 'OPEN' },
            { id: 'H2', label: 'Payment claim is mistaken', status: 'OPEN' },
          ],
        }
      }
      if (stage === 'SYNTHESIZE') {
        return {
          executiveConclusion: 'The invoice is still canonically open; payment settlement is not verified.',
          evidenceBasis: ['Canonical balance is 1200.00', 'Payment reconciliation found no settlement'],
          uncertaintyAndLimitations: ['Customer claim remains attributed, not canonical settlement truth'],
          recommendationOrNextStep: 'Keep collection contact on hold while reconciliation completes.',
          citedToolRunIds: ['tool-01-payment_reconciliation'],
        }
      }
      throw new Error(`unexpected primary stage ${stage}`)
    },
  })

  const verifierModel = createAskDwModelAdapter({
    name: 'verifier',
    invoke: async ({ stage, input }) => {
      assert.equal(stage, 'VERIFY')
      assert.equal(input.verificationMode, 'FRESH_CONTEXT')
      assert.equal(input.truthLock.canonicalFacts.balance, '1200.00')
      return {
        verdict: 'PASS',
        issues: [],
        checkedClaims: ['canonical balance', 'settlement not found'],
      }
    },
  })

  const orchestrator = createAskDwOrchestrator({
    deterministicCore,
    primaryModel,
    verifierModel,
    toolRegistry: registry(),
  })

  const result = await orchestrator.run({
    mode: 'deep',
    text: 'They say they paid. Are you sure?',
    context: { tenantId: 't-1', invoiceId: 'inv-1' },
  })

  assert.equal(result.toolRuns.length, 1)
  assert.equal(result.toolRuns[0].output.sideEffect, false)
  assert.equal(result.verification.verdict, 'PASS')
  assert.equal(result.answer.executiveConclusion.includes('canonically open'), true)
  assert.deepEqual(result.truthLock.canonicalFacts, deterministicCore().packet.canonicalFacts)
  assert.equal(result.safeguards.modelCanGrantAuthority, false)
  assert.equal(result.workManifest.truthfullyPending, false)
})

test('failed verification withholds model narrative and preserves deterministic truth lock', async () => {
  const primaryModel = createAskDwModelAdapter({
    invoke: async ({ stage }) => stage === 'PLAN'
      ? { toolRequests: [], hypotheses: [] }
      : {
          executiveConclusion: 'Mark it paid.',
          evidenceBasis: [],
          uncertaintyAndLimitations: [],
        },
  })
  const verifierModel = createAskDwModelAdapter({
    invoke: async () => ({
      verdict: 'BLOCK',
      issues: ['Candidate conflicts with canonical OPEN state'],
      checkedClaims: ['payment status'],
    }),
  })

  const result = await createAskDwOrchestrator({
    deterministicCore,
    primaryModel,
    verifierModel,
    toolRegistry: registry(),
  }).run({
    mode: 'deep',
    text: 'mark it paid',
    context: { tenantId: 't-1', invoiceId: 'inv-1' },
  })

  assert.equal(result.verification.verdict, 'BLOCK')
  assert.notEqual(result.answer.executiveConclusion, 'Mark it paid.')
  assert.equal(result.truthLock.canonicalFacts.canonicalStatus, 'OPEN')
  assert.equal(result.workManifest.truthfullyPending, true)
})

test('tool handler receives frozen tenant-scoped context', async () => {
  let seen
  const tools = createAskDwReadToolRegistry({
    definitions: {
      [ASK_DW_READ_TOOL.EVIDENCE_SEARCH]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE],
        handler: async ({ context, input }) => {
          seen = { context, input }
          return { ok: true }
        },
      },
    },
  })
  await tools.execute({
    name: ASK_DW_READ_TOOL.EVIDENCE_SEARCH,
    scope: ASK_DW_TOOL_SCOPE.INVOICE,
    input: { q: 'payment' },
    context: { tenantId: 't-1', invoiceId: 'inv-1' },
  })
  assert.equal(Object.isFrozen(seen.context), true)
  assert.equal(Object.isFrozen(seen.input), true)
  assert.equal(seen.context.tenantId, 't-1')
})

test('orchestrator refuses to run without tenant identity', async () => {
  const dummyModel = { plan: async () => ({ toolRequests: [], hypotheses: [] }), synthesize: async () => ({}), verify: async () => ({ verdict: 'PASS' }) }
  const orchestrator = createAskDwOrchestrator({
    deterministicCore,
    primaryModel: dummyModel,
    verifierModel: dummyModel,
    toolRegistry: registry(),
  })
  await assert.rejects(orchestrator.run({ text: 'why?' }), /tenantId required/)
})
