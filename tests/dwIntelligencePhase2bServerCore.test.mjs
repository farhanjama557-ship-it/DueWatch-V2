import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PHASE2B_SERVER_OUTCOME,
  runPhase2BServerProof,
} from '../supabase/functions/_shared/dwIntelligencePhase2bServerCore.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

function baseCase(overrides = {}) {
  const userId = 'tenant-a'
  const client = { id: 'client-a', user_id: userId, name: 'Atlas', email: 'ap@atlas.test' }
  const invoice = {
    id: 'invoice-a', user_id: userId, client_id: client.id, clients: client,
    inv_num: 'INV-100', amount: 1000, amount_paid: 0, due_date: '2026-08-01',
    paid: false, autopilot_paused: false,
  }
  return {
    invoice, client,
    rules: [{ id: 'rule-1', user_id: userId, name: 'Friendly overdue', trigger_type: 'after_due', trigger_days: 1, tone: 'friendly', enabled: true, sort_order: 1 }],
    autopilotSettings: { user_id: userId, enabled: true, approval_required: false },
    handledKeys: new Set(), pendingInvoiceIds: new Set(), events: [],
    evidence: [{ id: 'e1', tenantId: userId, clientId: client.id, invoiceId: invoice.id, sourceType: 'invoice', trust: 'HIGH', claimType: 'invoice_state' }],
    memory: [], tombstones: [], precedents: [], pooling: null, prediction: null,
    ...overrides,
  }
}

function authority({ auto = true, authorized = true } = {}) {
  return ({ invoice, rules }) => ({
    facts: { paid: invoice.paid },
    recommendation: authorized ? { action: 'send_reminder', tone: 'friendly', ruleId: rules[0]?.id ?? 'rule-1', ruleName: 'Friendly overdue' } : null,
    authority: { authorized, basis: authorized ? { ruleId: rules[0]?.id ?? 'rule-1' } : null, evaluatedAt: '2026-08-24T20:00:00.000Z', blockedReason: authorized ? null : 'no_rule' },
    permission: { requiresApproval: !auto, canActAutomatically: auto && authorized },
  })
}

function fakeIo(caseInputs, { failAt = null } = {}) {
  const calls = []
  const io = {
    calls,
    async fetchCaseInputs(args) { calls.push(['fetchCaseInputs', args]); if (failAt === 'fetch') throw new Error('fetch failed'); return caseInputs },
    async createRun(args) { calls.push(['createRun', args]); if (failAt === 'createRun') throw new Error('create run failed'); return { id: 'run-1' } },
    async persistEvidence(rows) { calls.push(['persistEvidence', rows]); if (failAt === 'evidence') throw new Error('evidence write failed') },
    async persistProofEvent(event) { calls.push(['persistProofEvent', event]); if (failAt === 'proof') throw new Error('proof write failed') },
    async finalizeRun(args) { calls.push(['finalizeRun', args]); if (failAt === 'finalize') throw new Error('finalize failed') },
  }
  return io
}

test('routine safe path persists sandbox proof and never exposes provider-send I/O', async () => {
  const inputs = baseCase()
  const io = fakeIo(inputs)
  const out = await runPhase2BServerProof({ userId: 'tenant-a', invoiceId: 'invoice-a', now: new Date('2026-08-24T20:00:00Z'), evaluateAuthority: authority(), io })
  assert.equal(out.outcome, PHASE2B_SERVER_OUTCOME.COMPLETED)
  assert.equal(out.result.state, 'HANDLED')
  assert.equal(out.result.execution.outcome, 'SANDBOX_SENT')
  assert.equal(out.result.execution.sideEffect, false)
  assert.equal(out.summary.real_side_effect, false)
  assert.equal('sendEmail' in io, false)
  assert.equal('fetch' in io, false)
  const create = io.calls.find(([n]) => n === 'createRun')[1]
  assert.equal(create.clientId, 'client-a')
  assert.equal(create.invoiceId, 'invoice-a')
  assert.equal(create.transport, 'sandbox')
  assert.equal(create.productionExecutionAuthorized, false)
  const proof = io.calls.find(([n]) => n === 'persistProofEvent')[1]
  assert.equal(proof.realSideEffect, false)
})

test('authority-required path persists APPROVAL without any send surface', async () => {
  const io = fakeIo(baseCase())
  const out = await runPhase2BServerProof({ userId: 'tenant-a', invoiceId: 'invoice-a', evaluateAuthority: authority({ auto: false }), io })
  assert.equal(out.result.state, 'APPROVAL')
  assert.equal(out.result.execution.outcome, 'NO_ACTION')
  assert.equal(out.result.execution.sideEffect, false)
  assert.equal('sendEmail' in io, false)
})

test('cross-tenant or mismatched object scope stops before durable run creation', async () => {
  const inputs = baseCase({ client: { id: 'client-b', user_id: 'tenant-b', name: 'Wrong tenant' } })
  const io = fakeIo(inputs)
  const out = await runPhase2BServerProof({ userId: 'tenant-a', invoiceId: 'invoice-a', evaluateAuthority: authority(), io })
  assert.equal(out.outcome, PHASE2B_SERVER_OUTCOME.BLOCKED_SCOPE)
  assert.equal(out.persisted, false)
  assert.deepEqual(io.calls.map(([n]) => n), ['fetchCaseInputs'])
})

test('payment claim conflict remains INVESTIGATING and canonical money is unchanged', async () => {
  const inputs = baseCase()
  inputs.evidence.push({
    id: 'e2', tenantId: 'tenant-a', clientId: 'client-a', invoiceId: 'invoice-a',
    sourceType: 'email', trust: 'MEDIUM', claimType: 'payment_claim', content: 'payment sent',
  })
  const io = fakeIo(inputs)
  const out = await runPhase2BServerProof({ userId: 'tenant-a', invoiceId: 'invoice-a', evaluateAuthority: authority(), io })
  assert.equal(out.result.state, 'INVESTIGATING')
  assert.deepEqual(out.result.canonicalAfter, out.result.canonicalBefore)
  assert.equal(out.result.canonicalAfter.canonicalStatus, 'OPEN')
  assert.equal(out.result.canonicalAfter.balance, 1000)
})

test('evidence persistence is pinned to the same run, tenant, client and invoice', async () => {
  const io = fakeIo(baseCase())
  await runPhase2BServerProof({ userId: 'tenant-a', invoiceId: 'invoice-a', evaluateAuthority: authority(), io })
  const rows = io.calls.find(([n]) => n === 'persistEvidence')[1]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].userId, 'tenant-a')
  assert.equal(rows[0].runId, 'run-1')
  assert.equal(rows[0].clientId, 'client-a')
  assert.equal(rows[0].invoiceId, 'invoice-a')
})

test('persistence failure is loud and attempts to finalize the run as failed', async () => {
  const io = fakeIo(baseCase(), { failAt: 'proof' })
  const out = await runPhase2BServerProof({ userId: 'tenant-a', invoiceId: 'invoice-a', evaluateAuthority: authority(), io })
  assert.equal(out.outcome, PHASE2B_SERVER_OUTCOME.PERSISTENCE_FAILED)
  assert.match(out.error, /proof write failed/)
  const finals = io.calls.filter(([n]) => n === 'finalizeRun')
  assert.equal(finals.length, 1)
  assert.equal(finals[0][1].status, 'failed')
})


test('authority-evaluator failure is captured as a failed run rather than disappearing', async () => {
  const io = fakeIo(baseCase())
  const out = await runPhase2BServerProof({
    userId: 'tenant-a',
    invoiceId: 'invoice-a',
    evaluateAuthority: () => { throw new Error('authority evaluation failed') },
    io,
  })
  assert.equal(out.outcome, PHASE2B_SERVER_OUTCOME.PERSISTENCE_FAILED)
  assert.match(out.error, /authority evaluation failed/)
  const finals = io.calls.filter(([n]) => n === 'finalizeRun')
  assert.equal(finals.length, 1)
  assert.equal(finals[0][1].status, 'failed')
})

test('server core preserves missing execution-history state so authority can fail closed', async () => {
  const inputs = baseCase({ handledKeys: null, pendingInvoiceIds: undefined })
  let observed
  const evalAuthority = (args) => {
    observed = args
    const historyEstablished = args.handledKeys instanceof Set && args.pendingInvoiceIds instanceof Set
    return {
      facts: {},
      recommendation: null,
      authority: { authorized: false, basis: null, evaluatedAt: '2026-08-24T20:00:00.000Z', blockedReason: historyEstablished ? 'no_rule' : 'execution_history_unavailable' },
      permission: { requiresApproval: true, canActAutomatically: false },
    }
  }
  const io = fakeIo(inputs)
  const out = await runPhase2BServerProof({ userId: 'tenant-a', invoiceId: 'invoice-a', evaluateAuthority: evalAuthority, io })
  assert.equal(observed.handledKeys, null)
  assert.equal(observed.pendingInvoiceIds, undefined)
  assert.equal(out.result.proof.authority.policyAuthorized, false)
  assert.equal(out.result.execution.sideEffect, false)
  assert.notEqual(out.result.state, 'HANDLED')
})

test('shared Phase 2B engine copy stays byte-identical to browser/lib proof engine', () => {
  const a = fs.readFileSync(path.join(repoRoot, 'src', 'lib', 'dwIntelligence', 'phase2bEngine.js'))
  const b = fs.readFileSync(path.join(repoRoot, 'supabase', 'functions', '_shared', 'dwIntelligencePhase2bEngine.js'))
  assert.deepEqual(a, b)
})

test('server adapter binds exact existing nextActionAuthority and contains no provider send path', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'supabase', 'functions', '_shared', 'dwIntelligencePhase2bServerAdapter.js'), 'utf8')
  assert.match(src, /from '\.\/nextActionAuthority\.js'/)
  assert.match(src, /evaluateNextActionAuthority/)
  assert.doesNotMatch(src, /sendEmail|resend|fetch\s*\(|functions\.invoke|api\.resend\.com/i)
})

test('server core source has no network/email provider execution primitive', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'supabase', 'functions', '_shared', 'dwIntelligencePhase2bServerCore.js'), 'utf8')
  const executable = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(executable, /from\s+['"](?:.*resend|https?:)|sendEmail\s*\(|fetch\s*\(|api\.resend\.com|sendgrid|postmark|mailgun/i)
})
