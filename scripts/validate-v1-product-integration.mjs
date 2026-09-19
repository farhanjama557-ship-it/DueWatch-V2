import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(root, rel))
const failures = []
function assert(ok, message) { if (!ok) failures.push(message) }

const app = read('src/App.jsx')
const sidebar = read('src/components/Sidebar.jsx')
const main = read('src/main.jsx')
const routes = [
  '/', '/invoices', '/import', '/imports', '/clients', '/promise-to-pay', '/cash-flow',
  '/autopilot', '/activity', '/reports', '/integrations', '/ask-dw', '/settings',
]
for (const route of routes.filter((r) => r !== '/')) {
  assert(app.includes(`path="${route}"`) || (route === '/imports' && app.includes('path="/imports"')), `missing route ${route}`)
}
for (const route of ['/invoices','/clients','/promise-to-pay','/cash-flow','/autopilot','/activity','/reports','/integrations','/settings','/ask-dw']) {
  assert(sidebar.includes(`to: '${route}'`) || sidebar.includes(`to="${route}"`), `sidebar missing ${route}`)
}
assert(main.includes("./styles/product-v1.css"), 'product-v1.css not loaded')
assert(exists('src/styles/product-v1.css'), 'product-v1.css missing')
assert(exists('src/components/PulseOrbHub.jsx'), 'PulseOrbHub missing')

const contracts = {
  'src/pages/Clients.jsx': ['Overview','Invoices','Payments','Promises','Activity','Notes','m2h_cp7_company_identity'],
  'src/pages/PromiseToPay.jsx': ['Calendar','List','All Promises','dw_proof_events','dw_evidence_items'],
  'src/pages/CashFlow.jsx': ['Forecast','Aging','Collections','payment_allocations'],
  'src/pages/Autopilot.jsx': ['Control Room','Rules','Modes','Approvals','Safety','Night Shift','Cash Recovery'],
  'src/pages/Activity.jsx': ['Timeline','Autopilot','Payments','DW proof'],
  'src/pages/Reports.jsx': ['Collections','Aging','Clients','Autopilot'],
  'src/pages/Integrations.jsx': ['Sources','Identity review','Import history','m2h_cp7_review_queue'],
  'src/pages/AskDw.jsx': ['Ask','Investigations','Proof journal','AskDwInvoiceLiveProbe'],
  'src/pages/Settings.jsx': ['Workspace','Time & contact','Notifications','Security'],
  'src/components/InvoiceDetailPanel.jsx': ['Overview','Evidence','Payments','History'],
}
for (const [file, strings] of Object.entries(contracts)) {
  const source = read(file)
  for (const value of strings) assert(source.includes(value), `${file} missing contract text: ${value}`)
}

const allUi = [
  'src/pages/Clients.jsx','src/pages/PromiseToPay.jsx','src/pages/CashFlow.jsx','src/pages/Autopilot.jsx',
  'src/pages/Activity.jsx','src/pages/Reports.jsx','src/pages/Integrations.jsx','src/pages/AskDw.jsx','src/pages/Settings.jsx',
  'src/components/PulseOrbHub.jsx','src/styles/product-v1.css',
].map(read).join('\n')
assert(!allUi.includes('Core Intelligence Center'), 'forbidden Core Intelligence Center copy reintroduced')
assert(!allUi.includes('AI-powered receivables intelligence'), 'forbidden generic AI copy reintroduced')

if (failures.length) {
  console.error(`V1 product integration validation failed (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('V1 product integration contract: PASS')
console.log(`routes=${routes.length}; room_contracts=${Object.keys(contracts).length}; forbidden_copy=0`)
