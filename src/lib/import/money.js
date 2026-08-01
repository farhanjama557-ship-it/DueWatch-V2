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
// "$1,234.56", "(500.00)") into an exact decimal string via BigInt
// minor-unit arithmetic. Separator ambiguity that can't be resolved from
// the string's own shape is reported, never silently guessed.
export function parseAmountString(rawStr) {
  let s = String(rawStr).trim()
  if (s === '') return { value: null, blank: true, ambiguous: false, error: null }

  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1).trim()
  }
  // Strip currency symbols, whitespace, and any other non-numeric noise —
  // keep only digits, '.', ',', and a leading '-'.
  s = s.replace(/[^0-9.,-]/g, '')
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  s = s.replace(/-/g, '')
  if (s === '') return invalidAmount()

  const dotCount = (s.match(/\./g) || []).length
  const commaCount = (s.match(/,/g) || []).length

  let integerPart
  let fractionPart

  if (dotCount === 0 && commaCount === 0) {
    integerPart = s
    fractionPart = ''
  } else if (dotCount > 0 && commaCount === 0) {
    const parts = s.split('.')
    if (parts.length === 2) {
      ;[integerPart, fractionPart] = parts
    } else {
      // More than one dot: only a safe reading if every group after the
      // first is a 3-digit thousands group (e.g. "1.200.000" -> 1200000).
      const groupsOk = parts.slice(1).every((g) => g.length === 3)
      if (!groupsOk) return invalidAmount()
      integerPart = parts.join('')
      fractionPart = ''
    }
  } else if (commaCount > 0 && dotCount === 0) {
    const parts = s.split(',')
    if (parts.length === 2) {
      if (parts[1].length === 3) {
        // "1,200" — genuinely ambiguous: US thousands separator (1200) or
        // an uncommon 3-digit decimal fraction. Never guessed.
        return ambiguousAmount()
      }
      ;[integerPart, fractionPart] = parts
    } else {
      const groupsOk = parts.slice(1).every((g) => g.length === 3)
      if (!groupsOk) return invalidAmount()
      integerPart = parts.join('')
      fractionPart = ''
    }
  } else {
    // Both separators present: whichever occurs last is the decimal
    // separator — unambiguous ("1,200.00" vs "1.200,00").
    const lastDot = s.lastIndexOf('.')
    const lastComma = s.lastIndexOf(',')
    const decimalChar = lastDot > lastComma ? '.' : ','
    const thousandsChar = decimalChar === '.' ? ',' : '.'
    const decimalIdx = decimalChar === '.' ? lastDot : lastComma
    const intRaw = s.slice(0, decimalIdx)
    fractionPart = s.slice(decimalIdx + 1)
    const thousandsParts = intRaw.split(thousandsChar)
    const groupsOk = thousandsParts.length === 1 || thousandsParts.slice(1).every((g) => g.length === 3)
    if (!groupsOk) return invalidAmount()
    integerPart = thousandsParts.join('')
  }

  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fractionPart)) return invalidAmount()
  if (integerPart === '' && fractionPart === '') return invalidAmount()
  if (integerPart === '') integerPart = '0'

  // More precision than this app stores is never silently rounded — the
  // source value is untrustworthy at that precision (we don't know what
  // the "real" two-decimal amount was meant to be), so it's rejected.
  if (fractionPart.length > MINOR_UNIT_DIGITS) return invalidAmount()

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
