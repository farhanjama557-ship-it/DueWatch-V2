import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDwPhase2bPreviewData } from '../visual-harness/dwPhase2bPreviewData.js'
const c=(id)=>({id,user_id:'visual-user',client_id:`c-${id}`,amount:1000,amount_paid:0,due_date:'2026-08-01',clients:{name:`Client ${id}`},invoice_number:`INV-${id}`})

test('preview supplies separate Pulse, Whats Done and Needs You models',()=>{
  const out=buildDwPhase2bPreviewData({userId:'visual-user',invoices:[c('1'),c('2'),c('3'),c('4')]})
  assert.equal(out.previewOnly,true); assert.ok(out.pulse); assert.ok(out.whatsDone); assert.ok(out.needsYou)
  assert.equal(out.needsYou.executionAvailable,false); assert.equal(out.needsYou.items[0].directlyExecutable,false)
  assert.equal(out.whatsDone.summary.realSideEffects,0)
})
