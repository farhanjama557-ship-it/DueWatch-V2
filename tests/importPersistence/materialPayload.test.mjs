import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MATERIAL_FIELDS,
  buildMaterialPayload,
  canonicalizeMaterialPayload,
  hashMaterialPayload,
  buildRowIdempotencyKey,
} from '../../src/lib/importPersistence/materialPayload.js'

const NORMALIZED = {
  client_name: 'Acme Co',
  client_company: null,
  client_email: 'billing@acme.test',
  client_phone: null,
  source_system: null,
  source_client_id: null,
  invoice_number: 'INV-1001',
  source_invoice_id: null,
  invoice_date: '2026-01-05',
  due_date: '2026-02-04',
  amount: '4200.00',
  currency: 'USD',
  status: null,
  amount_paid: null,
  payment_date: null,
  notes: 'ignore me — not material',
}

test('buildMaterialPayload includes every enumerated material field and the tenant', () => {
  const payload = buildMaterialPayload('user-1', NORMALIZED)
  assert.equal(payload.user_id, 'user-1')
  for (const field of MATERIAL_FIELDS) {
    assert.ok(field in payload, `expected ${field} in payload`)
  }
})

test('buildMaterialPayload excludes non-material fields like notes', () => {
  const payload = buildMaterialPayload('user-1', NORMALIZED)
  assert.equal('notes' in payload, false)
})

test('buildMaterialPayload throws without a tenant id', () => {
  assert.throws(() => buildMaterialPayload(null, NORMALIZED))
})

test('missing/empty values normalize to null consistently', () => {
  const payload = buildMaterialPayload('user-1', { ...NORMALIZED, client_company: '' })
  assert.equal(payload.client_company, null)
})

test('canonicalizeMaterialPayload is stable regardless of input key order', () => {
  const a = buildMaterialPayload('user-1', NORMALIZED)
  const b = {}
  for (const k of Object.keys(a).reverse()) b[k] = a[k]
  assert.equal(canonicalizeMaterialPayload(a), canonicalizeMaterialPayload(b))
})

test('hashMaterialPayload is deterministic for the same logical payload', async () => {
  const a = buildMaterialPayload('user-1', NORMALIZED)
  const b = buildMaterialPayload('user-1', { ...NORMALIZED })
  const [ha, hb] = await Promise.all([hashMaterialPayload(a), hashMaterialPayload(b)])
  assert.equal(ha, hb)
  assert.match(ha, /^[0-9a-f]{64}$/)
})

test('hashMaterialPayload changes when any material field changes', async () => {
  const a = buildMaterialPayload('user-1', NORMALIZED)
  const b = buildMaterialPayload('user-1', { ...NORMALIZED, amount: '4200.01' })
  const [ha, hb] = await Promise.all([hashMaterialPayload(a), hashMaterialPayload(b)])
  assert.notEqual(ha, hb)
})

test('hashMaterialPayload does not change when only a non-material field changes', async () => {
  const a = buildMaterialPayload('user-1', NORMALIZED)
  const b = buildMaterialPayload('user-1', { ...NORMALIZED, notes: 'completely different notes' })
  const [ha, hb] = await Promise.all([hashMaterialPayload(a), hashMaterialPayload(b)])
  assert.equal(ha, hb)
})

test('hashMaterialPayload changes across tenants for otherwise-identical data', async () => {
  const a = buildMaterialPayload('user-1', NORMALIZED)
  const b = buildMaterialPayload('user-2', NORMALIZED)
  const [ha, hb] = await Promise.all([hashMaterialPayload(a), hashMaterialPayload(b)])
  assert.notEqual(ha, hb)
})

test('buildRowIdempotencyKey combines run and row number deterministically', () => {
  assert.equal(buildRowIdempotencyKey('run-1', 3), 'run-1:3')
  assert.equal(buildRowIdempotencyKey('run-1', 3), buildRowIdempotencyKey('run-1', 3))
  assert.notEqual(buildRowIdempotencyKey('run-1', 3), buildRowIdempotencyKey('run-1', 4))
  assert.notEqual(buildRowIdempotencyKey('run-1', 3), buildRowIdempotencyKey('run-2', 3))
})

test('buildRowIdempotencyKey throws on missing inputs', () => {
  assert.throws(() => buildRowIdempotencyKey(null, 1))
  assert.throws(() => buildRowIdempotencyKey('run-1', null))
})
