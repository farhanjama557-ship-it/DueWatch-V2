import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXPECTED_GIT_BLOBS,
  gitBlobSha,
  patchDashboard,
  patchInvoiceDetailPanel,
  patchActivity,
  patchVisualHarnessData,
} from './apply-dw-phase2b-increment6-ui.mjs'

function replaceOnce(text, needle, replacement, label) {
  const count = text.split(needle).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`)
  return text.replace(needle, replacement)
}

export function patchFinalDashboard(text) {
  return patchDashboard(text)
}

export function patchFinalInvoiceDetailPanel(text) {
  return patchInvoiceDetailPanel(text)
}

export function patchFinalActivity(text) {
  let out = patchActivity(text)
  if (!out.includes('DwReplayCheckSurface')) {
    out = replaceOnce(
      out,
      "import DwWhatsDoneJournal from '../features/dwIntelligence/DwWhatsDoneJournal'",
      "import DwWhatsDoneJournal from '../features/dwIntelligence/DwWhatsDoneJournal'\nimport DwReplayCheckSurface from '../features/dwIntelligence/DwReplayCheckSurface'",
      'Activity Replay/DW Check import'
    )
  }
  if (!out.includes('<DwReplayCheckSurface')) {
    const anchor = `      <DwWhatsDoneJournal\n        model={dwIntelligence?.whatsDone ?? null}\n        invoices={invoices}\n      />`
    out = replaceOnce(
      out,
      anchor,
      `${anchor}\n\n      <DwReplayCheckSurface\n        replay={dwIntelligence?.replay ?? null}\n        checks={dwIntelligence?.dwChecks ?? []}\n      />`,
      'Activity Replay/DW Check insertion'
    )
  }
  return out
}

export function patchFinalVisualHarnessData(text) {
  return patchVisualHarnessData(text)
}

function main() {
  const args = new Set(process.argv.slice(2))
  const apply = args.has('--apply')
  const rootArg = process.argv.find((arg) => arg.startsWith('--repo='))
  const repoRoot = rootArg ? path.resolve(rootArg.slice('--repo='.length)) : process.cwd()
  const files = [
    ['src/pages/Dashboard.jsx', patchFinalDashboard, 'DwPulseIntelligence'],
    ['src/components/InvoiceDetailPanel.jsx', patchFinalInvoiceDetailPanel, 'DwInvoiceIntelligencePanel'],
    ['src/pages/Activity.jsx', patchFinalActivity, 'DwReplayCheckSurface'],
    ['visual-harness/mockDataContext.js', patchFinalVisualHarnessData, 'buildDwPhase2bPreviewData'],
  ]
  for (const [relative, patcher, finalMarker] of files) {
    const full = path.join(repoRoot, relative)
    if (!fs.existsSync(full)) throw new Error(`Missing ${relative}`)
    const original = fs.readFileSync(full, 'utf8')
    const finalIntegrated = original.includes(finalMarker)
    const incrementIntegrated =
      (relative.endsWith('Dashboard.jsx') && original.includes('DwNeedsYouQueue')) ||
      (relative.endsWith('InvoiceDetailPanel.jsx') && original.includes('DwInvoiceIntelligencePanel')) ||
      (relative.endsWith('Activity.jsx') && original.includes('DwWhatsDoneJournal')) ||
      (relative.endsWith('mockDataContext.js') && original.includes('buildDwPhase2bPreviewData'))
    if (!finalIntegrated && !incrementIntegrated && gitBlobSha(original) !== EXPECTED_GIT_BLOBS[relative]) {
      throw new Error(`${relative}: blob drifted; refusing to patch unreviewed source`)
    }
    const patched = patcher(original)
    if (apply && patched !== original) fs.writeFileSync(full, patched)
    console.log(`${apply ? 'APPLY' : 'CHECK'} ${relative}: ${patched === original ? 'already integrated' : 'ready'}`)
  }
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self)) main()
