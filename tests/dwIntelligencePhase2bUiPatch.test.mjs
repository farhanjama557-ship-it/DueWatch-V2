import test from 'node:test'
import assert from 'node:assert/strict'
import {
  patchDashboard,
  patchInvoiceDetailPanel,
  patchVisualHarnessData,
  gitBlobSha,
} from '../scripts/ci/apply-dw-phase2b-increment5-ui.mjs'

test('git blob SHA implementation matches Git framing', () => {
  // Known Git object example: SHA1("blob 0\\0")
  assert.equal(gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

test('Dashboard patch adds optional read-only command room and invoice case seam', () => {
  const base = [
    "import DuewatchAssistant from '../components/DuewatchAssistant'",
    '    lastSyncedAt,',
    '  } = useData()',
    '        <div className="brief-main">',
    '          <section className="kpi-grid">',
    '        onSignatureResolved={resolveSignatureLocal}',
    '      />',
  ].join('\n')
  const out = patchDashboard(base)
  assert.ok(out.includes('DwPulseIntelligence'))
  assert.ok(out.includes('model={dwIntelligence?.pulse ?? null}'))
  assert.ok(out.includes('dwCase={dwIntelligence?.casesByInvoiceId?.[selected?.id] ?? null}'))
  assert.equal(patchDashboard(out), out)
})

test('Invoice detail patch adds read-only case file after JourneyBar', () => {
  const base = [
    "import CognitiveCompose from '../features/reminders/CognitiveCompose'",
    '  signatureContext = null,',
    '  onSignatureResolved,',
    '}) {',
    '          <JourneyBar',
    '            invoice={data}',
    '            isPendingSignature={hasPendingSignature}',
    '            hasAutopilotRun={hasCompletedAutopilotRun}',
    '          />',
  ].join('\n')
  const out = patchInvoiceDetailPanel(base)
  assert.ok(out.includes('DwInvoiceIntelligencePanel'))
  assert.ok(out.includes('dwCase = null'))
  assert.ok(out.includes('<DwInvoiceIntelligencePanel model={dwCase} />'))
  assert.equal(patchInvoiceDetailPanel(out), out)
})

test('visual harness patch is explicitly local and injects preview data only into mock context', () => {
  const base = [
    "const events = isExact ? exactEvents : truthfulEvents",
    '',
    'const value = {',
    '  userId,',
    '  invoices,',
  ].join('\n')
  const out = patchVisualHarnessData(base)
  assert.ok(out.includes('buildDwPhase2bPreviewData'))
  assert.ok(out.includes('LOCAL VISUAL HARNESS ONLY'))
  assert.ok(out.includes('  dwIntelligence,'))
  assert.equal(patchVisualHarnessData(out), out)
})
