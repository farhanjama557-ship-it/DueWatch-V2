import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPhase2BPersistenceIo,
} from '../supabase/functions/_shared/dwIntelligencePhase2bPersistenceIo.js'
import {
  runPhase2BServerProof,
} from '../supabase/functions/_shared/dwIntelligencePhase2bServerCore.js'

function makeDb({ failTable = null } = {}) {
  const tables = new Map()
  const calls = []
  const get = (name) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)
  }
  return {
    tables, calls,
    async insertOne(table, row) {
      calls.push(['insertOne', table, structuredClone(row)])
      if (failTable === table) throw new Error(`failed ${table}`)
      const stored = { id: table === 'dw_intelligence_runs' ? 'run-1' : `${table}-${get(table).length + 1}`, ...structuredClone(row) }
      get(table).push(stored)
      return stored
    },
    async insertMany(table, rows) {
      calls.push(['insertMany', table, structuredClone(rows)])
      if (failTable === table) throw new Error(`failed ${table}`)
      for (const row of rows) get(table).push({ id: `${table}-${get(table).length + 1}`, ...structuredClone(row) })
      return rows
    },
    async updateOne(table, match, update) {
      calls.push(['updateOne', table, structuredClone(match), structuredClone(update)])
      if (failTable === `${table}:update`) throw new Error(`failed ${table} update`)
      const row = get(table).find((r) => Object.entries(match).every(([k,v]) => r[k] === v))
      if (!row) throw new Error(`row not found in ${table}`)
      Object.assign(row, structuredClone(update))
      return row
    },
  }
}

function caseInputs({ approval = false, paymentClaim = false } = {}) {
  const userId = 'tenant-a'
  const client = { id:'client-a', user_id:userId, name:'Atlas', email:'ap@atlas.test' }
  const invoice = { id:'invoice-a', user_id:userId, client_id:client.id, clients:client, inv_num:'INV-1', amount:5000, amount_paid:0, due_date:'2026-08-01', paid:false, autopilot_paused:false }
  const evidence = [
    { id:'e1', tenantId:userId, clientId:client.id, invoiceId:invoice.id, sourceType:'invoice', sourceRef:'invoice-a', trust:'HIGH', claimType:'invoice_state', provenance:{kind:'canonical_invoice'} },
  ]
  if (paymentClaim) evidence.push({ id:'e2', tenantId:userId, clientId:client.id, invoiceId:invoice.id, sourceType:'email', sourceRef:'msg-1', trust:'MEDIUM', claimType:'payment_claim', provenance:{kind:'client_email'} })
  return {
    invoice, client,
    rules:[{id:'rule-1',user_id:userId,name:'Friendly',trigger_type:'after_due',trigger_days:1,tone:'friendly',enabled:true,sort_order:1}],
    autopilotSettings:{user_id:userId,enabled:true,approval_required:approval},
    handledKeys:new Set(), pendingInvoiceIds:new Set(), events:[], evidence,
    memory:[], tombstones:[], precedents:[], preferenceEvents:[],
  }
}

function authority({ auto = true } = {}) {
  return ({ rules }) => ({
    facts:{},
    recommendation:{action:'send_reminder',tone:'friendly',ruleId:rules[0].id,ruleName:rules[0].name},
    authority:{authorized:true,basis:{ruleId:rules[0].id},evaluatedAt:'2026-08-24T20:00:00.000Z',blockedReason:null},
    permission:{requiresApproval:!auto,canActAutomatically:auto},
  })
}

test('end-to-end local persistence writes DB-shaped sandbox run/evidence/proof rows', async () => {
  const db = makeDb()
  const io = createPhase2BPersistenceIo({ db, caseLoader: async () => caseInputs() })
  const out = await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', engineVersion:'p2b-test', evaluateAuthority:authority(), io })
  assert.equal(out.result.state, 'HANDLED')
  const run = db.tables.get('dw_intelligence_runs')[0]
  assert.equal(run.user_id, 'tenant-a')
  assert.equal(run.client_id, 'client-a')
  assert.equal(run.invoice_id, 'invoice-a')
  assert.equal(run.transport, 'sandbox')
  assert.equal(run.production_execution_authorized, false)
  assert.equal(run.status, 'completed')
  const evidence = db.tables.get('dw_evidence_items')[0]
  assert.equal(evidence.invoice_id, 'invoice-a')
  assert.equal(evidence.admission_status, 'ADMITTED')
  const proof = db.tables.get('dw_proof_events')[0]
  assert.equal(proof.operational_state, 'HANDLED')
  assert.equal(proof.real_side_effect, false)
})

test('approval path persists proof state but no reminder/send table exists in adapter', async () => {
  const db = makeDb()
  const io = createPhase2BPersistenceIo({ db, caseLoader: async () => caseInputs({approval:true}) })
  const out = await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', evaluateAuthority:authority({auto:false}), io })
  assert.equal(out.result.state, 'APPROVAL')
  assert.equal(out.result.execution.sideEffect, false)
  assert.equal(db.tables.has('reminders'), false)
  assert.equal(db.tables.has('awaiting_signature'), false)
})

test('payment claim persists INVESTIGATING proof without canonical-money tables', async () => {
  const db = makeDb()
  const io = createPhase2BPersistenceIo({ db, caseLoader: async () => caseInputs({paymentClaim:true}) })
  const out = await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', evaluateAuthority:authority(), io })
  assert.equal(out.result.state, 'INVESTIGATING')
  assert.equal(db.tables.has('payments'), false)
  assert.equal(db.tables.has('invoices'), false)
  assert.equal(db.tables.get('dw_proof_events')[0].proof.canonicalFacts.canonicalStatus, 'OPEN')
})

test('cross-tenant case loader result creates zero database rows', async () => {
  const db = makeDb()
  const bad = caseInputs()
  bad.client = {...bad.client,user_id:'tenant-b'}
  const io = createPhase2BPersistenceIo({ db, caseLoader: async () => bad })
  const out = await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', evaluateAuthority:authority(), io })
  assert.equal(out.outcome, 'blocked_scope')
  assert.equal(db.calls.length, 0)
})

test('proof persistence failure leaves run visibly failed', async () => {
  const db = makeDb({failTable:'dw_proof_events'})
  const io = createPhase2BPersistenceIo({ db, caseLoader: async () => caseInputs() })
  const out = await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', evaluateAuthority:authority(), io })
  assert.equal(out.outcome, 'persistence_failed')
  const run = db.tables.get('dw_intelligence_runs')[0]
  assert.equal(run.status, 'failed')
  assert.match(run.summary.persistence_error, /failed dw_proof_events/)
})

test('persistence adapter source contains no network/provider client', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here,'..','supabase','functions','_shared','dwIntelligencePhase2bPersistenceIo.js'),'utf8')
  const executable = src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1')
  assert.doesNotMatch(executable,/createClient|supabase-js|sendEmail|resend|fetch\s*\(|https?:\/\//i)
})

test('source evidence lineage persists with run-scoped text keys rather than assuming UUID source ids', async () => {
  const db = makeDb()
  const raw = caseInputs()
  raw.evidence.push({
    id:'email-thread-reply-7', tenantId:'tenant-a', clientId:'client-a', invoiceId:'invoice-a',
    sourceType:'email', sourceRef:'message-7', trust:'MEDIUM', claimType:'communication',
    derivedFrom:'e1', provenance:{kind:'reply'},
  })
  const io = createPhase2BPersistenceIo({ db, caseLoader: async () => raw })
  await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', evaluateAuthority:authority(), io })
  const rows = db.tables.get('dw_evidence_items')
  const root = rows.find((r) => r.evidence_key === 'e1')
  const child = rows.find((r) => r.evidence_key === 'email-thread-reply-7')
  assert.ok(root)
  assert.ok(child)
  assert.equal(child.derived_from_key, 'e1')
})

test('foreign rejected evidence persists only as redacted audit metadata', async () => {
  const db = makeDb()
  const raw = caseInputs()
  raw.evidence.push({
    id:'foreign-secret-id', tenantId:'tenant-b', clientId:'client-a', invoiceId:'invoice-a',
    sourceType:'email', sourceRef:'foreign-message-secret', trust:'HIGH', claimType:'payment_claim',
    contentDigest:'a'.repeat(64), provenance:{secret:'must-not-cross'},
  })
  const io = createPhase2BPersistenceIo({ db, caseLoader: async () => raw })
  await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', evaluateAuthority:authority(), io })
  const rejected = db.tables.get('dw_evidence_items').find((r) => r.admission_status === 'REJECTED_TENANT')
  assert.ok(rejected)
  assert.match(rejected.evidence_key, /^redacted_\d+$/)
  assert.equal(rejected.source_type, 'redacted_rejected')
  assert.equal(rejected.source_ref, null)
  assert.equal(rejected.trust, null)
  assert.equal(rejected.claim_type, null)
  assert.equal(rejected.content_digest, null)
  assert.deepEqual(rejected.provenance, { redacted:true, admission_reason:'tenant_mismatch' })
  assert.doesNotMatch(JSON.stringify(rejected), /foreign-secret-id|foreign-message-secret|must-not-cross/)
  const proof = db.tables.get('dw_proof_events')[0]
  assert.doesNotMatch(JSON.stringify(proof.proof), /foreign-secret-id|foreign-message-secret|must-not-cross/)
})
