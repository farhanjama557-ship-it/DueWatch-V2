/**
 * G8-CP3 — structural locks.
 *
 * The hostile and property suites prove BEHAVIOUR. These lock the STRUCTURE
 * that behaviour depends on, so a later change that quietly removes a control
 * fails here with a message saying what was removed and why it mattered,
 * rather than passing because the test that covered it was also deleted.
 *
 * Two kinds of lock live here:
 *
 *   1. Boundary locks — the closed vocabularies, the frozen outputs, and the
 *      absence of a Company Brain or governance seam inside the truth engine.
 *   2. Honest-accounting locks — what G8 is NOT wired into. CP2 reported that
 *      no proactive runtime consumes these modules in production. That claim
 *      has to keep being true or stop being made, so it is asserted rather
 *      than written in a report and forgotten.
 *
 * A failure here is not necessarily a bug. It means a stated boundary moved,
 * and the statement must be re-reviewed before the lock is updated.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DW_ATTENTION_REASON, DW_ATTENTION_BLOCKER, DW_ATTENTION_VERSION, buildDwAttention,
} from '../src/lib/dwIntelligence/dwAttentionPriority.js'
import {
  DW_PROACTIVE_ISSUE, DW_PROVABLE_EXECUTION_ACTIONS, enforceDwProactiveGrounding,
} from '../src/lib/dwIntelligence/dwProactiveGrounding.js'
import {
  DW_INVESTIGATION_BOUNDS, DW_INVESTIGATION_SOURCE,
} from '../src/lib/dwIntelligence/dwInvestigationInput.js'
import { buildDwGovernanceContext } from '../src/lib/dwIntelligence/dwGovernanceContext.js'
import { ASK_DW_PRIORITY_REASON } from '../src/lib/dwIntelligence/askDwDailyPriorities.js'

import {
  TENANT_A, brainContext, governanceOf, needsYouItem, needsYouModel, truthLock,
} from './dwG8Fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const G8_MODULES = [
  'src/lib/dwIntelligence/dwInvestigationInput.js',
  'src/lib/dwIntelligence/dwGovernanceContext.js',
  'src/lib/dwIntelligence/dwAttentionPriority.js',
  'src/lib/dwIntelligence/dwProactiveGrounding.js',
]

/** Every source file in the repository, excluding tests and dependencies. */
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

// ── 1. Boundary locks ────────────────────────────────────────────────────────

test('LOCK the attention reason vocabulary is closed and ordered', () => {
  assert.deepEqual(Object.keys(DW_ATTENTION_REASON), [
    'FOUNDER_DECISION_REQUIRED',
    'UNRESOLVED_CONFLICT',
    'SUPPORTING_SOURCE_REVOKED',
    'CHANGED_SINCE_REVIEW',
    'BLOCKED_ON_MISSING_AUTHORITY',
    'BLOCKED_ON_OPERATIONAL_POLICY',
    'NEEDS_FOUNDER_ANSWER',
    'AWAITING_REVIEW',
  ])
  assert.deepEqual(Object.keys(DW_ATTENTION_BLOCKER), [
    'FOUNDER_DECISION', 'FOUNDER_ANSWER', 'MISSING_AUTHORITY',
    'OPERATIONAL_POLICY', 'UNRESOLVED_CONFLICT', 'FOUNDER_REVIEW',
  ])
  assert.equal(DW_ATTENTION_VERSION, 'DW_ATTENTION_V0')
  assert.ok(Object.isFrozen(DW_ATTENTION_REASON))
})

test('LOCK Ask DW reads the shared vocabulary rather than keeping a second one', () => {
  assert.equal(ASK_DW_PRIORITY_REASON, DW_ATTENTION_REASON,
    'two orderings are two answers waiting to disagree')
})

test('LOCK the proactive issue vocabulary is closed', () => {
  assert.deepEqual(Object.keys(DW_PROACTIVE_ISSUE).sort(), [
    'ALL_CLEAR_WHILE_DEGRADED',
    'CLAIMED_AUTHORITY_WITHOUT_GRANT',
    'EXECUTION_WITHOUT_RECEIPT',
    'INJECTED_INSTRUCTION_IN_NARRATIVE',
    'RESOLVED_AN_UNRESOLVED_CONFLICT',
    'UNGROUNDED_AMOUNT',
    'UNGROUNDED_DAY_COUNT',
    'UNGROUNDED_IDENTIFIER',
    'UNSUPPORTED_PAYMENT_CLAIM',
    'UNSUPPORTED_PROMISE_CLAIM',
    'UNSUPPORTED_URGENCY',
  ])
})

test('LOCK only send_reminder has a canonical execution contract to prove', () => {
  // Widening this set without a real execution-claim contract for the new
  // action would let a fabricated receipt license a sentence about money.
  assert.deepEqual([...DW_PROVABLE_EXECUTION_ACTIONS], ['send_reminder'])
})

test('LOCK the admission window is bounded and shared by both sources', () => {
  assert.deepEqual({ ...DW_INVESTIGATION_BOUNDS }, {
    MAX_EVIDENCE: 100, MAX_MEMORY: 100, MAX_PRECEDENTS: 100,
  })
  assert.deepEqual(Object.keys(DW_INVESTIGATION_SOURCE), ['ASK_DW', 'DW_INTELLIGENCE'])
})

test('LOCK the governance envelope exposes references only, never a verdict', () => {
  const envelope = buildDwGovernanceContext({
    tenantId: TENANT_A, companyBrainContext: brainContext(),
  })
  assert.deepEqual(Object.keys(envelope).sort(), [
    'authority', 'authorityMustBeReEvaluatedAtUse', 'companyBrain', 'conflicts',
    'entities', 'governs', 'kind', 'sourceState', 'tenantId',
  ])
  assert.deepEqual(Object.keys(envelope.authority).sort(),
    ['currentGrantIds', 'evaluatedAt', 'fingerprint'])
  assert.equal(envelope.governs, false)
})

test('LOCK every G8 output is deeply frozen', () => {
  const attention = buildDwAttention({
    tenantId: TENANT_A,
    needsYouReadModel: needsYouModel([needsYouItem()]),
    companyBrainContext: brainContext(),
  })
  const grounding = enforceDwProactiveGrounding({
    narrative: { headline: 'Atlas has paid.' }, truthLock: truthLock(), governance: governanceOf(),
  })
  for (const [name, value] of [['attention', attention], ['grounding', grounding],
    ['governance', governanceOf()]]) {
    assert.ok(Object.isFrozen(value), `${name} must be frozen`)
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') {
        assert.ok(Object.isFrozen(nested), `${name} nested value must be frozen`)
      }
    }
  }
  // A caller cannot quietly promote an entry or clear an issue.
  assert.throws(() => { attention.items[0].reasonRank = -1 }, TypeError)
  assert.throws(() => { grounding.issues.length = 0 }, TypeError)
})

test('LOCK the truth engine has no Company Brain, governance or attention seam', () => {
  const engine = read('src/lib/dwIntelligence/phase2bEngine.js')
  for (const forbidden of ['companyBrain', 'CompanyBrain', 'governance', 'buildDwAttention', 'dwProactiveGrounding']) {
    assert.equal(engine.includes(forbidden), false,
      `phase2bEngine must not reference ${forbidden}: canonical truth is not governable by memory`)
  }
})

test('LOCK the G8 modules perform no IO and open no persistence of their own', () => {
  for (const relative of G8_MODULES) {
    const source = read(relative)
    // Import lines are judged separately below: a pure helper may live under a
    // supabase/ path without any of it being IO.
    const body = source.split('\n').filter((line) => !/^\s*(import|}\s*from)\b/.test(line)).join('\n')
    for (const forbidden of ['createClient', 'fetch(', '.from(', 'INSERT', 'UPDATE ', 'process.env', 'Deno.']) {
      assert.equal(body.includes(forbidden), false,
        `${relative} must not contain ${forbidden}: CP1/CP2 add no persistence and no IO`)
    }
  }
})

test('LOCK the only supabase-path dependency is the pure execution-claim contract', () => {
  const imports = G8_MODULES.flatMap((relative) =>
    read(relative).split('\n').filter((line) => line.includes('supabase/')).map((line) => [relative, line.trim()]))
  for (const [relative, line] of imports) {
    assert.ok(line.includes('_shared/executionClaim.js'),
      `${relative} imports a supabase path that is not the shared execution-claim contract: ${line}`)
  }
  // That contract is itself IO-free, which is why importing it is not IO.
  const contract = read('supabase/functions/_shared/executionClaim.js')
  for (const forbidden of ['createClient', 'fetch(', 'Deno.', 'import ']) {
    assert.equal(contract.includes(forbidden), false,
      `the execution-claim contract must stay pure; found ${forbidden}`)
  }
})

test('LOCK no G8 module re-implements authority evaluation', () => {
  // Deciding that a grant governs is G5's alone. A second evaluator is how the
  // two lanes end up with two different permissions from one grant.
  for (const relative of G8_MODULES) {
    const source = read(relative)
    assert.equal(/status\s*===\s*['"]GRANTED['"]/.test(source), false,
      `${relative} interprets a grant status: that belongs to G5`)
    assert.equal(source.includes('approvalRequirement'), false,
      `${relative} interprets a grant condition: that belongs to G5`)
  }
  // The one authority answer in the attention primitive comes from the G5
  // resolver by import, not from a local re-implementation.
  const attention = read('src/lib/dwIntelligence/dwAttentionPriority.js')
  assert.ok(attention.includes("import { resolveAskDwAuthority } from './askDwAuthorityRenderer.js'"))
})

// ── 2. Honest-accounting locks ───────────────────────────────────────────────

test('LOCK proactive grounding is not yet a live output boundary', () => {
  // CP2 reported this plainly and it must not silently stop being true. If a
  // real proactive runtime starts calling the guard, this lock fails and the
  // statement in the CP2/CP3 reports gets revisited — which is the point.
  const callers = sourceFiles().filter((relative) =>
    relative !== 'src/lib/dwIntelligence/dwProactiveGrounding.js' &&
    read(relative).includes('enforceDwProactiveGrounding'))
  assert.deepEqual(callers, [],
    `proactive grounding is now called from ${callers.join(', ')} — the "not wired" claim must be re-reviewed`)
})

test('LOCK no browser data layer consumes DW Intelligence read models', () => {
  const context = read('src/context/DataContext.jsx')
  assert.equal(context.includes('dwIntelligence'), false,
    'a browser data layer reading these models is a product change, not a CP3 test change')
})

test('LOCK the DW Intelligence library is the only consumer of the G8 seams', () => {
  const seams = [
    'admitDwInvestigationInput', 'buildDwGovernanceContext',
    'buildDwAttention', 'projectNeedsYouCommandReadModel',
  ]
  const outside = sourceFiles().filter((relative) => {
    if (relative.startsWith('src/lib/dwIntelligence/')) return false
    const source = read(relative)
    return seams.some((seam) => source.includes(seam))
  })
  assert.deepEqual(outside, [],
    `G8 seams are consumed outside the library from ${outside.join(', ')} — production wiring is not CP3's scope`)
})

test('LOCK the founder queue still grants nothing and executes nothing', () => {
  const models = read('src/lib/dwIntelligence/phase2bCommandModels.js')
  assert.ok(models.includes('directlyExecutable: false'))
  assert.ok(models.includes('browserMayGrantAuthority: false'))
  assert.ok(models.includes('executionAvailable: false'))
  assert.ok(models.includes('authorityCanBeGrantedHere: false'))
  assert.ok(models.includes('g5AuthorityResolved: false'),
    'the composition must keep stating that it resolved no G5 authority')
})

test('LOCK CP3 added tests only — no new migration and no new schema', () => {
  // G8 CP1-CP3 introduce no table, no column and no policy. A migration
  // appearing alongside these modules would mean the checkpoint quietly grew
  // a persistence surface.
  for (const relative of G8_MODULES) {
    const source = read(relative)
    assert.equal(/create\s+table|alter\s+table|duewatch_ops\./i.test(source), false,
      `${relative} contains schema DDL`)
  }
})
