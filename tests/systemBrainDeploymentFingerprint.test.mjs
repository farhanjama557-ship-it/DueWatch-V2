import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDeploymentFingerprint,
} from '../scripts/system-brain/deployment-fingerprint-lib.mjs'

const source = {
  source_kind: 'SCHEMA_ONLY_DEPLOYMENT_SNAPSHOT',
  fingerprint_source_version: 'SYSTEM_BRAIN_DEPLOYMENT_SOURCE_V0',
  project_ref: 'example-project',
  schema: 'public',
  tenant_row_data_read: false,
  tables: [
    { name: 'invoices', signature: '1:id:uuid:NO:', rls_enabled: true, rls_forced: false },
    { name: 'clients', signature: '1:id:uuid:NO:', rls_enabled: true, rls_forced: false },
  ],
  foreign_keys: ['invoices.client_id->clients.id'],
  policies: ['invoices:own:ALL:public:(auth.uid() = user_id):(auth.uid() = user_id)'],
  database_functions: ['handle_new_user()->trigger:plpgsql:security_definer=true'],
  edge_functions: [
    { slug: 'send-reminder-email', status: 'ACTIVE', version: 1, verify_jwt: true, sha256: 'abc' },
  ],
}

test('deployment fingerprint is deterministic apart from generated_at', () => {
  const a = buildDeploymentFingerprint(source, { generatedAt: '2026-01-01T00:00:00.000Z' })
  const b = buildDeploymentFingerprint(source, { generatedAt: '2026-02-01T00:00:00.000Z' })

  assert.notEqual(a.meta.generated_at, b.meta.generated_at)
  assert.deepEqual(a.meta.section_hashes, b.meta.section_hashes)
  assert.equal(a.meta.aggregate_hash, b.meta.aggregate_hash)
})

test('deployment fingerprint refuses tenant-row sources', () => {
  assert.throws(
    () => buildDeploymentFingerprint({ ...source, tenant_row_data_read: true }),
    /refuses sources that read tenant row data/,
  )
})

test('deployment fingerprint keeps RLS separate from business authority', () => {
  const result = buildDeploymentFingerprint(source)
  assert.equal(result.boundaries.rls_represents_data_access_only, true)
  assert.equal(result.boundaries.business_authority_inferred_from_rls, false)
})

test('deployment fingerprint preserves table RLS state and edge function JWT state', () => {
  const result = buildDeploymentFingerprint(source)
  assert.equal(result.summary.tables, 2)
  assert.equal(result.summary.rls_enabled_tables, 2)
  assert.equal(result.edge_functions[0].verify_jwt, true)
})

test('reordering structural input does not change the aggregate fingerprint', () => {
  const reversed = {
    ...source,
    tables: [...source.tables].reverse(),
    foreign_keys: [...source.foreign_keys].reverse(),
    policies: [...source.policies].reverse(),
  }
  const a = buildDeploymentFingerprint(source, { generatedAt: 'x' })
  const b = buildDeploymentFingerprint(reversed, { generatedAt: 'y' })
  assert.equal(a.meta.aggregate_hash, b.meta.aggregate_hash)
})

test('a structural change changes the deployment fingerprint', () => {
  const changed = {
    ...source,
    tables: source.tables.map((table) =>
      table.name === 'invoices'
        ? { ...table, signature: `${table.signature}|2:currency:text:NO:` }
        : table
    ),
  }

  const a = buildDeploymentFingerprint(source)
  const b = buildDeploymentFingerprint(changed)
  assert.notEqual(a.meta.aggregate_hash, b.meta.aggregate_hash)
})
