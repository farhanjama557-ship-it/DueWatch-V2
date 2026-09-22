const SIGNATURE_VERSION = 'v1'
const DEFAULT_TOLERANCE_SECONDS = 300

function parseHeader(header) {
  const parts = String(header || '').split(',').map((part) => part.trim()).filter(Boolean)
  let timestamp = null
  const signatures = []
  for (const part of parts) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index)
    const value = part.slice(index + 1)
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value)
    if (key === SIGNATURE_VERSION && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase())
  }
  return { timestamp, signatures }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function expectedSignature(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return bytesToHex(new Uint8Array(signature))
}

export async function verifyStripeWebhookSignature({
  rawBody,
  signatureHeader,
  secret,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
} = {}) {
  if (typeof rawBody !== 'string' || typeof secret !== 'string' || !secret) {
    return Object.freeze({ verified: false, reason: 'SIGNATURE_INPUT_INVALID', timestamp: null })
  }

  const parsed = parseHeader(signatureHeader)
  if (!Number.isInteger(parsed.timestamp) || parsed.signatures.length === 0) {
    return Object.freeze({ verified: false, reason: 'SIGNATURE_HEADER_INVALID', timestamp: parsed.timestamp })
  }

  const nowSeconds = Math.floor(nowMs / 1000)
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return Object.freeze({ verified: false, reason: 'SIGNATURE_TIMESTAMP_OUTSIDE_TOLERANCE', timestamp: parsed.timestamp })
  }

  const expected = await expectedSignature(secret, `${parsed.timestamp}.${rawBody}`)
  const verified = parsed.signatures.some((candidate) => constantTimeHexEqual(candidate, expected))
  return Object.freeze({
    verified,
    reason: verified ? null : 'SIGNATURE_MISMATCH',
    timestamp: parsed.timestamp,
  })
}

export async function createStripeWebhookTestSignature({
  rawBody,
  secret,
  timestamp,
} = {}) {
  const t = Number(timestamp)
  if (!Number.isInteger(t)) throw new Error('timestamp required')
  const signature = await expectedSignature(secret, `${t}.${rawBody}`)
  return `t=${t},v1=${signature}`
}
