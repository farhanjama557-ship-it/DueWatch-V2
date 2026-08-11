// The exact "material payload" used everywhere idempotency/conflict
// decisions are made: same idempotent retry, conflicting retry, duplicate
// provenance identity, already-existing invoice, same-key/different-payload
// rejection. Nothing about "materially the same" is left implicit — every
// field that participates is enumerated here, once, and both the browser
// client and the server-side migration derive their comparisons from this
// same field list (the server keeps its own SQL copy of this shape so it
// never has to trust a client-computed hash, but the field list itself is
// the single source of truth for what counts as material).
//
// Included fields and why:
//   - tenant identity: user_id — nothing is comparable across tenants.
//   - client identity inputs: client_name, client_company, client_email,
//     client_phone, source_system, source_client_id — everything the
//     canonical resolver itself considers (PR #22's matching rules), so a
//     payload that would resolve to a different client is never treated
//     as "the same."
//   - invoice identity: invoice_number, source_invoice_id — either can be
//     the durable key depending on what the source system provided.
//   - invoice_date, due_date — date facts about the invoice itself.
//   - amount, currency — the money fact, as an exact decimal string, never
//     a float.
//   - paid/status state: status, amount_paid, payment_date — the payment
//     fact, since "the same invoice, but now marked paid differently" is
//     materially a different assertion, not a safe no-op retry.
//
// Excluded (non-material) fields and why:
//   - notes: free text, does not change what/who/how-much/when this
//     invoice is about; two submissions differing only in notes are the
//     same material fact under a slightly different annotation.
//   - originalRowNumber, sourceSheet, mapping, duplicateKey,
//     payment_timing_known, issues, outcome: transport/derived metadata
//     about how the value was produced, not what was asserted.
export const MATERIAL_FIELDS = Object.freeze([
  'client_name',
  'client_company',
  'client_email',
  'client_phone',
  'source_system',
  'source_client_id',
  'invoice_number',
  'source_invoice_id',
  'invoice_date',
  'due_date',
  'amount',
  'currency',
  'status',
  'amount_paid',
  'payment_date',
])

// Builds the canonical material payload object for one normalized row,
// scoped to a tenant. `normalized` is the importer engine's per-row
// `normalized` object (see src/lib/import/normalize.js's buildRowResult).
export function buildMaterialPayload(userId, normalized) {
  if (!userId) throw new Error('buildMaterialPayload: userId is required')
  const payload = { user_id: userId }
  for (const field of MATERIAL_FIELDS) {
    const value = normalized?.[field]
    payload[field] = value == null || value === '' ? null : value
  }
  return payload
}

// Deterministic JSON serialization — sorted keys, no whitespace — so the
// same logical payload always produces the same string regardless of
// object key insertion order.
export function canonicalizeMaterialPayload(payload) {
  const keys = Object.keys(payload).sort()
  const sorted = {}
  for (const k of keys) sorted[k] = payload[k]
  return JSON.stringify(sorted)
}

// SHA-256 over the canonical JSON, hex-encoded. Node's webcrypto (globally
// available since Node 19, and in this repo's Node 22 baseline) is used
// instead of importing the `crypto` module, so this stays usable from a
// browser bundle without a Node-specific import.
export async function hashMaterialPayload(payload) {
  const canonical = canonicalizeMaterialPayload(payload)
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// The row-level retry-idempotency key: identifies "this specific source
// row within this specific import run." Distinct from the material
// payload — this key stays the same across a retried submission of the
// same run even if (through a bug) the payload content changed, which is
// exactly the case the server must detect and reject rather than silently
// accept (see "same idempotency key with conflicting payload" in the
// recovery proof requirements).
export function buildRowIdempotencyKey(runId, rowNumber) {
  if (!runId || rowNumber == null) {
    throw new Error('buildRowIdempotencyKey: runId and rowNumber are required')
  }
  return `${runId}:${rowNumber}`
}
