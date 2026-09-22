export const STRIPE_SYNC_RESOURCES = Object.freeze({
  charges: Object.freeze({
    name: 'charges',
    path: '/v1/charges',
    objectType: 'charge',
    evidenceClass: 'PROVIDER_NATIVE',
  }),
  refunds: Object.freeze({
    name: 'refunds',
    path: '/v1/refunds',
    objectType: 'refund',
    evidenceClass: 'PROVIDER_NATIVE',
  }),
  invoices: Object.freeze({
    name: 'invoices',
    path: '/v1/invoices',
    objectType: 'invoice',
    evidenceClass: 'PROVIDER_NATIVE',
  }),
})

export const STRIPE_SYNC_ERROR = Object.freeze({
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  UNAVAILABLE: 'UNAVAILABLE',
  SCHEMA: 'SCHEMA',
  UNKNOWN: 'UNKNOWN',
})

function safeCursor(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

export function classifyStripeHttpStatus(status) {
  if (status === 401 || status === 403) return STRIPE_SYNC_ERROR.AUTH
  if (status === 429) return STRIPE_SYNC_ERROR.RATE_LIMIT
  if (status >= 500) return STRIPE_SYNC_ERROR.UNAVAILABLE
  if (status >= 400) return STRIPE_SYNC_ERROR.SCHEMA
  return STRIPE_SYNC_ERROR.UNKNOWN
}

export function buildStripeListUrl({
  resource,
  startingAfter = null,
  previousCompleteCursor = null,
  limit = 100,
} = {}) {
  const config = STRIPE_SYNC_RESOURCES[resource]
  if (!config) throw new Error(`Unsupported Stripe sync resource: ${resource}`)
  const url = new URL(`https://api.stripe.com${config.path}`)
  url.searchParams.set('limit', String(limit))
  if (startingAfter) url.searchParams.set('starting_after', String(startingAfter))
  const createdGte = safeCursor(previousCompleteCursor)
  if (createdGte != null) url.searchParams.set('created[gte]', String(createdGte))
  return url.toString()
}

export function expectedLivemode(environment) {
  if (environment === 'live') return true
  if (environment === 'test') return false
  throw new Error('Stripe connection environment must be live or test.')
}

export async function collectCompleteStripeResource({
  resource,
  previousCompleteCursor = null,
  requestPage,
  pageLimit = 1000,
} = {}) {
  if (typeof requestPage !== 'function') throw new Error('Stripe sync requires requestPage.')
  if (!STRIPE_SYNC_RESOURCES[resource]) throw new Error(`Unsupported Stripe sync resource: ${resource}`)
  if (!Number.isInteger(pageLimit) || pageLimit < 1) throw new Error('pageLimit must be a positive integer.')

  let startingAfter = null
  let pageCount = 0
  let maxCreated = safeCursor(previousCompleteCursor)
  const items = []
  const seen = new Set()

  while (pageCount < pageLimit) {
    let page
    try {
      page = await requestPage({ resource, startingAfter, previousCompleteCursor })
    } catch (error) {
      return Object.freeze({
        complete: false,
        items: Object.freeze(items),
        nextCompleteCursor: previousCompleteCursor ?? null,
        errorCategory: error?.category || STRIPE_SYNC_ERROR.UNAVAILABLE,
        errorCode: error?.code || 'STRIPE_PAGE_REQUEST_FAILED',
        pageCount,
      })
    }

    pageCount += 1
    if (!page || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      return Object.freeze({
        complete: false,
        items: Object.freeze(items),
        nextCompleteCursor: previousCompleteCursor ?? null,
        errorCategory: STRIPE_SYNC_ERROR.SCHEMA,
        errorCode: 'STRIPE_LIST_SHAPE_INVALID',
        pageCount,
      })
    }

    for (const item of page.data) {
      const id = typeof item?.id === 'string' ? item.id : ''
      if (!id) {
        return Object.freeze({
          complete: false,
          items: Object.freeze(items),
          nextCompleteCursor: previousCompleteCursor ?? null,
          errorCategory: STRIPE_SYNC_ERROR.SCHEMA,
          errorCode: 'STRIPE_OBJECT_ID_MISSING',
          pageCount,
        })
      }
      if (!seen.has(id)) {
        seen.add(id)
        items.push(item)
      }
      if (Number.isInteger(item?.created) && item.created >= 0) {
        maxCreated = Math.max(maxCreated ?? 0, item.created)
      }
    }

    if (!page.has_more) {
      return Object.freeze({
        complete: true,
        items: Object.freeze(items),
        nextCompleteCursor: maxCreated == null ? previousCompleteCursor ?? null : String(maxCreated),
        errorCategory: null,
        errorCode: null,
        pageCount,
      })
    }

    const last = page.data.at(-1)
    if (!last?.id) {
      return Object.freeze({
        complete: false,
        items: Object.freeze(items),
        nextCompleteCursor: previousCompleteCursor ?? null,
        errorCategory: STRIPE_SYNC_ERROR.SCHEMA,
        errorCode: 'STRIPE_PAGINATION_CURSOR_MISSING',
        pageCount,
      })
    }
    startingAfter = last.id
  }

  return Object.freeze({
    complete: false,
    items: Object.freeze(items),
    nextCompleteCursor: previousCompleteCursor ?? null,
    errorCategory: STRIPE_SYNC_ERROR.UNKNOWN,
    errorCode: 'STRIPE_PAGE_LIMIT_REACHED',
    pageCount,
  })
}
