import test from 'node:test'
import assert from 'node:assert/strict'
import { DW_LIVE_EVENT, validateLiveTransition, projectLiveFeedReadModel, liveTransitionRow } from '../src/lib/dwIntelligence/phase2bLiveFeed.js'

const U='u1', I='i1', C='c1'
const row=(event, at, extra={}) => ({ id:`${event}-${at}`, run_id:'r1', user_id:U, invoice_id:I, client_id:C, event_type:event, occurred_at:at, ...extra })
const ctx={userId:U,invoicesById:{[I]:{id:I,user_id:U,client_id:C,inv_num:'INV-42'}},clientsById:{[C]:{id:C,user_id:U,name:'Atlas'}}}

test('run must begin with analyzing',()=>assert.deepEqual(validateLiveTransition(null,DW_LIVE_EVENT.VERIFYING),{ok:false,reason:'RUN_MUST_START_ANALYZING'}))
test('valid transition chain is accepted',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[
  row('ANALYZING','2026-08-24T20:00:00Z'),row('VERIFYING','2026-08-24T20:01:00Z'),row('PREPARING','2026-08-24T20:02:00Z')
 ]})
 assert.equal(m.feed.length,3); assert.equal(m.live,true); assert.equal(m.active[0].workPhase,'preparing')
})
test('terminal handled removes run from LIVE',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[row('ANALYZING','2026-08-24T20:00:00Z'),row('PREPARING','2026-08-24T20:01:00Z'),row('HANDLED','2026-08-24T20:02:00Z')]})
 assert.equal(m.live,false); assert.equal(m.activeCount,0); assert.equal(m.feed[0].eventType,'HANDLED')
})
test('terminal run cannot resume',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[row('ANALYZING','2026-08-24T20:00:00Z'),row('BLOCKED','2026-08-24T20:01:00Z'),row('ANALYZING','2026-08-24T20:02:00Z')]})
 assert.equal(m.feed.length,2); assert.equal(m.rejected[0].reason,'TERMINAL_RUN_CANNOT_TRANSITION')
})
test('duplicate transition is rejected rather than animated',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[row('ANALYZING','2026-08-24T20:00:00Z'),row('ANALYZING','2026-08-24T20:01:00Z')]})
 assert.equal(m.feed.length,1); assert.equal(m.rejected[0].reason,'DUPLICATE_TRANSITION')
})
test('foreign tenant transition cannot enter feed',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[{...row('ANALYZING','2026-08-24T20:00:00Z'),user_id:'evil'}]})
 assert.equal(m.feed.length,0); assert.equal(m.live,false)
})
test('foreign invoice metadata cannot enter feed',()=>{
 const m=projectLiveFeedReadModel({userId:U,transitions:[row('ANALYZING','2026-08-24T20:00:00Z')],invoicesById:{[I]:{id:I,user_id:'evil',client_id:C}},clientsById:{}})
 assert.equal(m.feed.length,0); assert.equal(m.rejected[0].reason,'INVOICE_TENANT_MISMATCH')
})
test('transition never grants authority or execution',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[row('ANALYZING','2026-08-24T20:00:00Z')]})
 assert.equal(m.executionAvailable,false); assert.equal(m.browserMayGrantAuthority,false); assert.equal(m.feed[0].authorityGrantedByTransition,false)
})
test('real-side-effect truth is not hidden',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[row('ANALYZING','2026-08-24T20:00:00Z',{real_side_effect:true})]})
 assert.equal(m.feed[0].realSideEffect,true)
})
test('Join DW route target is data, not execution',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[row('ANALYZING','2026-08-24T20:00:00Z',{page:'invoice',route_target:{kind:'invoice',invoiceId:I}})]})
 assert.deepEqual(m.active[0].routeTarget,{kind:'invoice',invoiceId:I}); assert.equal(m.executionAvailable,false)
})
test('row mapper is sandbox-only and immutable',()=>{
 const r=liveTransitionRow({runId:'r',userId:U,invoiceId:I,eventType:'ANALYZING',occurredAt:'2026-08-24T20:00:00Z'})
 assert.equal(r.real_side_effect,false); assert.equal(r.production_execution_authorized,false); assert.equal(Object.isFrozen(r),true)
})
test('invalid event cannot be persisted by mapper',()=>assert.throws(()=>liveTransitionRow({runId:'r',userId:U,invoiceId:I,eventType:'MAGIC',occurredAt:'2026-08-24T20:00:00Z'}),/INVALID_LIVE_TRANSITION/))

test('stale active run does not pulse LIVE when explicit freshness window is applied',()=>{
 const m=projectLiveFeedReadModel({...ctx,now:'2026-08-24T21:00:00Z',freshnessMs:5*60*1000,transitions:[row('ANALYZING','2026-08-24T20:00:00Z')]})
 assert.equal(m.live,false); assert.equal(m.activeCount,0); assert.equal(m.staleActiveCount,1); assert.equal(m.staleActive[0].stale,true)
})

test('recent transition remains LIVE under explicit freshness window',()=>{
 const m=projectLiveFeedReadModel({...ctx,now:'2026-08-24T20:04:00Z',freshnessMs:5*60*1000,transitions:[row('ANALYZING','2026-08-24T20:00:00Z')]})
 assert.equal(m.live,true); assert.equal(m.activeCount,1); assert.equal(m.staleActiveCount,0)
})

test('multiple simultaneous recent runs are represented independently',()=>{
 const second={id:'i2',user_id:U,client_id:C,inv_num:'INV-43'}
 const m=projectLiveFeedReadModel({userId:U,now:'2026-08-24T20:02:00Z',freshnessMs:5*60*1000,invoicesById:{[I]:ctx.invoicesById[I],i2:second},clientsById:ctx.clientsById,transitions:[row('ANALYZING','2026-08-24T20:00:00Z'),{...row('ANALYZING','2026-08-24T20:01:00Z'),id:'r2',run_id:'r2',invoice_id:'i2'}]})
 assert.equal(m.activeCount,2); assert.equal(new Set(m.active.map(x=>x.runId)).size,2)
})

test('WAITING run remains visible but does not assert LIVE',()=>{
 const m=projectLiveFeedReadModel({...ctx,transitions:[row('ANALYZING','2026-08-24T20:00:00Z'),row('WAITING','2026-08-24T20:01:00Z')]})
 assert.equal(m.live,false); assert.equal(m.activeCount,0); assert.equal(m.waitingCount,1); assert.equal(m.waiting[0].workPhase,'waiting')
})
