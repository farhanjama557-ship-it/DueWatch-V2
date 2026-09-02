import { createDefaultAskDwOrchestrator } from './askDwOrchestratorDefault.js'
import {
  ASK_DW_MODEL_EDGE_FUNCTION,
  createAskDwLiveModels,
} from './askDwLiveModelProvider.js'
import { createAskDwSupabaseReadTools } from './askDwSupabaseReadTools.js'
import { loadAskDwLiveInvoiceInput } from './askDwLiveDataLoader.js'
import { createAskDwCaseAwareRuntime } from './askDwConversationRuntime.js'
import { ASK_DW_READ_TOOL, ASK_DW_TOOL_SCOPE } from './askDwToolRuntime.js'

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
  modelFunctionName = ASK_DW_MODEL_EDGE_FUNCTION,
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
    companyBrainReadModel = null,
    needsYouReadModel = null,
  } = {}) {
    if (!text || !String(text).trim()) throw new Error('Ask DW live question text required')
    const loaded = await loadAskDwLiveInvoiceInput({ supabase, tenantId, invoiceId, now })
    const orchestrationContext = {
      ...loaded.context,
      ...(caseContext ? { caseContext } : {}),
      companyBrainReadModel,
      needsYouReadModel,
    }

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

  async function runScopedQuestion({
    tenantId,
    clientId = null,
    scope,
    mode = 'normal',
    text,
    now = new Date(),
    caseContext = null,
    companyBrainReadModel = null,
    needsYouReadModel = null,
  } = {}) {
    if (!text || !String(text).trim()) throw new Error('Ask DW live scoped question text required')
    if (![ASK_DW_TOOL_SCOPE.CLIENT, ASK_DW_TOOL_SCOPE.PORTFOLIO].includes(scope)) {
      throw new Error('Ask DW live scoped question scope invalid')
    }
    if (scope === ASK_DW_TOOL_SCOPE.CLIENT && !clientId) {
      throw new Error('Ask DW live client question requires clientId')
    }
    const asOf = now instanceof Date ? now.toISOString() : new Date(now).toISOString()
    const scopedContext = { tenantId, clientId, invoiceId: null, asOf }
    const canonicalState = await toolRegistry.execute({
      name: ASK_DW_READ_TOOL.CANONICAL_STATE,
      scope,
      input: { limit: 50 },
      context: scopedContext,
    })
    const portfolioSummary = await toolRegistry.execute({
      name: ASK_DW_READ_TOOL.PORTFOLIO_SUMMARY,
      scope,
      input: {},
      context: scopedContext,
    })
    const conversationScopeSnapshot = freeze({
      tenantId,
      clientId: scope === ASK_DW_TOOL_SCOPE.CLIENT ? clientId : null,
      scope,
      asOf,
      canonicalState,
      portfolioSummary,
    })
    const result = await orchestrator.run({
      mode,
      text,
      context: {
        ...scopedContext,
        ...(caseContext ? { caseContext } : {}),
        companyBrainReadModel,
        needsYouReadModel,
      },
      intelligenceInput: { tenantId, conversationScopeSnapshot },
    })

    return freeze({
      ...result,
      liveReadReceipt: {
        source: 'ASK_DW_SCOPED_LIVE_READ',
        scope,
        canonicalStateRead: true,
        portfolioSummaryRead: true,
        writesPerformed: false,
        financialExecutionAuthorized: false,
        canonicalMutationAuthorized: false,
      },
      provider: {
        transport: models.transport,
        functionName: models.functionName,
        browserHoldsProviderSecret: models.browserHoldsProviderSecret,
      },
    })
  }

  const conversationRuntime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion,
    runScopedQuestion,
    resolveCaseEvents,
  })

  return freeze({
    scope: 'INVOICE_LIVE_V1',
    conversationScope: 'INVOICE_LIVE_V1_CASE_STATE_V0',
    runInvoiceQuestion,
    runScopedQuestion,
    runConversationTurn: conversationRuntime.runTurn,
  })
}
