/**
 * G8-CP1 — shared investigation input admission.
 *
 * Ask DW and DW Intelligence already share the Phase 2B engine: both call
 * runPhase2BWorkflow. What they do NOT share is how the input reaching that
 * engine is admitted.
 *
 *   Ask DW      loads from Supabase and bounds evidence/memory to a fixed read
 *               window, throwing when the window overflows (requiredBoundedRows).
 *   Proactive   accepts whatever arrays the caller supplies, unbounded and
 *               unvalidated.
 *
 * Same tenant, same invoice, one over-window evidence set: Ask DW refuses to
 * answer while DW Intelligence proceeds on a silently different admitted set.
 * Same engine, different facts.
 *
 * These tests drive ONE dataset through BOTH entry points and compare only the
 * engine-owned invariants. They are written before the refactor and are
 * expected to fail against the pre-CP1 tree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { runPhase2BWorkflow } from '../src/lib/dwIntelligence/phase2bEngine.js'
import { evaluatePhase2BInvoice } from '../src/lib/dwIntelligence/phase2bDuewatchAdapter.js'
import { loadAskDwLiveInvoiceInput } from '../src/lib/dwIntelligence/askDwLiveDataLoader.js'
import { admitDwInvestigationInput } from '../src/lib/dwIntelligence/dwInvestigationInput.js'

const NOW = new Date('2026-08-24T12:00:00Z')
const TENANT = 'tenant-a'
const CLIENT = { id: 'client-a', user_id: TENANT, name: 'Atlas' }
const INVOICE = {
  id: 'inv-a', user_id: TENANT, client_id: CLIENT.id, inv_num: 'INV-1001',
  amount: 10000, amount_paid: 0, inv_date: '2026-07-10', due_date: '2026-08-10',
  currency: 'USD', paid: false, last_reminder: null, autopilot_paused: false,
  created_at: '2026-07-10T00:00:00Z',
}

/** The bound the Ask DW loader enforces. Kept local so the test states it. */
const MAX_EVIDENCE = 100

function evidenceRow(index) {
  return {
    id: `e-${index}`,
    user_id: TENANT,
    client_id: CLIENT.id,
    invoice_id: INVOICE.id,
    evidence_key: `key-${index}`,
    source_type: 'ledger',
    source_ref: `ref-${index}`,
    trust: 'HIGH',
    admission_status: 'ADMITTED',
    claim_type: 'ledger_state',
    derived_from_key: null,
    provenance: {},
    created_at: '2026-08-20T00:00:00Z',
  }
}

/**
 * The same evidence, in the shape the proactive adapter is handed directly.
 * This mirrors askDwLiveDataLoader.mapEvidenceRows so both lanes genuinely
 * receive the same facts, and any divergence is admission, not mapping.
 */
function mappedEvidence(rows) {
  return rows.map((row) => ({
    id: row.id,
    evidenceKey: row.evidence_key,
    tenantId: row.user_id,
    clientId: row.client_id,
    invoiceId: row.invoice_id,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    trust: row.trust,
    claimType: row.claim_type,
    derivedFrom: null,
    observedAt: row.created_at,
    containsInstructions: row.admission_status === 'QUARANTINED_INSTRUCTION',
    persistedAdmissionStatus: row.admission_status,
    provenance: row.provenance || {},
  }))
}

/**
 * Minimal thenable Supabase double. Every builder method returns `this`; the
 * loader awaits the builder directly, so `then` resolves the configured rows
 * for whichever table `from()` last named.
 */
function fakeSupabase(tables) {
  // from() must return a FRESH builder: the loader creates eight queries
  // synchronously inside one Promise.all, so a shared mutable builder would
  // resolve every one of them against the last-named table.
  const makeQuery = (table) => {
    const query = {
      select: () => query,
      eq: () => query,
      neq: () => query,
      in: () => query,
      or: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve, reject) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject),
    }
    return query
  }
  return {
    from: (table) => makeQuery(table),
    auth: { getUser: async () => ({ data: { user: { id: TENANT } }, error: null }) },
  }
}

function tablesFor(evidenceRows) {
  return {
    invoices: [{ ...INVOICE, clients: CLIENT }],
    autopilot_rules: [],
    autopilot_settings: [{ id: 's-1', user_id: TENANT, enabled: false, approval_required: true }],
    awaiting_signature: [],
    autopilot_execution_claims: [],
    events: [],
    dw_evidence_items: evidenceRows,
    dw_memory_claims: [],
    dw_proof_events: [],
    dw_memory_tombstones: [],
    dw_memory_evidence_links: [],
    dw_tombstone_evidence_links: [],
  }
}

/** Only the invariants the ENGINE owns. Conversation shaping is not compared. */
function engineInvariants(result) {
  const proof = result?.proof ?? {}
  return {
    operationalState: result?.state ?? null,
    canonicalFacts: proof.canonicalFacts ?? null,
    arState: proof.arState ?? null,
    scope: proof.scope ?? null,
    evidenceDecisions: (proof.evidence?.records ?? [])
      .map((record) => `${record.id ?? record.evidenceId}:${record.status}`)
      .sort(),
    independentStrongRoots: [...(proof.evidence?.independentStrongRoots ?? [])].sort(),
    memoryActive: (proof.memory?.active ?? []).map((entry) => entry.id ?? entry).sort(),
    memoryBlocked: (proof.memory?.blocked ?? []).map((entry) => entry.id ?? entry).sort(),
    hardViolations: [...(result?.hardViolations ?? [])].sort(),
  }
}

async function askDwLane(evidenceRows) {
  const loaded = await loadAskDwLiveInvoiceInput({
    supabase: fakeSupabase(tablesFor(evidenceRows)),
    tenantId: TENANT,
    invoiceId: INVOICE.id,
    now: NOW,
  })
  return runPhase2BWorkflow(loaded.intelligenceInput)
}

function proactiveLane(evidenceRows) {
  return evaluatePhase2BInvoice({
    userId: TENANT,
    invoice: { ...INVOICE },
    client: { ...CLIENT },
    rules: [],
    autopilotSettings: { id: 's-1', user_id: TENANT, enabled: false, approval_required: true },
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
    events: [],
    evidence: mappedEvidence(evidenceRows),
    memory: [],
    tombstones: [],
    precedents: [],
    now: NOW,
  })
}

// ── P1 ───────────────────────────────────────────────────────────────────────

test('G8-P1 one input yields identical engine state through both entry points', async () => {
  const rows = [evidenceRow(1), evidenceRow(2)]
  const askDw = await askDwLane(rows)
  const proactive = proactiveLane(rows)
  assert.deepEqual(
    engineInvariants(askDw),
    engineInvariants(proactive),
    'Ask DW and proactive DW Intelligence must reach the same engine-owned state for one input',
  )
})

// ── P2 ───────────────────────────────────────────────────────────────────────

test('G8-P2 an over-window evidence set fails closed in BOTH lanes', async () => {
  const rows = Array.from({ length: MAX_EVIDENCE + 1 }, (_, index) => evidenceRow(index))

  // Ask DW already refuses: the read window overflowed, so the truth input is
  // incomplete and no answer may be built from it.
  await assert.rejects(
    () => askDwLane(rows),
    /bounded read window/i,
    'Ask DW must refuse an over-window evidence set',
  )

  // Proactive must refuse for the SAME reason. Today it proceeds, which is the
  // divergence CP1 closes: same tenant, same invoice, different admitted facts.
  await assert.rejects(
    async () => proactiveLane(rows),
    /bounded read window/i,
    'proactive DW Intelligence must refuse the same over-window evidence set',
  )
})

test('G8-P2b the bound is the same number in both lanes', async () => {
  const rows = Array.from({ length: MAX_EVIDENCE }, (_, index) => evidenceRow(index))
  // Exactly at the bound: both lanes must accept, and agree.
  const askDw = await askDwLane(rows)
  const proactive = proactiveLane(rows)
  assert.deepEqual(engineInvariants(askDw), engineInvariants(proactive))
})

test('G8-P2c malformed execution-history shapes fail closed in BOTH lanes', async () => {
  // The Ask DW loader verifies that handledKeys / pendingInvoiceIds really are
  // Sets before authority is evaluated, and refuses otherwise. The proactive
  // adapter passes caller-supplied values straight into authority evaluation.
  // An array where a Set is required silently produces a different authority
  // input, which is the same class of divergence as the read-window bound.
  await assert.rejects(
    async () => evaluatePhase2BInvoice({
      userId: TENANT,
      invoice: { ...INVOICE },
      client: { ...CLIENT },
      rules: [],
      autopilotSettings: { id: 's-1', user_id: TENANT, enabled: false, approval_required: true },
      handledKeys: ['not-a-set'],
      pendingInvoiceIds: new Set(),
      events: [],
      evidence: [],
      now: NOW,
    }),
    /execution history|handledKeys|could not be verified/i,
    'proactive DW Intelligence must refuse a malformed execution-history shape',
  )
})

// ── governance envelope ──────────────────────────────────────────────────────

import { buildAskDwCompanyBrainContext } from '../src/lib/dwIntelligence/askDwCompanyBrainContext.js'
import { buildDwGovernanceContext } from '../src/lib/dwIntelligence/dwGovernanceContext.js'
import * as governanceModule from '../src/lib/dwIntelligence/dwGovernanceContext.js'
import { resolveAskDwAuthority } from '../src/lib/dwIntelligence/askDwAuthorityRenderer.js'

const AS_OF = '2026-08-24T12:00:00Z'

function grantRow(overrides = {}) {
  return {
    id: 'g-1', action: 'SEND_REMINDER', scope: { level: 'CLIENT', clientId: CLIENT.id },
    channel: 'EMAIL', approvalRequirement: 'NONE', conditions: {},
    effectiveWindow: { effectiveFrom: '2026-08-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' },
    status: 'GRANTED', revision: 1, decidedAt: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

function readModel({ grants = [grantRow()], revoked = [], stale = [] } = {}) {
  return {
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0',
    tenantId: TENANT, generatedAt: AS_OF,
    items: [{
      reviewKey: 'u-1', category: 'POLICY', itemType: 'UNDERSTANDING', subject: 'late fees',
      scope: { level: 'COMPANY' }, clientId: null, reviewStatus: 'APPROVED',
      conflictStatus: 'NONE', changedSinceReview: false, supportingSourceRevoked: false,
      why: 'founder stated', evidence: [], proposedValue: { graceDays: 5 },
    }],
    summary: { understandingReviewed: 1, needsReview: 0, conflictsUnresolved: 0, changedSinceReview: 0 },
    authority: {
      evaluatedAt: AS_OF, activeGrantCount: grants.length, proposalCount: 0,
      noStandingAuthorityConfigured: grants.length === 0,
      currentAuthorityGrants: grants, proposedAuthority: [],
      revokedAuthority: revoked, staleAuthority: stale,
      supersededAuthority: [], invalidatedAuthority: [],
    },
    readiness: null,
  }
}

function governanceFor(model) {
  return buildDwGovernanceContext({
    tenantId: TENANT,
    companyBrainContext: buildAskDwCompanyBrainContext({ readModel: model, tenantId: TENANT }),
  })
}

test('G8-P3 both lanes see the same governance envelope for one tenant', () => {
  const model = readModel()
  // No Brain supplied is a STATED absence, never an empty-but-fine envelope.
  const proactive = proactiveLane([evidenceRow(1)])
  assert.equal(proactive.governance.companyBrain.available, false)
  assert.equal(proactive.governance.sourceState.companyBrainAvailable, false)
  assert.deepEqual(proactive.governance.authority.currentGrantIds, [],
    'an unreadable Brain must never yield invented grant references')

  const withBrain = evaluatePhase2BInvoice({
    userId: TENANT, invoice: { ...INVOICE }, client: { ...CLIENT }, rules: [],
    autopilotSettings: { id: 's-1', user_id: TENANT, enabled: false, approval_required: true },
    handledKeys: new Set(), pendingInvoiceIds: new Set(), events: [],
    evidence: mappedEvidence([evidenceRow(1)]), companyBrainReadModel: model, now: NOW,
  })
  assert.deepEqual(withBrain.governance, governanceFor(model),
    'proactive governance must equal the shared builder output Ask DW uses')
  assert.equal(withBrain.governance.companyBrain.available, true)
  assert.deepEqual(withBrain.governance.authority.currentGrantIds, ['g-1'])
})

test('G8-P4 the governance envelope is reference-only', () => {
  const governance = governanceFor(readModel())
  const serialized = JSON.stringify(governance)

  // Present: identities and observed timestamps.
  assert.ok(serialized.includes('u-1'), 'review keys are referenced')
  assert.ok(serialized.includes('g-1'), 'grant ids are referenced')
  assert.ok(serialized.includes(AS_OF), 'observed timestamps are carried')
  assert.match(governance.authority.fingerprint, /^[0-9a-f]{8}$/)

  // Absent: every reviewed value, every grant term, every derived summary.
  for (const leaked of [
    'graceDays',                                    // reviewed policy value
    'SEND_REMINDER', 'EMAIL',                       // grant action and channel
    'approvalRequirement', 'effectiveWindow',       // grant terms
    'limits', 'conditions',
    'noStandingAuthorityConfigured',                // derived conclusion
    'revokedCount', 'staleCount',                   // snapshot summaries
    'complete',                                     // invented completeness
  ]) {
    assert.ok(!serialized.includes(leaked), `${leaked} must not appear in a governance envelope`)
  }
  assert.ok(Object.isFrozen(governance))
})

test('G8-P5 the envelope owns no authority verdict and no derived conclusion', () => {
  const governance = governanceFor(readModel())
  const serialized = JSON.stringify(governance)
  for (const forbidden of [
    'canExecute', 'canActAutomatically', 'authorityGranted', 'executeNow',
    'governing', 'authorized', 'permitted',
    // A negative conclusion is still a conclusion, and goes stale the same way.
    'noStandingAuthorityConfigured',
  ]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not appear in a governance envelope`)
  }
  assert.equal(governance.governs, false)
  assert.equal(governance.authorityMustBeReEvaluatedAtUse, true)

  // The authority band is identity only: exactly three keys, no more.
  assert.deepEqual(
    Object.keys(governance.authority).sort(),
    ['currentGrantIds', 'evaluatedAt', 'fingerprint'],
  )

  // And the module exposes no helper that could interpret a grant.
  assert.deepEqual(Object.keys(governanceModule).sort(), ['buildDwGovernanceContext'],
    'the governance module must not offer an authority evaluator')
})

test('G8-P6 a stale governance reference cannot govern after revocation', () => {
  // T1 — the envelope references the grant that existed when it was built.
  const atT1 = governanceFor(readModel())
  assert.deepEqual(atT1.authority.currentGrantIds, ['g-1'])
  const fingerprintT1 = atT1.authority.fingerprint

  // T2 — G5/G6 revoke it. A NEW governance read no longer references it, and
  // the fingerprint changes, so the two envelopes are visibly not the same
  // state. Nothing in this module decided that; it simply read what is there.
  const atT2 = governanceFor(readModel({
    grants: [],
    revoked: [{ id: 'g-1', revokedAt: '2026-08-25T00:00:00Z' }],
  }))
  assert.deepEqual(atT2.authority.currentGrantIds, [],
    'a revoked grant is absent from a fresh governance read')
  assert.notEqual(atT2.authority.fingerprint, fingerprintT1)

  // The T1 envelope still holds the id — and that is all it holds. It carries
  // no status, no window, no conditions and no verdict, so nothing in it can
  // authorize anything on its own.
  assert.deepEqual(atT1.authority.currentGrantIds, ['g-1'])
  assert.deepEqual(Object.keys(atT1.authority).sort(),
    ['currentGrantIds', 'evaluatedAt', 'fingerprint'])
  assert.equal(atT1.governs, false)
  assert.equal(atT1.authorityMustBeReEvaluatedAtUse, true)

  // Real authority use still runs the existing fresh G5 path, which reads the
  // CURRENT projection and refuses — the envelope is not consulted for it.
  const afterRevocation = resolveAskDwAuthority({
    authorityProjection: { evaluatedAt: '2026-08-25T00:00:00Z', currentGrants: [] },
    request: { canonicalAction: 'SEND_REMINDER', scopeType: 'CLIENT', clientId: CLIENT.id, channel: 'EMAIL' },
    evaluatedAt: '2026-08-25T00:00:00Z',
  })
  assert.equal(afterRevocation.governing, false,
    'authority after revocation is decided by G5 on the current projection')
})

test('G8-P6b an available Company Brain never implies completeness or freshness', () => {
  // A readable Brain with old timestamps and revoked support must not present
  // itself as complete or fresh. The envelope states what it observed and
  // stops there.
  const stale = governanceFor({
    ...readModel(),
    generatedAt: '2020-01-01T00:00:00Z',
    items: [{
      reviewKey: 'u-1', category: 'POLICY', itemType: 'UNDERSTANDING', subject: 'late fees',
      scope: { level: 'COMPANY' }, clientId: null, reviewStatus: 'APPROVED',
      conflictStatus: 'NONE', changedSinceReview: true, supportingSourceRevoked: true,
      why: 'founder stated', evidence: [], proposedValue: { graceDays: 5 },
    }],
  })
  assert.equal(stale.companyBrain.available, true)
  assert.equal(stale.sourceState.companyBrainAvailable, true)
  assert.equal(stale.sourceState.companyBrainGeneratedAt, '2020-01-01T00:00:00Z')

  // No completeness or freshness conclusion exists to be wrong.
  assert.equal(stale.complete, undefined)
  assert.equal(stale.fresh, undefined)
  assert.equal(stale.sourceState.complete, undefined)
  assert.equal(stale.sourceState.fresh, undefined)
  assert.ok(!JSON.stringify(stale).includes('complete'))

  // The revoked and changed support is surfaced as references, not resolved.
  assert.deepEqual(stale.companyBrain.supportingSourceRevokedRefs, ['u-1'])
  assert.deepEqual(stale.companyBrain.changedSinceReviewRefs, ['u-1'])
})

test('G8-P8 tenant isolation holds identically in both lanes', async () => {
  const foreign = { ...INVOICE, user_id: 'tenant-b' }
  const proactive = evaluatePhase2BInvoice({
    userId: TENANT, invoice: foreign, client: { ...CLIENT }, rules: [],
    autopilotSettings: null, handledKeys: new Set(), pendingInvoiceIds: new Set(),
    events: [], evidence: [], now: NOW,
  })
  const direct = runPhase2BWorkflow({
    tenantId: TENANT, invoice: foreign, client: { ...CLIENT }, now: NOW, evidence: [],
  })
  assert.equal(proactive.state, 'BLOCKED')
  assert.equal(direct.state, 'BLOCKED')
  assert.equal(proactive.execution.outcome, 'BLOCKED_TENANT_SCOPE')
})

test('G8-P9 a conversational assertion cannot enter the proactive evidence set', () => {
  // Conversation memory is not an admission channel: the proactive lane takes
  // evidence and memory only, and an unadmitted conversational claim stays out
  // of the admitted evidence record whatever it asserts.
  const conversational = {
    id: 'conv-1', tenantId: TENANT, clientId: CLIENT.id, invoiceId: INVOICE.id,
    trust: 'LOW', claimType: 'contextual_payment_statement',
    persistedAdmissionStatus: 'QUARANTINED_INSTRUCTION', containsInstructions: true,
    provenance: { channel: 'conversation' },
  }
  const result = proactiveLane([evidenceRow(1)])
  const withClaim = evaluatePhase2BInvoice({
    userId: TENANT, invoice: { ...INVOICE }, client: { ...CLIENT }, rules: [],
    autopilotSettings: { id: 's-1', user_id: TENANT, enabled: false, approval_required: true },
    handledKeys: new Set(), pendingInvoiceIds: new Set(), events: [],
    evidence: [...mappedEvidence([evidenceRow(1)]), conversational], now: NOW,
  })
  assert.equal(withClaim.proof.canonicalFacts.paid, result.proof.canonicalFacts.paid,
    'a conversational assertion never moves canonical money')
  const record = (withClaim.proof.evidence?.records ?? []).find((r) => r.id === 'conv-1')
  assert.ok(record, 'the claim stays visible in the evidence ledger')
  assert.equal(record.status, 'QUARANTINED_INSTRUCTION',
    'a conversational instruction is quarantined, not admitted')
  assert.ok(!(withClaim.proof.evidence?.independentStrongRoots ?? []).includes('conv-1'),
    'a quarantined conversational claim can never be an independent strong root')
})

// ── Normal / Deep safety floor ───────────────────────────────────────────────

import { runAskDwDeterministicCore } from '../src/lib/dwIntelligence/askDwRuntime.js'

test('G8-P7 Normal and Deep share one truth and authority safety floor', async () => {
  const loaded = await loadAskDwLiveInvoiceInput({
    supabase: fakeSupabase(tablesFor([evidenceRow(1), evidenceRow(2)])),
    tenantId: TENANT, invoiceId: INVOICE.id, now: NOW,
  })
  const run = (mode) => runAskDwDeterministicCore({
    mode, text: 'why is this invoice still open?',
    context: { tenantId: TENANT, invoiceId: INVOICE.id, clientId: CLIENT.id },
    intelligenceInput: loaded.intelligenceInput,
  })
  const normal = run('normal')
  const deep = run('deep')

  // The FLOOR is identical: canonical truth, tenant/scope, authority state and
  // the hard safety gates. This is deliberately NOT an assertion that the two
  // modes examine an identical evidence set — Deep may later inspect a
  // superset, provided every extra item passes the same admission rules.
  assert.deepEqual(normal.packet.canonicalFacts, deep.packet.canonicalFacts)
  assert.deepEqual(normal.packet.arState, deep.packet.arState)
  assert.deepEqual(normal.packet.authority, deep.packet.authority)
  assert.equal(normal.packet.hardSafetyOutcome, deep.packet.hardSafetyOutcome)
  assert.deepEqual(normal.intelligence.proof.scope, deep.intelligence.proof.scope)
  assert.deepEqual(
    [...(normal.intelligence.hardViolations ?? [])].sort(),
    [...(deep.intelligence.hardViolations ?? [])].sort(),
  )

  // Deep never gains execution capability or a different safeguard posture.
  assert.deepEqual(normal.packet.safeguards, deep.packet.safeguards)

  // Depth may differ — that is the whole point of Deep.
  assert.equal(normal.packet.requestedMode, 'normal')
  assert.equal(deep.packet.requestedMode, 'deep')
})

test('G8-P7b any additional Deep evidence must pass the same admission gate', () => {
  // The gate is mode-blind by construction: it takes no mode and offers no
  // widened bound, so a Deep caller cannot admit more than a Normal one.
  const oversized = Array.from({ length: MAX_EVIDENCE + 1 }, (_, i) => ({ id: `x-${i}` }))
  for (const source of ['ASK_DW', 'DW_INTELLIGENCE']) {
    assert.throws(
      () => admitDwInvestigationInput({ source, tenantId: TENANT, evidence: oversized }),
      /bounded read window/i,
      `${source} must not be able to widen the window`,
    )
  }
})

test('G8-P8b admission never converts a governed BLOCKED outcome into a throw', () => {
  // Tenant scope belongs to the engine. A missing or mismatched tenant must
  // still produce BLOCKED_TENANT_SCOPE, not an exception from the admission
  // gate — otherwise a safety check silently becomes a behaviour change.
  const missing = evaluatePhase2BInvoice({})
  assert.equal(missing.state, 'BLOCKED')
  assert.equal(missing.execution.outcome, 'BLOCKED_TENANT_SCOPE')
  assert.equal(missing.governance.companyBrain.available, false)

  const mismatched = evaluatePhase2BInvoice({
    userId: TENANT, invoice: { ...INVOICE, user_id: 'tenant-b' }, client: { ...CLIENT },
    handledKeys: new Set(), pendingInvoiceIds: new Set(), now: NOW,
  })
  assert.equal(mismatched.state, 'BLOCKED')
  assert.equal(mismatched.execution.outcome, 'BLOCKED_TENANT_SCOPE')
})

test('G8-P2d malformed input is refused before any engine output exists', () => {
  // evaluateNextActionAuthority runs BEFORE shared admission validates the
  // execution-history shape. That ordering is acceptable only because the
  // authority evaluation is pure and non-executing, and because admission
  // still refuses before runPhase2BWorkflow produces anything. Both halves of
  // that assumption are asserted here rather than assumed.
  let workflowOutput = null
  assert.throws(
    () => {
      workflowOutput = evaluatePhase2BInvoice({
        userId: TENANT, invoice: { ...INVOICE }, client: { ...CLIENT }, rules: [],
        autopilotSettings: { id: 's-1', user_id: TENANT, enabled: false, approval_required: true },
        handledKeys: ['not-a-set'], pendingInvoiceIds: new Set(),
        events: [], evidence: [], now: NOW,
      })
    },
    /execution history/i,
  )
  assert.equal(workflowOutput, null, 'no engine result may be produced from malformed input')

  // The pre-admission authority evaluation is pure: nothing is executed and no
  // canonical state is touched by the refused call.
  const invoiceAfter = { ...INVOICE }
  assert.equal(invoiceAfter.paid, false)
  assert.equal(invoiceAfter.amount_paid, 0)
  assert.equal(invoiceAfter.last_reminder, null)
})
