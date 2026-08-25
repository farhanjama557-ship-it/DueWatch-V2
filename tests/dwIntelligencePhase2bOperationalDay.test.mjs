import test from 'node:test'
import assert from 'node:assert/strict'
import { runOperationalDaySimulation } from '../src/lib/dwIntelligence/phase2bOperationalSimulation.js'

const sim=runOperationalDaySimulation()
const stateFor=(invoiceId)=>sim.results.find(x=>x.invoiceId===invoiceId)?.state

test('integrated operational day runs eleven distinct cases',()=>assert.equal(sim.summary.cases,11))
test('integrated day has zero H01-H10 violations',()=>assert.equal(sim.summary.hardViolations,0))
test('integrated day has zero real side effects',()=>assert.equal(sim.summary.realSideEffects,0))
test('integrated day has zero canonical money mutations',()=>assert.equal(sim.summary.canonicalMoneyMutations,0))
test('routine authorized invoice is handled only in sandbox',()=>assert.equal(stateFor('inv-auto'),'HANDLED'))
test('approval-required invoice enters founder queue',()=>{assert.equal(stateFor('inv-approval'),'APPROVAL'); assert.ok(sim.needsYou.items.some(x=>x.invoiceId==='inv-approval')); assert.equal(sim.needsYou.executionAvailable,false)})
test('payment claim conflict becomes investigating',()=>assert.equal(stateFor('inv-conflict'),'INVESTIGATING'))
test('sparse/wide prediction abstains as uncertain',()=>assert.equal(stateFor('inv-uncertain'),'UNCERTAIN'))
test('no-rule case is watched rather than invented action',()=>assert.equal(stateFor('inv-watch'),'WATCH'))
test('rejected staged action is blocked before execution',()=>assert.equal(stateFor('inv-reject'),'BLOCKED'))
test('high-value founder question is asked exactly once in day fixture',()=>assert.equal(sim.summary.founderQuestions,1))
test('canonical paid invoice cannot be sandbox-sent even with authority',()=>assert.equal(stateFor('inv-paid'),'WATCH'))
test('instruction-bearing evidence cannot self-grant authority',()=>assert.equal(stateFor('inv-inject'),'HANDLED'))
test('tombstoned memory does not create H10',()=>assert.equal(sim.results.find(x=>x.invoiceId==='inv-tomb').hardViolations.length,0))
test('production-disabled action can be READY with no side effect',()=>assert.equal(stateFor('inv-ready'),'READY'))
test('all explicit DW Check manifests prove zero silently skipped',()=>assert.equal(sim.summary.zeroSkippedChecks,11))
test('Replay is sourced from the same transition spine',()=>{assert.equal(sim.replay.runCount,11); assert.ok(sim.replay.runs.every(x=>x.reconstructionSource==='persisted_transition_history'))})
test('What\'s Done includes completed proof-backed cases',()=>assert.equal(sim.whatsDone.total,11))
test('WAITING/open runs remain visible without falsely asserting LIVE',()=>{assert.ok(sim.liveFeed.feed.length>0); assert.equal(sim.liveFeed.live,false); assert.equal(sim.liveFeed.activeCount,0); assert.equal(sim.liveFeed.waitingCount,7)})
test('all transition records are tenant scoped',()=>assert.ok(sim.transitions.every(x=>x.user_id==='sim-tenant')))
test('all command-queue entries remain browser-non-executable',()=>assert.ok(sim.needsYou.items.every(x=>x.directlyExecutable===false && x.browserMayGrantAuthority===false)))
