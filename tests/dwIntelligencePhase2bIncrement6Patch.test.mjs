import test from 'node:test'
import assert from 'node:assert/strict'
import { patchDashboard, patchInvoiceDetailPanel, patchActivity, patchVisualHarnessData, gitBlobSha } from '../scripts/ci/apply-dw-phase2b-increment6-ui.mjs'

test('git blob helper remains Git-compatible',()=>assert.equal(gitBlobSha(''),'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'))

test('Dashboard cumulative patch adds Pulse, DW Needs You, and case detail seam',()=>{
  const base=["import DuewatchAssistant from '../components/DuewatchAssistant'",'    lastSyncedAt,','  } = useData()','        <div className="brief-main">','          <section className="kpi-grid">','        <aside className="pulse-rail">','          {awaitingSignature.length > 0 && (','        onSignatureResolved={resolveSignatureLocal}','      />'].join('\n')
  const out=patchDashboard(base)
  assert.ok(out.includes('DwPulseIntelligence')); assert.ok(out.includes('DwNeedsYouQueue')); assert.ok(out.includes('dwIntelligence?.needsYou')); assert.ok(out.includes('dwCase={dwIntelligence?.casesByInvoiceId?.[selected?.id] ?? null}'))
  assert.equal(patchDashboard(out),out)
})

test('Activity patch adds read-only Whats Done journal without replacing legacy activity',()=>{
  const base=["import { useAuth } from '../context/AuthContext'",'  const { user } = useAuth()','  const [events, setEvents] = useState([])','      <p className="brief-subline">Everything you and Duewatch have done.</p>','','      <div className="list-controls">'].join('\n')
  const out=patchActivity(base)
  assert.ok(out.includes('DwWhatsDoneJournal')); assert.ok(out.includes('dwIntelligence?.whatsDone')); assert.ok(out.includes('<div className="list-controls">')); assert.equal(patchActivity(out),out)
})

test('Invoice detail and visual harness cumulative patches remain idempotent',()=>{
  const inv=["import CognitiveCompose from '../features/reminders/CognitiveCompose'",'  signatureContext = null,','  onSignatureResolved,','}) {','          <JourneyBar','            invoice={data}','            isPendingSignature={hasPendingSignature}','            hasAutopilotRun={hasCompletedAutopilotRun}','          />'].join('\n')
  const i=patchInvoiceDetailPanel(inv); assert.equal(patchInvoiceDetailPanel(i),i)
  const vis=['const events = isExact ? exactEvents : truthfulEvents','','const value = {','  userId,','  invoices,'].join('\n')
  const v=patchVisualHarnessData(vis); assert.ok(v.includes('dwIntelligence')); assert.equal(patchVisualHarnessData(v),v)
})
