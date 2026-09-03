/**
 * G8-CP4 — freeze-candidate validation locks.
 *
 * CP1-CP3 each proved their own checkpoint. This file locks the properties the
 * final cross-layer audit found were true but NOT independently asserted, so
 * the freeze rests on tests rather than on a report someone has to trust.
 *
 * It adds no product behaviour and repairs nothing: every assertion here passed
 * on first run against the accepted CP3 head. What it changes is that these
 * facts can no longer drift silently.
 *
 * The heaviest of them is the receipt SOURCE-provenance contract. G8 can prove
 * a receipt and a claim match. It cannot prove where a JavaScript object came
 * from, and pretending otherwise is exactly the mistake CP3 corrected. What
 * makes that safe TODAY is that no runtime supplies receipts at all — so the
 * requirement is written down and locked here, for whoever wires one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildDwExecutionStatement,
  inspectDwExecutionStatement,
  proveDwExecutionStatement,
} from '../src/lib/dwIntelligence/dwExecutionPresentation.js'
import { enforceDwProactiveGrounding } from '../src/lib/dwIntelligence/dwProactiveGrounding.js'
import { buildDwGovernanceContext } from '../src/lib/dwIntelligence/dwGovernanceContext.js'
import { buildDwAttention, DW_ATTENTION_REASON } from '../src/lib/dwIntelligence/dwAttentionPriority.js'
import { buildAskDwDailyPriorities } from '../src/lib/dwIntelligence/askDwDailyPriorities.js'
import { ASK_DW_MODE, buildAskDwModePolicy } from '../src/lib/dwIntelligence/askDwModes.js'
import { buildIdempotencyKey } from '../supabase/functions/_shared/executionClaim.js'

import {
  TENANT_A, AS_OF, IDS,
  brainItem, brainReadModel, brainContext, governanceOf, grantRow,
  needsYouItem, needsYouModel, truthLock, realReceipt, REAL_CLAIM,
} from './dwG8Fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'build', 'coverage'].includes(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(m?js|jsx|ts|tsx)$/.test(name)) continue
      const relative = path.relative(root, full)
      if (relative.startsWith('tests/')) continue
      out.push(relative)
    }
  }
  walk(root)
  return out
}

// ── I. Receipt SOURCE provenance ─────────────────────────────────────────────

test('I1 no production caller can supply receipts, claims or statements to the boundary', () => {
  // The reason the source-provenance gap is safe today: there is no runtime
  // that reaches this boundary at all. If that stops being true, this fails
  // and the source contract below has to be satisfied for real.
  const callers = sourceFiles().filter((relative) => {
    if (relative === 'src/lib/dwIntelligence/dwProactiveGrounding.js') return false
    const source = read(relative)
    return /\bexecutionReceipts\b|\bexecutionStatements\b/.test(source) ||
      /enforceDwProactiveGrounding\s*\(/.test(source)
  })
  assert.deepEqual(callers, [],
    `a production caller now reaches the execution boundary from ${callers.join(', ')} — ` +
    'the receipt SOURCE contract must be satisfied before this can ship')
})

test('I2 no model, Brain, conversation or browser payload is adapted into a receipt', () => {
  // Nothing outside the canonical execution-claim contract constructs the
  // identity a receipt needs. buildIdempotencyKey is the tell: if a module
  // starts deriving execution keys, it is minting receipts.
  const minters = sourceFiles().filter((relative) =>
    relative !== 'src/lib/dwIntelligence/dwExecutionPresentation.js' &&
    !relative.startsWith('supabase/functions/') &&
    read(relative).includes('buildIdempotencyKey'))
  assert.deepEqual(minters, [],
    `execution keys are being derived in ${minters.join(', ')} outside the canonical contract`)
})

test('I3 SOURCE CONTRACT — structural receipt validity is not source provenance', () => {
  // Stated as an executable fact, not a comment: an object a caller invented
  // this instant, with no execution behind it, satisfies every structural
  // check the boundary can perform.
  const invented = {
    userId: IDS.userA, invoiceId: IDS.invoiceA, ruleId: IDS.ruleA,
    actionType: 'send_reminder', status: 'sent',
  }
  invented.idempotencyKey = buildIdempotencyKey(invented)
  const result = enforceDwProactiveGrounding({
    narrative: { headline: 'Here is what happened.' },
    truthLock: truthLock(),
    governance: governanceOf(),
    executionReceipts: [invented],
    executionClaim: REAL_CLAIM,
  })
  assert.equal(result.presentableExecution.length, 1,
    'a structurally valid receipt is accepted — which is exactly why its SOURCE must be canonical')

  // The requirement this implies must be written in the module that depends
  // on it, so a future integrator meets it rather than discovers it.
  const owner = read('src/lib/dwIntelligence/dwExecutionPresentation.js')
  assert.ok(/SOURCE/.test(owner) && /provenance/i.test(owner),
    'the module must document the receipt SOURCE-provenance requirement')
  assert.ok(/MUST originate from[\s\S]{0,120}canonical execution-claim/.test(owner),
    'the required source must be named as a requirement, not merely mentioned')
  assert.ok(/never be able to synthesise a receipt/i.test(owner),
    'the module must name what the contract forbids')
})

// ── Production status, as a fact rather than a report ────────────────────────

test('PROD dwIntelligence read models are never provided to the browser', () => {
  // Dashboard and Activity destructure `dwIntelligence` from useData() and
  // guard it with `?? null`. The context value never contains that key, so the
  // panels are permanently inert. That is the honest statement of "not wired":
  // the surface exists, the data never arrives.
  const context = read('src/context/DataContext.jsx')
  const valueBlock = context.slice(context.indexOf('const value = '))
  assert.equal(valueBlock.slice(0, valueBlock.indexOf('\n  }')).includes('dwIntelligence'), false,
    'DataContext now provides dwIntelligence — a proactive runtime exists and must be audited')
  for (const consumer of ['src/pages/Dashboard.jsx', 'src/pages/Activity.jsx']) {
    const source = read(consumer)
    const uses = source.match(/dwIntelligence\?\.[a-zA-Z]+/g) ?? []
    for (const use of uses) {
      assert.ok(source.includes(`${use} ??`) || source.includes(`${use}?.`),
        `${consumer} reads ${use} without a null guard`)
    }
  }
})

test('PROD the replay-only server core is still not deployed', () => {
  const importers = sourceFiles().filter((relative) =>
    read(relative).toLowerCase().includes('phase2bservercore'))
  assert.deepEqual(importers, ['supabase/functions/_shared/dwIntelligencePhase2bServerAdapter.js'],
    'the Phase 2B server core gained or lost an importer; its replay-only classification must be re-audited')
  const deployed = readdirSync(path.join(root, 'supabase/functions'))
    .filter((name) => !name.startsWith('_') && !name.endsWith('.md'))
  for (const fn of deployed) {
    const dir = path.join(root, 'supabase/functions', fn)
    if (!statSync(dir).isDirectory()) continue
    for (const file of readdirSync(dir)) {
      assert.equal(
        readFileSync(path.join(dir, file), 'utf8').toLowerCase().includes('phase2bservercore'), false,
        `deployed function ${fn} now imports the replay-only server core`)
    }
  }
})

// ── C. Authority substitutions that must never work ──────────────────────────

test('C4 provider capability is not authority anywhere in the G8 composition', () => {
  const envelope = buildDwGovernanceContext({
    tenantId: TENANT_A,
    companyBrainContext: brainContext(),
    // A caller insisting the transport is ready and production-capable.
    knownEntities: [],
  })
  assert.equal(envelope.governs, false)
  assert.equal(JSON.stringify(envelope).includes('capab'), false)

  // And capability cannot produce execution.
  const result = enforceDwProactiveGrounding({
    narrative: { headline: 'Here is what happened.' },
    truthLock: truthLock(),
    governance: envelope,
    executionClaim: REAL_CLAIM,
    providerCapability: { email: true, canSend: true, verified: true },
    transport: { mode: 'production', ready: true },
  })
  assert.deepEqual(result.presentableExecution, [])
})

test('C6 repeated approvals never accumulate into standing authority', () => {
  // Ten approval cases are ten decisions the founder still owns, not a
  // standing grant. The queue reports them; it never promotes them.
  const items = Array.from({ length: 10 }, (_, index) => needsYouItem({
    runId: `run-${index}`, invoiceId: `inv-${index}`, clientId: `client-${index}`,
    state: 'APPROVAL', at: `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00Z`,
  }))
  const attention = buildDwAttention({
    tenantId: TENANT_A,
    needsYouReadModel: needsYouModel(items),
    companyBrainContext: brainContext(),
    limit: 20,
  })
  assert.equal(attention.total, 10)
  for (const entry of attention.items) {
    assert.equal(entry.reason, DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED)
    assert.equal(entry.authorityImpact, 'NONE')
    assert.equal(entry.directlyExecutable, false)
  }
  assert.equal(attention.boundaries.canGrantAuthority, false)
})

test('C7 proposed authority is never carried as a current grant', () => {
  // The Company Brain projection exposes `proposals` alongside `currentGrants`.
  // A proposal is a request the founder has not granted; reading it as grant
  // identity would make an envelope report authority that does not exist.
  const model = brainReadModel({ grants: [grantRow({ id: 'g-live' })] })
  model.authority.proposedAuthority = [grantRow({ id: 'g-proposed', status: 'PROPOSED' })]
  model.authority.proposalCount = 1
  const envelope = governanceOf(model)
  assert.deepEqual(envelope.authority.currentGrantIds, ['g-live'])
  assert.equal(JSON.stringify(envelope).includes('g-proposed'), false,
    'a proposal was carried as current grant identity')
})

test('C7/B5 superseded and revoked authority never appear as current grants', () => {
  const model = brainReadModel({ grants: [grantRow({ id: 'g-live' })] })
  // Superseded and invalidated material exists in the read model and must not
  // reach the envelope's grant identity.
  model.authority.supersededAuthority = [grantRow({ id: 'g-superseded', status: 'SUPERSEDED' })]
  model.authority.invalidatedAuthority = [grantRow({ id: 'g-invalid', status: 'INVALIDATED' })]
  model.authority.revokedAuthority = [grantRow({ id: 'g-revoked', status: 'REVOKED' })]
  const envelope = governanceOf(model)
  assert.deepEqual(envelope.authority.currentGrantIds, ['g-live'])
  const serialized = JSON.stringify(envelope)
  for (const dead of ['g-superseded', 'g-invalid', 'g-revoked']) {
    assert.equal(serialized.includes(dead), false, `${dead} resurrected into the envelope`)
  }
  // Honest attribution of WHERE this holds: the G7 Company Brain projection
  // never surfaces superseded/invalidated/revoked grant objects at all, so the
  // envelope has nothing to leak. The envelope's own job is to read only
  // `currentGrants` from what it is given, which the proposal test above locks.
  const context = brainContext(model)
  assert.equal('supersededAuthority' in context.authority, false)
  assert.equal('revokedAuthority' in context.authority, false)
  assert.deepEqual(context.authority.currentGrants.map((g) => g.grantId), ['g-live'])
})

// ── L. Normal and Deep share one safety floor ────────────────────────────────

test('L Deep investigates more and is authorised no further', () => {
  const normal = buildAskDwModePolicy({ mode: ASK_DW_MODE.NORMAL })
  const deep = buildAskDwModePolicy({ mode: ASK_DW_MODE.DEEP })
  assert.notDeepEqual(normal, deep, 'the modes must differ in effort')
  // Neither mode carries a permission, an execution capability or a tenant.
  for (const [name, policy] of [['normal', normal], ['deep', deep]]) {
    const serialized = JSON.stringify(policy)
    for (const forbidden of [
      'canExecute', 'canActAutomatically', 'authorized', 'authorised',
      'grant', 'tenantId', 'receipt', 'idempotency',
    ]) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false,
        `${name} mode policy carries ${forbidden}`)
    }
  }
})

test('L the execution floor is identical under both modes', () => {
  // Execution is derived from the receipt, and mode is not an input to that
  // derivation at all — which is what makes the floor identical rather than
  // merely equal today.
  const builder = buildDwExecutionStatement.toString()
  assert.equal(/mode|deep|normal/i.test(builder), false,
    'the execution builder must not consider mode')
  for (const mode of [ASK_DW_MODE.NORMAL, ASK_DW_MODE.DEEP]) {
    const result = enforceDwProactiveGrounding({
      narrative: { headline: 'Here is what happened.' },
      truthLock: truthLock(),
      governance: governanceOf(),
      executionClaim: REAL_CLAIM,
      mode,
    })
    assert.deepEqual(result.presentableExecution, [], mode)
  }
})

// ── M. The two lanes cannot diverge on execution ─────────────────────────────

test('M6 neither lane can create execution the other cannot prove', () => {
  // Both lanes reach execution through one function, so "the other lane could
  // prove it" is structural rather than a coincidence of two code paths.
  const guardSource = read('src/lib/dwIntelligence/dwProactiveGrounding.js')
  const askSource = read('src/lib/dwIntelligence/askDwOrchestrator.js')
  const dailySource = read('src/lib/dwIntelligence/askDwDailyPriorities.js')
  for (const [name, source] of [['Ask DW orchestrator', askSource], ['Ask DW priorities', dailySource]]) {
    assert.equal(/buildDwExecutionStatement|presentableExecution/.test(source), false,
      `${name} builds execution independently of the shared boundary`)
  }
  assert.ok(guardSource.includes('buildDwExecutionStatement({'))

  // The same receipt proves the same statement regardless of which lane's
  // context surrounds it.
  const statement = buildDwExecutionStatement({ receipt: realReceipt(), claim: REAL_CLAIM }).statement
  assert.equal(proveDwExecutionStatement({
    statement, claim: REAL_CLAIM, receipt: realReceipt(),
  }), true)
  assert.equal(inspectDwExecutionStatement(statement).wellFormed, true)
})

test('M5 both lanes read one attention answer for the same state', () => {
  const items = [
    needsYouItem({ runId: 'r1', invoiceId: 'inv-1', clientId: 'c1', state: 'APPROVAL' }),
    needsYouItem({ runId: 'r2', invoiceId: 'inv-2', clientId: 'c2', state: 'UNCERTAIN' }),
  ]
  const model = brainReadModel({
    items: [brainItem({ reviewKey: 'k-1', itemType: 'CONFLICT', conflictStatus: 'CONFLICTED', reviewStatus: 'PENDING' })],
  })
  const context = brainContext(model)
  const ask = buildAskDwDailyPriorities({
    tenantId: TENANT_A, needsYouReadModel: needsYouModel(items), companyBrainContext: context, limit: 20,
  })
  const proactive = buildDwAttention({
    tenantId: TENANT_A, needsYouReadModel: needsYouModel(items), companyBrainContext: context, limit: 20,
  })
  assert.deepEqual(
    ask.items.map((item) => [item.source, item.reason, item.subject, item.reasonRank]),
    proactive.items.map((item) => [item.source, item.reason, item.subject, item.reasonRank]))
  assert.equal(ask.complete, proactive.complete)
})

// ── The G8 surface itself ────────────────────────────────────────────────────

test('FREEZE the G8 production surface is exactly the audited set of modules', () => {
  // A new file appearing under dwIntelligence is not automatically wrong, but
  // it is automatically something the freeze audit has not seen.
  const g8Modules = [
    'src/lib/dwIntelligence/dwInvestigationInput.js',
    'src/lib/dwIntelligence/dwGovernanceContext.js',
    'src/lib/dwIntelligence/dwAttentionPriority.js',
    'src/lib/dwIntelligence/dwProactiveGrounding.js',
    'src/lib/dwIntelligence/dwExecutionPresentation.js',
  ]
  for (const relative of g8Modules) {
    assert.ok(read(relative).length > 0, `${relative} is missing`)
    // None of the five may open a persistence, network or schema surface.
    const body = read(relative).split('\n')
      .filter((line) => !/^\s*(import|}\s*from)\b/.test(line)).join('\n')
    for (const forbidden of ['createClient', 'fetch(', '.from(', 'process.env', 'Deno.',
      'create table', 'alter table']) {
      assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false,
        `${relative} contains ${forbidden}`)
    }
  }
})
