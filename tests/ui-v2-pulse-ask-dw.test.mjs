import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const runtime = await readFile(new URL('../src/overhaul/integration/pulseAskDw.js', import.meta.url), 'utf8')
const pulse = await readFile(new URL('../src/overhaul/LockedPulse.jsx', import.meta.url), 'utf8')

test('Pulse Ask DW uses the governed resolver and controlled invoice runtime', () => {
  assert.match(runtime, /createAskDwEntityResolver/)
  assert.match(runtime, /createAskDwControlledActivationRuntime/)
  assert.match(runtime, /controlled\.runInvoiceQuestion/)
  assert.match(runtime, /resolver\.resolveCaseEvents/)
})

test('portfolio action requests are fail-closed and do not invoke execution', () => {
  assert.match(runtime, /intent\.job === ASK_DW_JOB\.ACT/)
  assert.match(runtime, /Ask DW does not execute portfolio actions/)
  assert.doesNotMatch(runtime, /sendReminderNow/)
  assert.doesNotMatch(runtime, /recordInvoicePayment/)
  assert.doesNotMatch(runtime, /functions\.invoke/)
})

test('portfolio cash answer is explicitly timing, not unsupported prediction', () => {
  assert.match(runtime, /This is invoice-date cash timing, not a predictive cash forecast/)
  assert.match(runtime, /does not infer an unsupported business-cause/)
})

test('Pulse Ask UI is interactive rather than read-only decoration', () => {
  assert.match(pulse, /createPulseAskDwRuntime/)
  assert.match(pulse, /onSubmit=/)
  assert.match(pulse, /runPulseAskDw/)
  assert.match(pulse, /value=\{askQuestion\}/)
  assert.doesNotMatch(pulse, /placeholder="Ask DW anything about your receivables\.\.\." readOnly/)
})
