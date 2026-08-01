import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TARGET_FIELDS,
  REQUIRED_FIELD_KEYS,
  guessMapping,
  detectDuplicateHeaders,
  missingRequiredMappings,
  normalizeStatus,
  STATUS_VALUES,
} from '../../src/lib/import/fields.js'

test('individually required fields are exactly invoice_number, invoice_date, amount (client identity is a one-of group, not required individually)', () => {
  assert.deepEqual(new Set(REQUIRED_FIELD_KEYS), new Set(['invoice_number', 'invoice_date', 'amount']))
})

test('the full field model covers client, invoice, and source-provenance fields', () => {
  const keys = TARGET_FIELDS.map((f) => f.key)
  for (const expected of [
    'client_name', 'client_company', 'client_email', 'client_phone', 'source_system', 'source_client_id',
    'invoice_number', 'source_invoice_id', 'invoice_date', 'due_date', 'status', 'amount', 'amount_paid',
    'currency', 'payment_date', 'notes',
  ]) {
    assert.ok(keys.includes(expected), `missing field ${expected}`)
  }
})

test('guessMapping prefers specific headers over generic ones', () => {
  const mapping = guessMapping(['Invoice Date', 'Amount Paid', 'Amount', 'Invoice Number', 'Client'])
  assert.equal(mapping[0], 'invoice_date')
  assert.equal(mapping[1], 'amount_paid')
  assert.equal(mapping[2], 'amount')
  assert.equal(mapping[3], 'invoice_number')
  assert.equal(mapping[4], 'client_name')
})

test('detectDuplicateHeaders finds case-insensitive, trimmed duplicates', () => {
  const dupes = detectDuplicateHeaders(['Amount', ' amount ', 'Invoice #'])
  assert.equal(dupes.length, 1)
  assert.deepEqual(dupes[0].indices, [0, 1])
})

test('detectDuplicateHeaders returns nothing for unique headers', () => {
  assert.deepEqual(detectDuplicateHeaders(['Amount', 'Invoice #']), [])
})

test('missingRequiredMappings reports every unmapped required field', () => {
  const missing = missingRequiredMappings({ 0: 'client_name' })
  assert.deepEqual(new Set(missing), new Set(['invoice_number', 'invoice_date', 'amount']))
})

test('missingRequiredMappings is empty when every required field is mapped', () => {
  const mapping = { 0: 'client_name', 1: 'invoice_number', 2: 'invoice_date', 3: 'amount' }
  assert.deepEqual(missingRequiredMappings(mapping), [])
})

test('normalizeStatus accepts a known status case-insensitively', () => {
  assert.deepEqual(normalizeStatus('Paid'), { value: 'paid', blank: false, error: null })
  assert.deepEqual(normalizeStatus(' SENT '), { value: 'sent', blank: false, error: null })
})

test('normalizeStatus flags an unrecognized status without guessing', () => {
  const result = normalizeStatus('archived')
  assert.equal(result.value, null)
  assert.equal(result.error, 'UNKNOWN_STATUS')
})

test('normalizeStatus treats blank as absent, not unknown', () => {
  assert.deepEqual(normalizeStatus(''), { value: null, blank: true, error: null })
})

test('STATUS_VALUES is a fixed, documented vocabulary', () => {
  assert.deepEqual(STATUS_VALUES, ['draft', 'sent', 'paid', 'partial', 'overdue', 'void'])
})
