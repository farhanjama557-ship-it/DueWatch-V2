import { createDefaultAskDwOrchestrator } from './askDwOrchestratorDefault.js'
import { createAskDwLiveModels } from './askDwLiveModelProvider.js'
import { createAskDwSupabaseReadTools } from './askDwSupabaseReadTools.js'
import { loadAskDwLiveInvoiceInput } from './askDwLiveDataLoader.js'
import { createAskDwCaseAwareRuntime } from './askDwConversationRuntime.js'

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

/**
 * Phase 2E live composition plus M1E conversation continuity.
 *
 * Canonical truth is still invoice-scoped and freshly loaded every turn.
 * M1E case state carries only references/presentation continuity and cannot
 * replace live invoice reads or the deterministic authority boundary.
 */
export function createAskDwLiveRuntime({
  supabase,
  modelFunctionName = 'ask-dw-model',
  resolveCaseEvents = null,
} = {}) {
  const models = createAskDwLiveModels({ supabase, functionName: modelFunctionName })
  const toolRegistry = createAskDwSupabaseReadTools({ supabase })
  const orchestrator = createDefaultAskDwOrchestrator({
    primaryModel: models.primaryModel,
    verifierModel: models.verifierModel,
    toolRegistry,
  })

  async function runInvoiceQuestion({
    tenantId,
    invoiceId,
    mode = 'normal',
    text,
    now = new Date(),
    caseContext = null,
  } = {}) {
    if (!text || !String(text).trim()) throw new Error('Ask DW live question text required')
    const loaded = await loadAskDwLiveInvoiceInput({ supabase, tenantId, invoiceId, now })
    const orchestrationContext = caseContext
      ? { ...loaded.context, caseContext }
      : loaded.context

    const result = await orchestrator.run({
      mode,
      text,
      context: orchestrationContext,
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
  }

  const conversationRuntime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion,
    resolveCaseEvents,
  })

  return freeze({
    scope: 'INVOICE_LIVE_V1',
    conversationScope: 'INVOICE_LIVE_V1_CASE_STATE_V0',
    runInvoiceQuestion,
    runConversationTurn: conversationRuntime.runTurn,
  })
}
