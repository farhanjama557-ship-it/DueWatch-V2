import { runPhase2BWorkflow } from './phase2bEngine.js'
import { projectLiveFeedReadModel } from './phase2bLiveFeed.js'
import { projectReplayShift } from './phase2bReplayShift.js'
import { projectDwCheck, phase2bRequiredManifest } from './phase2bDwCheck.js'
import { projectWhatsDoneReadModel, projectNeedsYouCommandReadModel } from './phase2bCommandModels.js'

function authority({ authorized = true, automatic = true, approval = !automatic, ruleId = 'rule-friendly' } = {}) {
  return {
    recommendation: authorized ? { action: 'send_reminder', tone: 'friendly', ruleId } : null,
    authority: { authorized, basis: authorized ? { ruleId } : null },
    permission: { canActAutomatically: authorized && automatic, requiresApproval: approval },
  }
}
function baseEvidence(tenantId, invoiceId, clientId) {
  return [
    { id: `ev-${invoiceId}-1`, tenantId, invoiceId, clientId, trust: 'HIGH', sourceType: 'invoice_system', claimType: 'invoice_state' },
    { id: `ev-${invoiceId}-2`, tenantId, invoiceId, clientId, trust: 'MEDIUM', sourceType: 'client_history', claimType: 'behavior_context' },
  ]
}
function resultTransitions({ result, runId, tenantId, invoice, client, startMs }) {
  const rows=[]
  const push=(eventType, offset, detail)=>rows.push({ id:`${runId}-${eventType}-${offset}`,run_id:runId,user_id:tenantId,invoice_id:invoice.id,client_id:client.id,event_type:eventType,occurred_at:new Date(startMs+offset*1000).toISOString(),detail,page:'invoice',route_target:{kind:'invoice',invoiceId:invoice.id},real_side_effect:false })
  push('ANALYZING',0,'DW opened the case and checked canonical invoice state.')
  if (result.state === 'BLOCKED') { push('BLOCKED',30,'DW stopped before execution.'); return rows }
  if (result.state === 'WATCH') { push('WAITING',30,'No verified action is currently authorized.'); return rows }
  push('VERIFYING',30,'DW verified evidence, memory, precedent, uncertainty, and authority inputs.')
  if (result.state === 'HANDLED') { push('PREPARING',60,'DW prepared the bounded friendly reminder in sandbox.'); push('HANDLED',90,'Sandbox workflow completed with no real side effect.'); return rows }
  if (result.state === 'READY') { push('PREPARING',60,'Verified action is ready but production execution is not authorized.'); push('WAITING',90,'Waiting outside production execution.'); return rows }
  if (result.state === 'APPROVAL') { push('WAITING',60,'Founder judgment is required before any execution.'); return rows }
  if (result.state === 'INVESTIGATING') { push('WAITING',60,'Conflicting payment evidence requires verification.'); return rows }
  if (result.state === 'UNCERTAIN') { push('WAITING',60,'Uncertainty or founder input blocks automatic action.'); return rows }
  push('WAITING',60,'DW is waiting.')
  return rows
}

export function buildOperationalDayFixture() {
  const tenantId='sim-tenant'
  const clients=[
    {id:'c-atlas',user_id:tenantId,name:'Atlas'},
    {id:'c-nova',user_id:tenantId,name:'Nova'},
    {id:'c-river',user_id:tenantId,name:'River'},
  ]
  const invoice=(id,clientId,days,extra={})=>({id,user_id:tenantId,client_id:clientId,amount:extra.amount??2400,amount_paid:extra.amount_paid??0,due_date:extra.due_date??'2026-08-01',paid:extra.paid===true,invoice_number:id.toUpperCase(),...extra})
  const scenarios=[
    {id:'routine-auto',invoice:invoice('inv-auto','c-atlas',23),authority:authority({automatic:true})},
    {id:'approval',invoice:invoice('inv-approval','c-nova',18),authority:authority({automatic:false,approval:true})},
    {id:'payment-conflict',invoice:invoice('inv-conflict','c-river',15),authority:authority({automatic:true}),evidenceExtra:[{id:'payment-claim',tenantId,invoiceId:'inv-conflict',clientId:'c-river',trust:'MEDIUM',claimType:'payment_claim'}]},
    {id:'uncertain',invoice:invoice('inv-uncertain','c-atlas',12),authority:authority({automatic:true}),predictionRequired:true,prediction:{sampleN:2,intervalDays:30,staleDays:1,assumptionsOk:true}},
    {id:'no-rule',invoice:invoice('inv-watch','c-nova',9),authority:authority({authorized:false})},
    {id:'rejected-action',invoice:invoice('inv-reject','c-river',31),authority:authority({automatic:true}),rejectStagedAction:true},
    {id:'question',invoice:invoice('inv-question','c-atlas',7),authority:authority({authorized:false}),question:{candidateQuestion:'Should this protected client receive a reminder?',informationValue:.8,burdenCost:.2,liveUncertainty:true,safeReversibleAvailable:false}},
    {id:'paid-during-prep',invoice:invoice('inv-paid','c-nova',5,{paid:true,amount_paid:2400}),authority:authority({automatic:true})},
    {id:'instruction-injection',invoice:invoice('inv-inject','c-river',40),authority:authority({automatic:true}),evidenceExtra:[{id:'inject',tenantId,invoiceId:'inv-inject',clientId:'c-river',trust:'HIGH',containsInstructions:true,attemptsAuthorityGrant:true,claimType:'note'}]},
    {id:'tombstone',invoice:invoice('inv-tomb','c-atlas',20),authority:authority({automatic:true}),memory:[{id:'mem-old',tenantId,clientId:'c-atlas',invoiceId:'inv-tomb',admitted:true,sourceEvidenceIds:['old-evidence']}],tombstones:[{memoryId:'mem-old',blockedEvidenceIds:['old-evidence']}]},
    {id:'ready-no-prod',invoice:invoice('inv-ready','c-nova',26),authority:authority({automatic:true}),sandboxTransport:false},
  ]
  return {tenantId,clients,scenarios}
}

export function runOperationalDaySimulation({ now = new Date('2026-08-24T20:00:00Z') } = {}) {
  const fixture=buildOperationalDayFixture()
  const clientsById=Object.fromEntries(fixture.clients.map(c=>[c.id,c]))
  const invoicesById={}
  const cases=[]
  const transitions=[]
  const proofByRunId={}
  const manifest=phase2bRequiredManifest()
  const dwChecks=[]

  fixture.scenarios.forEach((s,index)=>{
    const client=clientsById[s.invoice.client_id]
    invoicesById[s.invoice.id]=s.invoice
    const evidence=[...baseEvidence(fixture.tenantId,s.invoice.id,client.id),...(s.evidenceExtra||[])]
    const result=runPhase2BWorkflow({
      tenantId:fixture.tenantId,invoice:s.invoice,client,now,evidence,
      memory:s.memory||[],tombstones:s.tombstones||[],precedents:s.precedents||[],
      pooling:s.pooling||null,prediction:s.prediction||null,predictionRequired:s.predictionRequired===true,
      authorityEvaluation:s.authority,founderApproved:false,question:s.question||null,
      preferenceEvents:s.preferenceEvents||[],rejectStagedAction:s.rejectStagedAction===true,
      sandboxTransport:s.sandboxTransport !== false,identificationStatus:s.identificationStatus||'NOT_CAUSAL',
    })
    const runId=`run-${s.id}`
    const run={id:runId,user_id:fixture.tenantId,client_id:client.id,invoice_id:s.invoice.id,status:'completed',transport:'sandbox',production_execution_authorized:false,summary:{hard_violations:result.hardViolations}}
    const proofEvent={id:`proof-${s.id}`,run_id:runId,user_id:fixture.tenantId,client_id:client.id,invoice_id:s.invoice.id,operational_state:result.state,proof:result.proof,real_side_effect:false,created_at:new Date(now.getTime()+index*600000+120000).toISOString()}
    cases.push({invoice:s.invoice,client,run,proofEvent})
    proofByRunId[runId]={operational_state:result.state,real_side_effect:false,hard_violations:result.hardViolations}
    transitions.push(...resultTransitions({result,runId,tenantId:fixture.tenantId,invoice:s.invoice,client,startMs:now.getTime()+index*600000}))
    const observed=['canonical','evidence','authority','verification','proof']
    dwChecks.push(projectDwCheck({runId,expected:manifest,observed,proof:proofByRunId[runId]}))
  })

  const liveFeed=projectLiveFeedReadModel({userId:fixture.tenantId,transitions,invoicesById,clientsById})
  const replay=projectReplayShift({liveFeedModel:liveFeed,proofByRunId})
  const whatsDone=projectWhatsDoneReadModel({userId:fixture.tenantId,cases})
  const needsYou=projectNeedsYouCommandReadModel({userId:fixture.tenantId,cases})
  const results=cases.map(c=>({runId:c.run.id,invoiceId:c.invoice.id,state:c.proofEvent.operational_state,hardViolations:c.run.summary.hard_violations,canonicalBefore:c.proofEvent.proof.canonicalFacts,canonicalAfter:c.proofEvent.proof.canonicalFacts,realSideEffect:c.proofEvent.real_side_effect,founderQuestionAsked:c.proofEvent.proof.founderQuestion?.asked===true}))

  return {
    fixture,results,transitions,liveFeed,replay,whatsDone,needsYou,dwChecks,
    summary:{
      cases:results.length,
      hardViolations:results.reduce((n,r)=>n+r.hardViolations.length,0),
      realSideEffects:results.filter(r=>r.realSideEffect).length,
      canonicalMoneyMutations:results.filter(r=>JSON.stringify(r.canonicalBefore)!==JSON.stringify(r.canonicalAfter)).length,
      founderQuestions:results.filter(r=>r.founderQuestionAsked).length,
      zeroSkippedChecks:dwChecks.filter(c=>c.canClaimZeroSilentlySkipped).length,
      replayRuns:replay.runCount,
      whatsDone:whatsDone.total,
      needsYou:needsYou.count,
    },
  }
}
