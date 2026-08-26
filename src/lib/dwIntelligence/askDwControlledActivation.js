import { evaluateNextActionAuthority } from '../nextActionAuthority.js'
import { createDefaultAskDwOrchestrator } from './askDwOrchestratorDefault.js'
import { createAskDwLiveModels } from './askDwLiveModelProvider.js'
import { ASK_DW_JOB, ASK_DW_SCOPE, classifyAskDwIntent } from './askDwIntent.js'
import {
  ASK_DW_READ_TOOL,
  ASK_DW_TOOL_SCOPE,
  createAskDwReadToolRegistry,
} from './askDwToolRuntime.js'

const ACTIVITY_LIMIT = 50

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function clone(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function throwQueryError(label, response) {
  if (response?.error) throw new Error(`${label}: ${response.error.message || 'query failed'}`)
  return response?.data ?? null
}

function parseCents(value) {
  const raw = String(value ?? '').trim()
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw)
  if (!match) return null
  const sign = match[1] === '-' ? -1n : 1n
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'))
  return sign * cents
}

function centsToDecimal(value) {
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / 100n
  const cents = String(abs % 100n).padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${cents}`
}

function balanceOf(invoice) {
  const amount = parseCents(invoice?.amount)
  const paid = parseCents(invoice?.amount_paid)
  if (amount == null || paid == null) return null
  return centsToDecimal(amount > paid ? amount - paid : 0n)
}

async function assertAuthenticatedTenant(supabase, tenantId) {
  if (!supabase?.auth?.getUser) throw new Error('Ask DW controlled activation requires auth.getUser')
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) throw new Error('Ask DW controlled activation requires authentication')
  if (data.user.id !== tenantId) throw new Error('Ask DW controlled activation tenant mismatch')
  return data.user
}

async function readInvoice(supabase, tenantId, invoiceId) {
  const response = await supabase
    .from('invoices')
    .select('id,user_id,client_id,inv_num,amount,amount_paid,inv_date,due_date,paid,last_reminder,autopilot_paused,created_at')
    .eq('user_id', tenantId)
    .eq('id', invoiceId)
    .maybeSingle()
  return throwQueryError('Ask DW controlled invoice read failed', response)
}

async function readClient(supabase, tenantId, clientId) {
  const response = await supabase
    .from('clients')
    .select('id,user_id,name,created_at')
    .eq('user_id', tenantId)
    .eq('id', clientId)
    .maybeSingle()
  return throwQueryError('Ask DW controlled client read failed', response)
}

async function readActivity(supabase, tenantId, invoiceId, limit = ACTIVITY_LIMIT) {
  const bounded = Math.max(1, Math.min(ACTIVITY_LIMIT, Number(limit) || ACTIVITY_LIMIT))
  const response = await supabase
    .from('events')
    .select('id,user_id,event_type,invoice_id,created_at,lifecycle_state,evidence')
    .eq('user_id', tenantId)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false })
    .limit(bounded + 1)
  const window = safeArray(throwQueryError('Ask DW controlled activity read failed', response))
  return {
    events: window.slice(0, bounded),
    hasMore: window.length > bounded,
    boundedAt: bounded,
  }
}

export const ASK_DW_CONTROLLED_ACTIVATION_PROFILE = freeze({
  id: 'CANONICAL_READ_ONLY_V1',
  modelPlanningEnabled: false,
  allowedMode: 'normal',
  allowedJobs: [ASK_DW_JOB.EXPLAIN, ASK_DW_JOB.INVESTIGATE],
  availableTools: [
    { name: ASK_DW_READ_TOOL.CANONICAL_STATE, scopes: [ASK_DW_TOOL_SCOPE.INVOICE] },
    { name: ASK_DW_READ_TOOL.ACTIVITY_HISTORY, scopes: [ASK_DW_TOOL_SCOPE.INVOICE] },
  ],
  unavailableCapabilities: [
    'payment_ledger',
    'payment_reconciliation',
    'dw_evidence',
    'dw_memory',
    'dw_precedents',
    'prediction_model',
    'complete_execution_history',
    'production_financial_actions',
  ],
  financialExecutionAuthorized: false,
  canonicalMutationAuthorized: false,
})

export async function loadAskDwControlledActivationInput({
  supabase,
  tenantId,
  invoiceId,
  now = new Date(),
} = {}) {
  if (!supabase?.from) throw new Error('Ask DW controlled activation requires Supabase')
  if (!tenantId || !invoiceId) throw new Error('Ask DW controlled activation requires tenantId and invoiceId')
  await assertAuthenticatedTenant(supabase, tenantId)

  const invoice = await readInvoice(supabase, tenantId, invoiceId)
  if (!invoice) throw new Error('Ask DW controlled activation invoice not found for authenticated tenant')
  const client = await readClient(supabase, tenantId, invoice.client_id)
  if (!client || client.user_id !== tenantId || client.id !== invoice.client_id) {
    throw new Error('Ask DW controlled activation invoice/client scope could not be verified')
  }

  const [rulesResponse, settingsResponse, activity] = await Promise.all([
    supabase
      .from('autopilot_rules')
      .select('*')
      .eq('user_id', tenantId)
      .order('sort_order', { ascending: true }),
    supabase
      .from('autopilot_settings')
      .select('id,user_id,enabled,approval_required')
      .eq('user_id', tenantId)
      .maybeSingle(),
    readActivity(supabase, tenantId, invoiceId, ACTIVITY_LIMIT),
  ])

  const rules = safeArray(throwQueryError('Ask DW controlled rules read failed', rulesResponse))
  const settings = throwQueryError('Ask DW controlled settings read failed', settingsResponse)
  const asOf = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(asOf.getTime())) throw new Error('Ask DW controlled activation now is invalid')

  // Deliberately pass unavailable execution history as null. This reuses the
  // existing authority evaluator's fail-closed path instead of pretending the
  // missing autopilot_execution_claims table means "zero prior executions".
  const authorityEvaluation = evaluateNextActionAuthority({
    userId: tenantId,
    invoice,
    rules,
    autopilotSettings: settings,
    events: activity.events,
    handledKeys: null,
    pendingInvoiceIds: null,
    now: asOf,
  })

  return freeze({
    context: {
      tenantId,
      invoiceId: invoice.id,
      clientId: client.id,
      asOf: asOf.toISOString(),
    },
    intelligenceInput: {
      tenantId,
      invoice: { ...invoice, currency: null },
      client,
      now: asOf,
      evidence: [],
      memory: [],
      tombstones: [],
      precedents: [],
      pooling: null,
      prediction: null,
      predictionRequired: false,
      authorityEvaluation,
      founderApproved: false,
      preferenceEvents: [],
      disputed: false,
      sandboxTransport: true,
    },
    activationReceipt: {
      profile: ASK_DW_CONTROLLED_ACTIVATION_PROFILE.id,
      canonicalInvoiceRead: true,
      clientRead: true,
      policyRead: true,
      activityRead: true,
      currencyRead: false,
      paymentLedgerRead: false,
      executionHistoryRead: false,
      dwEvidenceRead: false,
      dwMemoryRead: false,
      precedentRead: false,
      predictionModelRead: false,
      writesPerformed: false,
      authorityInputComplete: false,
      authorityLimitation: 'complete_execution_history_unavailable',
    },
  })
}

export function createAskDwControlledReadTools({ supabase } = {}) {
  if (!supabase?.from) throw new Error('Ask DW controlled read tools require Supabase')

  return createAskDwReadToolRegistry({
    definitions: {
      [ASK_DW_READ_TOOL.CANONICAL_STATE]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE],
        sourceClass: 'CANONICAL_AR_READ_LIMITED_SCHEMA',
        canonicalAuthority: true,
        async handler({ context }) {
          await assertAuthenticatedTenant(supabase, context.tenantId)
          const invoice = await readInvoice(supabase, context.tenantId, context.invoiceId)
          if (!invoice) return { found: false, invoice: null }
          const client = await readClient(supabase, context.tenantId, invoice.client_id)
          return {
            found: true,
            invoice: {
              id: invoice.id,
              userId: invoice.user_id,
              clientId: invoice.client_id,
              invoiceNumber: invoice.inv_num,
              amount: String(invoice.amount),
              amountPaid: String(invoice.amount_paid),
              balance: balanceOf(invoice),
              issueDate: invoice.inv_date,
              dueDate: invoice.due_date,
              paid: invoice.paid === true,
              lastReminder: invoice.last_reminder,
              currency: null,
              currencyKnown: false,
              client: client ? { id: client.id, userId: client.user_id, name: client.name } : null,
            },
            source: 'invoices+clients',
            limitation: 'Hosted activation schema does not yet expose invoice currency to Ask DW. Currency is unknown, never defaulted.',
          }
        },
      },

      [ASK_DW_READ_TOOL.ACTIVITY_HISTORY]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE],
        sourceClass: 'DURABLE_ACTIVITY_READ',
        canonicalAuthority: false,
        async handler({ input, context }) {
          await assertAuthenticatedTenant(supabase, context.tenantId)
          const activity = await readActivity(
            supabase,
            context.tenantId,
            context.invoiceId,
            input?.limit ?? 25,
          )
          return {
            events: activity.events,
            count: activity.events.length,
            hasMore: activity.hasMore,
            boundedAt: activity.boundedAt,
            limitation: activity.hasMore
              ? 'Activity history is bounded; absence claims beyond the returned window are not allowed.'
              : null,
          }
        },
      },
    },
  })
}

function deterministicActivationPlan() {
  return freeze({
    toolRequests: [
      {
        name: ASK_DW_READ_TOOL.CANONICAL_STATE,
        scope: ASK_DW_TOOL_SCOPE.INVOICE,
        reason: 'controlled_activation_canonical_truth',
        input: {},
      },
      {
        name: ASK_DW_READ_TOOL.ACTIVITY_HISTORY,
        scope: ASK_DW_TOOL_SCOPE.INVOICE,
        reason: 'controlled_activation_recent_activity',
        input: { limit: 25 },
      },
    ],
    hypotheses: [],
    answerIntent: 'controlled_activation_read_only_explanation',
  })
}

function wrapLiveModelsForControlledActivation(models) {
  const policy = ASK_DW_CONTROLLED_ACTIVATION_PROFILE
  return freeze({
    primaryModel: {
      name: 'ask-dw-controlled-primary',
      async plan() {
        // Deliberately deterministic during the first production activation.
        // No provider call occurs at PLAN, so the model cannot route into a
        // capability the hosted schema does not yet support.
        return deterministicActivationPlan()
      },
      async synthesize(input) {
        return models.primaryModel.synthesize({
          ...clone(input),
          activationPolicy: policy,
        })
      },
    },
    verifierModel: {
      name: 'ask-dw-controlled-verifier',
      async verify(input) {
        return models.verifierModel.verify({
          ...clone(input),
          activationPolicy: policy,
        })
      },
    },
  })
}

export function createAskDwControlledActivationRuntime({
  supabase,
  modelFunctionName = 'ask-dw-model',
} = {}) {
  const models = createAskDwLiveModels({ supabase, functionName: modelFunctionName, maxToolRequests: 2 })
  const controlledModels = wrapLiveModelsForControlledActivation(models)
  const toolRegistry = createAskDwControlledReadTools({ supabase })
  const orchestrator = createDefaultAskDwOrchestrator({
    primaryModel: controlledModels.primaryModel,
    verifierModel: controlledModels.verifierModel,
    toolRegistry,
  })

  return freeze({
    scope: 'INVOICE_CONTROLLED_ACTIVATION_V1',
    profile: ASK_DW_CONTROLLED_ACTIVATION_PROFILE,
    async runInvoiceQuestion({ tenantId, invoiceId, mode = 'normal', text, now = new Date() } = {}) {
      if (!text || !String(text).trim()) throw new Error('Ask DW controlled activation question text required')
      if (String(mode || '').toLowerCase() !== 'normal') {
        throw new Error('Ask DW controlled activation supports Normal mode only')
      }

      const bootstrapIntent = classifyAskDwIntent({
        text,
        context: { invoiceId },
      })
      if (bootstrapIntent.scope !== ASK_DW_SCOPE.INVOICE) {
        throw new Error('Ask DW controlled activation is invoice-scoped only')
      }
      if (!ASK_DW_CONTROLLED_ACTIVATION_PROFILE.allowedJobs.includes(bootstrapIntent.job)) {
        throw new Error(`Ask DW controlled activation blocks ${bootstrapIntent.job} questions before any model call`)
      }

      const loaded = await loadAskDwControlledActivationInput({
        supabase,
        tenantId,
        invoiceId,
        now,
      })

      const result = await orchestrator.run({
        mode: 'normal',
        text,
        context: loaded.context,
        intelligenceInput: loaded.intelligenceInput,
      })

      return freeze({
        ...result,
        activationReceipt: loaded.activationReceipt,
        activationPolicy: ASK_DW_CONTROLLED_ACTIVATION_PROFILE,
        provider: {
          transport: models.transport,
          functionName: models.functionName,
          browserHoldsProviderSecret: models.browserHoldsProviderSecret,
          planProviderCalls: 0,
          synthesizeProviderCalls: 1,
          verifyProviderCalls: 1,
        },
      })
    },
  })
}
