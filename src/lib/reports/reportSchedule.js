const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CURRENCY_RE = /^[A-Z]{3}$/
const CADENCES = new Set(['weekly', 'monthly'])
const TABS = new Set(['collections', 'aging', 'client-risk', 'promises', 'team-activity'])
const MS_MINUTE = 60 * 1000
const MS_DAY = 24 * 60 * 60 * 1000

function assertIanaTimezone(timeZone) {
  const value = String(timeZone ?? '').trim()
  if (!value || value.length > 80) throw new Error('A valid timezone is required.')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date())
  } catch {
    throw new Error('A valid IANA timezone is required.')
  }
  return value
}

function datePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

function localDateKey(parts) {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-')
}

function localDateFromKey(key) {
  const [year, month, day] = String(key).split('-').map(Number)
  if (!year || !month || !day) throw new Error('Invalid local date.')
  return { year, month, day }
}

function shiftLocalDate(key, days) {
  const { year, month, day } = localDateFromKey(key)
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0))
  return d.toISOString().slice(0, 10)
}

function weekdayForLocalDate(key) {
  const { year, month, day } = localDateFromKey(key)
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()
}

function zonedInstantForLocalHour(localDate, localHour, timeZone, notBefore = null) {
  const { year, month, day } = localDateFromKey(localDate)
  const approximate = Date.UTC(year, month - 1, day, localHour, 0, 0)
  const start = approximate - 18 * 60 * MS_MINUTE
  const end = approximate + 18 * 60 * MS_MINUTE
  const floor = notBefore ? new Date(notBefore).getTime() : -Infinity

  let firstLaterHour = null
  for (let t = start; t <= end; t += MS_MINUTE) {
    if (t < floor) continue
    const parts = datePartsInZone(new Date(t), timeZone)
    if (localDateKey(parts) !== localDate) continue
    if (parts.minute !== 0 || parts.second !== 0) continue
    if (parts.hour === localHour) return new Date(t)
    if (parts.hour > localHour && firstLaterHour === null) firstLaterHour = new Date(t)
  }

  // DST spring-forward can make a requested wall-clock hour nonexistent.
  // In that case use the first valid whole hour later on the same local day;
  // never silently run on the previous day or invent a timestamp.
  if (firstLaterHour) return firstLaterHour
  throw new Error('Could not resolve the requested local schedule time.')
}

function nextWeeklyLocalDate(from, weekday, timeZone, localHour) {
  const fromDate = new Date(from)
  const today = localDateKey(datePartsInZone(fromDate, timeZone))
  const todayWeekday = weekdayForLocalDate(today)
  let offset = (weekday - todayWeekday + 7) % 7

  for (let attempts = 0; attempts < 3; attempts += 1) {
    const key = shiftLocalDate(today, offset + attempts * 7)
    const instant = zonedInstantForLocalHour(key, localHour, timeZone)
    if (instant.getTime() > fromDate.getTime()) return instant
  }
  throw new Error('Could not resolve the next weekly run.')
}

function nextMonthlyLocalDate(from, dayOfMonth, timeZone, localHour) {
  const fromDate = new Date(from)
  const local = datePartsInZone(fromDate, timeZone)

  for (let monthOffset = 0; monthOffset < 15; monthOffset += 1) {
    const d = new Date(Date.UTC(local.year, local.month - 1 + monthOffset, dayOfMonth, 12))
    const key = d.toISOString().slice(0, 10)
    const parsed = localDateFromKey(key)
    // day 1-28 is enforced, so this guard mostly documents the invariant.
    if (parsed.day !== dayOfMonth) continue
    const instant = zonedInstantForLocalHour(key, localHour, timeZone)
    if (instant.getTime() > fromDate.getTime()) return instant
  }
  throw new Error('Could not resolve the next monthly run.')
}

export function computeNextReportRun(schedule, from = new Date()) {
  const timeZone = assertIanaTimezone(schedule?.timezone)
  const cadence = String(schedule?.cadence ?? '')
  if (!CADENCES.has(cadence)) throw new Error('Unsupported schedule cadence.')

  const localHour = Number(schedule?.local_hour)
  if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) {
    throw new Error('Schedule hour must be between 0 and 23.')
  }

  if (cadence === 'weekly') {
    const weekday = Number(schedule?.weekday)
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error('Weekly schedules require weekday 0–6.')
    }
    return nextWeeklyLocalDate(from, weekday, timeZone, localHour).toISOString()
  }

  const dayOfMonth = Number(schedule?.day_of_month)
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    throw new Error('Monthly schedules require day 1–28.')
  }
  return nextMonthlyLocalDate(from, dayOfMonth, timeZone, localHour).toISOString()
}

export function previousCompleteReportPeriod(schedule, scheduledFor) {
  const timeZone = assertIanaTimezone(schedule?.timezone)
  const cadence = String(schedule?.cadence ?? '')
  if (!CADENCES.has(cadence)) throw new Error('Unsupported schedule cadence.')

  const localRunDate = localDateKey(datePartsInZone(new Date(scheduledFor), timeZone))
  if (cadence === 'weekly') {
    return {
      startDate: shiftLocalDate(localRunDate, -7),
      endDate: localRunDate,
    }
  }

  const { year, month } = localDateFromKey(localRunDate)
  const currentMonthStart = new Date(Date.UTC(year, month - 1, 1, 12))
  const previousMonthStart = new Date(Date.UTC(year, month - 2, 1, 12))
  return {
    startDate: previousMonthStart.toISOString().slice(0, 10),
    endDate: currentMonthStart.toISOString().slice(0, 10),
  }
}

export function normalizeReportScheduleInput({
  userId,
  name,
  recipientEmail,
  cadence,
  weekday = null,
  dayOfMonth = null,
  localHour = 8,
  timezone,
  currency = null,
  activeTab = 'collections',
  filters = {},
  enabled = true,
  now = new Date(),
}) {
  if (!userId) throw new Error('A user id is required.')
  const normalizedName = String(name ?? '').trim()
  if (!normalizedName || normalizedName.length > 80) throw new Error('Schedule name must be 1–80 characters.')

  const email = String(recipientEmail ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(email) || email.length > 320) throw new Error('A valid recipient email is required.')

  const normalizedCadence = String(cadence ?? '')
  if (!CADENCES.has(normalizedCadence)) throw new Error('Schedule cadence must be weekly or monthly.')

  const hour = Number(localHour)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Schedule hour must be between 0 and 23.')

  const zone = assertIanaTimezone(timezone)
  const normalizedWeekday = normalizedCadence === 'weekly' ? Number(weekday) : null
  const normalizedDay = normalizedCadence === 'monthly' ? Number(dayOfMonth) : null

  if (normalizedCadence === 'weekly' && (!Number.isInteger(normalizedWeekday) || normalizedWeekday < 0 || normalizedWeekday > 6)) {
    throw new Error('Weekly schedules require weekday 0–6.')
  }
  if (normalizedCadence === 'monthly' && (!Number.isInteger(normalizedDay) || normalizedDay < 1 || normalizedDay > 28)) {
    throw new Error('Monthly schedules require day 1–28.')
  }

  const normalizedCurrency =
    currency === null || currency === undefined || currency === ''
      ? null
      : String(currency).trim().toUpperCase()
  if (normalizedCurrency && !CURRENCY_RE.test(normalizedCurrency)) {
    throw new Error('Currency must be a three-letter ISO code.')
  }
  if (!TABS.has(activeTab)) throw new Error('Unsupported report section.')
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Filters must be an object.')

  const row = {
    user_id: userId,
    name: normalizedName,
    recipient_email: email,
    cadence: normalizedCadence,
    weekday: normalizedWeekday,
    day_of_month: normalizedDay,
    local_hour: hour,
    timezone: zone,
    currency: normalizedCurrency,
    active_tab: activeTab,
    filters,
    delivery_format: 'csv',
    period_mode: 'previous_complete_period',
    enabled: Boolean(enabled),
  }

  row.next_run_at = computeNextReportRun(row, now)
  return row
}

export async function loadReportSchedules({ database, userId }) {
  if (!database) throw new Error('A database client is required.')
  if (!userId) throw new Error('A user id is required.')

  const [schedules, runs] = await Promise.all([
    database
      .from('report_schedules')
      .select('id,user_id,name,recipient_email,cadence,weekday,day_of_month,local_hour,timezone,currency,active_tab,filters,delivery_format,period_mode,next_run_at,enabled,last_run_at,deleted_at,created_at,updated_at')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('next_run_at', { ascending: true }),
    database
      .from('report_delivery_runs')
      .select('id,schedule_id,user_id,scheduled_for,period_start,period_end,currency,status,provider,provider_message_id,error_code,error_detail,artifact_sha256,started_at,completed_at,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(25),
  ])

  return {
    schedules: {
      available: !schedules.error,
      rows: schedules.data || [],
      error: schedules.error?.message || null,
    },
    runs: {
      available: !runs.error,
      rows: runs.data || [],
      error: runs.error?.message || null,
    },
  }
}

export async function saveReportSchedule({ database, input }) {
  if (!database) throw new Error('A database client is required.')
  const row = normalizeReportScheduleInput(input)
  const { data, error } = await database.from('report_schedules').insert(row).select().single()
  if (error) throw new Error(error.message || 'Could not save report schedule.')
  return data
}

export async function deleteReportSchedule({ database, userId, id }) {
  if (!database) throw new Error('A database client is required.')
  if (!userId || !id) throw new Error('User and schedule are required.')
  const { error } = await database
    .from('report_schedules')
    .update({
      enabled: false,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw new Error(error.message || 'Could not remove report schedule.')
}

export async function setReportScheduleEnabled({ database, userId, id, enabled, now = new Date() }) {
  if (!database) throw new Error('A database client is required.')
  if (!userId || !id) throw new Error('User and schedule are required.')

  const { data: existing, error: loadError } = await database
    .from('report_schedules')
    .select('id,user_id,cadence,weekday,day_of_month,local_hour,timezone')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (loadError || !existing) throw new Error(loadError?.message || 'Schedule not found.')

  const patch = { enabled: Boolean(enabled), updated_at: new Date().toISOString() }
  if (enabled) patch.next_run_at = computeNextReportRun(existing, now)

  const { data, error } = await database
    .from('report_schedules')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw new Error(error.message || 'Could not update report schedule.')
  return data
}
