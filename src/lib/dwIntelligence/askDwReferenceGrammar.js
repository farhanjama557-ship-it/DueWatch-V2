/**
 * Shared finite grammar for references whose identity comes from the verified
 * Ask DW case focus rather than from free text. This module resolves nothing:
 * CP5 still revalidates the referenced client/invoice against the authenticated
 * tenant. Consumers may use these forms only to recognize that a reference is
 * contextual and therefore must not be treated as an ordinary unknown word.
 */

export const ASK_DW_CONTEXTUAL_REFERENCE_FORMS = Object.freeze([
  'it', 'them', 'this', 'that', 'this one', 'that one',
  'the client', 'the customer', 'the invoice',
  'this client', 'this customer', 'this invoice',
  'that client', 'that customer', 'that invoice',
])

export const ASK_DW_CONTEXTUAL_REFERENCE_TOKENS = Object.freeze(
  [...new Set(ASK_DW_CONTEXTUAL_REFERENCE_FORMS.flatMap((form) => form.split(' ')))],
)

function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US').replace(/[.!?]+$/u, '').trim()
}

export function findAskDwContextualReferenceSuffix(value) {
  const source = normalized(value)
  const form = [...ASK_DW_CONTEXTUAL_REFERENCE_FORMS]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => source === candidate || source.endsWith(` ${candidate}`))
  return form ?? null
}

export function isAskDwContextualReference(value) {
  return ASK_DW_CONTEXTUAL_REFERENCE_FORMS.includes(normalized(value))
}

export function hasAskDwVerifiedActiveSubject(caseContext) {
  const focus = caseContext?.focus ?? null
  return [focus?.clientRef, focus?.invoiceRef].some((reference) =>
    ['client', 'invoice'].includes(reference?.kind) &&
    typeof reference?.id === 'string' && reference.id.trim().length > 0)
}
