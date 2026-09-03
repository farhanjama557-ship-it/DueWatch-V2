import { evaluateNextActionAuthority } from '../nextActionAuthority.js'
import { toHandledKeys, toPendingInvoiceIds } from '../pulseAuthority.js'
import { assertAuthenticatedTenant } from './askDwSupabaseReadTools.js'
import {
  DW_INVESTIGATION_BOUNDS,
  DW_INVESTIGATION_SOURCE,
  admitDwInvestigationInput,
} from './dwInvestigationInput.js'

// The bounded read window is owned by the shared admission gate, so the
// founder and proactive lanes cannot drift to different numbers.
const MAX_EVIDENCE = DW_INVESTIGATION_BOUNDS.MAX_EVIDENCE
const MAX_PRECEDENTS = DW_INVESTIGATION_BOUNDS.MAX_PRECEDENTS

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function throwQueryError(label, response) {
  if (response?.error) throw new Error(`${label}: ${response.error.message || 'query failed'}`)
  return response?.data ?? null
}

function requiredBoundedRows(label, response, max) {
  const rows = safeArray(throwQueryError(label, response))
  if (rows.length > max) {
    throw new Error(`${label}: exceeds the current bounded read window; refusing an incomplete truth input`)
  }
  return rows
}

function mapEvidenceRows(rows) {
  const keyToId = new Map(rows.map((row) => [row.evidence_key, row.id]))
  return rows.map((row) => ({
    id: row.id,
    evidenceKey: row.evidence_key,
    tenantId: row.user_id,
    clientId: row.client_id,
    invoiceId: row.invoice_id,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    trust: row.trust,
    claimType: row.claim_type,
    derivedFrom: row.derived_from_key ? (keyToId.get(row.derived_from_key) ?? null) : null,
    observedAt: row.created_at,
    containsInstructions: row.admission_status === 'QUARANTINED_INSTRUCTION',
    persistedAdmissionStatus: row.admission_status,
    provenance: row.provenance || {},
  }))
}

function mapMemory(rows, links) {
  const linkMap = new Map()
  for (const link of links) {
    const list = linkMap.get(link.memory_id) || []
    list.push(link.evidence_id)
    linkMap.set(link.memory_id, list)
  }
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.user_id,
    clientId: row.client_id,
    invoiceId: row.invoice_id,
    scope: row.scope,
    claimKey: row.claim_key,
    claimValue: row.claim_value,
    admitted: row.admitted === true,
    derivedFromMemoryId: row.derived_from_memory_id,
    sourceEvidenceIds: linkMap.get(row.id) || [],
    createdAt: row.created_at,
  }))
}

function mapTombstones(rows, links) {
  const linkMap = new Map()
  for (const link of links) {
    const list = linkMap.get(link.tombstone_id) || []
    list.push(link.evidence_id)
    linkMap.set(link.tombstone_id, list)
  }
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.user_id,
    memoryId: row.memory_id,
    reason: row.reason,
    blockedEvidenceIds: linkMap.get(row.id) || [],
    createdAt: row.created_at,
  }))
}

function mapPrecedent(row, now) {
  const proof = row.proof || {}
  const ar = proof.arState || {}
  const created = row.created_at ? new Date(row.created_at) : null
  const ageDays = created && !Number.isNaN(created.getTime())
    ? Math.max(0, Math.floor((now.getTime() - created.getTime()) / 86_400_000))
    : null
  return {
    id: row.id,
    tenantId: row.user_id,
    clientId: row.client_id,
    invoiceId: row.invoice_id,
    disputed: ar.dispute?.status != null ? ar.dispute.status !== 'NONE' : null,
    actionType: proof.policy?.action ?? proof.stagedAction?.action ?? null,
    promiseStatus: ar.promise?.status ?? null,
    paymentState: ar.payment?.status ?? null,
    collectionStage: ar.collection?.status ?? null,
    similarity: 0,
    stale: ageDays == null ? true : ageDays > 180,
    outcomeValid: row.operational_state !== 'BLOCKED',
    outcomeQuality: row.operational_state === 'HANDLED' ? 'OK' : 'MEDIUM',
    allowCrossClient: false,
    createdAt: row.created_at,
  }
}

async function readRequiredInvoiceScope({ supabase, tenantId, invoiceId }) {
  const response = await supabase
    .from('invoices')
    .select('id,user_id,client_id,inv_num,amount,amount_paid,inv_date,due_date,currency,paid,last_reminder,autopilot_paused,created_at,clients(id,user_id,name)')
    .eq('user_id', tenantId)
    .eq('id', invoiceId)
    .maybeSingle()
  const invoice = throwQueryError('Ask DW live invoice load failed', response)
  if (!invoice) throw new Error('Ask DW live invoice not found for authenticated tenant')
  const client = invoice.clients
  if (!client || client.user_id !== tenantId || client.id !== invoice.client_id) {
    throw new Error('Ask DW live invoice/client tenant scope could not be verified')
  }
  const { clients: _clients, ...invoiceRow } = invoice
  return { invoice: invoiceRow, client }
}

/**
 * Loads a fresh invoice-scoped deterministic truth input from Duewatch.
 * Every tenant-owned table is explicitly filtered to the authenticated user;
 * RLS remains a second boundary. No write/RPC path exists in this loader.
 */
export async function loadAskDwLiveInvoiceInput({
  supabase,
  tenantId,
  invoiceId,
  now = new Date(),
} = {}) {
  if (!supabase?.from) throw new Error('Ask DW live data loader requires Supabase')
  if (!tenantId || !invoiceId) throw new Error('Ask DW live invoice loader requires tenantId and invoiceId')
  await assertAuthenticatedTenant(supabase, tenantId)

  const { invoice, client } = await readRequiredInvoiceScope({ supabase, tenantId, invoiceId })

  const [
    rulesResponse,
    settingsResponse,
    signatureResponse,
    claimsResponse,
    eventsResponse,
    evidenceResponse,
    memoryResponse,
    precedentResponse,
  ] = await Promise.all([
    supabase.from('autopilot_rules').select('*').eq('user_id', tenantId).order('sort_order', { ascending: true }),
    supabase.from('autopilot_settings').select('id,user_id,enabled,approval_required').eq('user_id', tenantId).maybeSingle(),
    supabase.from('awaiting_signature').select('id,user_id,invoice_id,status,ai_context,created_at').eq('user_id', tenantId).order('created_at', { ascending: true }),
    supabase.from('autopilot_execution_claims').select('invoice_id,rule_id,action_type,status,created_at').eq('user_id', tenantId).eq('action_type', 'send_reminder'),
    supabase.from('events').select('id,user_id,event_type,invoice_id,created_at,lifecycle_state,evidence').eq('user_id', tenantId).eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(100),
    supabase.from('dw_evidence_items').select('id,user_id,client_id,invoice_id,evidence_key,source_type,source_ref,trust,admission_status,claim_type,derived_from_key,provenance,created_at').eq('user_id', tenantId).eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(MAX_EVIDENCE + 1),
    supabase.from('dw_memory_claims').select('id,user_id,client_id,invoice_id,scope,claim_key,claim_value,admitted,derived_from_memory_id,created_at').eq('user_id', tenantId).or(`invoice_id.eq.${invoiceId},and(scope.eq.client,client_id.eq.${client.id})`).order('created_at', { ascending: false }).limit(MAX_EVIDENCE + 1),
    supabase.from('dw_proof_events').select('id,user_id,client_id,invoice_id,operational_state,proof,created_at').eq('user_id', tenantId).neq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(MAX_PRECEDENTS + 1),
  ])

  const rules = safeArray(throwQueryError('Ask DW rules load failed', rulesResponse))
  const settings = throwQueryError('Ask DW settings load failed', settingsResponse)
  const signatureHistory = safeArray(throwQueryError('Ask DW signature history load failed', signatureResponse))
  const executionClaims = safeArray(throwQueryError('Ask DW execution history load failed', claimsResponse))
  const events = safeArray(throwQueryError('Ask DW activity load failed', eventsResponse))
  const evidenceRows = requiredBoundedRows('Ask DW evidence load failed', evidenceResponse, MAX_EVIDENCE)
  const memoryRows = requiredBoundedRows('Ask DW memory load failed', memoryResponse, MAX_EVIDENCE)
  const precedentWindow = safeArray(throwQueryError('Ask DW precedent load failed', precedentResponse))
  const precedentWindowComplete = precedentWindow.length <= MAX_PRECEDENTS
  const precedentRows = precedentWindow.slice(0, MAX_PRECEDENTS)

  const memoryIds = memoryRows.map((row) => row.id)
  const tombstoneResponse = memoryIds.length
    ? await supabase
        .from('dw_memory_tombstones')
        .select('id,user_id,memory_id,reason,created_at')
        .eq('user_id', tenantId)
        .in('memory_id', memoryIds)
    : { data: [], error: null }
  const tombstoneRows = safeArray(throwQueryError('Ask DW tombstone load failed', tombstoneResponse))
  const tombstoneIds = tombstoneRows.map((row) => row.id)
  const [memoryLinksResponse, tombstoneLinksResponse] = await Promise.all([
    memoryIds.length
      ? supabase.from('dw_memory_evidence_links').select('memory_id,evidence_id').eq('user_id', tenantId).in('memory_id', memoryIds)
      : Promise.resolve({ data: [], error: null }),
    tombstoneIds.length
      ? supabase.from('dw_tombstone_evidence_links').select('tombstone_id,evidence_id').eq('user_id', tenantId).in('tombstone_id', tombstoneIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  const memoryLinks = safeArray(throwQueryError('Ask DW memory evidence links load failed', memoryLinksResponse))
  const tombstoneLinks = safeArray(throwQueryError('Ask DW tombstone evidence links load failed', tombstoneLinksResponse))

  const handledKeys = toHandledKeys(executionClaims, signatureHistory)
  const pendingInvoiceIds = toPendingInvoiceIds(signatureHistory)
  if (!(handledKeys instanceof Set) || !(pendingInvoiceIds instanceof Set)) {
    throw new Error('Ask DW live execution history could not be verified')
  }

  const authorityEvaluation = evaluateNextActionAuthority({
    userId: tenantId,
    invoice,
    rules,
    autopilotSettings: settings,
    events,
    handledKeys,
    pendingInvoiceIds,
    now,
  })

  // Admission runs through the shared gate, not through loader-local rules, so
  // the founder lane and the proactive lane bound and verify identically.
  const { intelligenceInput } = admitDwInvestigationInput({
    source: DW_INVESTIGATION_SOURCE.ASK_DW,
    tenantId,
    invoice,
    client,
    now,
    evidence: mapEvidenceRows(evidenceRows),
    memory: mapMemory(memoryRows, memoryLinks),
    tombstones: mapTombstones(tombstoneRows, tombstoneLinks),
    precedents: precedentRows.map((row) => mapPrecedent(row, now instanceof Date ? now : new Date(now))),
    pooling: null,
    prediction: null,
    handledKeys,
    pendingInvoiceIds,
    authorityEvaluation,
    founderApproved: false,
    preferenceEvents: [],
    disputed: false,
    sandboxTransport: true,
  })

  return {
    context: {
      tenantId,
      invoiceId: invoice.id,
      clientId: client.id,
      asOf: now instanceof Date ? now.toISOString() : String(now),
    },
    intelligenceInput,
    liveReadReceipt: {
      invoiceRead: true,
      clientRead: true,
      policyRead: true,
      executionHistoryRead: true,
      evidenceRead: true,
      evidenceWindowComplete: true,
      memoryRead: true,
      memoryWindowComplete: true,
      tombstonesScopedToLoadedMemory: true,
      precedentRead: true,
      precedentWindowComplete,
      predictionModelRead: false,
      writesPerformed: false,
    },
  }
}
