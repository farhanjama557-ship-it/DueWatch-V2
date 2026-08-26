import { createAskDwModelAdapter } from './askDwModelAdapter.js'

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function assertSupabase(supabase) {
  if (!supabase?.functions?.invoke) throw new Error('Ask DW live model provider requires supabase.functions.invoke')
}

async function readEdgeFunctionError(error) {
  const response = error?.context
  if (!response || typeof response.clone !== 'function') return null
  try {
    return await response.clone().json()
  } catch {
    return null
  }
}

function normalizeRetryAfterSeconds(value) {
  const retryAfterSeconds = Number(value)
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.ceil(retryAfterSeconds)
    : null
}

async function throwEdgeFunctionError(error, role) {
  const payload = await readEdgeFunctionError(error)
  const message = payload?.error || error?.message || `Ask DW ${role} model invocation failed`

  if (payload?.code === 'GROQ_RATE_LIMITED') {
    const retryAfterSeconds = normalizeRetryAfterSeconds(payload?.retryAfterSeconds)
    const retryCopy = retryAfterSeconds
      ? ` Try again in about ${retryAfterSeconds} seconds.`
      : ' Try again shortly.'
    const rateLimitError = new Error(`${message}${retryCopy}`)
    rateLimitError.code = 'GROQ_RATE_LIMITED'
    rateLimitError.retryAfterSeconds = retryAfterSeconds
    throw rateLimitError
  }

  const invocationError = new Error(message)
  if (payload?.code) invocationError.code = payload.code
  throw invocationError
}

function createEdgeInvoke({ supabase, functionName, role }) {
  assertSupabase(supabase)
  return async (request) => {
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: {
        role,
        stage: request.stage,
        contract: request.contract,
        input: request.input,
      },
    })
    if (error) await throwEdgeFunctionError(error, role)
    if (!data?.ok || !data?.output || typeof data.output !== 'object') {
      throw new Error(data?.error || `Ask DW ${role} model returned no structured output`)
    }
    return data.output
  }
}

/**
 * Browser-safe provider adapter. The provider key never exists in this module;
 * model calls go through the authenticated Supabase Edge Function.
 */
export function createAskDwLiveModels({
  supabase,
  functionName = 'ask-dw-model',
  maxToolRequests = 12,
} = {}) {
  assertSupabase(supabase)

  const primaryModel = createAskDwModelAdapter({
    name: 'ask-dw-live-primary',
    maxToolRequests,
    invoke: createEdgeInvoke({ supabase, functionName, role: 'primary' }),
  })

  const verifierModel = createAskDwModelAdapter({
    name: 'ask-dw-live-verifier',
    maxToolRequests: 0,
    invoke: createEdgeInvoke({ supabase, functionName, role: 'verifier' }),
  })

  return freeze({
    primaryModel,
    verifierModel,
    transport: 'supabase_edge_function',
    functionName,
    browserHoldsProviderSecret: false,
  })
}
