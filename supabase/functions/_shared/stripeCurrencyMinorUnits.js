// Explicit Stripe charge minor-unit exponents.
// Unknown codes fail closed; there is deliberately no default exponent.
//
// Stripe represents charge amounts as integer minor units. Most currencies use
// two decimal places, the listed zero-decimal currencies use none, and the
// listed three-decimal currencies use three.
//
// Special provider behavior belongs here rather than in generic money code.
const ZERO_DECIMAL = new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF',
  'UGX','VND','VUV','XAF','XOF','XPF',
])

const THREE_DECIMAL = new Set([
  'BHD','IQD','JOD','KWD','LYD','OMR','TND',
])

const TWO_DECIMAL = new Set([
  'AED','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT',
  'BGN','BMD','BND','BOB','BRL','BSD','BWP','BYN','BZD','CAD','CDF','CHF',
  'CNY','COP','CRC','CVE','CZK','DKK','DOP','DZD','EGP','ETB','EUR','FJD',
  'FKP','GBP','GEL','GIP','GMD','GTQ','GYD','HKD','HNL','HRK','HTG','HUF',
  'IDR','ILS','INR','ISK','JMD','KES','KGS','KHR','KYD','KZT','LAK','LBP',
  'LKR','LRD','LSL','MAD','MDL','MKD','MMK','MNT','MOP','MUR','MVR','MWK',
  'MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','PAB','PEN','PGK',
  'PHP','PKR','PLN','QAR','RON','RSD','RUB','SAR','SBD','SCR','SEK','SGD',
  'SHP','SLE','SOS','SRD','SZL','THB','TJS','TOP','TRY','TTD','TWD','TZS',
  'UAH','USD','UYU','UZS','WST','XCD','YER','ZAR','ZMW',
])

function normalize(code) {
  return String(code ?? '').trim().toUpperCase()
}

export function stripeChargeMinorUnitExponent(currency) {
  const code = normalize(currency)
  if (ZERO_DECIMAL.has(code)) return 0
  if (THREE_DECIMAL.has(code)) return 3
  if (TWO_DECIMAL.has(code)) return 2
  return null
}

export function requireStripeChargeMinorUnitExponent(currency) {
  const exponent = stripeChargeMinorUnitExponent(currency)
  if (exponent === null) {
    const code = normalize(currency) || 'UNKNOWN'
    const error = new Error(`PROVIDER_CURRENCY_UNKNOWN: ${code}`)
    error.code = 'PROVIDER_CURRENCY_UNKNOWN'
    throw error
  }
  return exponent
}
