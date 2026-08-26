import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const componentUrl = new URL('../src/features/dwIntelligence/AskDwInvoiceLiveProbe.jsx', import.meta.url)
const invoiceUrl = new URL('../src/components/InvoiceDetailPanel.jsx', import.meta.url)

const component = fs.readFileSync(componentUrl, 'utf8')
const invoice = fs.readFileSync(invoiceUrl, 'utf8')

test('live probe is development-only and uses the controlled activation runtime', () => {
  assert.match(component, /if \(!import\.meta\.env\.DEV\) return null/)
  assert.match(component, /createAskDwControlledActivationRuntime/)
  assert.match(component, /runInvoiceQuestion/)
  assert.match(component, /mode:\s*'normal'/)
})

test('live probe scopes every request to authenticated tenant + current invoice', () => {
  assert.match(component, /tenantId:\s*user\.id/)
  assert.match(component, /invoiceId/)
  assert.match(component, /useAuth/)
})

test('live probe contains no direct Groq/OpenAI fetch or provider secret', () => {
  assert.doesNotMatch(component, /api\.groq\.com/)
  assert.doesNotMatch(component, /api\.openai\.com/)
  assert.doesNotMatch(component, /GROQ_API_KEY/)
  assert.doesNotMatch(component, /OPENAI_API_KEY/)
  assert.doesNotMatch(component, /\bfetch\s*\(/)
})

test('invoice panel mounts the probe next to the existing DW intelligence panel', () => {
  assert.match(invoice, /AskDwInvoiceLiveProbe/)
  assert.match(invoice, /<AskDwInvoiceLiveProbe invoiceId=\{data\.id\} \/>/)
  assert.match(invoice, /<DwInvoiceIntelligencePanel model=\{dwCase\} \/>/)
})

test('live probe contains no mojibake encoding artifacts', () => {
  assert.doesNotMatch(component, /\u00c3|\u00c2|\u00e2/)
})