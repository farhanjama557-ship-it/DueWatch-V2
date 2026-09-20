export async function consumeRateLimits({ database, userId, limits, now = null }) {
  if (!database) throw new Error('Rate-limit database client is required.')
  if (!userId) throw new Error('Rate-limit user is required.')

  let tightestReset = null
  const receipts = []

  for (const limit of limits || []) {
    const { data, error } = await database.rpc('consume_request_rate_limit', {
      p_user_id: userId,
      p_scope: limit.scope,
      p_limit: limit.limit,
      p_window_seconds: limit.windowSeconds,
      ...(now ? { p_now: now } : {}),
    })
    if (error) throw error

    const row = data?.[0]
    if (!row) throw new Error('Rate limiter returned no receipt.')
    receipts.push(row)

    if (row.allowed !== true) {
      const resetAt = row.reset_at ? new Date(row.reset_at) : null
      if (resetAt && (!tightestReset || resetAt < tightestReset)) tightestReset = resetAt
      return {
        allowed: false,
        retryAfterSeconds: resetAt
          ? Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
          : 60,
        receipts,
      }
    }
  }

  return { allowed: true, retryAfterSeconds: null, receipts }
}
