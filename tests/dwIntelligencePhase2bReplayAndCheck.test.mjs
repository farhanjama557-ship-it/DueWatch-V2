import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { projectLiveFeedReadModel } from '../src/lib/dwIntelligence/phase2bLiveFeed.js'
import { projectReplayShift } from '../src/lib/dwIntelligence/phase2bReplayShift.js'
import { projectDwCheck, phase2bRequiredManifest } from '../src/lib/dwIntelligence/phase2bDwCheck.js'

const U='u1', I='i1', C='c1'
const invoice={id:I,user_id:U,client_id:C,inv_num:'INV-1'}
const client={id:C,user_id:U,name:'Atlas'}
const tr=(type,at,extra={})=>({id:`${type}-${at}`,run_id:'r1',user_id:U,invoice_id:I,client_id:C,event_type:type,occurred_at:at,...extra})
const live=projectLiveFeedReadModel({userId:U,invoicesById:{[I]:invoice},clientsById:{[C]:client},transitions:[
 tr('ANALYZING','2026-08-24T20:00:00Z',{detail:'Checked invoice'}),
 tr('VERIFYING','2026-08-24T20:01:00Z',{detail:'Verified evidence'}),
 tr('PREPARING','2026-08-24T20:02:00Z',{detail:'Prepared sandbox reminder'}),
 tr('HANDLED','2026-08-24T20:03:00Z',{detail:'Sandbox complete'}),
]})

test('Replay reconstructs exact accepted transition order',()=>{
 const r=projectReplayShift({liveFeedModel:live})
 assert.equal(r.runCount,1); assert.equal(r.completedRuns,1)
 assert.deepEqual(r.runs[0].timeline.map(x=>x.eventType),['ANALYZING','VERIFYING','PREPARING','HANDLED'])
 assert.equal(r.runs[0].reconstructionSource,'persisted_transition_history')
 assert.equal(r.runs[0].inferredHiddenSteps,0)
})

test('Replay is read-only and cannot grant authority',()=>{
 const r=projectReplayShift({liveFeedModel:live})
 assert.equal(r.rewritable,false); assert.equal(r.executionAvailable,false); assert.equal(r.browserMayGrantAuthority,false)
 assert.equal(Object.isFrozen(r),true)
})

test('Replay preserves real-side-effect truth',()=>{
 const x=projectLiveFeedReadModel({userId:U,invoicesById:{[I]:invoice},clientsById:{[C]:client},transitions:[tr('ANALYZING','2026-08-24T20:00:00Z',{real_side_effect:true})]})
 const r=projectReplayShift({liveFeedModel:x})
 assert.equal(r.runs[0].timeline[0].realSideEffect,true)
})

test('DW Check proves zero skipped only with explicit complete manifest',()=>{
 const m=phase2bRequiredManifest()
 const c=projectDwCheck({runId:'r1',expected:m,observed:m.map(x=>x.id),proof:{hard_violations:[],real_side_effect:false}})
 assert.equal(c.silentlySkipped,0); assert.equal(c.canClaimZeroSilentlySkipped,true); assert.equal(c.healthy,true)
})

test('DW Check refuses zero-skipped claim without manifest',()=>{
 const c=projectDwCheck({runId:'r1',expected:[],observed:['canonical']})
 assert.equal(c.silentlySkipped,null); assert.equal(c.canClaimZeroSilentlySkipped,false); assert.equal(c.healthy,false)
})

test('DW Check exposes missing required checkpoints',()=>{
 const m=phase2bRequiredManifest()
 const c=projectDwCheck({runId:'r1',expected:m,observed:['canonical','evidence','authority','proof']})
 assert.equal(c.silentlySkipped,1); assert.equal(c.missingRequired[0].id,'verification'); assert.equal(c.healthy,false)
})

test('DW Check surfaces hard violations instead of collapsing into health',()=>{
 const m=phase2bRequiredManifest()
 const c=projectDwCheck({runId:'r1',expected:m,observed:m.map(x=>x.id),proof:{hard_violations:['H07']}})
 assert.equal(c.silentlySkipped,0); assert.equal(c.hardViolations[0],'H07'); assert.equal(c.healthy,false)
})

test('DW Check cannot execute or grant browser authority',()=>{
 const c=projectDwCheck({runId:'r1',expected:phase2bRequiredManifest(),observed:[]})
 assert.equal(c.executionAvailable,false); assert.equal(c.browserMayGrantAuthority,false)
})

const root=path.resolve(process.cwd())
for (const file of ['DwLiveFeed.jsx','DwReplayShift.jsx','DwCheckPanel.jsx']) {
 test(`${file} has no network/database/execution import`,()=>{
   const s=fs.readFileSync(path.join(root,'src/features/dwIntelligence',file),'utf8')
   assert.doesNotMatch(s,/supabase|sendReminder|fetch\(|axios|execute|approveSignature|recordInvoicePayment/i)
   assert.match(s,/data-dw-read-only="true"/)
 })
}

test('LIVE component labels Join DW as navigation affordance only',()=>{
 const s=fs.readFileSync(path.join(root,'src/features/dwIntelligence/DwLiveFeed.jsx'),'utf8')
 assert.match(s,/Join DW/); assert.doesNotMatch(s,/Approve|Send reminder|Execute/)
})

test('Replay UI contains no mutation handler prop',()=>{
 const s=fs.readFileSync(path.join(root,'src/features/dwIntelligence/DwReplayShift.jsx'),'utf8')
 assert.doesNotMatch(s,/onApprove|onExecute|onSend|onMutate/)
})
