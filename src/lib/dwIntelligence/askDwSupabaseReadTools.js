import {
  ASK_DW_READ_TOOL,
  ASK_DW_TOOL_SCOPE,
  createAskDwReadToolRegistry,
} from './askDwToolRuntime.js'

const DAY_MS = 86_400_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
}

function dateOnly(value) {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
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


function sanitizeClient(row) {
  if (!row || typeof row !== 'object') return null
  return {
    id: row.id ?? null,
    userId: row.user_id ?? null,
    name: row.name ?? null,
  }
}

function invoiceBalance(invoice) {
  const amount = parseCents(invoice?.amount)
  const paid = parseCents(invoice?.amount_paid)
  if (amount == null || paid == null) return null
  return centsToDecimal(amount > paid ? amount - paid : 0n)
}

function daysOverdue(dueDate, asOf) {
  const due = dateOnly(dueDate)
  if (!due) return null
  const current = dateOnly(asOf || new Date().toISOString())
  if (!current) return null
  const dueMs = Date.parse(`${due}T12:00:00Z`)
  const currentMs = Date.parse(`${current}T12:00:00Z`)
  if (!Number.isFinite(dueMs) || !Number.isFinite(currentMs)) return null
  return Math.max(0, Math.floor((currentMs - dueMs) / DAY_MS))
}

async function assertAuthenticatedTenant(supabase, tenantId) {
  if (!supabase?.auth?.getUser) throw new Error('Ask DW Supabase tools require auth.getUser')
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) throw new Error('Ask DW read tools require an authenticated user')
  if (data.user.id !== tenantId) throw new Error('Ask DW read tool tenant does not match authenticated user')
  return data.user
}

function throwQueryError(label, response) {
  if (response?.error) throw new Error(`${label}: ${response.error.message || 'query failed'}`)
  return response?.data ?? null
}

async function readInvoice(supabase, tenantId, invoiceId) {
  const response = await supabase
    .from('invoices')
    .select('id,user_id,client_id,inv_num,amount,amount_paid,inv_date,due_date,currency,paid,last_reminder,created_at,clients(id,user_id,name)')
    .eq('user_id', tenantId)
    .eq('id', invoiceId)
    .maybeSingle()
  const invoice = throwQueryError('Ask DW invoice read failed', response)
  return invoice ? { ...invoice, clients: sanitizeClient(invoice.clients) } : null
}

async function readClient(supabase, tenantId, clientId) {
  const response = await supabase
    .from('clients')
    .select('id,user_id,name,created_at')
    .eq('user_id', tenantId)
    .eq('id', clientId)
    .maybeSingle()
  return sanitizeClient(throwQueryError('Ask DW client read failed', response))
}

async function invoiceIdsForClient(supabase, tenantId, clientId) {
  const response = await supabase
    .from('invoices')
    .select('id')
    .eq('user_id', tenantId)
    .eq('client_id', clientId)
    .limit(MAX_LIMIT + 1)
  const rows = safeArray(throwQueryError('Ask DW client invoice read failed', response))
  if (rows.length > MAX_LIMIT) throw new Error('Ask DW client invoice scope exceeds the current bounded read window')
  return rows.map((row) => row.id)
}

function evidenceMatchesQuery(row, query) {
  if (!query) return true
  const haystack = [
    row.evidence_key,
    row.source_type,
    row.source_ref,
    row.claim_type,
    row.admission_reason,
    JSON.stringify(row.provenance || {}),
  ].join(' ').toLowerCase()
  return haystack.includes(query.toLowerCase())
}

function hasDisputeSignal(value) {
  const text = JSON.stringify(value || {}).toLowerCase()
  return text.includes('dispute')
}

function structuralProjection(row) {
  const proof = row?.proof || {}
  const ar = proof.arState || {}
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    clientId: row.client_id,
    operationalState: row.operational_state ?? null,
    paymentState: ar.payment?.status ?? null,
    disputeState: ar.dispute?.status ?? null,
    promiseState: ar.promise?.status ?? null,
    collectionStage: ar.collection?.status ?? null,
    actionType: proof.policy?.action ?? proof.stagedAction?.action ?? null,
    createdAt: row.created_at ?? null,
  }
}

export function createAskDwSupabaseReadTools({ supabase } = {}) {
  if (!supabase?.from) throw new Error('Ask DW Supabase read tools require a Supabase client')

  const ensureTenant = (context) => assertAuthenticatedTenant(supabase, context.tenantId)

  return createAskDwReadToolRegistry({
    definitions: {
      [ASK_DW_READ_TOOL.CANONICAL_STATE]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE, ASK_DW_TOOL_SCOPE.CLIENT, ASK_DW_TOOL_SCOPE.PORTFOLIO],
        sourceClass: 'CANONICAL_AR_READ',
        canonicalAuthority: true,
        async handler({ input, context, scope }) {
          await ensureTenant(context)
          if (scope === ASK_DW_TOOL_SCOPE.INVOICE) {
            const invoice = await readInvoice(supabase, context.tenantId, context.invoiceId)
            return {
              found: Boolean(invoice),
              invoice: invoice ? {
                id: invoice.id,
                userId: invoice.user_id,
                clientId: invoice.client_id,
                invoiceNumber: invoice.inv_num,
                amount: String(invoice.amount),
                amountPaid: String(invoice.amount_paid),
                balance: invoiceBalance(invoice),
                issueDate: invoice.inv_date,
                dueDate: invoice.due_date,
                currency: invoice.currency,
                paid: invoice.paid === true,
                lastReminder: invoice.last_reminder,
                daysOverdue: daysOverdue(invoice.due_date, context.asOf),
                client: invoice.clients ?? null,
              } : null,
              source: 'invoices',
            }
          }
          if (scope === ASK_DW_TOOL_SCOPE.CLIENT) {
            const client = await readClient(supabase, context.tenantId, context.clientId)
            const ids = client ? await invoiceIdsForClient(supabase, context.tenantId, context.clientId) : []
            return { found: Boolean(client), client, invoiceIds: ids, source: 'clients+invoices' }
          }

          const limit = clampLimit(input.limit)
          const response = await supabase
            .from('invoices')
            .select('id,user_id,client_id,inv_num,amount,amount_paid,due_date,currency,paid,clients(name)')
            .eq('user_id', context.tenantId)
            .order('due_date', { ascending: true })
            .limit(limit + 1)
          const window = safeArray(throwQueryError('Ask DW portfolio canonical read failed', response))
          const hasMore = window.length > limit
          const rows = window.slice(0, limit)
          return { invoices: rows, returnedCount: rows.length, hasMore, boundedAt: limit, source: 'invoices' }
        },
      },

      [ASK_DW_READ_TOOL.EVIDENCE_SEARCH]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE, ASK_DW_TOOL_SCOPE.CLIENT],
        sourceClass: 'ATTRIBUTED_EVIDENCE_READ',
        canonicalAuthority: false,
        async handler({ input, context, scope }) {
          await ensureTenant(context)
          const limit = clampLimit(input.limit)
          let query = supabase
            .from('dw_evidence_items')
            .select('id,user_id,run_id,client_id,invoice_id,evidence_key,source_type,source_ref,trust,admission_status,admission_reason,claim_type,derived_from_key,provenance,created_at')
            .eq('user_id', context.tenantId)
          if (scope === ASK_DW_TOOL_SCOPE.INVOICE) query = query.eq('invoice_id', context.invoiceId)
          if (scope === ASK_DW_TOOL_SCOPE.CLIENT) query = query.eq('client_id', context.clientId)
          const response = await query.order('created_at', { ascending: false }).limit(MAX_LIMIT + 1)
          const window = safeArray(throwQueryError('Ask DW evidence read failed', response))
          const windowComplete = window.length <= MAX_LIMIT
          const rows = window
            .slice(0, MAX_LIMIT)
            .filter((row) => evidenceMatchesQuery(row, String(input.query || '').trim()))
            .slice(0, limit)
          return {
            records: rows,
            count: rows.length,
            query: String(input.query || '').trim() || null,
            windowComplete,
            limitation: windowComplete ? null : 'Evidence search is bounded to the newest 100 records; no exhaustive absence claim is allowed.',
          }
        },
      },

      [ASK_DW_READ_TOOL.PAYMENT_RECONCILIATION]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE],
        sourceClass: 'CANONICAL_LEDGER_READ',
        canonicalAuthority: true,
        async handler({ context }) {
          await ensureTenant(context)
          const invoice = await readInvoice(supabase, context.tenantId, context.invoiceId)
          if (!invoice) return { found: false, invoice: null, payments: [], allocations: [] }

          const allocationResponse = await supabase
            .from('payment_allocations')
            .select('id,payment_id,invoice_id,amount,created_at')
            .eq('invoice_id', context.invoiceId)
            .limit(MAX_LIMIT + 1)
          const allocations = safeArray(throwQueryError('Ask DW allocation read failed', allocationResponse))
          if (allocations.length > MAX_LIMIT) throw new Error('Ask DW payment reconciliation exceeds the current bounded allocation window')
          const paymentIds = [...new Set(allocations.map((row) => row.payment_id).filter(Boolean))]
          let payments = []
          if (paymentIds.length) {
            const paymentResponse = await supabase
              .from('payments')
              .select('id,user_id,recorded_at,payment_date,total_amount,currency,method,origin,source_event_id,legacy_invoice_id,reversed_at,reversal_reason,created_at')
              .eq('user_id', context.tenantId)
              .in('id', paymentIds)
              .limit(MAX_LIMIT)
            payments = safeArray(throwQueryError('Ask DW payment read failed', paymentResponse))
          }
          const byId = new Map(payments.map((row) => [row.id, row]))
          return {
            found: true,
            invoice: {
              id: invoice.id,
              amount: String(invoice.amount),
              amountPaid: String(invoice.amount_paid),
              balance: invoiceBalance(invoice),
              currency: invoice.currency,
              paid: invoice.paid === true,
            },
            allocations: allocations.map((row) => ({ ...row, amount: String(row.amount) })),
            payments: payments.map((row) => ({ ...row, total_amount: String(row.total_amount) })),
            unresolvedAllocationPaymentIds: paymentIds.filter((id) => !byId.has(id)),
            source: 'payments+payment_allocations+invoices',
          }
        },
      },

      [ASK_DW_READ_TOOL.DISPUTE_CONTEXT]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE, ASK_DW_TOOL_SCOPE.CLIENT],
        sourceClass: 'ATTRIBUTED_DISPUTE_CONTEXT',
        canonicalAuthority: false,
        async handler({ context, scope }) {
          await ensureTenant(context)
          let evidenceQuery = supabase
            .from('dw_evidence_items')
            .select('id,user_id,client_id,invoice_id,evidence_key,source_type,trust,admission_status,claim_type,provenance,created_at')
            .eq('user_id', context.tenantId)
          let memoryQuery = supabase
            .from('dw_memory_claims')
            .select('id,user_id,client_id,invoice_id,scope,claim_key,claim_value,admitted,created_at')
            .eq('user_id', context.tenantId)
          let proofQuery = supabase
            .from('dw_proof_events')
            .select('id,user_id,client_id,invoice_id,operational_state,proof,created_at')
            .eq('user_id', context.tenantId)
          if (scope === ASK_DW_TOOL_SCOPE.INVOICE) {
            evidenceQuery = evidenceQuery.eq('invoice_id', context.invoiceId)
            memoryQuery = memoryQuery.eq('invoice_id', context.invoiceId)
            proofQuery = proofQuery.eq('invoice_id', context.invoiceId)
          } else if (scope === ASK_DW_TOOL_SCOPE.CLIENT) {
            evidenceQuery = evidenceQuery.eq('client_id', context.clientId)
            memoryQuery = memoryQuery.eq('client_id', context.clientId)
            proofQuery = proofQuery.eq('client_id', context.clientId)
          }
          const [evidenceResponse, memoryResponse, proofResponse] = await Promise.all([
            evidenceQuery.order('created_at', { ascending: false }).limit(MAX_LIMIT + 1),
            memoryQuery.order('created_at', { ascending: false }).limit(MAX_LIMIT + 1),
            proofQuery.order('created_at', { ascending: false }).limit(21),
          ])
          const evidenceWindow = safeArray(throwQueryError('Ask DW dispute evidence read failed', evidenceResponse))
          const memoryWindow = safeArray(throwQueryError('Ask DW dispute memory read failed', memoryResponse))
          const proofWindow = safeArray(throwQueryError('Ask DW dispute proof read failed', proofResponse))
          const evidenceComplete = evidenceWindow.length <= MAX_LIMIT
          const memoryComplete = memoryWindow.length <= MAX_LIMIT
          const proofComplete = proofWindow.length <= 20
          const evidence = evidenceWindow.slice(0, MAX_LIMIT).filter(hasDisputeSignal)
          const memory = memoryWindow.slice(0, MAX_LIMIT).filter(hasDisputeSignal)
          const proofs = proofWindow.slice(0, 20).filter((row) => hasDisputeSignal(row.proof?.arState?.dispute))
          return {
            canonicalDisputeRecord: null,
            attributedEvidence: evidence,
            admittedMemory: memory.filter((row) => row.admitted === true),
            proofStates: proofs.map(structuralProjection),
            windowsComplete: { evidence: evidenceComplete, memory: memoryComplete, proof: proofComplete },
            limitation: 'The current repo contract has no dedicated canonical dispute table; this tool reports attributed evidence, admitted memory, and persisted DW proof state only. Bounded windows are labeled when incomplete.',
          }
        },
      },

      [ASK_DW_READ_TOOL.PRECEDENT_SEARCH]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE, ASK_DW_TOOL_SCOPE.CLIENT, ASK_DW_TOOL_SCOPE.PORTFOLIO],
        sourceClass: 'STRUCTURAL_PRECEDENT_READ',
        canonicalAuthority: false,
        async handler({ input, context, scope }) {
          await ensureTenant(context)
          const limit = clampLimit(input.limit, 20)
          let query = supabase
            .from('dw_proof_events')
            .select('id,user_id,client_id,invoice_id,operational_state,proof,created_at')
            .eq('user_id', context.tenantId)
          if (scope !== ASK_DW_TOOL_SCOPE.PORTFOLIO && context.clientId && input.allowCrossClient !== true) query = query.eq('client_id', context.clientId)
          const response = await query.order('created_at', { ascending: false }).limit(MAX_LIMIT + 1)
          const candidateWindow = safeArray(throwQueryError('Ask DW precedent read failed', response))
          const candidateWindowComplete = candidateWindow.length <= MAX_LIMIT
          const rows = candidateWindow
            .slice(0, MAX_LIMIT)
            .filter((row) => scope !== ASK_DW_TOOL_SCOPE.INVOICE || row.invoice_id !== context.invoiceId)
            .map(structuralProjection)
            .filter((row) => !input.paymentState || row.paymentState === input.paymentState)
            .filter((row) => !input.disputeState || row.disputeState === input.disputeState)
            .filter((row) => !input.promiseState || row.promiseState === input.promiseState)
            .filter((row) => !input.collectionStage || row.collectionStage === input.collectionStage)
            .filter((row) => !input.operationalState || row.operationalState === input.operationalState)
            .slice(0, limit)
          return {
            precedents: rows,
            count: rows.length,
            retrieval: 'tenant_scoped_structural_filter',
            candidateWindowComplete,
            limitation: candidateWindowComplete ? null : 'Precedent retrieval is bounded to the newest 100 candidates and is not exhaustive.',
            causalClaimAllowed: false,
          }
        },
      },

      [ASK_DW_READ_TOOL.ACTIVITY_HISTORY]: {
        scopes: [ASK_DW_TOOL_SCOPE.INVOICE, ASK_DW_TOOL_SCOPE.CLIENT, ASK_DW_TOOL_SCOPE.PORTFOLIO],
        sourceClass: 'DURABLE_ACTIVITY_READ',
        canonicalAuthority: false,
        async handler({ input, context, scope }) {
          await ensureTenant(context)
          const limit = clampLimit(input.limit)
          let query = supabase
            .from('events')
            .select('id,user_id,event_type,invoice_id,created_at,lifecycle_state,evidence')
            .eq('user_id', context.tenantId)
          if (scope === ASK_DW_TOOL_SCOPE.INVOICE) query = query.eq('invoice_id', context.invoiceId)
          if (scope === ASK_DW_TOOL_SCOPE.CLIENT) {
            const invoiceIds = await invoiceIdsForClient(supabase, context.tenantId, context.clientId)
            if (invoiceIds.length === 0) return { events: [], count: 0 }
            query = query.in('invoice_id', invoiceIds)
          }
          const response = await query.order('created_at', { ascending: false }).limit(limit + 1)
          const window = safeArray(throwQueryError('Ask DW activity read failed', response))
          const hasMore = window.length > limit
          const events = window.slice(0, limit)
          return { events, count: events.length, hasMore, boundedAt: limit }
        },
      },

      [ASK_DW_READ_TOOL.PORTFOLIO_SUMMARY]: {
        scopes: [ASK_DW_TOOL_SCOPE.PORTFOLIO, ASK_DW_TOOL_SCOPE.CLIENT],
        sourceClass: 'DERIVED_CANONICAL_SUMMARY',
        canonicalAuthority: false,
        async handler({ context, scope }) {
          await ensureTenant(context)
          let query = supabase
            .from('invoices')
            .select('id,user_id,client_id,amount,amount_paid,due_date,currency,paid')
            .eq('user_id', context.tenantId)
          if (scope === ASK_DW_TOOL_SCOPE.CLIENT) query = query.eq('client_id', context.clientId)
          const response = await query.limit(MAX_LIMIT + 1)
          const window = safeArray(throwQueryError('Ask DW portfolio summary read failed', response))
          if (window.length > MAX_LIMIT) {
            return {
              complete: false,
              invoiceCountAtLeast: MAX_LIMIT + 1,
              outstandingCount: null,
              overdueCount: null,
              totalsByCurrency: null,
              limitation: 'Portfolio summary exceeds the current 100-invoice bounded read window; totals are withheld rather than presented as complete.',
            }
          }
          const rows = window
          const byCurrency = new Map()
          let overdueCount = 0
          let outstandingCount = 0
          for (const row of rows) {
            if (row.paid !== true) outstandingCount += 1
            if (row.paid !== true && (daysOverdue(row.due_date, context.asOf) || 0) > 0) overdueCount += 1
            const currency = row.currency || 'UNKNOWN'
            const amount = parseCents(row.amount)
            const paid = parseCents(row.amount_paid)
            if (amount == null || paid == null) continue
            const current = byCurrency.get(currency) || { invoiced: 0n, paid: 0n, outstanding: 0n }
            current.invoiced += amount
            current.paid += paid
            current.outstanding += amount > paid ? amount - paid : 0n
            byCurrency.set(currency, current)
          }
          return {
            complete: true,
            invoiceCount: rows.length,
            outstandingCount,
            overdueCount,
            totalsByCurrency: Object.fromEntries([...byCurrency.entries()].map(([currency, totals]) => [currency, {
              invoiced: centsToDecimal(totals.invoiced),
              paid: centsToDecimal(totals.paid),
              outstanding: centsToDecimal(totals.outstanding),
            }])),
            boundedAt: MAX_LIMIT,
          }
        },
      },
    },
  })
}

export const ASK_DW_LIVE_READ_TOOLS_ARE_READ_ONLY = true
export const ASK_DW_LIVE_READ_TOOL_LIMIT = MAX_LIMIT
export { assertAuthenticatedTenant }
