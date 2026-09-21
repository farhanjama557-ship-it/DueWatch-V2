import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatMoneySummary,
  formatMoneyTruth,
  summarizeMoney,
  toMinorUnits,
} from '../src/lib/moneyTruth.js'

test('minor-unit parsing preserves exact cents', () => {
  assert.equal(toMinorUnits('0.10'), 10n)
  assert.equal(toMinorUnits('10000000000.00'), 1000000000000n)
  assert.equal(toMinorUnits('1.001'), null)
})

test('known money always displays an explicit currency code', () => {
  assert.match(formatMoneyTruth('1234.56','USD'), /USD/)
  assert.match(formatMoneyTruth('1234.56','EUR'), /EUR/)
})

test('unknown currency is never silently rendered as USD', () => {
  const value=formatMoneyTruth('1234.56',null)
  assert.match(value,/currency unknown/)
  assert.doesNotMatch(value,/USD/)
  assert.doesNotMatch(value,/\$/)
})

test('mixed currencies remain separate instead of being summed together', () => {
  const summary=summarizeMoney([
    {amount:'100.00',currency:'USD'},
    {amount:'50.00',currency:'EUR'},
    {amount:'25.00',currency:'USD'},
  ])
  assert.equal(summary.canRepresentAsSingleMoney,false)
  assert.deepEqual(summary.byCurrency.map(x=>[x.currency,x.amount]),[['EUR',50],['USD',125]])
  const display=formatMoneySummary(summary)
  assert.match(display,/EUR/)
  assert.match(display,/USD/)
  assert.doesNotMatch(display,/175/)
})

test('known and unknown amounts are kept distinct', () => {
  const summary=summarizeMoney([
    {amount:'100.00',currency:'USD'},
    {amount:'40.00',currency:null},
  ])
  assert.equal(summary.unknownAmount,40)
  const display=formatMoneySummary(summary)
  assert.match(display,/USD/)
  assert.match(display,/currency unknown/)
  assert.doesNotMatch(display,/140/)
})
