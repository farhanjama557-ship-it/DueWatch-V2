import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCompatibilityReport } from './system-brain/compatibility-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const brainDir = path.join(repoRoot, '.system-brain')

const codePath = path.join(brainDir, 'code-capabilities.v0.json')
const deploymentPath = path.join(brainDir, 'deployment-fingerprint.v0.json')
const outPath = path.join(brainDir, 'compatibility-report.v0.json')

const [codeRaw, deploymentRaw] = await Promise.all([
  fs.readFile(codePath, 'utf8'),
  fs.readFile(deploymentPath, 'utf8'),
])

const codeManifest = JSON.parse(codeRaw.replace(/^\uFEFF/, ''))
const deploymentFingerprint = JSON.parse(deploymentRaw.replace(/^\uFEFF/, ''))
const report = buildCompatibilityReport(codeManifest, deploymentFingerprint)

await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  compatibility_version: report.meta.compatibility_version,
  output: path.relative(repoRoot, outPath).split(path.sep).join('/'),
  compatible: report.compatible,
  runtime_policy: report.runtime_policy,
  ...report.counts,
  incompatible_dependencies: report.incompatible_dependencies.map((item) => ({
    kind: item.kind,
    name: item.name,
    status: item.status,
    missing_columns: item.missing_columns,
  })),
  aggregate_hash: report.meta.aggregate_hash,
}, null, 2))
