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
    if (error) throw new Error(error.message || `Ask DW ${role} model invocation failed`)
    if (!data?.ok || !data?.output || typeof data.output !== 'object') {
      throw new Error(data?.error || `Ask DW ${role} model returned no structured output`)
    }
    return data.output
  }
}

/**
 * Browser-safe provider adapter. The OpenAI key never exists in this module;
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
