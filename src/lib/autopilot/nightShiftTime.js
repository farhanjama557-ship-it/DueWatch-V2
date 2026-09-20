import {
  AUTOPILOT_MODE,
  MODE_ACTIVATION,
  normalizeModeConfig,
  resolveModeActivation,
} from './nightShiftModes.js'

const WEEKDAY = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '')
  if (!match) throw new Error('clock must be HH:MM')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error('clock must be valid')
  return { hour, minute, minutes: hour * 60 + minute }
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return true
  } catch {
    return false
  }
}

export function zonedLocalParts(date, timeZone) {
  if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) throw new Error('valid date required')
  if (!isValidTimeZone(timeZone)) throw new Error('valid IANA timezone required')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value
  return freeze({
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    weekday: WEEKDAY[pick('weekday')],
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
  })
}

function normalizeDays(days) {
  if (!Array.isArray(days) || days.length === 0) throw new Error('schedule days required')
  const normalized = [...new Set(days.map(Number))].sort((a, b) => a - b)
  if (normalized.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('schedule day must be 0..6')
  }
  return normalized
}

export function normalizeRecurringWindow(window, { defaultTimeZone = null } = {}) {
  if (!window || typeof window !== 'object') throw new Error('recurring window required')
  const timeZone = window.timezone ?? window.time_zone ?? defaultTimeZone
  if (!isValidTimeZone(timeZone)) throw new Error('recurring window timezone required')
  const start = parseClock(window.start)
  const end = parseClock(window.end)
  if (start.minutes === end.minutes) throw new Error('recurring window cannot span 24 hours')
  return freeze({
    timezone: timeZone,
    start: window.start,
    end: window.end,
    start_minutes: start.minutes,
    end_minutes: end.minutes,
    days: normalizeDays(window.days),
  })
}

function previousWeekday(day) {
  return (day + 6) % 7
}

export function recurringWindowContains(window, now = new Date()) {
  const normalized = normalizeRecurringWindow(window)
  const local = zonedLocalParts(now, normalized.timezone)
  const minute = local.hour * 60 + local.minute
  const days = new Set(normalized.days)
  const overnight = normalized.start_minutes > normalized.end_minutes

  const active = overnight
    ? (days.has(local.weekday) && minute >= normalized.start_minutes) ||
      (days.has(previousWeekday(local.weekday)) && minute < normalized.end_minutes)
    : days.has(local.weekday) &&
      minute >= normalized.start_minutes &&
      minute < normalized.end_minutes

  return freeze({ active, local, timezone: normalized.timezone, overnight })
}

function localWallTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0)
  let guess = target

  for (let i = 0; i < 6; i += 1) {
    const observed = zonedLocalParts(new Date(guess), timeZone)
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
    )
    const delta = target - observedAsUtc
    if (delta === 0) {
      const candidate = new Date(guess)
      const confirm = zonedLocalParts(candidate, timeZone)
      if (
        confirm.year === year &&
        confirm.month === month &&
        confirm.day === day &&
        confirm.hour === hour &&
        confirm.minute === minute
      ) return candidate
      return null
    }
    guess += delta
  }
  return null
}

function addCalendarDays(local, count) {
  const calendar = new Date(Date.UTC(local.year, local.month - 1, local.day + count))
  return {
    year: calendar.getUTCFullYear(),
    month: calendar.getUTCMonth() + 1,
    day: calendar.getUTCDate(),
    weekday: calendar.getUTCDay(),
  }
}

export function nextRecurringWindowStart(window, now = new Date()) {
  const normalized = normalizeRecurringWindow(window)
  const local = zonedLocalParts(now, normalized.timezone)
  const start = parseClock(normalized.start)

  for (let offset = 0; offset <= 8; offset += 1) {
    const date = addCalendarDays(local, offset)
    if (!normalized.days.includes(date.weekday)) continue
    const candidate = localWallTimeToUtc(
      { ...date, hour: start.hour, minute: start.minute },
      normalized.timezone,
    )
    if (!candidate || candidate <= now) continue
    return candidate.toISOString()
  }
  return null
}

export function resolveNightShiftSchedule(config, { userId, now = new Date() } = {}) {
  const normalized = normalizeModeConfig(config, { userId })
  if (normalized.mode !== AUTOPILOT_MODE.NIGHT_SHIFT) {
    return resolveModeActivation(normalized, { userId, now })
  }

  const base = resolveModeActivation(normalized, { userId, now })
  if (base.activation !== MODE_ACTIVATION.SCHEDULE_REQUIRED) return base

  let window
  try {
    window = normalizeRecurringWindow(normalized.schedule, {
      defaultTimeZone: normalized.business_timezone,
    })
  } catch {
    return freeze({
      mode: normalized.mode,
      activation: MODE_ACTIVATION.INVALID,
      active: false,
      evaluated_at: new Date(now).toISOString(),
      reason: 'night_shift_schedule_invalid',
    })
  }

  const membership = recurringWindowContains(window, now)
  return freeze({
    mode: normalized.mode,
    activation: membership.active ? MODE_ACTIVATION.ACTIVE : MODE_ACTIVATION.INACTIVE,
    active: membership.active,
    evaluated_at: new Date(now).toISOString(),
    reason: membership.active ? null : 'outside_night_shift_schedule',
    timezone: window.timezone,
    local: membership.local,
    next_start_at: membership.active ? null : nextRecurringWindowStart(window, now),
  })
}

export function evaluateContactWindow({ timezone, windows, now = new Date() } = {}) {
  if (!isValidTimeZone(timezone)) {
    return freeze({
      allowed: false,
      reason: 'client_timezone_unavailable',
      timezone: timezone ?? null,
      next_allowed_at: null,
    })
  }
  if (!Array.isArray(windows) || windows.length === 0) {
    return freeze({
      allowed: false,
      reason: 'contact_window_unavailable',
      timezone,
      next_allowed_at: null,
    })
  }

  let normalized
  try {
    normalized = windows.map((window) => normalizeRecurringWindow(window, { defaultTimeZone: timezone }))
  } catch {
    return freeze({
      allowed: false,
      reason: 'contact_window_invalid',
      timezone,
      next_allowed_at: null,
    })
  }

  if (normalized.some((window) => recurringWindowContains(window, now).active)) {
    return freeze({
      allowed: true,
      reason: null,
      timezone,
      next_allowed_at: null,
      local: zonedLocalParts(now, timezone),
    })
  }

  const candidates = normalized
    .map((window) => nextRecurringWindowStart(window, now))
    .filter(Boolean)
    .sort()

  return freeze({
    allowed: false,
    reason: 'outside_contact_window',
    timezone,
    next_allowed_at: candidates[0] ?? null,
    local: zonedLocalParts(now, timezone),
  })
}
