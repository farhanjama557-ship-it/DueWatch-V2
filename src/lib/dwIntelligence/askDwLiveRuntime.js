import { createDefaultAskDwOrchestrator } from './askDwOrchestratorDefault.js'
import { createAskDwLiveModels } from './askDwLiveModelProvider.js'
import { createAskDwSupabaseReadTools } from './askDwSupabaseReadTools.js'
import { loadAskDwLiveInvoiceInput } from './askDwLiveDataLoader.js'

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

/**
 * Phase 2E live composition. This intentionally starts with invoice-scoped
 * questions because the current deterministic DW truth core is invoice-scoped.
 * Client/portfolio read tools exist, but business-wide truth-lock expansion is
 * a later core change rather than a fake portfolio wrapper around one invoice.
 */
export function createAskDwLiveRuntime({
  supabase,
  modelFunctionName = 'ask-dw-model',
} = {}) {
  const models = createAskDwLiveModels({ supabase, functionName: modelFunctionName })
  const toolRegistry = createAskDwSupabaseReadTools({ supabase })
  const orchestrator = createDefaultAskDwOrchestrator({
    primaryModel: models.primaryModel,
    verifierModel: models.verifierModel,
    toolRegistry,
  })

  return freeze({
    scope: 'INVOICE_LIVE_V1',
    async runInvoiceQuestion({ tenantId, invoiceId, mode = 'normal', text, now = new Date() } = {}) {
      if (!text || !String(text).trim()) throw new Error('Ask DW live question text required')
      const loaded = await loadAskDwLiveInvoiceInput({ supabase, tenantId, invoiceId, now })
      const result = await orchestrator.run({
        mode,
        text,
        context: loaded.context,
        intelligenceInput: loaded.intelligenceInput,
      })
      return freeze({
        ...result,
        liveReadReceipt: loaded.liveReadReceipt,
        provider: {
          transport: models.transport,
          functionName: models.functionName,
          browserHoldsProviderSecret: models.browserHoldsProviderSecret,
        },
      })
    },
  })
}
