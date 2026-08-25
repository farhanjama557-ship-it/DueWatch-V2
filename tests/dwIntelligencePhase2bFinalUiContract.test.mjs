import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildDwPhase2bPreviewData } from '../visual-harness/dwPhase2bPreviewData.js'
import { patchFinalActivity } from '../scripts/ci/apply-dw-phase2b-final-ui.mjs'

const U='visual-user'
const clients=['A','B','C','D'].map((name,i)=>({id:`c${i}`,user_id:U,name}))
const invoices=clients.map((c,i)=>({id:`i${i}`,user_id:U,client_id:c.id,clients:c,invoice_number:`INV-${i}`,inv_num:`INV-${i}`,amount:1000+i*100,amount_paid:0,due_date:'2026-08-01',paid:false}))
const preview=buildDwPhase2bPreviewData({userId:U,invoices})

test('visual preview uses actual transition model for one LIVE job',()=>{assert.equal(preview.liveFeed.live,true); assert.equal(preview.liveFeed.activeCount,1); assert.equal(preview.pulse.liveFeed,preview.liveFeed)})
test('visual preview Replay shares the LIVE transition spine',()=>{assert.ok(preview.replay.runCount>=2); assert.ok(preview.replay.runs.every(r=>r.reconstructionSource==='persisted_transition_history'))})
test('visual preview DW Check proves explicit manifest with zero skipped',()=>{assert.equal(preview.dwChecks.length,1); assert.equal(preview.dwChecks[0].canClaimZeroSilentlySkipped,true); assert.equal(preview.dwChecks[0].silentlySkipped,0)})
test('visual preview contains no real side effects',()=>{assert.equal(preview.whatsDone.summary.realSideEffects,0); assert.ok(preview.liveFeed.feed.every(e=>e.realSideEffect===false))})
test('visual preview founder queue remains non executable',()=>{assert.equal(preview.needsYou.executionAvailable,false); assert.ok(preview.needsYou.items.every(x=>x.directlyExecutable===false))})

const root=path.resolve(process.cwd())
test('Pulse renders Live Feed from model.liveFeed',()=>{const s=fs.readFileSync(path.join(root,'src/features/dwIntelligence/DwPulseIntelligence.jsx'),'utf8'); assert.match(s,/DwLiveFeed/); assert.match(s,/model\.liveFeed/); assert.doesNotMatch(s,/sendReminder|approveSignature|recordInvoicePayment/)})
test('LIVE badge presentation can refuse stale aggregate activity',()=>{const s=fs.readFileSync(path.join(root,'src/lib/dwIntelligence/phase2bUiPresentation.js'),'utf8'); assert.match(s,/staleActiveCount/); assert.match(s,/LIVE is not asserted/)})
test('Replay and DW Check surface is read only',()=>{const s=fs.readFileSync(path.join(root,'src/features/dwIntelligence/DwReplayCheckSurface.jsx'),'utf8'); assert.match(s,/data-dw-read-only="true"/); assert.doesNotMatch(s,/onApprove|onExecute|sendReminder|supabase/)})
test('reduced-motion rule covers LIVE Replay and DW Check',()=>{const s=fs.readFileSync(path.join(root,'src/features/dwIntelligence/dwIntelligencePhase2b.css'),'utf8'); assert.match(s,/prefers-reduced-motion/); assert.match(s,/dw-live-feed/); assert.match(s,/dw-replay-shift/); assert.match(s,/dw-check-panel/)})

test('final Activity patch adds Replay and DW Check without removing legacy controls',()=>{
 const base=["import { useAuth } from '../context/AuthContext'",'  const { user } = useAuth()','  const [events, setEvents] = useState([])','      <p className="brief-subline">Everything you and Duewatch have done.</p>','','      <div className="list-controls">'].join('\n')
 const out=patchFinalActivity(base)
 assert.match(out,/DwWhatsDoneJournal/); assert.match(out,/DwReplayCheckSurface/); assert.match(out,/dwIntelligence\?\.replay/); assert.match(out,/dwIntelligence\?\.dwChecks/); assert.match(out,/list-controls/)
 assert.equal(patchFinalActivity(out),out)
})

test('Live Feed contains no timer/random theater generator',()=>{
 const s=fs.readFileSync(path.join(root,'src/features/dwIntelligence/DwLiveFeed.jsx'),'utf8')
 assert.doesNotMatch(s,/setInterval|setTimeout|Math\.random|requestAnimationFrame/)
})

test('LIVE freshness is explicit input rather than a hidden magic timer',()=>{
 const s=fs.readFileSync(path.join(root,'src/lib/dwIntelligence/phase2bLiveFeed.js'),'utf8')
 assert.match(s,/freshnessMs = null/); assert.match(s,/freshnessApplied/)
})

test('final repo UI patch defaults to check-only and writes only with --apply',()=>{
 const s=fs.readFileSync(path.join(root,'scripts/ci/apply-dw-phase2b-final-ui.mjs'),'utf8')
 assert.match(s,/const apply = args\.has\('--apply'\)/); assert.match(s,/if \(apply && patched !== original\) fs\.writeFileSync/)
})
