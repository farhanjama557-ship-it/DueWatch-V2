import test from 'node:test'
import assert from 'node:assert/strict'
import { projectWhatsDoneReadModel, projectNeedsYouCommandReadModel } from '../src/lib/dwIntelligence/phase2bCommandModels.js'

function proofEvent({ state='HANDLED', invoiceId='i1', clientId='c1', createdAt='2026-08-24T23:00:00Z', question=false }={}) {
  return {
    user_id:'tenant-a', run_id:`run-${invoiceId}`, invoice_id:invoiceId, client_id:clientId,
    operational_state:state, created_at:createdAt, real_side_effect:false,
    proof:{
      scope:{tenantId:'tenant-a', invoiceId, clientId},
      canonicalFacts:{tenantId:'tenant-a', invoiceId, clientId, amount:5000, amountPaid:1000, balance:4000, daysOverdue:12, canonicalStatus:'OPEN'},
      evidence:{records:[{id:'e1',trust:'HIGH',status:'ADMITTED',claimType:'invoice_state'}],independentStrongRoots:['e1']},
      interpretations:[], memory:{active:[],blocked:[]}, precedent:{checked:[],applicable:[]},
      founderQuestion:{asked:question,question:question?'Is this client protected?':null},
      policy:{action:'send_reminder',tone:'friendly',ruleId:'r1'},
      authority:{policyAuthorized:true,actual:state==='HANDLED'?'GRANTED':'NOT_GRANTED',canActAutomatically:state==='HANDLED',requiresApproval:state!=='HANDLED',basis:{ruleId:'r1'}},
      verifier:{passed:true},
      stagedAction:{action:'send_reminder',tone:'friendly',ruleId:'r1',status:state==='APPROVAL'?'AWAITING_APPROVAL':'STAGED'},
      execution:{mode:state==='HANDLED'?'sandbox':'none',sideEffect:false,outcome:state==='HANDLED'?'SANDBOX_SENT':'NO_ACTION'},
    }
  }
}
function input({state='HANDLED',invoiceId='i1',clientId='c1',runStatus='completed',createdAt,question=false}={}) {
  return {
    invoice:{id:invoiceId,user_id:'tenant-a',client_id:clientId}, client:{id:clientId,user_id:'tenant-a'},
    run:{id:`run-${invoiceId}`,user_id:'tenant-a',status:runStatus,transport:'sandbox',production_execution_authorized:false,summary:{hard_violations:[]}},
    proofEvent:proofEvent({state,invoiceId,clientId,createdAt,question})
  }
}

test('Whats Done excludes running work so LIVE cannot be mistaken for completed work',()=>{
  const out=projectWhatsDoneReadModel({userId:'tenant-a',cases:[input({invoiceId:'done'}),input({invoiceId:'live',runStatus:'running'})]})
  assert.equal(out.total,1); assert.equal(out.entries[0].invoiceId,'done')
})

test('Whats Done records handled work as sandbox proof with zero real side effects',()=>{
  const out=projectWhatsDoneReadModel({userId:'tenant-a',cases:[input()]})
  assert.equal(out.summary.handled,1); assert.equal(out.summary.realSideEffects,0); assert.equal(out.entries[0].proofAvailable,true)
})

test('Whats Done records blocked work as intentionally withheld rather than silently disappearing it',()=>{
  const out=projectWhatsDoneReadModel({userId:'tenant-a',cases:[input({state:'BLOCKED'})]})
  assert.equal(out.entries[0].kind,'WITHHELD'); assert.match(out.entries[0].title,/withheld/i)
})

test('Needs You contains approval review but remains structurally non executable',()=>{
  const out=projectNeedsYouCommandReadModel({userId:'tenant-a',cases:[input({state:'APPROVAL'})]})
  assert.equal(out.count,1); assert.equal(out.executionAvailable,false); assert.equal(out.authorityCanBeGrantedHere,false)
  assert.equal(out.items[0].directlyExecutable,false); assert.equal(out.items[0].boundary,'REQUEST_BACKEND_REVALIDATION')
})

test('Needs You surfaces a valuable founder question without manufacturing approval authority',()=>{
  const out=projectNeedsYouCommandReadModel({userId:'tenant-a',cases:[input({state:'UNCERTAIN',question:true})]})
  assert.equal(out.items[0].commandType,'FOUNDER_ANSWER'); assert.equal(out.items[0].browserMayGrantAuthority,false)
})

test('Needs You excludes ordinary WATCH and HANDLED cases',()=>{
  const out=projectNeedsYouCommandReadModel({userId:'tenant-a',cases:[input({state:'WATCH',invoiceId:'w'}),input({state:'HANDLED',invoiceId:'h'})]})
  assert.equal(out.count,0)
})

test('foreign tenant case cannot self-authorize its way into founder journal',()=>{
  const foreign=input(); foreign.run.user_id='tenant-b'; foreign.proofEvent.user_id='tenant-b'; foreign.proofEvent.proof.scope.tenantId='tenant-b'
  assert.equal(projectWhatsDoneReadModel({userId:'tenant-a',cases:[foreign]}).total,0)
  assert.equal(projectNeedsYouCommandReadModel({userId:'tenant-a',cases:[foreign]}).count,0)
})
