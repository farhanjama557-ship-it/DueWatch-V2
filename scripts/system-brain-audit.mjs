import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeCodeCapabilityAudit } from './system-brain/code-audit-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const outFile = path.join(repoRoot, '.system-brain', 'code-capabilities.v0.json')

const manifest = await writeCodeCapabilityAudit({ repoRoot, outFile })

console.log(JSON.stringify({
  audit_version: manifest.meta.audit_version,
  output: path.relative(repoRoot, outFile).split(path.sep).join('/'),
  routes: manifest.routes.length,
  ask_dw_read_tools: manifest.ask_dw_tools.length,
  data_dependencies: manifest.data_dependencies.length,
  authority_actions: manifest.authority_actions.map((x) => x.action),
  tenant_row_data_read: manifest.meta.tenant_row_data_read,
  aggregate_hash: manifest.meta.aggregate_hash,
}, null, 2))
