import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAmount,
  parseAmountString,
  parseAmountNumber,
  compareAmounts,
  minorUnitsToDecimalString,
  decimalStringToMinorUnits,
  normalizeCurrencyCode,
  SUPPORTED_CURRENCIES,
} from '../../src/lib/import/money.js'

test('"1200" normalizes to "1200.00"', () => {
  assert.equal(parseAmountString('1200').value, '1200.00')
})

test('"1,200.00" (US) normalizes to "1200.00"', () => {
  assert.equal(parseAmountString('1,200.00').value, '1200.00')
})

test('"1.200,00" (European) normalizes to "1200.00"', () => {
  assert.equal(parseAmountString('1.200,00').value, '1200.00')
})

test('ambiguous single-separator amount ("1,200") is flagged, not guessed', () => {
  const result = parseAmountString('1,200')
  assert.equal(result.value, null)
  assert.equal(result.ambiguous, true)
  assert.equal(result.error, 'AMBIGUOUS_AMOUNT_FORMAT')
})

test('a 1-2 digit group after a single comma is unambiguously a decimal, not a guess', () => {
  assert.equal(parseAmountString('1200,5').value, '1200.50')
  assert.equal(parseAmountString('1200,50').value, '1200.50')
})

test('malformed amount is rejected as INVALID_AMOUNT', () => {
  const result = parseAmountString('abc')
  assert.equal(result.value, null)
  assert.equal(result.error, 'INVALID_AMOUNT')
})

test('malformed amount: multiple dots with a non-3-digit group is invalid, not silently coerced', () => {
  const result = parseAmountString('1.20.5')
  assert.equal(result.error, 'INVALID_AMOUNT')
})

test('currency symbols and whitespace are stripped safely', () => {
  assert.equal(parseAmountString('$1,234.56').value, '1234.56')
  assert.equal(parseAmountString('  42.00 ').value, '42.00')
})

test('parenthesized amounts are treated as negative (accounting notation)', () => {
  assert.equal(parseAmountString('(500.00)').value, '-500.00')
})

test('negative invoice amount parses (validity is a separate business rule)', () => {
  assert.equal(parseAmountString('-42.50').value, '-42.50')
})

test('zero amount parses to "0.00" (validity is a separate business rule)', () => {
  assert.equal(parseAmountString('0').value, '0.00')
})

test('exact amount comparisons never use float arithmetic', () => {
  // 0.1 + 0.2 !== 0.3 in binary float; the decimal-string/BigInt path must
  // not inherit that error.
  assert.equal(compareAmounts('0.10', '0.10'), 0)
  assert.equal(compareAmounts('1200.10', '1200.09'), 1)
  assert.equal(compareAmounts('1200.09', '1200.10'), -1)
  assert.equal(compareAmounts('19.99', '19.99'), 0)
})

test('minor-units round trip is exact', () => {
  const minor = decimalStringToMinorUnits('1234.56')
  assert.equal(minor, 123456n)
  assert.equal(minorUnitsToDecimalString(minor), '1234.56')
  assert.equal(minorUnitsToDecimalString(-5n), '-0.05')
})

test('Excel numeric cells (JS numbers) round-trip exactly for realistic currency values', () => {
  assert.equal(parseAmountNumber(1200).value, '1200.00')
  assert.equal(parseAmountNumber(19.99).value, '19.99')
  assert.equal(parseAmountNumber(0.1).value, '0.10')
})

// ---- Correction 2: no toFixed/rounding on authoritative money ----

test('Excel numeric 1200 -> "1200.00" via String(), not toFixed', () => {
  assert.equal(parseAmountNumber(1200).value, '1200.00')
})

test('Excel numeric 1200.5 -> "1200.50"', () => {
  assert.equal(parseAmountNumber(1200.5).value, '1200.50')
})

// Correction 2 makes single-separator ambiguity symmetrical between '.'
// and ',': a single dot followed by exactly 3 digits is exactly as
// ambiguous (thousands vs. decimal) as a single comma followed by exactly
// 3 digits ("1,200"). "1.005" and "2.675" have that exact shape, so under
// the corrected grammar they are AMBIGUOUS_AMOUNT_FORMAT, not a silent
// round AND not an outright INVALID_AMOUNT — never rounded to "1.00"/"1.01"
// either way.
test('Excel numeric 1.005 (single dot, exactly 3 fractional digits) is ambiguous like any 3-digit single-separator group, never rounded', () => {
  const result = parseAmountNumber(1.005)
  assert.equal(result.value, null)
  assert.equal(result.ambiguous, true)
  assert.equal(result.error, 'AMBIGUOUS_AMOUNT_FORMAT')
})

test('Excel numeric 2.675 (single dot, exactly 3 fractional digits) is ambiguous, never silently rounded', () => {
  const result = parseAmountNumber(2.675)
  assert.equal(result.value, null)
  assert.equal(result.ambiguous, true)
  assert.equal(result.error, 'AMBIGUOUS_AMOUNT_FORMAT')
})

test('a CSV-text amount with a non-3-digit excess of fractional digits is rejected as INVALID_AMOUNT, not rounded', () => {
  const result = parseAmountString('19.9999')
  assert.equal(result.value, null)
  assert.equal(result.error, 'INVALID_AMOUNT')
})

test('an untrustworthy/oversized numeric amount is rejected rather than trusted', () => {
  // Number.MAX_SAFE_INTEGER has 16 integer digits — far beyond the 10-digit
  // numeric(12,2) destination precision, and beyond what a double reliably
  // represents as a real currency amount.
  const result = parseAmountNumber(Number.MAX_SAFE_INTEGER)
  assert.equal(result.value, null)
  assert.equal(result.error, 'INVALID_AMOUNT')
})

test('a numeric amount requiring exponential notation is rejected, never trusted as a plain decimal', () => {
  const result = parseAmountNumber(1e21)
  assert.equal(result.value, null)
  assert.equal(result.error, 'INVALID_AMOUNT')
})

test('non-finite numeric amounts (NaN, Infinity) are rejected', () => {
  assert.equal(parseAmountNumber(NaN).error, 'INVALID_AMOUNT')
  assert.equal(parseAmountNumber(Infinity).error, 'INVALID_AMOUNT')
  assert.equal(parseAmountNumber(-Infinity).error, 'INVALID_AMOUNT')
})

test('exact comparisons after a numeric-cell parse still use BigInt/digit-string arithmetic, not float', () => {
  const a = parseAmountNumber(19.99).value
  const b = parseAmountString('19.99').value
  assert.equal(a, b)
  assert.equal(compareAmounts(a, b), 0)
})

test('all six supported currency codes normalize', () => {
  for (const code of SUPPORTED_CURRENCIES) {
    assert.deepEqual(normalizeCurrencyCode(code), { value: code, blank: false, error: null })
  }
  assert.deepEqual(SUPPORTED_CURRENCIES, ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD'])
})

test('lowercase supported currency code normalizes to uppercase', () => {
  assert.deepEqual(normalizeCurrencyCode('usd'), { value: 'USD', blank: false, error: null })
  assert.deepEqual(normalizeCurrencyCode(' cad '), { value: 'CAD', blank: false, error: null })
})

test('blank currency is reported distinctly from malformed currency', () => {
  assert.deepEqual(normalizeCurrencyCode(''), { value: null, blank: true, error: null })
  assert.deepEqual(normalizeCurrencyCode(null), { value: null, blank: true, error: null })
})

test('unsupported or malformed nonblank currency is never coerced to USD', () => {
  const result = normalizeCurrencyCode('XYZ')
  assert.equal(result.value, null)
  assert.equal(result.error, 'UNSUPPORTED_CURRENCY')
  const result2 = normalizeCurrencyCode('dollars')
  assert.equal(result2.error, 'UNSUPPORTED_CURRENCY')
})

test('parseAmount dispatches on raw type (number vs string vs blank)', () => {
  assert.equal(parseAmount(1200).value, '1200.00')
  assert.equal(parseAmount('1,200.00').value, '1200.00')
  assert.deepEqual(parseAmount(null), { value: null, blank: true, ambiguous: false, error: null })
  assert.deepEqual(parseAmount(''), { value: null, blank: true, ambiguous: false, error: null })
})

// ---- Correction 2: strict amount grammar — reject rather than repair ----

test('strict grammar: every listed malformed example produces INVALID_AMOUNT', () => {
  const malformed = ['12O0', 'abc1200', '1200abc', '1-200', '--1200', '$USD 1200', '(1200', '1200)', '1,20,0', '12.34.56']
  for (const input of malformed) {
    const result = parseAmountString(input)
    assert.equal(result.value, null, `expected "${input}" to be rejected`)
    assert.equal(result.error, 'INVALID_AMOUNT', `expected "${input}" -> INVALID_AMOUNT, got ${result.error}`)
  }
})

test('strict grammar: every listed valid example parses to the correct exact amount', () => {
  assert.equal(parseAmountString('$1,234.56').value, '1234.56')
  assert.equal(parseAmountString('USD 1,234.56').value, '1234.56')
  assert.equal(parseAmountString('1,234.56 USD').value, '1234.56')
  assert.equal(parseAmountString('€1.200,00').value, '1200.00')
  assert.equal(parseAmountString('(500.00)').value, '-500.00')
  assert.equal(parseAmountString('-500.00').value, '-500.00')
})

test('strict grammar: single-separator ambiguity is symmetrical between comma and dot', () => {
  const commaResult = parseAmountString('1,200')
  assert.equal(commaResult.value, null)
  assert.equal(commaResult.error, 'AMBIGUOUS_AMOUNT_FORMAT')
  const dotResult = parseAmountString('1.200')
  assert.equal(dotResult.value, null)
  assert.equal(dotResult.error, 'AMBIGUOUS_AMOUNT_FORMAT')
})

test('strict grammar: recognized £ and lowercase-code prefixes/suffixes are accepted', () => {
  assert.equal(parseAmountString('£500.00').value, '500.00')
  assert.equal(parseAmountString('cad 42.50').value, '42.50')
  assert.equal(parseAmountString('42.50 eur').value, '42.50')
})

test('strict grammar: repeated currency symbols are rejected, not silently deduplicated', () => {
  assert.equal(parseAmountString('$$500.00').error, 'INVALID_AMOUNT')
  assert.equal(parseAmountString('$1,234.56 USD').error, 'INVALID_AMOUNT')
})

test('strict grammar: an unrecognized currency word is rejected, not stripped', () => {
  assert.equal(parseAmountString('dollars 1200').error, 'INVALID_AMOUNT')
  assert.equal(parseAmountString('1200 dollars').error, 'INVALID_AMOUNT')
})

test('strict grammar: grouped-thousands rule — first group 1-3 digits, every following group exactly 3', () => {
  assert.equal(parseAmountString('1,234,567.89').value, '1234567.89')
  assert.equal(parseAmountString('1.234.567,89').value, '1234567.89')
  assert.equal(parseAmountString('12,34,567').error, 'INVALID_AMOUNT') // second group "34" is not 3 digits
  assert.equal(parseAmountString('1234,567').error, 'INVALID_AMOUNT') // first group "1234" is over 3 digits
})

test('strict grammar: leading zeroes are stripped before the magnitude check, zero itself is preserved', () => {
  assert.equal(parseAmountString('007.50').value, '7.50')
  assert.equal(parseAmountString('0.00').value, '0.00')
  assert.equal(parseAmountString('000').value, '0.00')
  assert.equal(parseAmountString('0').value, '0.00')
})

test('strict grammar: a value with 11 significant integer digits after stripping leading zeroes is still rejected', () => {
  assert.equal(parseAmountString('00012345678901.00').error, 'INVALID_AMOUNT') // 12345678901 = 11 digits
  assert.equal(parseAmountString('000099999999999.00').error, 'INVALID_AMOUNT') // 99999999999 = 11 nines
})

test('strict grammar: comparisons and normalization after strict parsing remain BigInt/string-exact', () => {
  const a = parseAmountString('$1,200.00').value
  const b = parseAmountString('1200.00').value
  assert.equal(a, b)
  assert.equal(compareAmounts(a, b), 0)
})
