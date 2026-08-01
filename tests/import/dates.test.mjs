import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseIsoDate,
  parseNamedMonthDate,
  classifyNumericDate,
  resolveAmbiguousNumericDate,
  detectMixedDateConvention,
  excelSerialToDate,
  parseDateValue,
  isValidCalendarDate,
} from '../../src/lib/import/dates.js'

test('ISO date parses deterministically', () => {
  assert.equal(parseIsoDate('2026-01-05'), '2026-01-05')
  assert.equal(parseIsoDate('2026-1-5'), '2026-01-05')
})

test('ISO date rejects an invalid calendar date (no permissive Date.parse rollover)', () => {
  assert.equal(parseIsoDate('2026-02-30'), null)
  assert.equal(parseIsoDate('2025-02-29'), null) // 2025 is not a leap year
  assert.equal(parseIsoDate('2024-02-29'), '2024-02-29') // 2024 is a leap year
})

test('named-month date parses deterministically, four-digit year required', () => {
  assert.equal(parseNamedMonthDate('January 5, 2026'), '2026-01-05')
  assert.equal(parseNamedMonthDate('Jan 5 2026'), '2026-01-05')
  assert.equal(parseNamedMonthDate('5 January 2026'), '2026-01-05')
  assert.equal(parseNamedMonthDate('5-Jan-2026'), '2026-01-05')
  assert.equal(parseNamedMonthDate('not a date'), null)
})

test('ambiguous numeric date is classified, not guessed', () => {
  const c = classifyNumericDate('04/05/2025')
  assert.equal(c.kind, 'ambiguous')
})

test('explicit MDY choice resolves an ambiguous date correctly', () => {
  const c = classifyNumericDate('04/05/2025')
  assert.equal(resolveAmbiguousNumericDate(c, 'MDY'), '2025-04-05')
})

test('explicit DMY choice resolves the same ambiguous date differently', () => {
  const c = classifyNumericDate('04/05/2025')
  assert.equal(resolveAmbiguousNumericDate(c, 'DMY'), '2025-05-04')
})

test('a numeric date forced unambiguous by an out-of-range segment resolves without a choice', () => {
  assert.deepEqual(classifyNumericDate('25/03/2025'), { kind: 'forced-dmy', day: 25, month: 3, year: 2025 })
  assert.deepEqual(classifyNumericDate('03/25/2025'), { kind: 'forced-mdy', month: 3, day: 25, year: 2025 })
})

test('a numeric date where neither segment can be valid is invalid', () => {
  assert.equal(classifyNumericDate('35/45/2025').kind, 'invalid')
})

test('mixed date formats are detected only when forced evidence conflicts', () => {
  const classifications = [classifyNumericDate('25/03/2025'), classifyNumericDate('03/25/2025')]
  assert.equal(detectMixedDateConvention(classifications), true)
})

test('two ambiguous (not forced) dates alone do not count as a mixed-convention conflict', () => {
  const classifications = [classifyNumericDate('04/05/2025'), classifyNumericDate('06/07/2025')]
  assert.equal(detectMixedDateConvention(classifications), false)
})

test('invalid calendar date (e.g. April 31) is rejected', () => {
  const result = parseDateValue('04/31/2025')
  assert.equal(result.value, null)
  assert.equal(result.code, 'INVALID_DATE')
})

test('two-digit years are rejected outright, never inferred', () => {
  const result = parseDateValue('04/05/25')
  assert.equal(result.value, null)
  assert.equal(result.code, 'INVALID_DATE')
})

test('no timezone shift: a Date instance at UTC midnight keeps its calendar day', () => {
  const d = new Date(Date.UTC(2026, 5, 15))
  const result = parseDateValue(d)
  assert.equal(result.value, '2026-06-15')
})

test('excelSerialToDate: 1900 system serial 1 is January 1, 1900', () => {
  assert.deepEqual(excelSerialToDate(1, '1900'), { value: '1900-01-01', error: null })
})

test('excelSerialToDate: 1900 system serial 59 is February 28, 1900', () => {
  assert.deepEqual(excelSerialToDate(59, '1900'), { value: '1900-02-28', error: null })
})

test('excelSerialToDate: serial 60 (the fictitious Feb 29, 1900) is refused, not silently rolled to March 1', () => {
  const result = excelSerialToDate(60, '1900')
  assert.equal(result.value, null)
  assert.equal(result.error, 'excel-1900-fictitious-leap-day')
})

test('excelSerialToDate: 1900 system serial 61 is March 1, 1900', () => {
  assert.deepEqual(excelSerialToDate(61, '1900'), { value: '1900-03-01', error: null })
})

test('excelSerialToDate: 1904 system serial 0 is January 1, 1904', () => {
  assert.deepEqual(excelSerialToDate(0, '1904'), { value: '1904-01-01', error: null })
})

test('excelSerialToDate: 1904 system has no leap-year bug to work around', () => {
  assert.deepEqual(excelSerialToDate(59, '1904'), { value: '1904-02-29', error: null }) // 1904 IS a real leap year
})

test('isValidCalendarDate rejects month/day out of range', () => {
  assert.equal(isValidCalendarDate(2026, 13, 1), false)
  assert.equal(isValidCalendarDate(2026, 0, 1), false)
  assert.equal(isValidCalendarDate(2026, 1, 32), false)
})

test('parseDateValue treats blank as valid-and-absent, not an error', () => {
  assert.deepEqual(parseDateValue(''), { value: null, code: null, requiresUserChoice: false })
  assert.deepEqual(parseDateValue(null), { value: null, code: null, requiresUserChoice: false })
})

test('parseDateValue surfaces AMBIGUOUS_DATE_FORMAT with requiresUserChoice when no convention is supplied', () => {
  const result = parseDateValue('04/05/2025')
  assert.equal(result.code, 'AMBIGUOUS_DATE_FORMAT')
  assert.equal(result.requiresUserChoice, true)
})

test('parseDateValue applies a supplied convention to resolve an ambiguous date', () => {
  assert.equal(parseDateValue('04/05/2025', { convention: 'MDY' }).value, '2025-04-05')
  assert.equal(parseDateValue('04/05/2025', { convention: 'DMY' }).value, '2025-05-04')
})

test('parseDateValue reads a numeric raw value as an Excel serial with the supplied date system', () => {
  const result = parseDateValue(1, { dateSystem: '1900' })
  assert.equal(result.value, '1900-01-01')
})
