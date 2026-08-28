import { createHash } from 'node:crypto'

export const SYSTEM_BRAIN_COMPATIBILITY_VERSION = 'SYSTEM_BRAIN_COMPATIBILITY_V0'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

export function sha256(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function parseTableSignature(signature = '') {
  const columns = new Map()
  for (const piece of String(signature).split('|')) {
    if (!piece) continue
    const parts = piece.split(':')
    if (parts.length < 4) continue
    const [, name, type, nullable, ...defaultParts] = parts
    columns.set(name, {
      name,
      type,
      nullable: nullable === 'YES',
      default: defaultParts.join(':') || null,
    })
  }
  return columns
}

function topLevelTokens(selectShape = '') {
  const out = []
  let current = ''
  let depth = 0
  for (const char of String(selectShape)) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export function extractConservativeColumns(selectShapes = []) {
  const columns = new Set()
  for (const shape of selectShapes || []) {
    for (const token of topLevelTokens(shape)) {
      if (!token || token === '*') continue
      if (token.includes('(') || token.includes(')')) continue
      if (token.includes('!')) continue

      let candidate = token
      if (candidate.includes(':')) {
        const [alias, source] = candidate.split(':', 2)
        if (!source || source.includes('(')) continue
        candidate = source
      }

      candidate = candidate.trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) columns.add(candidate)
    }
  }
  return [...columns].sort()
}

function normalizeDeploymentTables(deployment) {
  const map = new Map()
  for (const table of deployment?.tables || []) {
    map.set(table.name, {
      ...table,
      columns: parseTableSignature(table.signature),
    })
  }
  return map
}

function deploymentRpcNames(deployment) {
  const names = new Set()
  for (const signature of deployment?.database_functions || []) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\(/.exec(String(signature))
    if (match) names.add(match[1])
  }
  return names
}

function deploymentEdgeFunctions(deployment) {
  return new Map(
    (deployment?.edge_functions || []).map((fn) => [String(fn?.slug || ''), fn]),
  )
}

function findingForTable(dep, deployedTables) {
  const deployed = deployedTables.get(dep.name)
  if (!deployed) {
    return {
      kind: 'table',
      name: dep.name,
      status: 'MISSING_TABLE',
      runtime_policy: 'BLOCK_DEPENDENT_PATH',
      sources: dep.sources || [],
      select_shapes: dep.select_shapes || [],
      required_columns: extractConservativeColumns(dep.select_shapes),
      missing_columns: [],
    }
  }

  const requiredColumns = extractConservativeColumns(dep.select_shapes)
  const missingColumns = requiredColumns.filter((column) => !deployed.columns.has(column))
  if (missingColumns.length > 0) {
    return {
      kind: 'table',
      name: dep.name,
      status: 'COLUMN_DRIFT',
      runtime_policy: 'BLOCK_OR_EXPLICITLY_DEGRADE_DEPENDENT_PATH',
      sources: dep.sources || [],
      select_shapes: dep.select_shapes || [],
      required_columns: requiredColumns,
      missing_columns: missingColumns,
    }
  }

  return {
    kind: 'table',
    name: dep.name,
    status: 'MATCH',
    runtime_policy: 'ALLOW_STRUCTURALLY',
    sources: dep.sources || [],
    select_shapes: dep.select_shapes || [],
    required_columns: requiredColumns,
    missing_columns: [],
  }
}

function findingForRpc(dep, rpcNames) {
  const exists = rpcNames.has(dep.name)
  return {
    kind: 'rpc',
    name: dep.name,
    status: exists ? 'MATCH' : 'MISSING_RPC',
    runtime_policy: exists ? 'ALLOW_STRUCTURALLY' : 'BLOCK_DEPENDENT_PATH',
    sources: dep.sources || [],
    select_shapes: dep.select_shapes || [],
    required_columns: [],
    missing_columns: [],
  }
}

function findingForEdgeFunction(dep, edgeFunctions) {
  const deployed = edgeFunctions.get(dep.name)
  let status = 'MATCH'
  if (!deployed) status = 'MISSING_EDGE_FUNCTION'
  else if (String(deployed.status || '') !== 'ACTIVE') status = 'EDGE_FUNCTION_INACTIVE'
  else if (dep.requires_verify_jwt === true && deployed.verify_jwt !== true) status = 'EDGE_FUNCTION_JWT_DISABLED'

  return {
    kind: 'edge_function',
    name: dep.name,
    status,
    runtime_policy: status === 'MATCH' ? 'ALLOW_STRUCTURALLY' : 'BLOCK_DEPENDENT_PATH',
    sources: dep.sources || [],
    select_shapes: dep.select_shapes || [],
    required_columns: [],
    missing_columns: [],
    requires_verify_jwt: dep.requires_verify_jwt === true,
  }
}

export function buildCompatibilityReport(codeManifest, deploymentFingerprint, {
  generatedAt = new Date().toISOString(),
} = {}) {
  if (codeManifest?.meta?.source_kind !== 'CODE_CAPABILITY_MANIFEST') {
    throw new Error('M1C requires a code capability manifest')
  }
  if (deploymentFingerprint?.meta?.source_kind !== 'SCHEMA_ONLY_DEPLOYMENT_SNAPSHOT') {
    throw new Error('M1C requires a schema-only deployment fingerprint')
  }
  if (codeManifest?.meta?.tenant_row_data_read !== false ||
      deploymentFingerprint?.meta?.tenant_row_data_read !== false) {
    throw new Error('M1C refuses manifests that include tenant row data')
  }

  const tables = normalizeDeploymentTables(deploymentFingerprint)
  const rpcNames = deploymentRpcNames(deploymentFingerprint)
  const edgeFunctions = deploymentEdgeFunctions(deploymentFingerprint)

  const findings = (codeManifest.data_dependencies || [])
    .map((dep) => {
      if (dep.kind === 'rpc') return findingForRpc(dep, rpcNames)
      if (dep.kind === 'edge_function') return findingForEdgeFunction(dep, edgeFunctions)
      return findingForTable(dep, tables)
    })
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`))

  const counts = {
    total_dependencies: findings.length,
    match: findings.filter((x) => x.status === 'MATCH').length,
    missing_tables: findings.filter((x) => x.status === 'MISSING_TABLE').length,
    missing_rpcs: findings.filter((x) => x.status === 'MISSING_RPC').length,
    missing_edge_functions: findings.filter((x) => x.status === 'MISSING_EDGE_FUNCTION').length,
    inactive_edge_functions: findings.filter((x) => x.status === 'EDGE_FUNCTION_INACTIVE').length,
    jwt_disabled_edge_functions: findings.filter((x) => x.status === 'EDGE_FUNCTION_JWT_DISABLED').length,
    column_drift: findings.filter((x) => x.status === 'COLUMN_DRIFT').length,
  }

  const incompatible = findings.filter((x) => x.status !== 'MATCH')

  const reportCore = {
    code_manifest_hash: codeManifest.meta.aggregate_hash,
    deployment_fingerprint_hash: deploymentFingerprint.meta.aggregate_hash,
    counts,
    findings,
  }

  return {
    meta: {
      compatibility_version: SYSTEM_BRAIN_COMPATIBILITY_VERSION,
      generated_at: generatedAt,
      hash_algorithm: 'SHA-256',
      aggregate_hash: sha256(reportCore),
      code_manifest_hash: codeManifest.meta.aggregate_hash,
      deployment_fingerprint_hash: deploymentFingerprint.meta.aggregate_hash,
      tenant_row_data_read: false,
    },
    boundaries: {
      compatibility_is_structural_only: true,
      live_tenant_state_included: false,
      business_authority_inferred: false,
      structural_match_does_not_grant_execution_authority: true,
    },
    compatible: incompatible.length === 0,
    runtime_policy: incompatible.length === 0
      ? 'ALLOW_STRUCTURALLY'
      : 'BLOCK_OR_DEGRADE_ONLY_AFFECTED_PATHS',
    counts,
    findings,
    incompatible_dependencies: incompatible.map((item) => ({
      kind: item.kind,
      name: item.name,
      status: item.status,
      runtime_policy: item.runtime_policy,
      missing_columns: item.missing_columns,
      sources: item.sources,
    })),
  }
}

export function assertDependencyAvailable(report, {
  kind = 'table',
  name,
  columns = [],
} = {}) {
  if (!name) throw new Error('dependency name required')
  const finding = (report?.findings || []).find((item) => item.kind === kind && item.name === name)

  if (!finding) {
    throw new Error(`System Brain dependency is not declared by code: ${kind}:${name}`)
  }
  if (['MISSING_TABLE', 'MISSING_RPC', 'MISSING_EDGE_FUNCTION', 'EDGE_FUNCTION_INACTIVE', 'EDGE_FUNCTION_JWT_DISABLED'].includes(finding.status)) {
    throw new Error(`System Brain blocked unavailable dependency: ${kind}:${name}`)
  }

  const missing = columns.filter((column) =>
    finding.missing_columns?.includes(column))
  if (missing.length > 0) {
    throw new Error(`System Brain blocked drifted columns on ${name}: ${missing.join(', ')}`)
  }

  if (finding.status === 'COLUMN_DRIFT' && columns.length === 0) {
    throw new Error(`System Brain blocked structurally drifted dependency: ${kind}:${name}`)
  }

  return true
}
