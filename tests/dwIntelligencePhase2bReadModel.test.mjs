import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DW_UI_STATE,
  DW_WORK_PHASE,
  FOUNDER_ACTION_BOUNDARY,
  deriveWorkPhase,
  projectActivityReadModel,
  projectCaseReadModel,
  projectNeedsYouReadModel,
  projectPulseReadModel,
  projectLivePresenceReadModel,
} from '../src/lib/dwIntelligence/phase2bReadModel.js'

function proofEvent({
  state = 'HANDLED',
  userId = 'tenant-a',
  invoiceId = 'invoice-a',
  clientId = 'client-a',
  actualAuthority = 'GRANTED',
  canActAutomatically = true,
  requiresApproval = false,
  paymentConflict = false,
  questionAsked = false,
  verifierPassed = true,
  executionOutcome = 'SANDBOX_SENT',
  sideEffect = false,
  createdAt = '2026-08-24T23:00:00.000Z',
} = {}) {
  return {
    id: 'proof-1',
    user_id: userId,
    run_id: 'run-1',
    invoice_id: invoiceId,
    client_id: clientId,
    operational_state: state,
    created_at: createdAt,
    real_side_effect: false,
    proof: {
      scope: { tenantId: userId, businessId: userId, invoiceId, clientId },
      canonicalFacts: {
        invoiceId,
        tenantId: userId,
        clientId,
        amount: 5000,
        amountPaid: 1000,
        balance: 4000,
        dueDate: '2026-08-01',
        daysOverdue: 23,
        paid: false,
        settled: false,
        canonicalStatus: 'OPEN',
        lastReminderAt: null,
      },
      evidence: {
        records: [
          { id: 'e1', trust: 'HIGH', status: 'ADMITTED', reason: null, derivedFrom: null, claimType: 'invoice_state' },
          { id: 'e2', trust: 'MEDIUM', status: paymentConflict ? 'ADMITTED' : 'CONTEXT_ONLY', reason: paymentConflict ? null : 'low_trust_context_only', derivedFrom: null, claimType: paymentConflict ? 'payment_claim' : 'communication' },
          { id: 'e3', trust: 'UNTRUSTED', status: 'QUARANTINED_INSTRUCTION', reason: 'external_instruction_not_authority', derivedFrom: null, claimType: null },
        ],
        independentStrongRoots: paymentConflict ? ['e1', 'e2'] : ['e1'],
        fabricatedIds: [],
      },
      interpretations: paymentConflict ? [{ type: 'payment_claim', value: 'client_says_payment_sent', promotedToCanonical: false }] : [],
      predictions: null,
      identificationStatus: null,
      memory: { active: [], blocked: [], rederivedFromBlockedEvidence: false },
      precedent: { checked: [{ id: 'p1', similarity: 0.85, applicable: true, reasons: {} }], applicable: ['p1'] },
      pooling: null,
      uncertainty: null,
      founderQuestion: { question: questionAsked ? 'Is Atlas a protected strategic account?' : null, asked: questionAsked },
      preferenceEvidence: { admitted: [], excluded: [] },
      policy: { action: 'send_reminder', tone: 'friendly', ruleId: 'rule-1', ruleName: 'Friendly follow-up' },
      authority: {
        policyAuthorized: true,
        actual: actualAuthority,
        canActAutomatically,
        requiresApproval,
        basis: { ruleId: 'rule-1', ruleName: 'Friendly follow-up' },
      },
      verifier: { passed: verifierPassed, checks: { invoiceOpen: true } },
      stagedAction: state === 'APPROVAL'
        ? { action: 'send_reminder', tone: 'friendly', ruleId: 'rule-1', status: 'AWAITING_APPROVAL' }
        : { action: 'send_reminder', tone: 'friendly', ruleId: 'rule-1', status: state === 'HANDLED' ? 'SANDBOX_EXECUTED' : 'STAGED' },
      execution: { mode: state === 'HANDLED' ? 'sandbox' : 'none', sideEffect, outcome: executionOutcome },
    },
  }
}

function caseInput(opts = {}) {
  const event = proofEvent(opts)
  return {
    userId: opts.userId ?? 'tenant-a',
    invoice: { id: opts.invoiceId ?? 'invoice-a', client_id: opts.clientId ?? 'client-a' },
    client: { id: opts.clientId ?? 'client-a' },
    run: {
      id: 'run-1',
      user_id: opts.userId ?? 'tenant-a',
      status: opts.runStatus ?? 'completed',
      started_at: '2026-08-24T22:59:00.000Z',
      completed_at: opts.runStatus === 'running' ? null : '2026-08-24T23:00:00.000Z',
      summary: { hard_violations: [] },
    },
    proofEvent: event,
  }
}

test('case read model projects HANDLED proof without creating execution authority', () => {
  const input = caseInput()
  const before = structuredClone(input.proofEvent.proof.canonicalFacts)
  const out = projectCaseReadModel(input)
  assert.equal(out.available, true)
  assert.equal(out.state, DW_UI_STATE.HANDLED)
  assert.equal(out.workPhase, DW_WORK_PHASE.HANDLED)
  assert.equal(out.canonical.balance, 4000)
  assert.equal(out.execution.realSideEffect, false)
  assert.equal(out.proofIntegrity.displayGrantsAuthority, false)
  assert.equal(out.proofIntegrity.directExecutionAvailable, false)
  assert.equal(out.founderAction, null)
  assert.deepEqual(input.proofEvent.proof.canonicalFacts, before)
})

test('APPROVAL creates a founder decision card that only requests backend revalidation', () => {
  const out = projectCaseReadModel(caseInput({ state: 'APPROVAL', actualAuthority: 'NOT_GRANTED', canActAutomatically: false, requiresApproval: true, executionOutcome: 'NO_ACTION' }))
  assert.equal(out.needsFounder, true)
  assert.equal(out.founderAction.kind, 'APPROVAL_REQUIRED')
  assert.equal(out.founderAction.boundary, FOUNDER_ACTION_BOUNDARY)
  assert.equal(out.founderAction.directlyExecutable, false)
  assert.equal(out.authority.actual, 'NOT_GRANTED')
  assert.equal(out.execution.realSideEffect, false)
})

test('founder question is surfaced without manufacturing action authority', () => {
  const out = projectCaseReadModel(caseInput({ state: 'UNCERTAIN', questionAsked: true, actualAuthority: 'NOT_GRANTED', canActAutomatically: false, requiresApproval: true, executionOutcome: 'NO_ACTION' }))
  assert.equal(out.needsFounder, true)
  assert.equal(out.founderAction.kind, 'ANSWER_REQUIRED')
  assert.equal(out.founderAction.boundary, FOUNDER_ACTION_BOUNDARY)
  assert.equal(out.founderAction.directlyExecutable, false)
})

test('payment-claim conflict projects INVESTIGATING and keeps canonical invoice OPEN', () => {
  const out = projectCaseReadModel(caseInput({ state: 'INVESTIGATING', paymentConflict: true, executionOutcome: 'NO_ACTION', actualAuthority: 'GRANTED' }))
  assert.equal(out.state, DW_UI_STATE.INVESTIGATING)
  assert.equal(out.workPhase, DW_WORK_PHASE.WAITING)
  assert.equal(out.nextWorkPhase, DW_WORK_PHASE.VERIFYING)
  assert.equal(out.canonical.canonicalStatus, 'OPEN')
  assert.equal(out.canonical.balance, 4000)
  assert.match(out.why.find((x) => x.type === 'interpretation').text, /separate from canonical money truth/)
})

test('• LIVE analyzing state appears only from a real persisted running run', () => {
  const running = caseInput({ runStatus: 'running', state: 'WATCH', executionOutcome: 'NO_ACTION', actualAuthority: 'NOT_GRANTED', canActAutomatically: false })
  const live = projectCaseReadModel(running)
  assert.equal(live.live, true)
  assert.equal(live.workPhase, DW_WORK_PHASE.ANALYZING)

  const done = projectCaseReadModel(caseInput({ state: 'WATCH', executionOutcome: 'NO_ACTION', actualAuthority: 'NOT_GRANTED', canActAutomatically: false }))
  assert.equal(done.live, false)
  assert.equal(done.workPhase, DW_WORK_PHASE.WAITING)
  assert.equal(done.nextWorkPhase, DW_WORK_PHASE.WAITING)
})

test('run-only LIVE presence is truthful before a final proof event exists', () => {
  const out = projectLivePresenceReadModel({
    userId: 'tenant-a',
    runs: [
      { id:'run-live', user_id:'tenant-a', client_id:'client-a', invoice_id:'invoice-a', workflow:'overdue_invoice_triage_friendly_reminder', status:'running', transport:'sandbox', production_execution_authorized:false, started_at:'2026-08-24T23:10:00.000Z' },
      { id:'foreign', user_id:'tenant-b', client_id:'client-b', invoice_id:'invoice-b', status:'running', transport:'sandbox', production_execution_authorized:false },
      { id:'unsafe', user_id:'tenant-a', client_id:'client-c', invoice_id:'invoice-c', status:'running', transport:'production', production_execution_authorized:true },
    ],
  })
  assert.equal(out.live, true)
  assert.equal(out.count, 1)
  assert.equal(out.entries[0].runId, 'run-live')
  assert.equal(out.entries[0].workPhase, DW_WORK_PHASE.ANALYZING)
  assert.match(out.entries[0].detail, /Detailed step state is not claimed/)
})

test('Pulse can count a real running scoped run even before a proof event is available', () => {
  const out = projectPulseReadModel({
    userId: 'tenant-a',
    cases: [],
    activeRuns: [
      { id:'run-live', user_id:'tenant-a', client_id:'client-a', invoice_id:'invoice-a', workflow:'overdue_invoice_triage_friendly_reminder', status:'running', transport:'sandbox', production_execution_authorized:false, started_at:'2026-08-24T23:10:00.000Z' },
    ],
  })
  assert.equal(out.totalCases, 0)
  assert.equal(out.live, true)
  assert.equal(out.liveJobs, 1)
  assert.equal(out.livePresence.runOnly[0].invoiceId, 'invoice-a')
})


test('cross-tenant or object-scope mismatch fails closed and reveals no case details', () => {
  const input = caseInput()
  input.proofEvent.user_id = 'tenant-b'
  input.proofEvent.proof.scope.tenantId = 'tenant-b'
  const out = projectCaseReadModel(input)
  assert.deepEqual(out, {
    available: false,
    state: 'BLOCKED',
    workPhase: 'blocked',
    blockedReason: 'READ_MODEL_SCOPE_MISMATCH',
    founderAction: null,
  })
  assert.equal('canonical' in out, false)
})

test('proof integrity anomaly blocks the UI even if the persisted operational state says HANDLED', () => {
  const input = caseInput()
  input.run.transport = 'production'
  input.run.production_execution_authorized = true
  input.proofEvent.real_side_effect = true
  input.proofEvent.proof.execution.sideEffect = true
  const out = projectCaseReadModel(input)
  assert.equal(out.state, DW_UI_STATE.BLOCKED)
  assert.equal(out.live, false)
  assert.equal(out.needsFounder, false)
  assert.equal(out.proofIntegrity.sandboxIntegrityOk, false)
  assert.equal(out.proofIntegrity.directExecutionAvailable, false)
})

test('unknown operational state fails closed to BLOCKED rather than inventing UI meaning', () => {
  const input = caseInput()
  input.proofEvent.operational_state = 'MAGIC_AUTONOMOUS'
  const out = projectCaseReadModel(input)
  assert.equal(out.state, DW_UI_STATE.BLOCKED)
  assert.equal(out.proofIntegrity.directExecutionAvailable, false)
})

test('Pulse aggregates proven case states, money, LIVE jobs and Needs You', () => {
  const cases = [
    caseInput({ invoiceId: 'i1', clientId: 'c1', state: 'HANDLED' }),
    caseInput({ invoiceId: 'i2', clientId: 'c2', state: 'WATCH', actualAuthority: 'NOT_GRANTED', canActAutomatically: false, executionOutcome: 'NO_ACTION' }),
    caseInput({ invoiceId: 'i3', clientId: 'c3', state: 'APPROVAL', actualAuthority: 'NOT_GRANTED', canActAutomatically: false, requiresApproval: true, executionOutcome: 'NO_ACTION' }),
    caseInput({ invoiceId: 'i4', clientId: 'c4', state: 'INVESTIGATING', paymentConflict: true, runStatus: 'running', executionOutcome: 'NO_ACTION' }),
  ]
  const out = projectPulseReadModel({ userId: 'tenant-a', cases })
  assert.equal(out.totalCases, 4)
  assert.equal(out.cashUnderManagement, 16000)
  assert.equal(out.handled, 1)
  assert.equal(out.watching, 1)
  assert.equal(out.approval, 1)
  assert.equal(out.investigating, 1)
  assert.equal(out.needsYou, 1)
  assert.equal(out.liveJobs, 1)
  assert.equal(out.live, true)
  assert.match(out.headline, /4 cases under management\. 1 needs your judgment\./)
})

test('Pulse silently excludes cross-tenant records instead of leaking them into totals', () => {
  const own = caseInput({ invoiceId: 'i1', clientId: 'c1' })
  const foreign = caseInput({ invoiceId: 'i2', clientId: 'c2' })
  foreign.proofEvent.user_id = 'tenant-b'
  foreign.proofEvent.proof.scope.tenantId = 'tenant-b'
  const out = projectPulseReadModel({ userId: 'tenant-a', cases: [own, foreign] })
  assert.equal(out.totalCases, 1)
  assert.equal(out.cashUnderManagement, 4000)
})

test('aggregate caller tenant overrides any case-supplied userId so a foreign case cannot self-authorize projection', () => {
  const own = caseInput({ invoiceId: 'i1', clientId: 'c1' })
  const foreign = caseInput({ userId: 'tenant-b', invoiceId: 'i2', clientId: 'c2' })
  const out = projectPulseReadModel({ userId: 'tenant-a', cases: [own, foreign] })
  assert.equal(out.totalCases, 1)
  assert.equal(out.cases[0].invoiceId, 'i1')
})

test('Invoice Detail timeline is proof-derived and reports sandbox side-effect truth', () => {
  const out = projectCaseReadModel(caseInput())
  assert.ok(out.timeline.find((x) => x.kind === 'canonical'))
  assert.ok(out.timeline.find((x) => x.kind === 'evidence'))
  assert.ok(out.timeline.find((x) => x.kind === 'authority'))
  assert.ok(out.timeline.find((x) => x.kind === 'execution'))
  assert.match(out.timeline.find((x) => x.kind === 'execution').detail, /real side effect: no/)
  assert.ok(out.timeline.every((x) => x.timestampKind === 'proof_event_time'))
})

test('Evidence drawer counts admitted/context/quarantined sources and strong roots', () => {
  const out = projectCaseReadModel(caseInput())
  assert.equal(out.evidence.total, 3)
  assert.equal(out.evidence.admitted, 1)
  assert.equal(out.evidence.contextOnly, 1)
  assert.equal(out.evidence.quarantined, 1)
  assert.equal(out.evidence.independentStrongRoots, 1)
})

test('Activity / What\'s Done produces proof-linked entries with no side-effect inflation', () => {
  const cases = [
    caseInput({ invoiceId: 'i1', clientId: 'c1', createdAt: '2026-08-24T23:00:00.000Z' }),
    caseInput({ invoiceId: 'i2', clientId: 'c2', state: 'WATCH', actualAuthority: 'NOT_GRANTED', canActAutomatically: false, executionOutcome: 'NO_ACTION', createdAt: '2026-08-24T22:00:00.000Z' }),
  ]
  const out = projectActivityReadModel({ userId: 'tenant-a', cases })
  assert.equal(out.entries.length, 2)
  assert.equal(out.entries[0].invoiceId, 'i1')
  assert.equal(out.entries[0].proofAvailable, true)
  assert.equal(out.entries[0].realSideEffect, false)
})

test('Needs You contains only approval/question cases and never exposes a directly executable control', () => {
  const cases = [
    caseInput({ invoiceId: 'i1', clientId: 'c1' }),
    caseInput({ invoiceId: 'i2', clientId: 'c2', state: 'APPROVAL', actualAuthority: 'NOT_GRANTED', canActAutomatically: false, requiresApproval: true, executionOutcome: 'NO_ACTION' }),
    caseInput({ invoiceId: 'i3', clientId: 'c3', state: 'UNCERTAIN', questionAsked: true, actualAuthority: 'NOT_GRANTED', canActAutomatically: false, requiresApproval: true, executionOutcome: 'NO_ACTION' }),
  ]
  const out = projectNeedsYouReadModel({ userId: 'tenant-a', cases })
  assert.equal(out.count, 2)
  assert.ok(out.items.every((x) => x.founderAction.directlyExecutable === false))
  assert.ok(out.items.every((x) => x.founderAction.boundary === FOUNDER_ACTION_BOUNDARY))
})

test('read model outputs are deeply frozen so UI consumers cannot mutate proof-derived state in place', () => {
  const out = projectCaseReadModel(caseInput())
  assert.equal(Object.isFrozen(out), true)
  assert.equal(Object.isFrozen(out.canonical), true)
  assert.equal(Object.isFrozen(out.timeline), true)
  assert.throws(() => { out.canonical.balance = 0 }, TypeError)
})

test('read model source contains no network, database, provider-send, or canonical mutation primitive', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '..', 'src', 'lib', 'dwIntelligence', 'phase2bReadModel.js'), 'utf8')
  const executable = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(executable, /createClient|supabase-js|sendEmail|resend|fetch\s*\(|https?:\/\//i)
  assert.doesNotMatch(executable, /\.from\(['\"]invoices['\"]\).*\.(insert|update|delete)|(?:^|[^=!<>])amount_paid\s*=(?!=)|(?:^|[^=!<>])paid\s*=(?!=)/im)
})
