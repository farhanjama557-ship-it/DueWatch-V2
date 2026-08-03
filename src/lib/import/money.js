// Precision-safe money parsing. The authoritative output is always a
// decimal string with exactly MINOR_UNIT_DIGITS fraction digits (e.g.
// "1200.00"), produced and compared via BigInt minor-unit arithmetic.
// `Number`/`parseFloat` are never used on the authoritative value or in any
// amount comparison in this module.

export const SUPPORTED_CURRENCIES = Object.freeze(['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD'])
// All six currently-supported currencies use two decimal minor units in
// Phase 1.5A (locked by the founder decision) — a currency needing a
// different minor-unit count is simply not supported yet.
const MINOR_UNIT_DIGITS = 2
// Matches the eventual DB column (`numeric(12, 2)`): at most 10 digits
// before the decimal point. Also serves as the "untrustworthy magnitude"
// guard for Excel numeric cells — anything larger is rejected rather than
// trusted, since a JS double's ~15-17 significant decimal digits stop
// reliably representing the spreadsheet's original value long before this
// limit anyway.
const MAX_INTEGER_DIGITS = 10

// Recognized currency wrapper tokens (Correction 2). A symbol may sit
// directly against the number ("$1,234.56") with no separating space; a
// three-letter code requires an actual separating space ("USD 1,234.56",
// "1,234.56 USD") so it's never confused with letters glued onto the
// number itself (which must be rejected as embedded alphabetic text).
const CURRENCY_SYMBOLS = ['$', '£', '€']
const CURRENCY_CODE_ALTERNATION = SUPPORTED_CURRENCIES.join('|')
const SYMBOL_PREFIX_RE = /^[$£€]\s*/
const SYMBOL_SUFFIX_RE = /\s*[$£€]$/
const CODE_PREFIX_RE = new RegExp(`^(?:${CURRENCY_CODE_ALTERNATION})\\s+`, 'i')
const CODE_SUFFIX_RE = new RegExp(`\\s+(?:${CURRENCY_CODE_ALTERNATION})$`, 'i')

// Strips AT MOST ONE currency wrapper token (prefix OR suffix, symbol OR
// code) — never more than one. A second currency token left over after
// this single strip (e.g. "$USD 1200", "$1,234.56 USD") is deliberately
// NOT removed here; it survives into the final digits-only grammar check
// below and gets rejected there as leftover junk, which is exactly the
// "repeated currency symbols" rejection the correction requires.
function stripOneCurrencyWrapper(s) {
  if (SYMBOL_PREFIX_RE.test(s)) return s.replace(SYMBOL_PREFIX_RE, '')
  if (CODE_PREFIX_RE.test(s)) return s.replace(CODE_PREFIX_RE, '')
  if (SYMBOL_SUFFIX_RE.test(s)) return s.replace(SYMBOL_SUFFIX_RE, '')
  if (CODE_SUFFIX_RE.test(s)) return s.replace(CODE_SUFFIX_RE, '')
  return s
}

// Assembles { integerPart, fractionPart } from a digits/./,-only body, or
// returns 'AMBIGUOUS' / 'INVALID' as a sentinel string. Grouped-thousands
// rule: the first group is 1-3 digits, every following group is exactly 3
// digits. A single separator with an exactly-3-digit trailing group is
// symmetrically ambiguous regardless of whether it's '.' or ',' — never
// resolved by a US-locale assumption.
function assembleDigitGroups(body) {
  const dotCount = (body.match(/\./g) || []).length
  const commaCount = (body.match(/,/g) || []).length

  if (dotCount === 0 && commaCount === 0) {
    return { integerPart: body, fractionPart: '' }
  }

  if (dotCount > 0 && commaCount === 0) return assembleSingleCharGroups(body, '.', dotCount)
  if (commaCount > 0 && dotCount === 0) return assembleSingleCharGroups(body, ',', commaCount)

  // Both separators present: whichever occurs LAST is the decimal
  // separator — unambiguous ("1,200.00" vs "1.200,00").
  const lastDot = body.lastIndexOf('.')
  const lastComma = body.lastIndexOf(',')
  const decimalChar = lastDot > lastComma ? '.' : ','
  const thousandsChar = decimalChar === '.' ? ',' : '.'
  const decimalIdx = decimalChar === '.' ? lastDot : lastComma
  const intRaw = body.slice(0, decimalIdx)
  const fractionPart = body.slice(decimalIdx + 1)
  if (intRaw.includes(decimalChar)) return 'INVALID' // a stray extra decimal separator
  const thousandsParts = intRaw.split(thousandsChar)
  if (!isValidThousandsGrouping(thousandsParts)) return 'INVALID'
  return { integerPart: thousandsParts.join(''), fractionPart }
}

function assembleSingleCharGroups(body, sep, count) {
  const parts = body.split(sep)
  if (count === 1) {
    const [integerPart, fractionPart] = parts
    // Genuinely ambiguous only when BOTH readings are structurally
    // plausible: a thousands grouping needs a 1-3 digit leading group, and
    // a decimal fraction happens to be exactly 3 digits too. If the
    // leading group is too long to be a thousands group (e.g. "1234,567"),
    // there's only one plausible reading (decimal) — not an ambiguity.
    const plausibleAsThousands = integerPart.length >= 1 && integerPart.length <= 3
    if (plausibleAsThousands && fractionPart.length === 3) return 'AMBIGUOUS'
    return { integerPart, fractionPart }
  }
  if (!isValidThousandsGrouping(parts)) return 'INVALID'
  return { integerPart: parts.join(''), fractionPart: '' }
}

function isValidThousandsGrouping(parts) {
  if (parts.length < 2) return true
  if (parts[0].length < 1 || parts[0].length > 3) return false
  return parts.slice(1).every((g) => g.length === 3)
}

export function normalizeCurrencyCode(raw) {
  if (raw == null) return { value: null, blank: true, error: null }
  const trimmed = String(raw).trim()
  if (trimmed === '') return { value: null, blank: true, error: null }
  const upper = trimmed.toUpperCase()
  if (SUPPORTED_CURRENCIES.includes(upper)) return { value: upper, blank: false, error: null }
  return { value: null, blank: false, error: 'UNSUPPORTED_CURRENCY' }
}

export function minorUnitsToDecimalString(minor) {
  const neg = minor < 0n
  const abs = neg ? -minor : minor
  const s = abs.toString().padStart(MINOR_UNIT_DIGITS + 1, '0')
  const intPart = s.slice(0, -MINOR_UNIT_DIGITS)
  const fracPart = s.slice(-MINOR_UNIT_DIGITS)
  return `${neg ? '-' : ''}${intPart}.${fracPart}`
}

export function decimalStringToMinorUnits(decStr) {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(decStr)
  if (!m) throw new Error(`decimalStringToMinorUnits: not a normalized amount string: "${decStr}"`)
  const [, sign, intPart, fracPart] = m
  const minor = BigInt(intPart + fracPart)
  return sign === '-' ? -minor : minor
}

// Exact comparison of two normalized decimal-string amounts. Returns -1, 0,
// or 1 — never compares via Number/parseFloat.
export function compareAmounts(a, b) {
  const ma = decimalStringToMinorUnits(a)
  const mb = decimalStringToMinorUnits(b)
  if (ma < mb) return -1
  if (ma > mb) return 1
  return 0
}

function finalizeFromMinorUnits(minorUnits, negative) {
  const signed = negative && minorUnits !== 0n ? -minorUnits : minorUnits
  return { value: minorUnitsToDecimalString(signed), blank: false, ambiguous: false, error: null }
}

function invalidAmount() {
  return { value: null, blank: false, ambiguous: false, error: 'INVALID_AMOUNT' }
}

function ambiguousAmount() {
  return { value: null, blank: false, ambiguous: true, error: 'AMBIGUOUS_AMOUNT_FORMAT' }
}

// Parses a human-entered amount string ("1200", "1,200.00", "1.200,00",
// "$1,234.56", "USD 1,234.56", "(500.00)") into an exact decimal string via
// BigInt minor-unit arithmetic. A strict grammar — never a "strip anything
// that isn't a digit" repair pass: embedded letters, embedded/multiple
// signs, unmatched parentheses, repeated currency tokens, and malformed
// separator grouping are all rejected rather than silently cleaned up.
// Separator ambiguity that can't be resolved from the string's own shape
// is reported, never guessed via a locale assumption.
export function parseAmountString(rawStr) {
  let s = String(rawStr).trim()
  if (s === '') return { value: null, blank: true, ambiguous: false, error: null }

  let negative = false

  // One balanced pair of accounting parentheses wraps the WHOLE value.
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1).trim()
    if (s.includes('(') || s.includes(')')) return invalidAmount() // nested/unmatched
    if (s.startsWith('-')) return invalidAmount() // sign + parens together is not an accepted combination
  }

  // One leading minus sign.
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }

  // One recognized currency symbol or supported ISO code, prefix or suffix.
  s = stripOneCurrencyWrapper(s).trim()

  if (s === '') return invalidAmount()
  // Anything left that isn't a digit or a separator is rejected outright —
  // embedded letters, a second sign, stray parentheses, a leftover second
  // currency token, or any other trailing/leading junk.
  if (!/^[0-9.,]+$/.test(s)) return invalidAmount()

  const assembled = assembleDigitGroups(s)
  if (assembled === 'AMBIGUOUS') return ambiguousAmount()
  if (assembled === 'INVALID') return invalidAmount()

  let { integerPart, fractionPart } = assembled
  if (integerPart === '' && fractionPart === '') return invalidAmount()
  if (integerPart === '') integerPart = '0'

  // More precision than this app stores is never silently rounded — the
  // source value is untrustworthy at that precision (we don't know what
  // the "real" two-decimal amount was meant to be), so it's rejected.
  if (fractionPart.length > MINOR_UNIT_DIGITS) return invalidAmount()

  // Strip insignificant leading zeroes before the magnitude check, while
  // preserving a genuine zero ("000" -> "0", not "").
  integerPart = integerPart.replace(/^0+(?=\d)/, '')

  // Magnitude guard (see MAX_INTEGER_DIGITS) — applies uniformly to
  // CSV-text and Excel-number-derived amounts alike.
  if (integerPart.length > MAX_INTEGER_DIGITS) return invalidAmount()

  const paddedFraction = fractionPart.padEnd(MINOR_UNIT_DIGITS, '0')
  const minor = BigInt(integerPart + paddedFraction)
  return finalizeFromMinorUnits(minor, negative)
}

// Excel numeric cells arrive as JS numbers — that is the most precise form
// ExcelJS exposes, so this is the one place a JS number is unavoidable.
// `String(n)` (NOT `toFixed`) is used to convert it: per ECMA-262,
// Number::toString produces the SHORTEST decimal string that round-trips
// back to the exact same double — it performs no rounding of its own and
// is exact for the value ExcelJS actually gave us. That string is then run
// through the identical exact string parser used for CSV text below, so
// `toFixed`/rounding never touches an authoritative amount, and a value
// with more than two fractional digits is rejected (INVALID_AMOUNT) by
// that shared parser rather than silently rounded.
export function parseAmountNumber(n) {
  if (!Number.isFinite(n)) return invalidAmount()
  const str = String(n)
  if (/e/i.test(str)) {
    // Exponential notation: the magnitude is outside a range this parser
    // can represent as a trustworthy plain decimal string.
    return invalidAmount()
  }
  return parseAmountString(str)
}

// Dispatches on the raw value's JS type (string from CSV/Excel text cells,
// number from Excel numeric cells, null/undefined/'' for blank).
export function parseAmount(raw) {
  if (raw == null) return { value: null, blank: true, ambiguous: false, error: null }
  if (typeof raw === 'number') return parseAmountNumber(raw)
  return parseAmountString(String(raw))
}
