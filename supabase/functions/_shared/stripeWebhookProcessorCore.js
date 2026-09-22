const STRIPE_RETRIEVE_PATH = Object.freeze({
  charge: '/v1/charges/',
  refund: '/v1/refunds/',
  invoice: '/v1/invoices/',
  payment_intent: '/v1/payment_intents/',
  dispute: '/v1/disputes/',
})

export function normalizeStripeWebhookEnvelope(event) {
  if (!event || typeof event !== 'object') {
    return Object.freeze({ valid: false, reason: 'EVENT_INVALID' })
  }
  const id = typeof event.id === 'string' ? event.id : ''
  const type = typeof event.type === 'string' ? event.type : ''
  const account = typeof event.account === 'string' ? event.account : ''
  const livemode = event.livemode
  const object = event?.data?.object
  const objectId = typeof object?.id === 'string' ? object.id : ''
  const objectType = typeof object?.object === 'string' ? object.object : ''
  if (!id || !type || !account || typeof livemode !== 'boolean' || !objectId || !objectType) {
    return Object.freeze({ valid: false, reason: 'EVENT_SHAPE_INVALID' })
  }
  return Object.freeze({
    valid: true,
    id,
    type,
    account,
    livemode,
    apiVersion: typeof event.api_version === 'string' ? event.api_version : null,
    objectId,
    objectType,
    eventCreated: Number.isInteger(event.created) ? event.created : null,
  })
}

export function supportedStripeApiVersion(apiVersion, configuredVersions) {
  if (typeof apiVersion !== 'string' || !apiVersion) return false
  const supported = String(configuredVersions || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return supported.includes(apiVersion)
}

export function stripeRetrieveUrl(objectType, objectId) {
  const prefix = STRIPE_RETRIEVE_PATH[objectType]
  if (!prefix || typeof objectId !== 'string' || !objectId) return null
  return `https://api.stripe.com${prefix}${encodeURIComponent(objectId)}`
}

export function webhookObjectEvidenceClass(objectType) {
  if (['charge','refund','invoice','payment_intent','dispute'].includes(objectType)) {
    return 'PROVIDER_NATIVE'
  }
  return null
}
