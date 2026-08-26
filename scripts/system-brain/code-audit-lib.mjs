import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const SYSTEM_BRAIN_CODE_AUDIT_VERSION = 'SYSTEM_BRAIN_CODE_AUDIT_V0'

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

export function sha256(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

async function walk(directory) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return out
    throw error
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function normalizeRepoPath(repoRoot, fullPath) {
  return path.relative(repoRoot, fullPath).split(path.sep).join('/')
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort()
}

export function extractRoutes(appSource = '') {
  const routes = []
  const routePattern = /<Route\b[\s\S]*?\bpath\s*=\s*["']([^"']+)["'][\s\S]*?>/g
  for (const match of appSource.matchAll(routePattern)) routes.push(match[1])
  return uniqueSorted(routes)
}

function parseObjectLiteralStringPairs(source, exportName) {
  const start = source.indexOf(`export const ${exportName}`)
  if (start < 0) return []
  const objectStart = source.indexOf('{', start)
  if (objectStart < 0) return []

  let depth = 0
  let end = -1
  for (let i = objectStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return []

  const body = source.slice(objectStart + 1, end)
  const pairs = []
  const pairPattern = /([A-Z0-9_]+)\s*:\s*['"]([^'"]+)['"]/g
  for (const match of body.matchAll(pairPattern)) pairs.push({ key: match[1], value: match[2] })
  return pairs
}

export function extractAskDwTools(toolRuntimeSource = '') {
  return parseObjectLiteralStringPairs(toolRuntimeSource, 'ASK_DW_READ_TOOL')
    .map(({ key, value }) => ({ id: value, constant: key, side_effect_class: 'NONE', read_only: true }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function extractAskDwScopes(toolRuntimeSource = '') {
  return parseObjectLiteralStringPairs(toolRuntimeSource, 'ASK_DW_TOOL_SCOPE')
    .map(({ key, value }) => ({ id: value, constant: key }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function extractAuthorityActions(authoritySource = '') {
  const actions = []
  const pattern = /export const (ACTION_[A-Z0-9_]+)\s*=\s*['"]([^'"]+)['"]/g
  for (const match of authoritySource.matchAll(pattern)) actions.push({ constant: match[1], action: match[2] })
  return actions.sort((a, b) => a.action.localeCompare(b.action))
}

function extractSelectAfter(source, fromEnd) {
  const nextFrom = source.indexOf('.from(', fromEnd)
  const windowEnd = nextFrom >= 0 ? nextFrom : Math.min(source.length, fromEnd + 2500)
  const window = source.slice(fromEnd, windowEnd)
  const match = /\.select\(\s*(['"`])([\s\S]*?)\1\s*\)/.exec(window)
  return match ? match[2].replace(/\s+/g, ' ').trim() : null
}

export function extractSupabaseDependencies(source = '', sourcePath = 'unknown') {
  const dependencies = []
  const fromPattern = /\.from\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(fromPattern)) {
    dependencies.push({
      kind: 'table',
      name: match[1],
      select: extractSelectAfter(source, match.index + match[0].length),
      source: sourcePath,
    })
  }

  const rpcPattern = /\.rpc\(\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(rpcPattern)) {
    dependencies.push({ kind: 'rpc', name: match[1], select: null, source: sourcePath })
  }
  return dependencies
}

function aggregateDependencies(dependencies) {
  const byKey = new Map()
  for (const item of dependencies) {
    const key = `${item.kind}:${item.name}`
    const existing = byKey.get(key) ?? { kind: item.kind, name: item.name, sources: [], select_shapes: [] }
    existing.sources.push(item.source)
    if (item.select) existing.select_shapes.push(item.select)
    byKey.set(key, existing)
  }

  return [...byKey.values()]
    .map((item) => ({ ...item, sources: uniqueSorted(item.sources), select_shapes: uniqueSorted(item.select_shapes) }))
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`))
}

function buildSectionHashes(sections) {
  const section_hashes = Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, sha256(value)]))
  return { section_hashes, aggregate_hash: sha256(section_hashes) }
}

export async function buildCodeCapabilityAudit({ repoRoot, generatedAt = new Date().toISOString() } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required')

  const [packageRaw, appSource, toolRuntimeSource, authoritySource] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src', 'App.jsx'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src', 'lib', 'dwIntelligence', 'askDwToolRuntime.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src', 'lib', 'nextActionAuthority.js'), 'utf8'),
  ])

  const packageJson = JSON.parse(packageRaw)
  const sourceFiles = await walk(path.join(repoRoot, 'src'))
  const dependencies = []

  for (const fullPath of sourceFiles) {
    const repoPath = normalizeRepoPath(repoRoot, fullPath)
    const source = await fs.readFile(fullPath, 'utf8')
    dependencies.push(...extractSupabaseDependencies(source, repoPath))
  }

  const dwIntelligenceFiles = (await walk(path.join(repoRoot, 'src', 'lib', 'dwIntelligence')))
    .map((fullPath) => normalizeRepoPath(repoRoot, fullPath))
    .sort()

  const sections = {
    routes: extractRoutes(appSource),
    ask_dw_tools: extractAskDwTools(toolRuntimeSource),
    ask_dw_scopes: extractAskDwScopes(toolRuntimeSource),
    authority_actions: extractAuthorityActions(authoritySource),
    data_dependencies: aggregateDependencies(dependencies),
    dw_intelligence_modules: dwIntelligenceFiles,
  }

  const hashes = buildSectionHashes(sections)

  return {
    meta: {
      audit_version: SYSTEM_BRAIN_CODE_AUDIT_VERSION,
      generated_at: generatedAt,
      application_name: packageJson.name ?? null,
      application_version: packageJson.version ?? null,
      source_kind: 'CODE_CAPABILITY_MANIFEST',
      tenant_row_data_read: false,
      hash_algorithm: 'SHA-256',
      ...hashes,
    },
    boundaries: {
      closed_world_routes: true,
      closed_world_ask_dw_read_tools: true,
      live_tenant_state_included: false,
      business_authority_source: 'src/lib/nextActionAuthority.js',
      data_access_authority_source: 'deployment RLS fingerprint (M1B; not inferred from code audit)',
    },
    ...sections,
  }
}

export async function writeCodeCapabilityAudit({ repoRoot, outFile } = {}) {
  const manifest = await buildCodeCapabilityAudit({ repoRoot })
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.writeFile(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}
