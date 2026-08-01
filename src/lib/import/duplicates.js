// Within-upload duplicate identity. Deliberately scoped to "within this
// file" — cross-database duplicate resolution against already-persisted
// clients/invoices is Phase 1.5B's job (it needs PR #22's canonical
// resolver, which this engine has zero access to).
//
// Priority (per the locked correction):
//   A. When a source invoice ID exists: normalized source system + exact
//      normalized source invoice ID.
//   B. Otherwise: a reliable client reference + normalized invoice number.
//
// Reliable client-reference priority:
//   1. normalized source system + source client ID
//   2. normalized client email
//   3. exact normalized client company + client name
//   4. normalized client phone, only when accompanied by company or name
//
// Invoice number is never used alone as a duplicate signal.

function normalizeKeyPart(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizePhoneKeyPart(v) {
  return String(v ?? '').replace(/[^0-9]/g, '')
}

// Returns a client-reference key string, or null if no reliable reference
// exists — callers must not manufacture a key when this returns null.
export function buildClientReference({ source_system, source_client_id, client_email, client_company, client_name, client_phone }) {
  if (source_system && source_client_id) {
    return `srcclient:${normalizeKeyPart(source_system)}|${normalizeKeyPart(source_client_id)}`
  }
  if (client_email) {
    return `email:${normalizeKeyPart(client_email)}`
  }
  if (client_company && client_name) {
    return `namecompany:${normalizeKeyPart(client_company)}|${normalizeKeyPart(client_name)}`
  }
  if (client_phone && (client_company || client_name)) {
    return `phone:${normalizePhoneKeyPart(client_phone)}|${normalizeKeyPart(client_company || client_name)}`
  }
  return null
}

// Returns { key: string|null, incomplete: boolean }. `incomplete` is true
// only when no reliable client reference could be built AND no source
// invoice ID path applied — the caller should attach a nonblocking/review
// DUPLICATE_DETECTION_INCOMPLETE issue in that case, never fabricate a key.
export function buildDuplicateKey(values) {
  const { source_system, source_invoice_id, invoice_number } = values

  if (source_system && source_invoice_id) {
    return {
      key: `src:${normalizeKeyPart(source_system)}|${normalizeKeyPart(source_invoice_id)}`,
      incomplete: false,
    }
  }

  const clientRef = buildClientReference(values)
  if (!clientRef) {
    return { key: null, incomplete: true }
  }
  if (!invoice_number) {
    return { key: null, incomplete: true }
  }
  return { key: `${clientRef}::inv:${normalizeKeyPart(invoice_number)}`, incomplete: false }
}

// Groups a list of { index, key } pairs (key may be null) by key and
// returns a Map<key, number[]> of only the keys that repeat (length > 1).
// Null keys are never grouped together (an absent key is not a match).
export function findDuplicateGroups(entries) {
  const groups = new Map()
  for (const { index, key } of entries) {
    if (key == null) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(index)
  }
  for (const [key, indices] of groups) {
    if (indices.length < 2) groups.delete(key)
  }
  return groups
}
