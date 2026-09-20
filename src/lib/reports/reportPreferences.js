const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Z]{3}$/
const CADENCES = new Set(['Monthly', 'Quarterly', 'Yearly', 'Custom'])
const TABS = new Set(['collections', 'aging', 'client-risk', 'promises', 'team-activity'])

function requiredDate(value, label) {
  const raw = String(value ?? '')
  if (!DATE_RE.test(raw)) throw new Error(label + ' is required.')
  return raw
}

function normalizedCurrency(value) {
  if (value === null || value === undefined || value === '') return null
  const currency = String(value).trim().toUpperCase()
  if (!CURRENCY_RE.test(currency)) throw new Error('Currency must be a three-letter ISO code.')
  return currency
}

export function normalizeSavedViewInput({
  userId,
  name,
  cadence,
  startDate,
  endDate,
  currency = null,
  activeTab = 'collections',
  filters = {},
}) {
  if (!userId) throw new Error('A user id is required.')
  const normalizedName = String(name ?? '').trim()
  if (!normalizedName || normalizedName.length > 80) throw new Error('View name must be 1–80 characters.')
  const normalizedCadence = String(cadence ?? '')
  if (!CADENCES.has(normalizedCadence)) throw new Error('Unsupported report cadence.')
  const start = requiredDate(startDate, 'Start date')
  const end = requiredDate(endDate, 'End date')
  if (end <= start) throw new Error('End date must be after start date.')
  if (!TABS.has(activeTab)) throw new Error('Unsupported report tab.')
  if (!filters || Array.isArray(filters) || typeof filters !== 'object') {
    throw new Error('Filters must be an object.')
  }

  return {
    user_id: userId,
    name: normalizedName,
    cadence: normalizedCadence,
    start_date: start,
    end_date: end,
    currency: normalizedCurrency(currency),
    active_tab: activeTab,
    filters,
    updated_at: new Date().toISOString(),
  }
}

export function normalizeCollectionTargetInput({
  userId,
  startDate,
  endDate,
  currency,
  targetAmount,
}) {
  if (!userId) throw new Error('A user id is required.')
  const start = requiredDate(startDate, 'Start date')
  const end = requiredDate(endDate, 'End date')
  if (end <= start) throw new Error('End date must be after start date.')

  const amount = Number(targetAmount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999999.99) {
    throw new Error('Target amount must be greater than zero and within the supported range.')
  }

  return {
    user_id: userId,
    period_start: start,
    period_end: end,
    currency: normalizedCurrency(currency),
    target_amount: Math.round(amount * 100) / 100,
    updated_at: new Date().toISOString(),
  }
}

export async function loadReportPreferences({ database, userId }) {
  if (!database) throw new Error('A database client is required.')
  if (!userId) throw new Error('A user id is required.')

  const [viewsResult, targetsResult] = await Promise.all([
    database
      .from('report_saved_views')
      .select('id,user_id,name,cadence,start_date,end_date,currency,active_tab,filters,created_at,updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
    database
      .from('report_collection_targets')
      .select('id,user_id,period_start,period_end,currency,target_amount,created_at,updated_at')
      .eq('user_id', userId)
      .order('period_start', { ascending: false }),
  ])

  return {
    savedViews: {
      available: !viewsResult.error,
      rows: viewsResult.data || [],
      error: viewsResult.error?.message || null,
    },
    targets: {
      available: !targetsResult.error,
      rows: targetsResult.data || [],
      error: targetsResult.error?.message || null,
    },
  }
}

export async function saveReportView({ database, input }) {
  if (!database) throw new Error('A database client is required.')
  const row = normalizeSavedViewInput(input)
  const { data, error } = await database
    .from('report_saved_views')
    .upsert(row, { onConflict: 'user_id,name' })
    .select()
    .single()
  if (error) throw new Error(error.message || 'Could not save report view.')
  return data
}

export async function deleteReportView({ database, userId, id }) {
  if (!database) throw new Error('A database client is required.')
  if (!userId || !id) throw new Error('User and saved view are required.')
  const { error } = await database
    .from('report_saved_views')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw new Error(error.message || 'Could not delete report view.')
}

export async function saveCollectionTarget({ database, input }) {
  if (!database) throw new Error('A database client is required.')
  const row = normalizeCollectionTargetInput(input)
  const { data, error } = await database
    .from('report_collection_targets')
    .upsert(row, { onConflict: 'user_id,period_start,period_end,currency' })
    .select()
    .single()
  if (error) throw new Error(error.message || 'Could not save collection target.')
  return data
}

export function findCollectionTarget(targets, { startDate, endDate, currency }) {
  const normalized = normalizedCurrency(currency)
  return (targets || []).find(
    (row) =>
      row.period_start === startDate &&
      row.period_end === endDate &&
      row.currency === normalized
  ) || null
}
