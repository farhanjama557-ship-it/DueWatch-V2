import test from 'node:test'
import assert from 'node:assert/strict'
import {
  presentDwLive,
  presentPulseCommand,
  presentCaseState,
  resolveDwInvoice,
} from '../src/lib/dwIntelligence/phase2bUiPresentation.js'

test('LIVE appears only for a truthy live model with a real job count', () => {
  assert.equal(presentDwLive({ live: true, liveJobs: 1 }).label, 'LIVE')
  assert.equal(presentDwLive({ live: false, liveJobs: 1 }).label, 'CAUGHT UP')
  assert.equal(presentDwLive({ live: true, liveJobs: 0 }).label, 'CAUGHT UP')
})

test('Pulse command uses separated founder metrics, not a fake master score', () => {
  const view = presentPulseCommand({ headline: 'DW has 2 cases.', cashUnderManagement: 10000, handled: 1, investigating: 1, ready: 0, needsYou: 1, live:false, liveJobs:0 })
  assert.equal(view.metrics.length, 4)
  assert.deepEqual(view.metrics.map((m) => m.label), ['Under management', 'Handled', 'Working', 'Needs you'])
  assert.ok(!JSON.stringify(view).includes('/100'))
})

test('case presentation does not turn approval into authority', () => {
  const view = presentCaseState({ available:true, state:'APPROVAL', live:false, stateMessage:'Needs founder', needsFounder:true, authority:{actual:'NOT_GRANTED'}, evidence:{admitted:2,rejected:0,quarantined:0}, execution:{realSideEffect:false} })
  assert.equal(view.authorityLabel, 'Founder judgment required')
  assert.equal(view.label, 'Needs you')
})

test('invoice lookup is display-only and exact-id scoped', () => {
  const invoice = { id:'inv-1' }
  assert.equal(resolveDwInvoice([invoice], 'inv-1'), invoice)
  assert.equal(resolveDwInvoice([invoice], 'inv-2'), null)
})

test('persisted transition feed overrides stale aggregate LIVE flag',()=>{
 const view=presentDwLive({live:true,liveJobs:1,liveFeed:{live:false,activeCount:0,staleActiveCount:1}})
 assert.equal(view.active,false); assert.equal(view.label,'CHECKING'); assert.match(view.detail,/LIVE is not asserted/)
})

test('persisted transition feed can assert LIVE even if old aggregate is false',()=>{
 const view=presentDwLive({live:false,liveJobs:0,liveFeed:{live:true,activeCount:2,staleActiveCount:0}})
 assert.equal(view.active,true); assert.equal(view.label,'LIVE'); assert.match(view.detail,/2 jobs active/)
})

test('waiting transition state renders WATCHING, never LIVE',()=>{
 const view=presentDwLive({live:true,liveJobs:1,liveFeed:{live:false,activeCount:0,waitingCount:2,staleActiveCount:0}})
 assert.equal(view.active,false); assert.equal(view.label,'WATCHING'); assert.match(view.detail,/LIVE is not asserted/)
})
