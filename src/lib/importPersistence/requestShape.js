// Pure request-shaping helpers for the persistence client — no Supabase
// import here, deliberately, so this stays testable under plain Node
// without a browser/Vite env (see importPersistenceClient.js for the
// actual RPC calls, which build on these).

// Maps one normalize.js row result (see src/lib/import/normalize.js's
// buildRowResult) into the shape start_import_run expects. Called for
// every row, not just eligible ones — the server independently
// re-evaluates eligibility from this same data rather than trusting a
// client claim.
export function buildRunRequestRows(previewRows) {
  return (previewRows || []).map((row) => ({
    row_number: row.originalRowNumber,
    outcome: row.outcome,
    issue_codes: (row.issues || []).map((issue) => issue.code),
    normalized: row.normalized || {},
  }))
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// A deterministic idempotency key derived from exactly what would be sent:
// the same file, mapping, and decisions always hash to the same key, so
// re-clicking "Start Import" (double submit, or retrying after a network
// error) reuses the same server-side run instead of starting a second one.
// A genuinely different file/mapping — or a changed warnings-acknowledged
// decision — naturally hashes to a different key. warningsAcknowledged is
// folded in deliberately: the server's own request_payload_hash also
// covers it (see start_import_run), so if the client's key ignored it, a
// user who legitimately toggles acknowledgement and retries would collide
// with their own earlier key and be rejected as a conflicting payload,
// with no way to proceed. Including it here means that toggle starts a
// genuinely new run instead.
export async function buildImportIdempotencyKey(userId, requestRows, warningsAcknowledged = false) {
  if (!userId) throw new Error('buildImportIdempotencyKey: userId is required')
  const hash = await sha256Hex(JSON.stringify({ rows: requestRows, warningsAcknowledged: warningsAcknowledged === true }))
  return `${userId}:${hash}`
}
