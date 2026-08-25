import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPhase2BWriteContract,
  mapEvidenceInsert,
  mapProofEventInsert,
  mapRunFinalize,
  mapRunInsert,
} from '../supabase/functions/_shared/dwIntelligencePhase2bPersistenceMapper.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const sql = fs.readFileSync(path.join(repoRoot, 'supabase', 'migrations', '20260824234500_dw_intelligence_phase2b_proof.sql'), 'utf8')

function columnsFor(table) {
  const re = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`, 'i')
  const body = re.exec(sql)?.[1]
  if (!body) throw new Error(`table not found: ${table}`)
  return new Set(body.split('\n').map((line) => line.trim()).filter((line) => /^[a-z_][a-z0-9_]*\s/i.test(line)).map((line) => line.split(/\s+/)[0]).filter((c) => !['constraint','unique','primary','foreign','check'].includes(c)))
}

function expectKeysExist(table, row) {
  const cols = columnsFor(table)
  for (const key of Object.keys(row)) assert.ok(cols.has(key), `${table}.${key} must exist in migration`)
}

test('run insert maps exactly to declared Phase 2B run columns', () => {
  const row = mapRunInsert({ userId:'u1', clientId:'c1', invoiceId:'i1', engineVersion:'v1', transport:'sandbox', productionExecutionAuthorized:false, inputFingerprint:null })
  expectKeysExist('dw_intelligence_runs', row)
  assert.equal(row.production_execution_authorized, false)
  assert.equal(row.transport, 'sandbox')
})

test('mapper is incapable of elevating caller-requested production transport/authority', () => {
  const row = mapRunInsert({ userId:'u1', clientId:'c1', invoiceId:'i1', engineVersion:'v1', transport:'production', productionExecutionAuthorized:true })
  assert.equal(row.transport, 'sandbox')
  assert.equal(row.production_execution_authorized, false)
  assert.equal(assertPhase2BWriteContract({ runInsert: row, proofEvent: mapProofEventInsert({ userId:'u1', runId:'r1', clientId:'c1', invoiceId:'i1', eventType:'x' }) }), true)
})

test('evidence insert maps exact provenance/admission columns', () => {
  const row = mapEvidenceInsert({
    userId:'u1', runId:'r1', clientId:'c1', invoiceId:'i1', evidenceKey:'e1', sourceType:'email', sourceRef:'msg-1',
    trust:'MEDIUM', admissionStatus:'CONTEXT_ONLY', admissionReason:'low_trust_context_only', claimType:'payment_claim',
    derivedFromKey:null, contentDigest:null, provenance:{provider:'fixture'},
  })
  expectKeysExist('dw_evidence_items', row)
  assert.equal(row.claim_type, 'payment_claim')
  assert.equal(row.evidence_key, 'e1')
  assert.equal(row.derived_from_key, null)
})

test('proof insert always emits real_side_effect false regardless of caller input', () => {
  const row = mapProofEventInsert({ userId:'u1', runId:'r1', clientId:'c1', invoiceId:'i1', sequenceNo:0, eventType:'phase2b_workflow_evaluated', operationalState:'HANDLED', proof:{}, realSideEffect:true })
  expectKeysExist('dw_proof_events', row)
  assert.equal(row.real_side_effect, false)
})

test('run finalize maps only completed/failed states', () => {
  const completed = mapRunFinalize({ status:'completed', summary:{ok:true}, completedAt:'2026-08-24T20:00:00.000Z' })
  expectKeysExist('dw_intelligence_runs', completed)
  assert.equal(completed.status, 'completed')
  assert.throws(() => mapRunFinalize({ status:'running' }), /unsupported final status/)
})

test('write contract rejects cross-tenant evidence or proof rows', () => {
  const run = mapRunInsert({ userId:'u1', clientId:'c1', invoiceId:'i1', engineVersion:'v1', transport:'sandbox', productionExecutionAuthorized:false })
  const proof = mapProofEventInsert({ userId:'u1', runId:'r1', clientId:'c1', invoiceId:'i1', eventType:'x' })
  const ev = mapEvidenceInsert({ userId:'u2', runId:'r1', clientId:'c1', invoiceId:'i1', evidenceKey:'e1', sourceType:'email', trust:'HIGH', admissionStatus:'ADMITTED' })
  assert.throws(() => assertPhase2BWriteContract({ runInsert:run, evidenceRows:[ev], proofEvent:proof }), /evidence tenant/)
})


test('rejected evidence is structurally redacted by the mapper', () => {
  const row = mapEvidenceInsert({
    userId:'u1', runId:'r1', clientId:'c1', invoiceId:'i1', evidenceKey:'redacted_0',
    sourceType:'redacted_rejected', sourceRef:'foreign-secret', trust:'HIGH',
    admissionStatus:'REJECTED_TENANT', claimType:'payment_claim', derivedFromKey:'foreign-parent',
    contentDigest:'a'.repeat(64), provenance:{redacted:true},
  })
  assert.equal(row.trust, null)
  assert.equal(row.source_ref, null)
  assert.equal(row.claim_type, null)
  assert.equal(row.derived_from_key, null)
  assert.equal(row.content_digest, null)
})

test('write contract rejects same-tenant object-scope drift between run and evidence/proof', () => {
  const run = mapRunInsert({ userId:'u1', clientId:'c1', invoiceId:'i1', engineVersion:'v1' })
  const proof = mapProofEventInsert({ userId:'u1', runId:'r1', clientId:'c2', invoiceId:'i2', eventType:'x' })
  assert.throws(() => assertPhase2BWriteContract({ runInsert:run, proofEvent:proof }), /proof object scope/)
})

test('valid sandbox write bundle passes the pure write contract', () => {
  const run = mapRunInsert({ userId:'u1', clientId:'c1', invoiceId:'i1', engineVersion:'v1', transport:'sandbox', productionExecutionAuthorized:false })
  const proof = mapProofEventInsert({ userId:'u1', runId:'r1', clientId:'c1', invoiceId:'i1', eventType:'x' })
  const ev = mapEvidenceInsert({ userId:'u1', runId:'r1', clientId:'c1', invoiceId:'i1', evidenceKey:'e1', sourceType:'invoice', trust:'HIGH', admissionStatus:'ADMITTED' })
  const final = mapRunFinalize({ status:'completed', completedAt:'2026-08-24T20:00:00.000Z' })
  assert.equal(assertPhase2BWriteContract({ runInsert:run, evidenceRows:[ev], proofEvent:proof, runFinalize:final }), true)
})
