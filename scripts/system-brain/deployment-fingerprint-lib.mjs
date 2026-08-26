import { createHash } from 'node:crypto'

export const SYSTEM_BRAIN_DEPLOYMENT_FINGERPRINT_VERSION = 'SYSTEM_BRAIN_DEPLOYMENT_FINGERPRINT_V0'

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

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function uniqueBy(items, key, name) {
  const seen = new Set()
  for (const item of items) {
    const value = item?.[key]
    if (!value) throw new Error(`${name} contains item missing ${key}`)
    if (seen.has(value)) throw new Error(`${name} contains duplicate ${value}`)
    seen.add(value)
  }
}

function normalizeTables(input) {
  const tables = assertArray(input, 'tables').map((table) => ({
    name: String(table?.name || '').trim(),
    signature: String(table?.signature || ''),
    rls_enabled: table?.rls_enabled === true,
    rls_forced: table?.rls_forced === true,
  }))
  uniqueBy(tables, 'name', 'tables')
  return tables.sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeEdgeFunctions(input) {
  const functions = assertArray(input, 'edge_functions').map((fn) => ({
    slug: String(fn?.slug || '').trim(),
    status: String(fn?.status || '').trim(),
    version: Number(fn?.version ?? 0),
    verify_jwt: fn?.verify_jwt === true,
    sha256: String(fn?.sha256 || '').trim(),
  }))
  uniqueBy(functions, 'slug', 'edge_functions')
  return functions.sort((a, b) => a.slug.localeCompare(b.slug))
}

function sortedStrings(value, name) {
  return [...assertArray(value, name).map((item) => String(item))].sort()
}

export function buildDeploymentFingerprint(source, {
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!source || typeof source !== 'object') throw new Error('deployment source object required')
  if (source.source_kind !== 'SCHEMA_ONLY_DEPLOYMENT_SNAPSHOT') {
    throw new Error('deployment source must be schema-only')
  }
  if (source.tenant_row_data_read !== false) {
    throw new Error('deployment fingerprint refuses sources that read tenant row data')
  }

  const sections = {
    tables: normalizeTables(source.tables),
    foreign_keys: sortedStrings(source.foreign_keys, 'foreign_keys'),
    policies: sortedStrings(source.policies, 'policies'),
    database_functions: sortedStrings(source.database_functions, 'database_functions'),
    edge_functions: normalizeEdgeFunctions(source.edge_functions),
  }

  const section_hashes = Object.fromEntries(
    Object.entries(sections).map(([name, value]) => [name, sha256(value)]),
  )

  const summary = {
    tables: sections.tables.length,
    rls_enabled_tables: sections.tables.filter((table) => table.rls_enabled).length,
    foreign_keys: sections.foreign_keys.length,
    policies: sections.policies.length,
    database_functions: sections.database_functions.length,
    edge_functions: sections.edge_functions.length,
  }

  return {
    meta: {
      fingerprint_version: SYSTEM_BRAIN_DEPLOYMENT_FINGERPRINT_VERSION,
      source_version: String(source.fingerprint_source_version || ''),
      generated_at: generatedAt,
      project_ref: String(source.project_ref || ''),
      schema: String(source.schema || 'public'),
      source_kind: source.source_kind,
      tenant_row_data_read: false,
      hash_algorithm: 'SHA-256',
      section_hashes,
      aggregate_hash: sha256(section_hashes),
    },
    boundaries: {
      live_tenant_state_included: false,
      row_values_included: false,
      business_authority_inferred_from_rls: false,
      rls_represents_data_access_only: true,
    },
    summary,
    ...sections,
  }
}
