/**
 * M2H-CP1 — one canonical structural comparison, shared.
 *
 * `JSON.stringify(a) === JSON.stringify(b)` compares SERIALISATIONS, not
 * values, so it reports { balance, currency } and { currency, balance } as
 * different. Before any real adapter exists that is already fatal: QuickBooks
 * and Xero do not emit their fields in the same order, and a false conflict on
 * every invoice teaches a founder to ignore conflicts — which is worse than
 * not detecting them at all.
 *
 * Two deliberate decisions:
 *
 *   Objects are UNORDERED. Key order is a serialisation artefact and carries
 *   no meaning in any provider payload we expect.
 *
 *   Arrays stay ORDERED. Allocation sequences, payment histories and line
 *   items mean something by their order. Sorting them to make a comparison
 *   pass would erase real differences, so arrays are compared element by
 *   element unless a normalized-value contract explicitly says otherwise —
 *   and no such contract exists yet.
 *
 * There is one algorithm here, on purpose. Several subtly different equality
 * helpers is how two parts of a system come to disagree about whether two
 * things are the same thing.
 */

/**
 * A canonical, key-order-independent string form of a value.
 *
 * Also the module's stable digest input, so provenance hashing and equality
 * cannot drift apart.
 */
export function canonicalStringify(value) {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      // An absent key and an explicitly-undefined one are the same absence.
      .filter((key) => value[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`
  }
  // Numbers, strings and booleans keep their own types: '1000' is not 1000,
  // and a provider sending a string amount is a real difference worth seeing.
  return JSON.stringify(value)
}

/** Whether two values are the same value, whatever order their keys arrived in. */
export function canonicalValueEquals(a, b) {
  return canonicalStringify(a) === canonicalStringify(b)
}

/** FNV-1a over the canonical form. Matches the repository's hashing convention. */
export function canonicalHash(value) {
  const text = canonicalStringify(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
