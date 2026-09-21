export const DEFAULT_WORKSPACE_PREFERENCES = Object.freeze({
  workspace_name: null,
  timezone: null,
  date_format: 'MM/DD/YYYY',
  weekly_digest: true,
  overdue_summary: true,
  product_updates: true,
  promise_notifications: true,
  escalation_alerts: true,
})

function cleanText(value, max = 80) {
  const text=String(value ?? '').trim()
  return text ? text.slice(0,max) : null
}

export async function loadWorkspacePreferences({ database, userId } = {}) {
  if (!database?.from) throw new Error('Workspace preferences require a database client.')
  if (!userId) throw new Error('Workspace preferences require a user id.')

  const { data, error } = await database
    .from('workspace_preferences')
    .select('user_id,workspace_name,timezone,date_format,weekly_digest,overdue_summary,product_updates,promise_notifications,escalation_alerts,updated_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(error.message || 'Could not load workspace preferences.')
  return {
    ...DEFAULT_WORKSPACE_PREFERENCES,
    ...(data || {}),
    exists: Boolean(data),
  }
}

export async function saveWorkspacePreferences({ database, userId, preferences } = {}) {
  if (!database?.from) throw new Error('Workspace preferences require a database client.')
  if (!userId) throw new Error('Workspace preferences require a user id.')

  const dateFormat=String(preferences?.date_format || 'MM/DD/YYYY')
  if (!['MM/DD/YYYY','DD/MM/YYYY','YYYY-MM-DD'].includes(dateFormat)) {
    throw new Error('Choose a supported date format.')
  }

  const payload={
    user_id:userId,
    workspace_name:cleanText(preferences?.workspace_name),
    timezone:cleanText(preferences?.timezone),
    date_format:dateFormat,
    weekly_digest:preferences?.weekly_digest !== false,
    overdue_summary:preferences?.overdue_summary !== false,
    product_updates:preferences?.product_updates !== false,
    promise_notifications:preferences?.promise_notifications !== false,
    escalation_alerts:preferences?.escalation_alerts !== false,
    updated_at:new Date().toISOString(),
  }

  const { data, error } = await database
    .from('workspace_preferences')
    .upsert(payload, { onConflict:'user_id' })
    .select('user_id,workspace_name,timezone,date_format,weekly_digest,overdue_summary,product_updates,promise_notifications,escalation_alerts,updated_at')
    .single()

  if (error) throw new Error(error.message || 'Could not save workspace preferences.')
  return data
}
