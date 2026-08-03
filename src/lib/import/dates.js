// Precision-safe, non-permissive date parsing. Never uses `Date.parse`/
// `new Date(string)` for authoritative normalization — every recognized
// format is matched and validated by hand so the result is deterministic
// and no locale/engine-dependent guessing can occur.

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function pad2(n) {
  return String(n).padStart(2, '0')
}

function ymd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

export function isValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12) return false
  if (day < 1) return false
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  return day <= maxDay
}

// Strict ISO (YYYY-MM-DD, four-digit year required). Returns a normalized
// "YYYY-MM-DD" string or null if the string doesn't match/isn't a real date.
export function parseIsoDate(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (!isValidCalendarDate(year, month, day)) return null
  return ymd(year, month, day)
}

// "5 January 2026", "January 5, 2026", "Jan 5 2026", "5-Jan-2026". Requires
// a recognized English month name and a four-digit year.
export function parseNamedMonthDate(str) {
  let monthName
  let day
  let year

  let m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(str)
  if (m) {
    ;[, monthName, day, year] = m
  } else {
    m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]+)\.?,?[\s-]+(\d{4})$/.exec(str)
    if (!m) return null
    ;[, day, monthName, year] = m
  }

  const month = MONTH_NAMES[monthName.toLowerCase()]
  if (!month) return null
  const y = Number(year)
  const d = Number(day)
  if (!isValidCalendarDate(y, month, d)) return null
  return ymd(y, month, d)
}

const TWO_DIGIT_YEAR_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/
const FOUR_DIGIT_YEAR_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/

// Classifies a numeric slash/dash date's ambiguity WITHOUT resolving it.
// Returns one of:
//   { kind: 'two-digit-year' }                         — rejected outright, four-digit year required
//   { kind: 'invalid' }                                 — neither segment can be a valid day/month
//   { kind: 'forced-mdy', month, day, year }             — only Month/Day/Year is structurally possible
//   { kind: 'forced-dmy', day, month, year }             — only Day/Month/Year is structurally possible
//   { kind: 'ambiguous', a, b, year }                    — both conventions are structurally possible
//   null                                                 — string doesn't match a numeric slash/dash date at all
export function classifyNumericDate(str) {
  if (TWO_DIGIT_YEAR_RE.test(str) && !FOUR_DIGIT_YEAR_RE.test(str)) {
    return { kind: 'two-digit-year' }
  }
  const m = FOUR_DIGIT_YEAR_RE.exec(str)
  if (!m) return null

  const a = Number(m[1])
  const b = Number(m[2])
  const year = Number(m[3])
  const aCanBeMonth = a >= 1 && a <= 12
  const bCanBeMonth = b >= 1 && b <= 12
  const aCanBeDay = a >= 1 && a <= 31
  const bCanBeDay = b >= 1 && b <= 31

  if (aCanBeMonth && bCanBeMonth) return { kind: 'ambiguous', a, b, year }
  if (!aCanBeMonth && bCanBeMonth && aCanBeDay) return { kind: 'forced-dmy', day: a, month: b, year }
  if (aCanBeMonth && !bCanBeMonth && bCanBeDay) return { kind: 'forced-mdy', month: a, day: b, year }
  return { kind: 'invalid' }
}

// Resolves an 'ambiguous' classification once a file-level MDY/DMY
// convention decision is supplied. Returns null if the resolved
// month/day/year isn't a real calendar date.
export function resolveAmbiguousNumericDate({ a, b, year }, convention) {
  const month = convention === 'MDY' ? a : b
  const day = convention === 'MDY' ? b : a
  if (!isValidCalendarDate(year, month, day)) return null
  return ymd(year, month, day)
}

// Detects a genuine mixed-convention file: numeric dates elsewhere in the
// same file that are UNAMBIGUOUSLY forced into opposite conventions (e.g.
// one row has day=25 forcing DMY, another has day=25 in the second position
// forcing MDY) — not merely two different ambiguous readings, which a
// single file-level decision can resolve on its own.
export function detectMixedDateConvention(classifications) {
  const hasForcedMdy = classifications.some((c) => c && c.kind === 'forced-mdy')
  const hasForcedDmy = classifications.some((c) => c && c.kind === 'forced-dmy')
  return hasForcedMdy && hasForcedDmy
}

const EXCEL_EPOCH_1900_MS = Date.UTC(1899, 11, 31) // serial 0 -> Dec 31, 1899 (serial 1 -> Jan 1, 1900)
const EXCEL_EPOCH_1904_MS = Date.UTC(1904, 0, 1) // serial 0 -> Jan 1, 1904
const MS_PER_DAY = 86400000

// Converts an Excel serial date number to "YYYY-MM-DD" without any
// timezone shift (all arithmetic is done in UTC calendar days). Respects
// the workbook's date system (1900 vs. 1904). Excel's 1900 system has a
// well-known bug that treats 1900 as a leap year — serial 60 is meant to
// represent the fictitious "February 29, 1900", a date that never existed.
// That serial is refused explicitly here rather than letting `Date` roll
// it silently into March 1, 1900.
export function excelSerialToDate(serial, dateSystem = '1900') {
  if (!Number.isFinite(serial)) return { value: null, error: 'not-a-number' }
  const days = Math.trunc(serial)

  if (dateSystem === '1904') {
    const d = new Date(EXCEL_EPOCH_1904_MS + days * MS_PER_DAY)
    return { value: ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), error: null }
  }

  if (days === 60) {
    return { value: null, error: 'excel-1900-fictitious-leap-day' }
  }
  const adjusted = days > 60 ? days - 1 : days
  const d = new Date(EXCEL_EPOCH_1900_MS + adjusted * MS_PER_DAY)
  return { value: ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), error: null }
}

// Top-level date parse for one raw cell value. `options.convention` is the
// file-level MDY/DMY decision (if the user has made one); `options.dateSystem`
// is the workbook's Excel date system. Returns:
//   { value: 'YYYY-MM-DD'|null, code: null|'INVALID_DATE'|'AMBIGUOUS_DATE_FORMAT',
//     requiresUserChoice: boolean, classification?: object, forcedConvention?: 'MDY'|'DMY' }
export function parseDateValue(raw, options = {}) {
  const { convention = null, dateSystem = '1900' } = options

  if (raw == null || raw === '') {
    return { value: null, code: null, requiresUserChoice: false }
  }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { value: null, code: 'INVALID_DATE', requiresUserChoice: false }
    return {
      value: ymd(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate()),
      code: null,
      requiresUserChoice: false,
    }
  }

  if (typeof raw === 'number') {
    const result = excelSerialToDate(raw, dateSystem)
    if (result.error) return { value: null, code: 'INVALID_DATE', requiresUserChoice: false, detail: result.error }
    return { value: result.value, code: null, requiresUserChoice: false }
  }

  const str = String(raw).trim()
  if (!str) return { value: null, code: null, requiresUserChoice: false }

  const iso = parseIsoDate(str)
  if (iso) return { value: iso, code: null, requiresUserChoice: false }

  const named = parseNamedMonthDate(str)
  if (named) return { value: named, code: null, requiresUserChoice: false }

  const classification = classifyNumericDate(str)
  if (classification) {
    if (classification.kind === 'two-digit-year') {
      return { value: null, code: 'INVALID_DATE', requiresUserChoice: false, detail: 'two-digit-year' }
    }
    if (classification.kind === 'invalid') {
      return { value: null, code: 'INVALID_DATE', requiresUserChoice: false }
    }
    if (classification.kind === 'forced-mdy' || classification.kind === 'forced-dmy') {
      const { month, day, year } = classification
      if (!isValidCalendarDate(year, month, day)) {
        return { value: null, code: 'INVALID_DATE', requiresUserChoice: false }
      }
      return {
        value: ymd(year, month, day),
        code: null,
        requiresUserChoice: false,
        forcedConvention: classification.kind === 'forced-mdy' ? 'MDY' : 'DMY',
      }
    }
    if (classification.kind === 'ambiguous') {
      if (!convention) {
        return { value: null, code: 'AMBIGUOUS_DATE_FORMAT', requiresUserChoice: true, classification }
      }
      const resolved = resolveAmbiguousNumericDate(classification, convention)
      if (!resolved) return { value: null, code: 'INVALID_DATE', requiresUserChoice: false }
      return { value: resolved, code: null, requiresUserChoice: false }
    }
  }

  return { value: null, code: 'INVALID_DATE', requiresUserChoice: false }
}
