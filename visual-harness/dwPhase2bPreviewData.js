// LOCAL VISUAL-HARNESS DATA ONLY. Never used as production intelligence.
import { projectLiveFeedReadModel } from '../src/lib/dwIntelligence/phase2bLiveFeed.js'
import { projectReplayShift } from '../src/lib/dwIntelligence/phase2bReplayShift.js'
import { projectDwCheck, phase2bRequiredManifest } from '../src/lib/dwIntelligence/phase2bDwCheck.js'

const stateMessage = {
  HANDLED: 'DW handled this safely in sandbox.',
  APPROVAL: 'DW finished its review and needs founder approval before anything can execute.',
  WATCH: 'DW is watching this case; no verified action is currently authorized.',
  INVESTIGATING: 'DW found a fact conflict that must be verified before action.',
}
function caseModel(invoice, state, options = {}) {
  const balance=Math.max((Number(invoice.amount)||0)-(Number(invoice.amount_paid)||0),0)
  const needsFounder=state==='APPROVAL'
  return {
    available:true,runId:options.runId||`preview-${invoice.id}`,invoiceId:invoice.id,clientId:invoice.client_id,state,stateMessage:stateMessage[state],
    workPhase:options.live?'verifying':state==='HANDLED'?'handled':'waiting',nextWorkPhase:state==='INVESTIGATING'?'verifying':state==='HANDLED'?'handled':'waiting',live:options.live===true,
    lastUpdatedAt:options.lastUpdatedAt||'2026-08-15T13:30:00.000Z',
    canonical:{invoiceId:invoice.id,clientId:invoice.client_id,amount:Number(invoice.amount)||0,amountPaid:Number(invoice.amount_paid)||0,balance,dueDate:invoice.due_date,daysOverdue:options.daysOverdue||0,canonicalStatus:'OPEN',paid:false,settled:false,lastReminderAt:invoice.last_reminder||null},
    evidence:{admitted:2,contextOnly:0,rejected:0,quarantined:0,independentStrongRoots:2,total:2,records:[]},
    authority:{actual:needsFounder?'NOT_GRANTED':options.authorityGranted?'GRANTED':'NOT_GRANTED',policyAuthorized:true,canActAutomatically:options.authorityGranted===true,requiresApproval:needsFounder,executionBoundary:'REQUEST_BACKEND_REVALIDATION'},
    recommendation:options.recommendation||null,execution:{mode:state==='HANDLED'?'sandbox':'none',outcome:state==='HANDLED'?'SANDBOX_SENT':'NO_ACTION',realSideEffect:false},
    why:options.why||[{type:'canonical',text:'Invoice is canonically open.'},{type:'evidence',text:'2 independent strong evidence roots support this review.'}],
    needsFounder,founderAction:needsFounder?{kind:'APPROVAL_REQUIRED',label:'Review decision',boundary:'REQUEST_BACKEND_REVALIDATION',directlyExecutable:false}:null,
    proofIntegrity:{hardViolations:[],sandboxIntegrityOk:true,displayGrantsAuthority:false,directExecutionAvailable:false},
  }
}
export function buildDwPhase2bPreviewData({ userId, invoices }) {
  const usable=Array.isArray(invoices)?invoices.slice(0,4):[]
  if(usable.length<4)return null
  const cases=[
    caseModel(usable[0],'INVESTIGATING',{live:true,runId:'preview-live-run',daysOverdue:32}),
    caseModel(usable[1],'HANDLED',{authorityGranted:true,daysOverdue:18,recommendation:{action:'send_reminder',tone:'friendly'}}),
    caseModel(usable[2],'APPROVAL',{daysOverdue:7,recommendation:{action:'send_reminder',tone:'friendly'}}),
    caseModel(usable[3],'WATCH',{daysOverdue:0}),
  ]
  const clientsById=Object.fromEntries(usable.map(i=>[i.client_id,{id:i.client_id,user_id:userId,name:i.clients?.name||'Client'}]))
  const invoicesById=Object.fromEntries(usable.map(i=>[i.id,i]))
  const liveTransitions=[
    {id:'pv-a',run_id:'preview-live-run',user_id:userId,invoice_id:usable[0].id,client_id:usable[0].client_id,event_type:'ANALYZING',occurred_at:'2026-08-15T13:28:00Z',detail:'Checked canonical invoice state.'},
    {id:'pv-v',run_id:'preview-live-run',user_id:userId,invoice_id:usable[0].id,client_id:usable[0].client_id,event_type:'VERIFYING',occurred_at:'2026-08-15T13:29:00Z',detail:'Verifying a payment-status conflict.'},
    {id:'done-a',run_id:cases[1].runId,user_id:userId,invoice_id:usable[1].id,client_id:usable[1].client_id,event_type:'ANALYZING',occurred_at:'2026-08-15T13:20:00Z'},
    {id:'done-p',run_id:cases[1].runId,user_id:userId,invoice_id:usable[1].id,client_id:usable[1].client_id,event_type:'PREPARING',occurred_at:'2026-08-15T13:21:00Z'},
    {id:'done-h',run_id:cases[1].runId,user_id:userId,invoice_id:usable[1].id,client_id:usable[1].client_id,event_type:'HANDLED',occurred_at:'2026-08-15T13:22:00Z'},
  ]
  const liveFeed=projectLiveFeedReadModel({userId,transitions:liveTransitions,invoicesById,clientsById})
  const replay=projectReplayShift({liveFeedModel:liveFeed,proofByRunId:{[cases[1].runId]:{operational_state:'HANDLED',real_side_effect:false,hard_violations:[]}}})
  const manifest=phase2bRequiredManifest()
  const dwChecks=[projectDwCheck({runId:cases[1].runId,expected:manifest,observed:manifest.map(x=>x.id),proof:{hard_violations:[],real_side_effect:false}})]
  const casesByInvoiceId=Object.fromEntries(cases.map(x=>[x.invoiceId,x]))
  const whatsDoneEntries=cases.filter(x=>!x.live).map(item=>({runId:item.runId,invoiceId:item.invoiceId,clientId:item.clientId,at:item.lastUpdatedAt,kind:item.state==='HANDLED'?'HANDLED':item.state==='APPROVAL'?'ESCALATED':'WATCHED',state:item.state,title:item.state==='HANDLED'?'DW completed a sandbox workflow':item.state==='APPROVAL'?'DW escalated a decision':'DW kept the case under watch',detail:item.stateMessage,proofAvailable:true,realSideEffect:false,why:item.why}))
  const needsYouItems=cases.filter(x=>x.needsFounder).map(item=>({runId:item.runId,invoiceId:item.invoiceId,clientId:item.clientId,at:item.lastUpdatedAt,state:item.state,stateMessage:item.stateMessage,commandType:'APPROVAL_REVIEW',balance:item.canonical.balance,daysOverdue:item.canonical.daysOverdue,recommendation:item.recommendation,why:item.why,authority:item.authority,founderAction:item.founderAction,cta:'Review case',boundary:'REQUEST_BACKEND_REVALIDATION',directlyExecutable:false,browserMayGrantAuthority:false}))
  const pulse={userId,totalCases:cases.length,cashUnderManagement:cases.reduce((s,x)=>s+x.canonical.balance,0),handled:1,ready:0,approval:1,watching:1,investigating:1,uncertain:0,blocked:0,needsYou:1,liveJobs:liveFeed.activeCount,live:liveFeed.live,livePresence:{count:1,caseBacked:[{runId:cases[0].runId,invoiceId:cases[0].invoiceId,clientId:cases[0].clientId,workPhase:'verifying'}],runOnly:[]},headline:'DW has 4 cases under management. 1 needs your judgment.',cases,needsYouCases:[cases[2]],liveFeed}
  return {previewOnly:true,casesByInvoiceId,liveFeed,replay,dwChecks,whatsDone:{userId,total:whatsDoneEntries.length,summary:{handled:1,prepared:0,investigated:0,watched:1,escalated:1,withheld:0,hardViolations:0,realSideEffects:0,allProofAvailable:true},entries:whatsDoneEntries},needsYou:{userId,count:needsYouItems.length,items:needsYouItems,executionAvailable:false,authorityCanBeGrantedHere:false,boundary:'REQUEST_BACKEND_REVALIDATION'},pulse}
}
