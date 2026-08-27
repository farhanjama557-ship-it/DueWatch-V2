import { normalizeClientText } from '../clientIdentity.js'
import { ASK_DW_CASE_EVENT } from './askDwCaseState.js'

const MAX_CLIENT_TERM_QUERIES = 4
const MAX_CLIENT_MATCHES_PER_TERM = 20
const MAX_INVOICE_CANDIDATES = 20
const MAX_EXACT_INVOICE_VARIANTS = 4

const CLIENT_TERM_STOPWORDS = new Set([
  'about', 'again', 'amount', 'and', 'are', 'balance', 'been', 'being', 'brief',
  'calculate', 'calculations', 'client', 'customer', 'decide', 'did', 'do', 'does',
  'doing', 'done', 'due', 'follow', 'followed', 'following', 'for', 'from', 'going',
  'has', 'hasnt', 'have', 'history', 'invoice', 'invoices', 'late', 'make', 'money',
  'other', 'outstanding', 'overdue', 'paid', 'pay', 'paying', 'payment', 'payments',
  'please', 'remind', 'reminder', 'reminders', 'short', 'shorter', 'should', 'status',
  'that', 'the', 'their', 'them', 'this', 'today', 'what', 'whats', 'when', 'where',
  'which', 'why', 'with', 'yesterday', 'you', 'your',
])

const CLIENT_REFERENCE_CUES = new Set(['about', 'with', 'for', 'client', 'customer'])

export const ASK_DW_ENTITY_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  RESOLVED_WITH_LIMITATION: 'RESOLVED_WITH_LIMITATION',
  NOOP: 'NOOP',
  NEEDS_CLIENT_RESOLUTION: 'NEEDS_CLIENT_RESOLUTION',
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  CLIENT_HAS_NO_INVOICES: 'CLIENT_HAS_NO_INVOICES',
  NEEDS_INVOICE_RESOLUTION: 'NEEDS_INVOICE_RESOLUTION',
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
})

export const ASK_DW_ENTITY_RESOLVER_PROFILE = Object.freeze({
  id: 'ASK_DW_ENTITY_RESOLVER_READ_ONLY_V0',
  authenticatedTenantRequired: true,
  readsOnly: true,
  clientCreationAllowed: false,
  canonicalMutationAllowed: false,
  financialTruthStoredInCaseState: false,
  authorityGranted: false,
  modelDependency: false,
  maxClientTermQueries: MAX_CLIENT_TERM_QUERIES,
  maxClientMatchesPerTerm: MAX_CLIENT_MATCHES_PER_TERM,
  maxInvoiceCandidates: MAX_INVOICE_CANDIDATES,
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function required(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} required`)
  return normalized
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function throwQueryError(label, response) {
  if (response?.error) throw new Error(`${label}: ${response.error.message || 'query failed'}`)
  return response?.data ?? null
}

function ref(kind, id) {
  return freeze({ kind, id: required(id, `${kind} reference id`) })
}

function outcome({
  status,
  events = [],
  blocked = false,
  reason = null,
} = {}) {
  return freeze({
    status: required(status, 'Ask DW entity resolution status'),
    events: clone(events),
    blocked: blocked === true,
    reason: reason == null ? null : String(reason),
  })
}

async function assertAuthenticatedTenant(supabase, tenantId) {
  if (!supabase?.auth?.getUser) throw new Error('Ask DW entity resolver requires auth.getUser')
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) throw new Error('Ask DW entity resolver requires authentication')
  if (data.user.id !== tenantId) throw new Error('Ask DW entity resolver tenant mismatch')
}

function normalizedText(value) {
  return normalizeClientText(value) || ''
}

function tokens(value) {
  const normalized = normalizedText(value)
  return normalized ? normalized.split(' ').filter(Boolean) : []
}

function containsWholeToken(text, token) {
  if (!text || !token) return false
  return (` ${text} `).includes(` ${token} `)
}

function containsPhrase(text, phrase) {
  if (!text || !phrase) return false
  return (` ${text} `).includes(` ${phrase} `)
}

function meaningfulClientNameTokens(name) {
  return tokens(name).filter((token) => token.length >= 2)
}

function extractClientSearchTerms(text) {
  const list = tokens(text)
  const cueTerms = []
  for (let index = 0; index < list.length; index += 1) {
    if (!CLIENT_REFERENCE_CUES.has(list[index])) continue
    for (let offset = 1; offset <= 3; offset += 1) {
      const candidate = list[index + offset]
      if (!candidate) break
      if (CLIENT_TERM_STOPWORDS.has(candidate) || /^\d+$/.test(candidate)) continue
      cueTerms.push(candidate)
    }
  }

  const genericTerms = list.filter((token) =>
    token.length >= 3 &&
    token.length <= 40 &&
    !CLIENT_TERM_STOPWORDS.has(token) &&
    !/^\d+$/.test(token)
  )

  return {
    cueTerms: [...new Set(cueTerms)].slice(0, MAX_CLIENT_TERM_QUERIES),
    terms: [...new Set([...cueTerms, ...genericTerms])].slice(0, MAX_CLIENT_TERM_QUERIES),
  }
}

function scoreClientCandidate(client, questionText) {
  const name = normalizedText(client?.name)
  if (!name) return { score: 0, term: null }
  const question = normalizedText(questionText)

  if (containsPhrase(question, name)) {
    return { score: 3, term: name }
  }

  const nameTokens = meaningfulClientNameTokens(name)
  const matchingTokens = nameTokens.filter((token) => containsWholeToken(question, token))
  if (nameTokens.length > 1 && matchingTokens.length === nameTokens.length) {
    return { score: 2, term: matchingTokens.join(' ') }
  }
  if (matchingTokens.length > 0) {
    return { score: 1, term: matchingTokens[0] }
  }
  return { score: 0, term: null }
}

function pickClient(candidates, text) {
  const scored = safeArray(candidates)
    .map((client) => ({ client, ...scoreClientCandidate(client, text) }))
    .filter((entry) => entry.score > 0)

  if (scored.length === 0) {
    return { selected: null, ambiguous: [], term: null, score: 0 }
  }

  const bestScore = Math.max(...scored.map((entry) => entry.score))
  const best = scored.filter((entry) => entry.score === bestScore)

  if (best.length !== 1) {
    return {
      selected: null,
      ambiguous: best.map((entry) => entry.client),
      term: null,
      score: bestScore,
    }
  }

  return {
    selected: best[0].client,
    ambiguous: [],
    term: best[0].term,
    score: best[0].score,
  }
}

function wildcardTerm(term) {
  return `%${term}%`
}

function escapeIlikeLiteral(value) {
  return String(value ?? '').replace(/([\\%_])/g, '\\$1')
}

async function queryClientCandidates(supabase, tenantId, termsToSearch) {
  const byId = new Map()
  const truncatedTerms = []

  for (const term of termsToSearch.slice(0, MAX_CLIENT_TERM_QUERIES)) {
    const response = await supabase
      .from('clients')
      .select('id,user_id,name,created_at')
      .eq('user_id', tenantId)
      .ilike('name', wildcardTerm(term))
      .order('created_at', { ascending: true })
      .limit(MAX_CLIENT_MATCHES_PER_TERM + 1)

    const rows = safeArray(throwQueryError('Ask DW client candidate read failed', response))

    if (rows.length > MAX_CLIENT_MATCHES_PER_TERM) {
      truncatedTerms.push(term)
      continue
    }

    for (const row of rows) {
      if (row?.user_id !== tenantId || !row?.id) continue
      byId.set(row.id, row)
    }
  }

  return {
    rows: [...byId.values()],
    truncated: truncatedTerms.length > 0,
    truncatedTerms,
  }
}

async function readClientById(supabase, tenantId, clientId) {
  const response = await supabase
    .from('clients')
    .select('id,user_id,name,created_at')
    .eq('user_id', tenantId)
    .eq('id', clientId)
    .maybeSingle()
  const client = throwQueryError('Ask DW client read failed', response)
  if (!client || client.user_id !== tenantId || client.id !== clientId) return null
  return client
}

async function readInvoiceById(supabase, tenantId, invoiceId) {
  const response = await supabase
    .from('invoices')
    .select('id,user_id,client_id,inv_num,created_at')
    .eq('user_id', tenantId)
    .eq('id', invoiceId)
    .maybeSingle()

  const invoice = throwQueryError('Ask DW invoice reference read failed', response)

  if (!invoice || invoice.user_id !== tenantId || invoice.id !== invoiceId) {
    return null
  }

  return invoice
}

async function readClientInvoices(supabase, tenantId, clientId) {
  const response = await supabase
    .from('invoices')
    .select('id,user_id,client_id,inv_num,created_at')
    .eq('user_id', tenantId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: true })
    .limit(MAX_INVOICE_CANDIDATES + 1)

  const rows = safeArray(throwQueryError('Ask DW client invoice reference read failed', response))
    .filter((row) => row?.user_id === tenantId && row?.client_id === clientId && row?.id)

  return {
    invoices: rows.slice(0, MAX_INVOICE_CANDIDATES),
    truncated: rows.length > MAX_INVOICE_CANDIDATES,
  }
}

function explicitInvoiceLookup(text) {
  const raw = String(text ?? '')
  const match = /\binv(?:oice)?\s*[-#:]?\s*([a-z0-9][a-z0-9._/-]*)\b/i.exec(raw)
  if (!match) return null

  const suffix = String(match[1] || '').replace(/^[#:_/-]+/, '').trim()
  if (!suffix) return null

  const variants = [
    `INV-${suffix}`,
    `INV ${suffix}`,
    `INV${suffix}`,
    suffix,
  ]

  return freeze({
    term: match[0].trim(),
    variants: [...new Set(variants.map((value) => value.trim()).filter(Boolean))]
      .slice(0, MAX_EXACT_INVOICE_VARIANTS),
  })
}

async function queryExactInvoiceCandidates(supabase, tenantId, lookup) {
  const byId = new Map()
  for (const variant of lookup.variants) {
    const response = await supabase
      .from('invoices')
      .select('id,user_id,client_id,inv_num,created_at')
      .eq('user_id', tenantId)
      .ilike('inv_num', escapeIlikeLiteral(variant))
      .order('created_at', { ascending: true })
      .limit(3)

    const rows = safeArray(throwQueryError('Ask DW exact invoice reference read failed', response))
    for (const row of rows) {
      if (row?.user_id !== tenantId || !row?.id || !row?.client_id) continue
      byId.set(row.id, row)
    }
  }
  return [...byId.values()]
}

function clientEvents({ client, term }) {
  const clientRef = ref('client', client.id)
  const events = [{
    type: ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT,
    payload: { clientRef },
  }]
  if (term) {
    events.push({
      type: ASK_DW_CASE_EVENT.RESOLVE_REFERENCE,
      payload: { term, ref: clientRef },
    })
  }
  return events
}

function candidateEvent(invoices) {
  return {
    type: ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES,
    payload: {
      invoiceRefs: invoices.map((invoice) => ref('invoice', invoice.id)),
    },
  }
}

function selectInvoiceEvent(invoice) {
  return {
    type: ASK_DW_CASE_EVENT.SELECT_INVOICE,
    payload: { invoiceRef: ref('invoice', invoice.id) },
  }
}

function resolveInvoiceBindingEvent(term, invoice) {
  return {
    type: ASK_DW_CASE_EVENT.RESOLVE_REFERENCE,
    payload: { term, ref: ref('invoice', invoice.id) },
  }
}

function sameId(reference, id) {
  return Boolean(reference && reference.id === id)
}

async function resolveExplicitInvoice({ supabase, tenantId, lookup }) {
  const matches = await queryExactInvoiceCandidates(supabase, tenantId, lookup)
  if (matches.length === 0) {
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.INVOICE_NOT_FOUND,
      blocked: true,
      reason: `No invoice matched ${lookup.term} for the authenticated tenant.`,
    })
  }
  if (matches.length > 1) {
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION,
      blocked: true,
      reason: `${lookup.term} matched more than one tenant invoice; explicit selection is required.`,
    })
  }

  const invoice = matches[0]
  const client = await readClientById(supabase, tenantId, invoice.client_id)
  if (!client) {
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_CLIENT_RESOLUTION,
      blocked: true,
      reason: 'The resolved invoice owner could not be verified for the authenticated tenant.',
    })
  }

  const clientInvoiceRead = await readClientInvoices(supabase, tenantId, client.id)
  const candidateInvoices = clientInvoiceRead.truncated
    ? [invoice]
    : clientInvoiceRead.invoices

  if (!candidateInvoices.some((candidate) => candidate.id === invoice.id)) {
    candidateInvoices.push(invoice)
  }

  const events = [
    ...clientEvents({ client, term: null }),
    candidateEvent(candidateInvoices),
    selectInvoiceEvent(invoice),
    resolveInvoiceBindingEvent(normalizedText(lookup.term), invoice),
  ]

  return outcome({
    status: clientInvoiceRead.truncated
      ? ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED_WITH_LIMITATION
      : ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED,
    events,
    blocked: false,
    reason: clientInvoiceRead.truncated
      ? 'The invoice was resolved exactly, but the client has more invoice references than the bounded case candidate set can safely carry.'
      : null,
  })
}

async function resolveClientText({
  supabase,
  tenantId,
  text,
  caseContext,
}) {
  const activeClientRef = caseContext?.focus?.clientRef ?? null
  const activeInvoiceRef = caseContext?.focus?.invoiceRef ?? null
  const search = extractClientSearchTerms(text)

  if (search.terms.length === 0) {
    if (activeClientRef || activeInvoiceRef) {
      return outcome({ status: ASK_DW_ENTITY_RESOLUTION_STATUS.NOOP })
    }
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_CLIENT_RESOLUTION,
      blocked: true,
      reason: 'No client or invoice reference could be deterministically resolved from this turn.',
    })
  }

  const candidateRead = await queryClientCandidates(supabase, tenantId, search.terms)
  const picked = pickClient(candidateRead.rows, text)

  if (picked.ambiguous.length > 0) {
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_CLIENT_RESOLUTION,
      blocked: true,
      reason: 'More than one client matches this reference; explicit client selection is required.',
    })
  }

  if (
    candidateRead.truncated &&
    (!picked.selected || picked.score < 2)
  ) {
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_CLIENT_RESOLUTION,
      blocked: true,
      reason: `Client term ${candidateRead.truncatedTerms[0]} matched more records than the bounded deterministic resolver can safely disambiguate.`,
    })
  }

  if (!picked.selected) {
    if (activeClientRef || activeInvoiceRef) {
      if (search.cueTerms.length > 0) {
        return outcome({
          status: ASK_DW_ENTITY_RESOLUTION_STATUS.CLIENT_NOT_FOUND,
          blocked: true,
          reason: 'The client reference in this turn did not match a verified client for the authenticated tenant.',
        })
      }
      return outcome({ status: ASK_DW_ENTITY_RESOLUTION_STATUS.NOOP })
    }
    return outcome({
      status: search.cueTerms.length > 0
        ? ASK_DW_ENTITY_RESOLUTION_STATUS.CLIENT_NOT_FOUND
        : ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_CLIENT_RESOLUTION,
      blocked: true,
      reason: search.cueTerms.length > 0
        ? 'The client reference in this turn did not match a verified client for the authenticated tenant.'
        : 'No unique client could be deterministically resolved from this turn.',
    })
  }

  const client = picked.selected
  const invoiceRead = await readClientInvoices(supabase, tenantId, client.id)
  const baseEvents = clientEvents({ client, term: picked.term })
  const sameActiveClient = sameId(activeClientRef, client.id)

  if (invoiceRead.truncated) {
    if (sameActiveClient && activeInvoiceRef) {
      const activeInvoice = await readInvoiceById(
        supabase,
        tenantId,
        activeInvoiceRef.id,
      )

      if (activeInvoice?.client_id === client.id) {
        return outcome({
          status: ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED_WITH_LIMITATION,
          events: [
            ...baseEvents,
            candidateEvent([activeInvoice]),
          ],
          reason: 'The active invoice reference was re-verified exactly, but the client has more invoices than the bounded case candidate set can safely carry. Other-invoice switching requires an explicit invoice reference.',
        })
      }
    }

    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION,
      events: [
        ...baseEvents,
        candidateEvent([]),
      ],
      blocked: true,
      reason: 'The client has more invoice references than the bounded case candidate set can safely carry; an explicit invoice number is required.',
    })
  }

  const invoices = invoiceRead.invoices
  const events = [...baseEvents, candidateEvent(invoices)]

  if (invoices.length === 0) {
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.CLIENT_HAS_NO_INVOICES,
      events,
      blocked: true,
      reason: 'The resolved client has no invoice references for the authenticated tenant.',
    })
  }

  if (sameActiveClient && activeInvoiceRef) {
    if (!invoices.some((invoice) => invoice.id === activeInvoiceRef.id)) {
      return outcome({
        status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION,
        events,
        blocked: true,
        reason: 'The active invoice reference is no longer present in the resolved client invoice set.',
      })
    }
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED,
      events,
    })
  }

  if (invoices.length === 1) {
    events.push(selectInvoiceEvent(invoices[0]))
    return outcome({
      status: ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED,
      events,
    })
  }

  return outcome({
    status: ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION,
    events,
    blocked: true,
    reason: 'The client has more than one resolved invoice; explicit invoice selection is required.',
  })
}

/**
 * M2B deterministic, read-only entity resolver.
 *
 * It resolves only references. It never reads or stores invoice money fields,
 * never creates clients, never mutates canonical state, and never grants action
 * authority. Once an invoice reference is resolved, the existing M2A runtime
 * remains responsible for fresh canonical truth and fail-closed authority.
 */
export function createAskDwEntityResolver({ supabase } = {}) {
  if (!supabase?.from) throw new Error('Ask DW entity resolver requires Supabase')

  async function resolveCaseEvents({
    tenantId,
    text,
    caseContext,
  } = {}) {
    const tenant = required(tenantId, 'Ask DW entity resolver tenantId')
    await assertAuthenticatedTenant(supabase, tenant)

    const lookup = explicitInvoiceLookup(text)
    if (lookup) {
      return resolveExplicitInvoice({
        supabase,
        tenantId: tenant,
        lookup,
      })
    }

    return resolveClientText({
      supabase,
      tenantId: tenant,
      text: String(text ?? ''),
      caseContext: caseContext || {},
    })
  }

  return freeze({
    profile: ASK_DW_ENTITY_RESOLVER_PROFILE,
    resolveCaseEvents,
  })
}
