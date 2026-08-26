import { evaluateNextActionAuthority } from '../nextActionAuthority.js'
import { runAskDwDeterministicCore } from './askDwRuntime.js'
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
  id: 'DW_INTELLIGENCE_READ_ONLY_V1',
  modelPlanningEnabled: false,
  externalAiEnabled: false,
  modelDependency: false,
  allowedMode: 'normal',
  allowedJobs: [ASK_DW_JOB.EXPLAIN, ASK_DW_JOB.INVESTIGATE, ASK_DW_JOB.DECIDE],
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
        reason: 'dw_intelligence_canonical_truth',
        input: {},
      },
      {
        name: ASK_DW_READ_TOOL.ACTIVITY_HISTORY,
        scope: ASK_DW_TOOL_SCOPE.INVOICE,
        reason: 'dw_intelligence_recent_activity',
        input: { limit: 25 },
      },
    ],
    hypotheses: [],
    answerIntent: 'dw_intelligence_deterministic_read_only',
  })
}

async function executeControlledPlan({ toolRegistry, plan, context }) {
  const runs = []
  for (let index = 0; index < plan.toolRequests.length; index += 1) {
    const request = plan.toolRequests[index]
    const output = await toolRegistry.execute({
      name: request.name,
      scope: request.scope,
      input: clone(request.input),
      context,
    })
    runs.push(freeze({
      id: `tool-${String(index + 1).padStart(2, '0')}-${request.name}`,
      request: clone(request),
      output,
    }))
  }
  return freeze(runs)
}

function normalizedQuestion(value) {
  return String(value || '').trim().toLowerCase()
}

function includesAny(value, terms) {
  return terms.some((term) => value.includes(term))
}

function deterministicTopics(text) {
  const value = normalizedQuestion(text)
  const topics = new Set()

  if (includesAny(value, ['balance', 'outstanding', 'amount due', 'remaining', 'owe', 'owed'])) {
    topics.add('BALANCE')
  }
  if (includesAny(value, ['activity', 'recent', 'history', 'what happened', 'last event', 'reminder'])) {
    topics.add('ACTIVITY')
  }
  if (includesAny(value, ['status', 'state', 'paid', 'settled', 'open', 'partial'])) {
    topics.add('STATUS')
  }
  if (includesAny(value, ['autopilot', 'policy', 'handling', 'authority', 'approval'])) {
    topics.add('AUTOPILOT')
  }
  if (includesAny(value, ['why', 'inconsistent', 'conflict', 'discrepancy', 'wrong', 'does not match', "doesn't match"])) {
    topics.add('WHY')
  }
  if (includesAny(value, ['what should', 'next action', 'next step', 'what do we do', 'recommend', 'best next'])) {
    topics.add('NEXT')
  }

  if (topics.size === 0) topics.add('OVERVIEW')
  return topics
}

function formatDateOnly(value) {
  const raw = String(value || '').trim()
  if (!raw) return 'unknown date'
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
  return match ? match[1] : raw
}

function humanizeEventType(value) {
  const text = String(value || 'activity').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : 'Activity'
}

function formatMoney(invoice, value) {
  if (value == null) return 'unknown'
  if (invoice?.currencyKnown && invoice?.currency) return `${invoice.currency} ${value}`
  return `${value} (currency unknown)`
}

function deriveMoneyState(invoice) {
  const amount = parseCents(invoice?.amount)
  const amountPaid = parseCents(invoice?.amountPaid)
  const balance = parseCents(invoice?.balance)
  const paidFlag = invoice?.paid === true
  const invoiceNumber = invoice?.invoiceNumber || 'This invoice'

  if (amount == null || amountPaid == null || balance == null) {
    return {
      conflict: true,
      summary: `${invoiceNumber} has incomplete or invalid canonical money fields, so DueWatch cannot state a verified balance.`,
      amount,
      amountPaid,
      balance,
    }
  }

  if (amountPaid > amount) {
    const excess = centsToDecimal(amountPaid - amount)
    return {
      conflict: true,
      summary: `${invoiceNumber} has a canonical money conflict: amount paid exceeds invoice amount by ${formatMoney(invoice, excess)}.`,
      amount,
      amountPaid,
      balance,
    }
  }

  if (paidFlag && amountPaid < amount) {
    return {
      conflict: true,
      summary: `${invoiceNumber} is marked Paid, but canonical amounts show ${formatMoney(invoice, invoice.balance)} still outstanding. This is a canonical data conflict; DueWatch does not infer the cause.`,
      amount,
      amountPaid,
      balance,
    }
  }

  if (!paidFlag && amountPaid >= amount) {
    return {
      conflict: true,
      summary: `${invoiceNumber} is not marked Paid, but canonical amounts show no remaining balance. This is a canonical data conflict; DueWatch does not infer the cause.`,
      amount,
      amountPaid,
      balance,
    }
  }

  if (paidFlag) {
    return {
      conflict: false,
      summary: `${invoiceNumber} is marked Paid with no remaining canonical balance.`,
      amount,
      amountPaid,
      balance,
    }
  }

  if (amountPaid > 0n) {
    return {
      conflict: false,
      summary: `${invoiceNumber} is partially paid with ${formatMoney(invoice, invoice.balance)} outstanding.`,
      amount,
      amountPaid,
      balance,
    }
  }

  return {
    conflict: false,
    summary: `${invoiceNumber} has ${formatMoney(invoice, invoice.balance)} outstanding.`,
    amount,
    amountPaid,
    balance,
  }
}

function summarizeActivity(activity) {
  const events = safeArray(activity?.events)
  if (events.length === 0) {
    return {
      summary: 'No activity events are recorded in the returned activity window.',
      evidence: 'Activity history read returned 0 events.',
    }
  }

  const latest = events[0]
  const latestSummary = `${humanizeEventType(latest?.event_type)} on ${formatDateOnly(latest?.created_at)}`
  const countCopy = `${events.length} event${events.length === 1 ? '' : 's'}`
  return {
    summary: `The most recent recorded activity is ${latestSummary}.`,
    evidence: `Activity history read returned ${countCopy}; newest is ${latestSummary}.`,
  }
}

function authoritySummary(core, activationReceipt) {
  const state = core?.packet?.executiveState || 'unknown'
  const actual = core?.packet?.authority?.actual || 'NOT_GRANTED'

  if (activationReceipt?.authorityInputComplete === false) {
    return `DW Intelligence state is ${state}. Execution authority is ${actual}; complete execution history is unavailable, so Ask DW cannot verify an executable next action.`
  }

  return `DW Intelligence state is ${state}. Execution authority is ${actual}.`
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))]
}

function composeDeterministicAnswer({
  text,
  core,
  toolRuns,
  activationReceipt,
}) {
  const canonicalRun = toolRuns.find((run) => run.request.name === ASK_DW_READ_TOOL.CANONICAL_STATE)
  const activityRun = toolRuns.find((run) => run.request.name === ASK_DW_READ_TOOL.ACTIVITY_HISTORY)
  const canonical = canonicalRun?.output?.result
  const activity = activityRun?.output?.result

  if (!canonical?.found || !canonical?.invoice) {
    throw new Error('Ask DW deterministic canonical invoice read was unavailable')
  }

  const invoice = canonical.invoice
  const money = deriveMoneyState(invoice)
  const activitySummary = summarizeActivity(activity)
  const topics = deterministicTopics(text)
  const conclusionParts = []

  const wantsMoney = topics.has('BALANCE') || topics.has('STATUS') || topics.has('WHY') || topics.has('OVERVIEW')
  const wantsActivity = topics.has('ACTIVITY') || topics.has('OVERVIEW')
  const wantsAuthority = topics.has('AUTOPILOT') || topics.has('NEXT') || topics.has('OVERVIEW')

  if (wantsMoney) conclusionParts.push(money.summary)
  if (wantsActivity) conclusionParts.push(activitySummary.summary)
  if (wantsAuthority) conclusionParts.push(authoritySummary(core, activationReceipt))

  if (topics.has('WHY') && !money.conflict) {
    conclusionParts.push('No canonical money/status contradiction is visible in the controlled invoice read.')
  }

  if (topics.has('OVERVIEW')) {
    conclusionParts.push('Ask DW is deterministic here: it can explain balance, status, recent activity, Autopilot authority, and safe next-step limits from DueWatch data.')
  }

  const limitations = []
  if (!invoice.currencyKnown) {
    limitations.push('Currency is not available in the hosted controlled schema, so DueWatch does not assume USD or any other currency.')
  }
  if (activity?.hasMore) {
    limitations.push('Activity history is bounded to the returned window, so absence claims beyond that window are not allowed.')
  }
  if (money.conflict || topics.has('WHY')) {
    limitations.push('Payment-ledger and reconciliation data are unavailable in this activation, so DueWatch cannot determine the cause of a money/status conflict.')
  }
  if ((topics.has('AUTOPILOT') || topics.has('NEXT')) && activationReceipt?.authorityInputComplete === false) {
    limitations.push('Complete execution history is unavailable, so executable authority and a safe action recommendation cannot be fully verified.')
  }

  const evidenceBasis = [
    `Canonical invoice read: invoice ${invoice.invoiceNumber || invoice.id}, amount ${invoice.amount}, amount paid ${invoice.amountPaid}, balance ${invoice.balance}, paid flag ${invoice.paid === true}.`,
    activitySummary.evidence,
    `DW Intelligence core state: ${core?.packet?.executiveState || 'unknown'}; execution authority: ${core?.packet?.authority?.actual || 'NOT_GRANTED'}.`,
  ]

  const recommendationOrNextStep = topics.has('NEXT')
    ? activationReceipt?.authorityInputComplete === false
      ? 'DueWatch cannot safely recommend an executable next action until complete execution history is available and authority is revalidated.'
      : 'This Ask DW surface is read only; any executable action still requires the normal DueWatch authority and server-revalidation path.'
    : null

  return freeze({
    executiveConclusion: conclusionParts.join(' '),
    evidenceBasis: uniqueStrings(evidenceBasis),
    uncertaintyAndLimitations: uniqueStrings(limitations),
    recommendationOrNextStep,
    competingExplanations: [],
    citedToolRunIds: toolRuns.map((run) => run.id),
  })
}

function verifyDeterministicAnswer({ answer, toolRuns, activationReceipt }) {
  const knownIds = new Set(toolRuns.map((run) => run.id))
  const unknownCitations = safeArray(answer?.citedToolRunIds).filter((id) => !knownIds.has(id))
  const issues = []

  if (unknownCitations.length > 0) {
    issues.push(`Unknown deterministic evidence references: ${unknownCitations.join(', ')}`)
  }
  if (toolRuns.some((run) => run?.output?.sideEffect === true)) {
    issues.push('A controlled read unexpectedly reported a side effect.')
  }
  if (activationReceipt?.writesPerformed !== false) {
    issues.push('Activation receipt did not prove zero writes.')
  }

  return freeze({
    verdict: issues.length === 0 ? 'PASS' : 'BLOCK',
    issues,
    checkedClaims: [
      'Answer composed only from controlled canonical/activity reads and DW Intelligence output.',
      'Every cited deterministic read reference exists in this run.',
      'Controlled reads reported zero side effects.',
      'Activation receipt reports zero writes.',
      'No external AI or model provider participated in synthesis or verification.',
    ],
    method: 'DETERMINISTIC_INVARIANTS_V1',
  })
}

function blockedJobMessage(job) {
  if (job === ASK_DW_JOB.ACT) {
    return 'Ask DW is read only and cannot execute actions. Use DueWatch action controls, which revalidate authority on the server.'
  }
  if (job === ASK_DW_JOB.PREDICT) {
    return 'Ask DW cannot forecast payment timing from the current deterministic data because prediction capability is unavailable.'
  }
  return `Ask DW cannot answer ${job} with the current deterministic activation profile.`
}

export function createAskDwControlledActivationRuntime({
  supabase,
} = {}) {
  const toolRegistry = createAskDwControlledReadTools({ supabase })

  return freeze({
    scope: 'INVOICE_DW_INTELLIGENCE_V1',
    profile: ASK_DW_CONTROLLED_ACTIVATION_PROFILE,
    async runInvoiceQuestion({ tenantId, invoiceId, mode = 'normal', text, now = new Date() } = {}) {
      if (!text || !String(text).trim()) throw new Error('Ask DW question text required')
      if (String(mode || '').toLowerCase() !== 'normal') {
        throw new Error('Ask DW deterministic activation supports Normal mode only')
      }

      const bootstrapIntent = classifyAskDwIntent({
        text,
        context: { invoiceId },
      })
      if (bootstrapIntent.scope !== ASK_DW_SCOPE.INVOICE) {
        throw new Error('Ask DW deterministic activation is invoice-scoped only')
      }
      if (!ASK_DW_CONTROLLED_ACTIVATION_PROFILE.allowedJobs.includes(bootstrapIntent.job)) {
        throw new Error(blockedJobMessage(bootstrapIntent.job))
      }

      const loaded = await loadAskDwControlledActivationInput({
        supabase,
        tenantId,
        invoiceId,
        now,
      })

      const core = runAskDwDeterministicCore({
        mode: 'normal',
        text,
        context: loaded.context,
        intelligenceInput: loaded.intelligenceInput,
      })

      const plan = deterministicActivationPlan()
      const toolRuns = await executeControlledPlan({
        toolRegistry,
        plan,
        context: loaded.context,
      })

      const answer = composeDeterministicAnswer({
        text,
        core,
        toolRuns,
        activationReceipt: loaded.activationReceipt,
      })

      const verification = verifyDeterministicAnswer({
        answer,
        toolRuns,
        activationReceipt: loaded.activationReceipt,
      })

      if (verification.verdict !== 'PASS') {
        throw new Error(`Ask DW deterministic verification failed: ${verification.issues.join('; ')}`)
      }

      return freeze({
        mode: 'normal',
        intent: core.intent,
        plan,
        toolRuns,
        answer,
        verification,
        dwIntelligence: {
          executiveState: core.packet.executiveState,
          canonicalFacts: core.packet.canonicalFacts,
          arState: core.packet.arState,
          authority: core.packet.authority,
          hardSafetyOutcome: core.packet.hardSafetyOutcome,
          needsYou: core.packet.needsYou,
          reasoningTrail: core.reasoningTrail,
        },
        truthLock: {
          canonicalFacts: core.packet.canonicalFacts,
          arState: core.packet.arState,
          authority: core.packet.authority,
          hardSafetyOutcome: core.packet.hardSafetyOutcome,
        },
        workManifest: core.workManifest,
        activationReceipt: loaded.activationReceipt,
        activationPolicy: ASK_DW_CONTROLLED_ACTIVATION_PROFILE,
        intelligenceReceipt: {
          engine: 'DW_INTELLIGENCE_PHASE2B',
          interface: 'DETERMINISTIC_INVOICE_QA_V1',
          externalAi: false,
          modelDependency: false,
          modelCalls: 0,
          providerCalls: 0,
          writesPerformed: false,
          financialExecutionAuthorized: false,
        },
        safeguards: {
          externalAiEnabled: false,
          modelCanGrantAuthority: false,
          providerExecutionFromAskDw: false,
          canonicalMutationFromAskDw: false,
          financialExecutionAuthorized: false,
          serverRevalidationRequiredForActions: true,
        },
      })
    },
  })
}
