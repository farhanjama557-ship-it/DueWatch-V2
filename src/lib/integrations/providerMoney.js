const CURRENCY_CODE = /^[A-Z]{3}$/
const INTEGER_MINOR = /^-?\d+$/
const DECIMAL_MAJOR = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

function normalizeExponent(value) {
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw new Error('A known currency minor-unit exponent from 0 to 6 is required.')
  }
  return value
}

export function normalizeProviderCurrency(currency) {
  const code = String(currency ?? '').trim().toUpperCase()
  if (!CURRENCY_CODE.test(code)) {
    throw new Error('A normalized three-letter currency is required.')
  }
  return code
}

export function normalizeMinorAmount(value) {
  const raw = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim()
  if (!INTEGER_MINOR.test(raw)) {
    throw new Error('Provider minor-unit amount must be an integer.')
  }
  return BigInt(raw)
}

export function minorUnitsToDecimalString({ amountMinor, exponent } = {}) {
  const scale = normalizeExponent(exponent)
  const minor = normalizeMinorAmount(amountMinor)
  const negative = minor < 0n
  const absolute = negative ? -minor : minor
  if (scale === 0) return `${negative ? '-' : ''}${absolute}`

  const divisor = 10n ** BigInt(scale)
  const whole = absolute / divisor
  const fraction = String(absolute % divisor).padStart(scale, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

export function decimalStringToMinorUnits({ amount, exponent } = {}) {
  const scale = normalizeExponent(exponent)
  const raw = String(amount ?? '').trim()
  if (!DECIMAL_MAJOR.test(raw)) {
    throw new Error('Major-unit amount must be a plain decimal string.')
  }

  const negative = raw.startsWith('-')
  const unsigned = negative ? raw.slice(1) : raw
  const [whole, fraction = ''] = unsigned.split('.')
  if (fraction.length > scale) {
    throw new Error('Amount has more decimal places than the currency supports.')
  }

  const padded = fraction.padEnd(scale, '0')
  const factor = 10n ** BigInt(scale)
  const minor = BigInt(whole) * factor + BigInt(padded || '0')
  return negative ? -minor : minor
}

export function normalizeProviderMoney({
  currency,
  amountMinor,
  minorUnitExponent,
} = {}) {
  const normalizedCurrency = normalizeProviderCurrency(currency)
  const exponent = normalizeExponent(minorUnitExponent)
  const minor = normalizeMinorAmount(amountMinor)
  return Object.freeze({
    currency: normalizedCurrency,
    amountMinor: minor.toString(),
    minorUnitExponent: exponent,
    amountMajor: minorUnitsToDecimalString({ amountMinor: minor, exponent }),
  })
}
