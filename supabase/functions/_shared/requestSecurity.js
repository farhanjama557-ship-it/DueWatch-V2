const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value) {
  return UUID_RE.test(String(value || ''))
}

export async function readBoundedJson(req, maxBytes = 32768) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error('REQUEST_TOO_LARGE')
    error.status = 413
    throw error
  }

  const raw = await req.text()
  if (new TextEncoder().encode(raw).length > maxBytes) {
    const error = new Error('REQUEST_TOO_LARGE')
    error.status = 413
    throw error
  }

  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    const error = new Error('INVALID_JSON')
    error.status = 400
    throw error
  }
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return atob(padded)
}

// This parser does NOT verify a signature. It is only safe after the Supabase
// Edge gateway has already enforced verify_jwt=true. We use it solely to
// require the verified token's role claim to be service_role for schedulers.
export function verifiedJwtRole(req) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]))
    return typeof payload?.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}
