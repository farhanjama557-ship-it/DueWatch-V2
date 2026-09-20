import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findCollectionTarget,
  normalizeCollectionTargetInput,
  normalizeSavedViewInput,
} from '../src/lib/reports/reportPreferences.js'

test('saved views normalize only supported report state', () => {
  const row = normalizeSavedViewInput({
    userId: 'u1',
    name: '  Monthly close  ',
    cadence: 'Monthly',
    startDate: '2026-09-01',
    endDate: '2026-10-01',
    currency: 'usd',
    activeTab: 'aging',
    filters: {},
  })

  assert.equal(row.user_id, 'u1')
  assert.equal(row.name, 'Monthly close')
  assert.equal(row.currency, 'USD')
  assert.equal(row.active_tab, 'aging')
})

test('saved views reject invalid periods and unknown tabs', () => {
  assert.throws(
    () => normalizeSavedViewInput({
      userId: 'u1',
      name: 'bad',
      cadence: 'Monthly',
      startDate: '2026-09-01',
      endDate: '2026-09-01',
    }),
    /after start/
  )
  assert.throws(
    () => normalizeSavedViewInput({
      userId: 'u1',
      name: 'bad',
      cadence: 'Monthly',
      startDate: '2026-09-01',
      endDate: '2026-10-01',
      activeTab: 'magic',
    }),
    /Unsupported report tab/
  )
})

test('collection target is explicit, currency-scoped, and positive', () => {
  const row = normalizeCollectionTargetInput({
    userId: 'u1',
    startDate: '2026-09-01',
    endDate: '2026-10-01',
    currency: 'usd',
    targetAmount: '400000.50',
  })

  assert.equal(row.currency, 'USD')
  assert.equal(row.target_amount, 400000.5)
  assert.throws(
    () => normalizeCollectionTargetInput({
      userId: 'u1',
      startDate: '2026-09-01',
      endDate: '2026-10-01',
      currency: 'USD',
      targetAmount: 0,
    }),
    /greater than zero/
  )
})

test('collection target lookup requires exact period and currency', () => {
  const targets = [
    { id: 't1', period_start: '2026-09-01', period_end: '2026-10-01', currency: 'USD', target_amount: 400000 },
    { id: 't2', period_start: '2026-09-01', period_end: '2026-10-01', currency: 'EUR', target_amount: 300000 },
  ]

  assert.equal(
    findCollectionTarget(targets, {
      startDate: '2026-09-01',
      endDate: '2026-10-01',
      currency: 'USD',
    }).id,
    't1'
  )
  assert.equal(
    findCollectionTarget(targets, {
      startDate: '2026-08-01',
      endDate: '2026-09-01',
      currency: 'USD',
    }),
    null
  )
})
