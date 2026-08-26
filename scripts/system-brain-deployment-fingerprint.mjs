import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDeploymentFingerprint } from './system-brain/deployment-fingerprint-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const inputArg = process.argv.indexOf('--input')
const inputPath = inputArg >= 0 && process.argv[inputArg + 1]
  ? path.resolve(process.argv[inputArg + 1])
  : path.join(repoRoot, '.system-brain', 'deployment-source.current.json')
const outFile = path.join(repoRoot, '.system-brain', 'deployment-fingerprint.v0.json')

const raw = await fs.readFile(inputPath, 'utf8')
const source = JSON.parse(raw.replace(/^\uFEFF/, ''))
const fingerprint = buildDeploymentFingerprint(source)

await fs.mkdir(path.dirname(outFile), { recursive: true })
await fs.writeFile(outFile, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  fingerprint_version: fingerprint.meta.fingerprint_version,
  output: path.relative(repoRoot, outFile).split(path.sep).join('/'),
  project_ref: fingerprint.meta.project_ref,
  schema: fingerprint.meta.schema,
  ...fingerprint.summary,
  tenant_row_data_read: fingerprint.meta.tenant_row_data_read,
  aggregate_hash: fingerprint.meta.aggregate_hash,
}, null, 2))
