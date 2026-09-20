import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('../src/overhaul/OverhaulShell.jsx', import.meta.url), 'utf8')
const pages = await readFile(new URL('../src/overhaul/OverhaulPages.jsx', import.meta.url), 'utf8')
const pulse = await readFile(new URL('../src/overhaul/LockedPulse.jsx', import.meta.url), 'utf8')

test('UI v2 owns every product route while legacy Pulse stays isolated', () => {
  for (const route of [
    '/invoices',
    '/clients',
    '/promise-to-pay',
    '/cash-flow',
    '/autopilot',
    '/activity',
    '/reports',
    '/integrations',
    '/settings',
    '/import',
    '/imports',
  ]) {
    assert.ok(app.includes(`path="${route}"`), `missing new-shell route ${route}`)
  }

  assert.ok(app.includes('<OverhaulShell />'))
  assert.ok(app.includes('path="/legacy-pulse"'))
  assert.ok(app.includes('<Layout />'))
  assert.equal((app.match(/<Layout \/>/g) || []).length, 1, 'legacy Layout must only be mounted once')
})

test('Promise-to-Pay and Integrations are live navigation destinations, not disabled placeholders', () => {
  assert.ok(shell.includes("to: '/promise-to-pay'"))
  assert.ok(shell.includes("to: '/integrations'"))
  assert.equal(shell.includes("{ label: 'Promise-to-Pay', disabled: true"), false)
  assert.equal(shell.includes("{ label: 'Integrations', disabled: true"), false)
})

test('new UI does not ship the old demo-company fixtures as live-looking data', () => {
  const combined = pages + '\n' + pulse
  for (const fake of ['Atlas Freight', 'Northstar Labs', 'Luma Studio']) {
    assert.equal(combined.includes(fake), false, `fixture leaked into UI v2: ${fake}`)
  }
})

test('Autopilot UI reflects the actual Normal-mode-only authority contract', () => {
  assert.ok(pages.includes('Operating mode'))
  assert.ok(pages.includes('<strong>Normal</strong>'))
  assert.ok(pages.includes('current production authority model is Normal-mode only'))
  assert.equal(pages.includes('className="is-selected">Night Shift'), false)
  assert.equal(pages.includes('Cash Recovery</button>'), false)
  assert.equal(pages.includes('Quarter-End</button>'), false)
})

test('Integrations never claim unsupported providers are connected', () => {
  assert.ok(pages.includes("state: 'not_configured'"))
  assert.ok(pages.includes('No user-facing OAuth connection is configured in this build.'))
  assert.ok(pages.includes('No connect action available'))
})

test('Pulse and product pages use real data seams rather than static financial fixtures', () => {
  assert.ok(pulse.includes('useData()'))
  assert.ok(pulse.includes('formatMoney(outstanding)'))
  assert.ok(pages.includes("from('promises')"))
  assert.ok(pages.includes('fetchAutopilotRules'))
  assert.ok(pages.includes('InvoiceDetailPanel'))
  assert.ok(pages.includes('AddInvoiceModal'))
})
