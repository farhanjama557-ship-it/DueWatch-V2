import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const componentUrl = new URL('../src/features/dwIntelligence/AskDwInvoiceLiveProbe.jsx', import.meta.url)
const invoiceUrl = new URL('../src/components/InvoiceDetailPanel.jsx', import.meta.url)

const component = fs.readFileSync(componentUrl, 'utf8')
const invoice = fs.readFileSync(invoiceUrl, 'utf8')

test('Ask DW is a production durable conversation using the existing live runtime', () => {
  assert.doesNotMatch(component, /import\.meta\.env\.DEV/)
  assert.match(component, /createAskDwDurableLiveConversationRuntime/)
  assert.match(component, /runConversationTurn/)
  assert.match(component, /companyBrainReadModel/)
  assert.match(component, /initialInvoiceIds/)
})

test('live probe scopes every request to authenticated tenant + current invoice', () => {
  assert.match(component, /tenantId:\s*user\.id/)
  assert.match(component, /invoiceId/)
  assert.match(component, /useAuth/)
})

test('the real surface preserves Normal and Deep across the same conversation', () => {
  assert.match(component, /setMode\('normal'\)/)
  assert.match(component, /setMode\('deep'\)/)
  assert.match(component, /conversationId:/)
  assert.match(component, /mode,/)
  assert.match(component, /keeps the same truth and safety floor/)
})

test('the real surface progressively reveals actual evidence and checks', () => {
  assert.match(component, /<summary>Evidence and checks<\/summary>/)
  assert.match(component, /reasoningTrail/)
  assert.match(component, /entry\?\.observable === true/)
  assert.doesNotMatch(component, /rawChainOfThought/)
})

test('degraded services are visible and never converted into a confident answer', () => {
  assert.match(component, /Company Brain is unavailable for this turn/)
  assert.match(component, /reasoning service is unavailable/)
  assert.match(component, /I have not guessed or taken action/)
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
  assert.match(invoice, /<AskDwInvoiceLiveProbe/)
  assert.match(invoice, /invoiceId=\{data\.id\}/)
  assert.match(invoice, /invoiceIds=\{invoices/)
  assert.match(invoice, /<DwInvoiceIntelligencePanel model=\{dwCase\} \/>/)
})

test('live probe contains no mojibake encoding artifacts', () => {
  assert.doesNotMatch(component, /\u00c3|\u00c2|\u00e2/)
})
