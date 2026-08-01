import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClientReference, buildDuplicateKey, findDuplicateGroups } from '../../src/lib/import/duplicates.js'

test('source system + source invoice ID takes priority over everything else', () => {
  const result = buildDuplicateKey({
    source_system: 'QuickBooks',
    source_invoice_id: 'INV-9',
    invoice_number: 'IGNORED',
    client_email: 'a@example.test',
  })
  assert.equal(result.key, 'src:quickbooks|inv-9')
  assert.equal(result.incomplete, false)
})

test('same source invoice ID in different source systems is not a duplicate', () => {
  const a = buildDuplicateKey({ source_system: 'QuickBooks', source_invoice_id: 'INV-9' })
  const b = buildDuplicateKey({ source_system: 'Xero', source_invoice_id: 'INV-9' })
  assert.notEqual(a.key, b.key)
})

test('client reference priority: email beats company+name', () => {
  const ref = buildClientReference({
    client_email: 'billing@example.test',
    client_company: 'Acme Co',
    client_name: 'Acme',
  })
  assert.equal(ref, 'email:billing@example.test')
})

test('client reference falls back to company+name when no email', () => {
  const ref = buildClientReference({ client_company: 'Acme Co', client_name: 'Jane Doe' })
  assert.equal(ref, 'namecompany:acme co|jane doe')
})

test('phone is only a reliable reference when paired with company or name', () => {
  assert.equal(buildClientReference({ client_phone: '555-0100' }), null)
  assert.equal(buildClientReference({ client_phone: '555-0100', client_company: 'Acme Co' }), 'phone:5550100|acme co')
})

test('no reliable client reference -> key is null and incomplete is true, never fabricated', () => {
  const result = buildDuplicateKey({ invoice_number: 'INV-1' })
  assert.equal(result.key, null)
  assert.equal(result.incomplete, true)
})

test('duplicate invoice number for the same reliable client produces the same key', () => {
  const a = buildDuplicateKey({ client_email: 'a@example.test', invoice_number: 'INV-100' })
  const b = buildDuplicateKey({ client_email: 'A@Example.test', invoice_number: ' inv-100 ' })
  assert.equal(a.key, b.key)
})

test('the same invoice number across two different clients is not flagged as a duplicate (no invoice-number-only matching)', () => {
  const a = buildDuplicateKey({ client_email: 'alice@example.test', invoice_number: 'INV-1' })
  const b = buildDuplicateKey({ client_email: 'bob@example.test', invoice_number: 'INV-1' })
  assert.notEqual(a.key, b.key)
})

test('findDuplicateGroups groups only repeated non-null keys', () => {
  const groups = findDuplicateGroups([
    { index: 0, key: 'a' },
    { index: 1, key: 'a' },
    { index: 2, key: 'b' },
    { index: 3, key: null },
    { index: 4, key: null },
  ])
  assert.deepEqual([...groups.keys()], ['a'])
  assert.deepEqual(groups.get('a'), [0, 1])
})
