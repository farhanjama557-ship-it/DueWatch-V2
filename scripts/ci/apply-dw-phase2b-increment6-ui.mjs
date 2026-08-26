import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const EXPECTED_GIT_BLOBS = Object.freeze({
  'src/pages/Dashboard.jsx': 'a60217825c88acb48d8d62f3449f99a65fc93cb3',
  'src/components/InvoiceDetailPanel.jsx': 'cbf914510442ce6f4511cda7151f05e468ca7f69',
  'src/pages/Activity.jsx': '3cf3a00c4dfa0ad6cd96a5287185e45013ec0559',
  'visual-harness/mockDataContext.js': '00b255a1341cc3ffbbefb97e5511c62b49880560',
})

export function gitBlobSha(text) {
  const bytes = Buffer.from(text, 'utf8')
  return crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex')
}

function replaceOnce(text, needle, replacement, label) {
  const count = text.split(needle).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`)
  return text.replace(needle, replacement)
}

export function patchDashboard(text) {
  if (text.includes('DwNeedsYouQueue') && text.includes('DwPulseIntelligence')) return text
  let out = text
  if (!out.includes('DwPulseIntelligence')) {
    out = replaceOnce(
      out,
      "import DuewatchAssistant from '../components/DuewatchAssistant'",
      "import DuewatchAssistant from '../components/DuewatchAssistant'\nimport DwPulseIntelligence from '../features/dwIntelligence/DwPulseIntelligence'\nimport DwNeedsYouQueue from '../features/dwIntelligence/DwNeedsYouQueue'",
      'Dashboard DW imports'
    )
  } else if (!out.includes('DwNeedsYouQueue')) {
    out = replaceOnce(
      out,
      "import DwPulseIntelligence from '../features/dwIntelligence/DwPulseIntelligence'",
      "import DwPulseIntelligence from '../features/dwIntelligence/DwPulseIntelligence'\nimport DwNeedsYouQueue from '../features/dwIntelligence/DwNeedsYouQueue'",
      'Dashboard Needs You import'
    )
  }

  if (!out.includes('dwIntelligence,')) {
    out = replaceOnce(
      out,
      '    lastSyncedAt,\n  } = useData()',
      '    lastSyncedAt,\n    // Phase 2B: optional, read-only intelligence projection.\n    dwIntelligence,\n  } = useData()',
      'Dashboard DataContext seam'
    )
  }

  if (!out.includes('<DwPulseIntelligence')) {
    out = replaceOnce(
      out,
      '        <div className="brief-main">\n          <section className="kpi-grid">',
      `        <div className="brief-main">\n          <DwPulseIntelligence\n            model={dwIntelligence?.pulse ?? null}\n            invoices={invoices}\n            onOpenInvoice={(invoiceId) => {\n              const target = invoices.find((inv) => inv.id === invoiceId)\n              if (target) setSelected(target)\n            }}\n          />\n\n          <section className="kpi-grid">`,
      'Dashboard Pulse insertion'
    )
  }

  if (!out.includes('dwCase={dwIntelligence?.casesByInvoiceId?.[selected?.id] ?? null}')) {
    out = replaceOnce(
      out,
      '        onSignatureResolved={resolveSignatureLocal}\n      />',
      '        onSignatureResolved={resolveSignatureLocal}\n        dwCase={dwIntelligence?.casesByInvoiceId?.[selected?.id] ?? null}\n      />',
      'Dashboard invoice DW case prop'
    )
  }

  if (!out.includes('<DwNeedsYouQueue')) {
    out = replaceOnce(
      out,
      '        <aside className="pulse-rail">\n          {awaitingSignature.length > 0 && (',
      `        <aside className="pulse-rail">\n          <DwNeedsYouQueue\n            model={dwIntelligence?.needsYou ?? null}\n            invoices={invoices}\n            onOpenInvoice={(invoiceId) => {\n              const target = invoices.find((inv) => inv.id === invoiceId)\n              if (target) setSelected(target)\n            }}\n          />\n\n          {awaitingSignature.length > 0 && (`,
      'Dashboard Needs You queue insertion'
    )
  }

  return out
}

export function patchInvoiceDetailPanel(text) {
  if (text.includes('DwInvoiceIntelligencePanel')) return text
  let out = replaceOnce(
    text,
    "import CognitiveCompose from '../features/reminders/CognitiveCompose'",
    "import CognitiveCompose from '../features/reminders/CognitiveCompose'\nimport DwInvoiceIntelligencePanel from '../features/dwIntelligence/DwInvoiceIntelligencePanel'",
    'Invoice detail import'
  )
  out = replaceOnce(
    out,
    '  signatureContext = null,\n  onSignatureResolved,\n}) {',
    '  signatureContext = null,\n  onSignatureResolved,\n  // Read-only Phase 2B projection. Never execution authority.\n  dwCase = null,\n}) {',
    'Invoice detail prop'
  )
  out = replaceOnce(
    out,
    '          <JourneyBar\n            invoice={data}\n            isPendingSignature={hasPendingSignature}\n            hasAutopilotRun={hasCompletedAutopilotRun}\n          />',
    '          <JourneyBar\n            invoice={data}\n            isPendingSignature={hasPendingSignature}\n            hasAutopilotRun={hasCompletedAutopilotRun}\n          />\n\n          <DwInvoiceIntelligencePanel model={dwCase} />',
    'Invoice DW case insertion'
  )
  return out
}

export function patchActivity(text) {
  if (text.includes('DwWhatsDoneJournal')) return text
  let out = replaceOnce(
    text,
    "import { useAuth } from '../context/AuthContext'",
    "import { useAuth } from '../context/AuthContext'\nimport { useData } from '../context/DataContext'\nimport DwWhatsDoneJournal from '../features/dwIntelligence/DwWhatsDoneJournal'\nimport DwReplayCheckSurface from '../features/dwIntelligence/DwReplayCheckSurface'",
    'Activity imports'
  )
  out = replaceOnce(
    out,
    '  const { user } = useAuth()\n  const [events, setEvents] = useState([])',
    '  const { user } = useAuth()\n  const { invoices, dwIntelligence } = useData()\n  const [events, setEvents] = useState([])',
    'Activity DataContext seam'
  )
  out = replaceOnce(
    out,
    '      <p className="brief-subline">Everything you and Duewatch have done.</p>\n\n      <div className="list-controls">',
    `      <p className="brief-subline">Everything you and Duewatch have done.</p>\n\n      <DwWhatsDoneJournal\n        model={dwIntelligence?.whatsDone ?? null}\n        invoices={invoices}\n      />\n\n      <div className="list-controls">`,
    'Activity What\'s Done insertion'
  )
  return out
}

export function patchVisualHarnessData(text) {
  if (text.includes('buildDwPhase2bPreviewData')) return text
  let out = `import { buildDwPhase2bPreviewData } from './dwPhase2bPreviewData'\n\n${text}`
  out = replaceOnce(
    out,
    'const events = isExact ? exactEvents : truthfulEvents\n\nconst value = {',
    'const events = isExact ? exactEvents : truthfulEvents\n\n// LOCAL VISUAL HARNESS ONLY — explicit proof data, never hosted/project data.\nconst dwIntelligence = buildDwPhase2bPreviewData({ userId, invoices })\n\nconst value = {',
    'Visual harness preview builder'
  )
  out = replaceOnce(
    out,
    '  userId,\n  invoices,',
    '  userId,\n  invoices,\n  dwIntelligence,',
    'Visual harness DataContext value'
  )
  return out
}

function main() {
  const args = new Set(process.argv.slice(2))
  const apply = args.has('--apply')
  const rootArg = process.argv.find((arg) => arg.startsWith('--repo='))
  const repoRoot = rootArg ? path.resolve(rootArg.slice('--repo='.length)) : process.cwd()
  const files = [
    ['src/pages/Dashboard.jsx', patchDashboard],
    ['src/components/InvoiceDetailPanel.jsx', patchInvoiceDetailPanel],
    ['src/pages/Activity.jsx', patchActivity],
    ['visual-harness/mockDataContext.js', patchVisualHarnessData],
  ]

  for (const [relative, patcher] of files) {
    const full = path.join(repoRoot, relative)
    if (!fs.existsSync(full)) throw new Error(`Missing ${relative}`)
    const original = fs.readFileSync(full, 'utf8')
    const currentSha = gitBlobSha(original)
    const alreadyPatched =
      (relative.endsWith('Dashboard.jsx') && original.includes('DwNeedsYouQueue')) ||
      (relative.endsWith('InvoiceDetailPanel.jsx') && original.includes('DwInvoiceIntelligencePanel')) ||
      (relative.endsWith('Activity.jsx') && original.includes('DwWhatsDoneJournal')) ||
      (relative.endsWith('mockDataContext.js') && original.includes('buildDwPhase2bPreviewData'))
    if (!alreadyPatched && currentSha !== EXPECTED_GIT_BLOBS[relative]) {
      throw new Error(`${relative}: blob drifted (${currentSha}); refusing to patch an unreviewed file`)
    }
    const patched = patcher(original)
    if (apply && patched !== original) fs.writeFileSync(full, patched)
    console.log(`${apply ? 'APPLY' : 'CHECK'} ${relative}: ${patched === original ? 'already integrated' : 'ready'}`)
  }
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self)) main()
