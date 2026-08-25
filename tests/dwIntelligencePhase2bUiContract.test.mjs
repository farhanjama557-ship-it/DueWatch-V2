import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pulse = read('src/features/dwIntelligence/DwPulseIntelligence.jsx')
const detail = read('src/features/dwIntelligence/DwInvoiceIntelligencePanel.jsx')
const queue = read('src/features/dwIntelligence/DwNeedsYouQueue.jsx')
const live = read('src/features/dwIntelligence/DwLiveBadge.jsx')
const css = read('src/features/dwIntelligence/dwIntelligencePhase2b.css')

test('Phase 2B UI components have no network, Supabase, provider, or execution imports', () => {
  const joined = [pulse, detail, live, queue].join('\n')
  for (const forbidden of ['supabase', 'sendReminderNow', 'sendEmail', 'fetch(', 'axios', 'RESEND', 'executeAutoSend', 'executeApprovalSend']) {
    assert.equal(joined.includes(forbidden), false, `forbidden UI capability: ${forbidden}`)
  }
})

test('Needs You review action only opens an invoice and never approves', () => {
  assert.ok(queue.includes('onOpenInvoice?.(item.invoiceId)'))
  assert.ok(queue.includes('server-side revalidation'))
  assert.equal(queue.includes('onApprove'), false)
  assert.equal(pulse.includes('onApprove'), false)
})

test('invoice panel explicitly states backend revalidation boundary', () => {
  assert.ok(detail.includes('Any approval must be revalidated by the server before execution.'))
  assert.ok(detail.includes('data-dw-read-only="true"'))
})

test('LIVE dot animation is reduced-motion safe and tied to is-live class', () => {
  assert.ok(css.includes('.dw-live-badge.is-live .dw-live-dot'))
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'))
  assert.ok(live.includes("data-dw-live={live.active ? 'true' : 'false'}"))
})
