import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDwPhase2bPreviewData } from '../visual-harness/dwPhase2bPreviewData.js'

const invoices = Array.from({ length: 4 }, (_, i) => ({
  id: `inv-${i + 1}`,
  user_id: 'visual-user',
  client_id: `client-${i + 1}`,
  clients: { id:`client-${i + 1}`, user_id:'visual-user', name:`Client ${i + 1}` },
  invoice_number: `INV-${i + 1}`,
  amount: (i + 1) * 1000,
  amount_paid: 0,
  paid: false,
  due_date: '2026-08-01',
}))

test('visual fixture creates exactly one truthful LIVE preview job', () => {
  const data = buildDwPhase2bPreviewData({ userId:'visual-user', invoices })
  assert.equal(data.previewOnly, true)
  assert.equal(data.pulse.live, true)
  assert.equal(data.pulse.liveJobs, 1)
  assert.equal(Object.values(data.casesByInvoiceId).filter((c) => c.live).length, 1)
})

test('visual approval preview is not directly executable', () => {
  const data = buildDwPhase2bPreviewData({ userId:'visual-user', invoices })
  const approval = data.pulse.needsYouCases[0]
  assert.equal(approval.state, 'APPROVAL')
  assert.equal(approval.authority.actual, 'NOT_GRANTED')
  assert.equal(approval.founderAction.directlyExecutable, false)
  assert.equal(approval.founderAction.boundary, 'REQUEST_BACKEND_REVALIDATION')
})
