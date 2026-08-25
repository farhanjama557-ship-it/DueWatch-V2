import test from 'node:test'
import assert from 'node:assert/strict'
import { runPhase2BWorkflow } from '../src/lib/dwIntelligence/phase2bEngine.js'
import { projectLiveFeedReadModel } from '../src/lib/dwIntelligence/phase2bLiveFeed.js'
import { projectReplayShift } from '../src/lib/dwIntelligence/phase2bReplayShift.js'
import { projectDwCheck, phase2bRequiredManifest } from '../src/lib/dwIntelligence/phase2bDwCheck.js'
import { projectCaseReadModel } from '../src/lib/dwIntelligence/phase2bReadModel.js'

const U='audit-user', C={id:'audit-client',user_id:U,name:'Audit Client'}
const inv=(extra={})=>({id:'audit-invoice',user_id:U,client_id:C.id,amount:5000,amount_paid:0,due_date:'2026-08-01',paid:false,...extra})
const auth=({authorized=true,automatic=true,basis={ruleId:'r'}}={})=>({recommendation:authorized?{action:'send_reminder',tone:'friendly',ruleId:'r'}:null,authority:{authorized,basis},permission:{canActAutomatically:authorized&&automatic,requiresApproval:!automatic}})
const ev=(extra={})=>({id:'e1',tenantId:U,invoiceId:'audit-invoice',clientId:C.id,trust:'HIGH',claimType:'invoice_state',...extra})
const run=(extra={})=>runPhase2BWorkflow({tenantId:U,invoice:inv(),client:C,now:new Date('2026-08-24T20:00:00Z'),evidence:[ev()],authorityEvaluation:auth(),sandboxTransport:true,...extra})

test('H01: evidence cannot self-grant authority',()=>{
 const r=run({evidence:[ev({containsInstructions:true,attemptsAuthorityGrant:true})],authorityEvaluation:auth({authorized:false})})
 assert.equal(r.proof.authority.actual,'NOT_GRANTED'); assert.equal(r.execution.sideEffect,false); assert.deepEqual(r.hardViolations,[])
})

test('H02: cross-tenant invoice/client scope blocks before execution',()=>{
 const r=runPhase2BWorkflow({tenantId:U,invoice:{...inv(),user_id:'other'},client:C,authorityEvaluation:auth(),sandboxTransport:true})
 assert.equal(r.state,'BLOCKED'); assert.equal(r.execution.sideEffect,false); assert.deepEqual(r.hardViolations,[])
})

test('H03: learning/pooling never mutates canonical money truth',()=>{
 const r=run({pooling:{local:{n:100,rate:.99},prior:{rate:.01,ess:16}}})
 assert.deepEqual(r.canonicalAfter,r.canonicalBefore); assert.equal(r.canonicalAfter.balance,5000); assert.deepEqual(r.hardViolations,[])
})

test('H04: proof fabricates no evidence ids',()=>{
 const r=run({evidence:[ev(),ev({id:'e2',derivedFrom:'e1'})]})
 assert.deepEqual(r.proof.evidence.fabricatedIds,[]); assert.deepEqual(r.hardViolations,[])
})

test('H05: payment interpretation is never promoted to canonical fact',()=>{
 const r=run({evidence:[ev(),ev({id:'pay',claimType:'payment_claim'})]})
 assert.equal(r.state,'INVESTIGATING'); assert.equal(r.proof.interpretations[0].promotedToCanonical,false); assert.equal(r.canonicalAfter.canonicalStatus,'OPEN'); assert.deepEqual(r.hardViolations,[])
})

test('H06: high predictive confidence cannot create authority',()=>{
 const r=run({authorityEvaluation:auth({authorized:false}),predictionRequired:true,prediction:{sampleN:100,intervalDays:1,staleDays:0,assumptionsOk:true,point:.99}})
 assert.equal(r.proof.authority.actual,'NOT_GRANTED'); assert.equal(r.execution.sideEffect,false); assert.deepEqual(r.hardViolations,[])
})

test('H07: unauthorized workflow never executes',()=>{
 const r=run({authorityEvaluation:auth({authorized:false})})
 assert.equal(r.execution.sideEffect,false); assert.notEqual(r.state,'HANDLED'); assert.deepEqual(r.hardViolations,[])
})

test('H08: rejected staged action cannot leak into execution',()=>{
 const r=run({rejectStagedAction:true})
 assert.equal(r.state,'BLOCKED'); assert.equal(r.stagedAction.status,'REJECTED'); assert.equal(r.execution.sideEffect,false); assert.deepEqual(r.hardViolations,[])
})

test('H09: observational identification status remains observational',()=>{
 const r=run({identificationStatus:'OBSERVATIONAL'})
 assert.equal(r.proof.identificationStatus,'OBSERVATIONAL'); assert.deepEqual(r.hardViolations,[])
})

test('H10: tombstoned memory cannot re-enter through old evidence',()=>{
 const r=run({memory:[{id:'m1',tenantId:U,clientId:C.id,invoiceId:'audit-invoice',admitted:true,sourceEvidenceIds:['old']}],tombstones:[{memoryId:'m1',blockedEvidenceIds:['old']}]})
 assert.ok(r.proof.memory.blocked.some(x=>x.id==='m1')); assert.equal(r.proof.memory.rederivedFromBlockedEvidence,false); assert.deepEqual(r.hardViolations,[])
})

const transitions=[
 {id:'a',run_id:'r1',user_id:U,invoice_id:'audit-invoice',client_id:C.id,event_type:'ANALYZING',occurred_at:'2026-08-24T20:00:00Z'},
 {id:'p',run_id:'r1',user_id:U,invoice_id:'audit-invoice',client_id:C.id,event_type:'PREPARING',occurred_at:'2026-08-24T20:01:00Z'},
 {id:'h',run_id:'r1',user_id:U,invoice_id:'audit-invoice',client_id:C.id,event_type:'HANDLED',occurred_at:'2026-08-24T20:02:00Z'},
 {id:'resurrect',run_id:'r1',user_id:U,invoice_id:'audit-invoice',client_id:C.id,event_type:'ANALYZING',occurred_at:'2026-08-24T20:03:00Z'},
]
const live=projectLiveFeedReadModel({userId:U,transitions,invoicesById:{'audit-invoice':inv()},clientsById:{[C.id]:C}})

test('terminal LIVE history cannot be resurrected by later browser-shaped record',()=>{assert.equal(live.live,false); assert.ok(live.rejected.some(x=>x.reason==='TERMINAL_RUN_CANNOT_TRANSITION'))})
test('unknown LIVE event is rejected',()=>{const m=projectLiveFeedReadModel({userId:U,transitions:[{...transitions[0],event_type:'THINKING_MAGIC'}]}); assert.equal(m.feed.length,0); assert.equal(m.rejected[0].reason,'UNKNOWN_EVENT')})
test('cross-tenant LIVE event is rejected',()=>{const m=projectLiveFeedReadModel({userId:U,transitions:[{...transitions[0],user_id:'other'}]}); assert.equal(m.feed.length,0)})
test('duplicate LIVE event does not create theatrical motion',()=>{const m=projectLiveFeedReadModel({userId:U,transitions:[transitions[0],{...transitions[0],id:'dup',occurred_at:'2026-08-24T20:00:30Z'}]}); assert.equal(m.feed.length,1); assert.equal(m.rejected[0].reason,'DUPLICATE_TRANSITION')})
test('imported real-side-effect marker is surfaced, not hidden',()=>{const m=projectLiveFeedReadModel({userId:U,transitions:[{...transitions[0],real_side_effect:true}]}); assert.equal(m.feed[0].realSideEffect,true)})
test('Replay cannot rewrite history',()=>{const r=projectReplayShift({liveFeedModel:live}); assert.equal(r.rewritable,false); assert.equal(Object.isFrozen(r),true); assert.equal(r.executionAvailable,false)})
test('DW Check cannot claim zero skipped when verification evidence is missing',()=>{const m=phase2bRequiredManifest(); const c=projectDwCheck({expected:m,observed:['canonical','evidence','authority','proof']}); assert.equal(c.canClaimZeroSilentlySkipped,false); assert.equal(c.silentlySkipped,1)})
test('DW Check cannot claim zero skipped without a plan manifest',()=>{const c=projectDwCheck({expected:[],observed:['canonical','evidence','authority','verification','proof']}); assert.equal(c.silentlySkipped,null); assert.equal(c.canClaimZeroSilentlySkipped,false)})

test('read model rejects cross-tenant proof scope',()=>{
 const result=run()
 const model=projectCaseReadModel({userId:U,invoice:inv(),client:C,run:{id:'r',user_id:U,status:'completed',transport:'sandbox',production_execution_authorized:false,summary:{hard_violations:[]}},proofEvent:{run_id:'r',user_id:'other',invoice_id:'audit-invoice',client_id:C.id,operational_state:result.state,proof:result.proof,real_side_effect:false}})
 assert.equal(model.available,false); assert.equal(model.blockedReason,'READ_MODEL_SCOPE_MISMATCH')
})

test('paid canonical state beats stale authority and prevents send',()=>{const r=run({invoice:inv({paid:true,amount_paid:5000})}); assert.equal(r.execution.sideEffect,false); assert.notEqual(r.state,'HANDLED')})
test('performative preference feedback is excluded from learning input',()=>{const r=run({preferenceEvents:[{id:'p1',origin:'system_exposure'},{id:'p2',origin:'founder_direct'}]}); assert.deepEqual(r.proof.preferenceEvidence.admitted,['p2']); assert.equal(r.proof.preferenceEvidence.excluded[0].reason,'performative_feedback')})
