import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertDependencyAvailable,
  buildCompatibilityReport,
  extractConservativeColumns,
} from '../scripts/system-brain/compatibility-lib.mjs'

const code = {
  meta: {
    source_kind: 'CODE_CAPABILITY_MANIFEST',
    tenant_row_data_read: false,
    aggregate_hash: 'code-hash',
  },
  data_dependencies: [
    {
      kind: 'table',
      name: 'invoices',
      sources: ['src/example.js'],
      select_shapes: ['id, amount, currency, client:clients(name,email)'],
    },
    {
      kind: 'table',
      name: 'payments',
      sources: ['src/example.js'],
      select_shapes: ['id, amount'],
    },
    {
      kind: 'rpc',
      name: 'record_invoice_payment',
      sources: ['src/example.js'],
      select_shapes: [],
    },
  ],
}

const deployment = {
  meta: {
    source_kind: 'SCHEMA_ONLY_DEPLOYMENT_SNAPSHOT',
    tenant_row_data_read: false,
    aggregate_hash: 'deployment-hash',
  },
  tables: [
    {
      name: 'invoices',
      signature: '1:id:uuid:NO:|2:amount:numeric:NO:0',
      rls_enabled: true,
      rls_forced: false,
    },
  ],
  database_functions: ['other_rpc()->void:plpgsql:security_definer=false'],
}

test('select column extraction ignores nested Supabase relationship syntax', () => {
  assert.deepEqual(
    extractConservativeColumns(['id, amount, currency, client:clients(name,email), *']),
    ['amount', 'currency', 'id'],
  )
})

test('compatibility report distinguishes missing table, missing RPC and column drift', () => {
  const report = buildCompatibilityReport(code, deployment, { generatedAt: '2026-01-01T00:00:00.000Z' })
  const byKey = new Map(report.findings.map((x) => [`${x.kind}:${x.name}`, x]))

  assert.equal(byKey.get('table:invoices').status, 'COLUMN_DRIFT')
  assert.deepEqual(byKey.get('table:invoices').missing_columns, ['currency'])
  assert.equal(byKey.get('table:payments').status, 'MISSING_TABLE')
  assert.equal(byKey.get('rpc:record_invoice_payment').status, 'MISSING_RPC')
  assert.equal(report.compatible, false)
})

test('structural drift blocks only the affected dependency contract', () => {
  const report = buildCompatibilityReport(code, deployment)
  assert.throws(() => assertDependencyAvailable(report, { name: 'payments' }), /blocked unavailable dependency/)
  assert.throws(
    () => assertDependencyAvailable(report, { name: 'invoices', columns: ['currency'] }),
    /blocked drifted columns/,
  )
})

test('a declared matching dependency is allowed structurally without granting business authority', () => {
  const aligned = {
    ...deployment,
    tables: [
      {
        name: 'invoices',
        signature: '1:id:uuid:NO:|2:amount:numeric:NO:0|3:currency:text:NO:USD',
        rls_enabled: true,
        rls_forced: false,
      },
      {
        name: 'payments',
        signature: '1:id:uuid:NO:|2:amount:numeric:NO:0',
        rls_enabled: true,
        rls_forced: false,
      },
    ],
    database_functions: [
      'record_invoice_payment()->void:plpgsql:security_definer=false',
    ],
  }

  const report = buildCompatibilityReport(code, aligned)
  assert.equal(report.compatible, true)
  assert.equal(assertDependencyAvailable(report, { name: 'invoices', columns: ['currency'] }), true)
  assert.equal(report.boundaries.business_authority_inferred, false)
  assert.equal(report.boundaries.structural_match_does_not_grant_execution_authority, true)
})

test('compatibility hash is deterministic apart from generated_at', () => {
  const a = buildCompatibilityReport(code, deployment, { generatedAt: 'a' })
  const b = buildCompatibilityReport(code, deployment, { generatedAt: 'b' })
  assert.equal(a.meta.aggregate_hash, b.meta.aggregate_hash)
  assert.notEqual(a.meta.generated_at, b.meta.generated_at)
})

test('M1C refuses any manifest that claims tenant row reads', () => {
  assert.throws(
    () => buildCompatibilityReport(
      { ...code, meta: { ...code.meta, tenant_row_data_read: true } },
      deployment,
    ),
    /refuses manifests that include tenant row data/,
  )
})
