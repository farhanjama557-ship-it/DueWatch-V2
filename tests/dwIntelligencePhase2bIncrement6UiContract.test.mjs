import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const queue=read('src/features/dwIntelligence/DwNeedsYouQueue.jsx')
const journal=read('src/features/dwIntelligence/DwWhatsDoneJournal.jsx')
const pulse=read('src/features/dwIntelligence/DwPulseIntelligence.jsx')

test('Increment 6 display components import no network, database, or execution capability',()=>{
  const joined=[queue,journal,pulse].join('\n')
  for(const forbidden of ['supabase','sendReminderNow','sendEmail','fetch(','axios','executeAutoSend','approveSignature','recordInvoicePayment']) assert.equal(joined.includes(forbidden),false,forbidden)
})

test('Needs You only opens a case and explicitly says server revalidation is required',()=>{
  assert.ok(queue.includes('onOpenInvoice?.(item.invoiceId)'))
  assert.ok(queue.includes('requires current server-side revalidation'))
  assert.equal(queue.includes('onApprove'),false)
})

test('Whats Done is explicitly read-only and does not fabricate a clickable affordance without a handler',()=>{
  assert.ok(journal.includes('This journal is a read-only proof surface'))
  assert.ok(journal.includes("typeof onOpenInvoice === 'function'"))
  assert.ok(journal.includes('<div className="dw-work-journal-row">'))
})

test('Pulse no longer duplicates the detailed Needs You queue',()=>{
  assert.equal(pulse.includes('dw-needs-you-head'),false)
  assert.ok(pulse.includes('dw-command-metrics'))
})
