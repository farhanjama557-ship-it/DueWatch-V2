export async function collectPagedRows(fetchPage, { pageSize = 1000, maxPages = 50 } = {}) {
  const rows = []
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize
    const to = from + pageSize - 1
    const result = await fetchPage({ from, to })
    if (result?.error) throw new Error(result.error.message || 'Report data query failed.')
    const batch = result?.data || []
    rows.push(...batch)
    if (batch.length < pageSize) {
      return { rows, truncated: false }
    }
  }
  return { rows, truncated: true }
}

async function loadPaged({
  database,
  table,
  select,
  userId = null,
  orderColumn = null,
  tenantFilter = null,
  pageSize = 1000,
  maxPages = 50,
}) {
  return collectPagedRows(async ({ from, to }) => {
    let query = database.from(table).select(select)
    if (userId) query = query.eq('user_id', userId)
    if (tenantFilter) query = tenantFilter(query)
    if (orderColumn) query = query.order(orderColumn, { ascending: true })
    return query.range(from, to)
  }, { pageSize, maxPages })
}

function safeResult(value, fallback = []) {
  if (value.status === 'fulfilled') {
    if (value.value.truncated) {
      return {
        available: false,
        rows: fallback,
        truncated: true,
        error: 'Report source exceeded the supported row limit; dependent metrics were withheld.',
      }
    }
    return {
      available: true,
      rows: value.value.rows,
      truncated: false,
      error: null,
    }
  }
  return {
    available: false,
    rows: fallback,
    truncated: false,
    error: value.reason instanceof Error ? value.reason.message : String(value.reason || 'Unknown query error'),
  }
}

export async function loadReportsSourceData({ database, userId, pageSize = 1000, maxPages = 50 }) {
  if (!database) throw new Error('A database client is required.')
  if (!userId) throw new Error('A user id is required.')

  const requests = await Promise.allSettled([
    loadPaged({
      database,
      table: 'invoices',
      select:
        'id,user_id,client_id,inv_num,amount,amount_paid,due_date,paid,currency,clients(id,name)',
      userId,
      orderColumn: 'created_at',
      pageSize,
      maxPages,
    }),
    loadPaged({
      database,
      table: 'payments',
      select:
        'id,user_id,payment_date,total_amount,currency,origin,source_event_id,recorded_at,reversed_at',
      userId,
      orderColumn: 'recorded_at',
      pageSize,
      maxPages,
    }),
    loadPaged({
      database,
      table: 'payment_allocations',
      select:
        'id,payment_id,invoice_id,amount,created_at,invoices!inner(id,user_id,client_id,inv_num,clients(id,name))',
      tenantFilter: (query) => query.eq('invoices.user_id', userId),
      orderColumn: 'created_at',
      pageSize,
      maxPages,
    }),
    loadPaged({
      database,
      table: 'promises',
      select:
        'id,user_id,invoice_id,status,promised_amount,promised_date,currency,source,confirmed_at,created_at',
      userId,
      orderColumn: 'created_at',
      pageSize,
      maxPages,
    }),
    loadPaged({
      database,
      table: 'autopilot_execution_claims',
      select:
        'id,user_id,invoice_id,rule_id,action_type,status,provider,provider_message_id,claimed_at,resolved_at,evidence',
      userId,
      orderColumn: 'claimed_at',
      pageSize,
      maxPages,
    }),
    loadPaged({
      database,
      table: 'awaiting_signature',
      select: 'id,user_id,invoice_id,status,created_at,resolved_at,ai_reason,ai_context',
      userId,
      orderColumn: 'created_at',
      pageSize,
      maxPages,
    }),
    loadPaged({
      database,
      table: 'events',
      select: 'id,user_id,event_type,invoice_id,created_at,lifecycle_state,evidence',
      userId,
      orderColumn: 'created_at',
      pageSize,
      maxPages,
    }),
  ])

  const [invoices, payments, allocations, promises, executionClaims, approvals, events] = requests.map((value) =>
    safeResult(value)
  )

  return {
    invoices,
    payments,
    allocations,
    promises,
    executionClaims,
    approvals,
    events,
  }
}
