import test from 'node:test'
import assert from 'node:assert/strict'
import { createPhase2BPersistenceIo } from '../supabase/functions/_shared/dwIntelligencePhase2bPersistenceIo.js'
import { runPhase2BServerProof } from '../supabase/functions/_shared/dwIntelligencePhase2bServerCore.js'
import { projectCaseReadModel, projectNeedsYouReadModel, projectPulseReadModel } from '../src/lib/dwIntelligence/phase2bReadModel.js'

function makeDb() {
  const tables = new Map()
  const get = (name) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)
  }
  return {
    tables,
    async insertOne(table, row) {
      const stored = {
        id: table === 'dw_intelligence_runs' ? `run-${get(table).length + 1}` : `${table}-${get(table).length + 1}`,
        created_at: '2026-08-24T23:30:00.000Z',
        started_at: table === 'dw_intelligence_runs' ? '2026-08-24T23:29:59.000Z' : undefined,
        status: table === 'dw_intelligence_runs' ? 'running' : undefined,
        ...structuredClone(row),
      }
      get(table).push(stored)
      return stored
    },
    async insertMany(table, rows) {
      for (const row of rows) get(table).push({ id: `${table}-${get(table).length + 1}`, created_at:'2026-08-24T23:30:00.000Z', ...structuredClone(row) })
      return rows
    },
    async updateOne(table, match, update) {
      const row = get(table).find((r) => Object.entries(match).every(([k,v]) => r[k] === v))
      if (!row) throw new Error(`row not found in ${table}`)
      Object.assign(row, structuredClone(update))
      return row
    },
  }
}

function inputs({ approval = false } = {}) {
  const userId='tenant-a'
  const client={ id:'client-a', user_id:userId, name:'Atlas', email:'ap@atlas.test' }
  const invoice={ id:'invoice-a', user_id:userId, client_id:client.id, clients:client, inv_num:'INV-1', amount:5000, amount_paid:0, due_date:'2026-08-01', paid:false, autopilot_paused:false }
  return {
    invoice, client,
    rules:[{ id:'rule-1', user_id:userId, name:'Friendly', trigger_type:'after_due', trigger_days:1, tone:'friendly', enabled:true, sort_order:1 }],
    autopilotSettings:{ user_id:userId, enabled:true, approval_required:approval },
    handledKeys:new Set(), pendingInvoiceIds:new Set(), events:[],
    evidence:[{ id:'e1', tenantId:userId, clientId:client.id, invoiceId:invoice.id, sourceType:'invoice', trust:'HIGH', claimType:'invoice_state' }],
    memory:[], tombstones:[], precedents:[], preferenceEvents:[],
  }
}

function authority(auto) {
  return ({ rules }) => ({
    facts:{},
    recommendation:{ action:'send_reminder', tone:'friendly', ruleId:rules[0].id, ruleName:rules[0].name },
    authority:{ authorized:true, basis:{ruleId:rules[0].id}, evaluatedAt:'2026-08-24T23:30:00.000Z', blockedReason:null },
    permission:{ requiresApproval:!auto, canActAutomatically:auto },
  })
}

function dbCase(db, raw) {
  const run = db.tables.get('dw_intelligence_runs')[0]
  const proofEvent = db.tables.get('dw_proof_events')[0]
  return { userId:'tenant-a', invoice:raw.invoice, client:raw.client, run, proofEvent }
}

test('server proof -> DB-shaped rows -> read model -> Pulse preserves HANDLED sandbox truth', async () => {
  const db=makeDb(); const raw=inputs()
  const io=createPhase2BPersistenceIo({ db, caseLoader:async()=>raw })
  await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', now:new Date('2026-08-24T23:30:00Z'), evaluateAuthority:authority(true), io })
  const c=dbCase(db, raw)
  const projected=projectCaseReadModel(c)
  assert.equal(projected.state,'HANDLED')
  assert.equal(projected.execution.realSideEffect,false)
  assert.equal(projected.proofIntegrity.directExecutionAvailable,false)
  const pulse=projectPulseReadModel({ userId:'tenant-a', cases:[c] })
  assert.equal(pulse.handled,1)
  assert.equal(pulse.needsYou,0)
  assert.equal(pulse.cashUnderManagement,5000)
})

test('server approval proof -> read model -> Needs You never becomes browser execution authority', async () => {
  const db=makeDb(); const raw=inputs({approval:true})
  const io=createPhase2BPersistenceIo({ db, caseLoader:async()=>raw })
  await runPhase2BServerProof({ userId:'tenant-a', invoiceId:'invoice-a', now:new Date('2026-08-24T23:30:00Z'), evaluateAuthority:authority(false), io })
  const c=dbCase(db, raw)
  const needs=projectNeedsYouReadModel({ userId:'tenant-a', cases:[c] })
  assert.equal(needs.count,1)
  assert.equal(needs.items[0].founderAction.directlyExecutable,false)
  assert.equal(needs.items[0].founderAction.boundary,'REQUEST_BACKEND_REVALIDATION')
})
