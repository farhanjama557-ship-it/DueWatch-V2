import { supabase } from './supabase'

// Real columns (already created, RLS enabled):
// autopilot_settings: id, user_id, enabled, approval_required, created_at, updated_at
// autopilot_rules:    id, user_id, name, trigger_type, trigger_days, tone, enabled, sort_order, created_at

export const DEFAULT_RULES = [
  { name: 'Friendly reminder', trigger_type: 'before_due', trigger_days: 3, tone: 'friendly', enabled: true, sort_order: 0 },
  { name: 'First follow-up', trigger_type: 'after_due', trigger_days: 5, tone: 'friendly', enabled: true, sort_order: 1 },
  { name: 'Firm reminder', trigger_type: 'after_due', trigger_days: 15, tone: 'firm', enabled: true, sort_order: 2 },
  { name: 'Final notice', trigger_type: 'after_due', trigger_days: 30, tone: 'firm', enabled: true, sort_order: 3 },
]

// "3 days before due date" / "5 days after due date"
export function ruleTiming(rule) {
  const days = rule.trigger_days
  const noun = days === 1 ? 'day' : 'days'
  return rule.trigger_type === 'before_due'
    ? `${days} ${noun} before due date`
    : `${days} ${noun} after due date`
}

export async function fetchAutopilotSettings(userId) {
  const { data, error } = await supabase
    .from('autopilot_settings')
    .select('id, enabled, approval_required')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return null
  return data
}

export async function fetchAutopilotRules(userId) {
  const { data, error } = await supabase
    .from('autopilot_rules')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
  if (error) return []
  return data || []
}

// Enable Autopilot: upsert settings, and seed default rules only if the
// user has none yet (preserves any rules already customized on a re-run).
export async function enableAutopilot(userId, { approvalRequired, rules }) {
  const { data: existing } = await supabase
    .from('autopilot_settings')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()

  const settingsResult = existing
    ? await supabase
        .from('autopilot_settings')
        .update({ enabled: true, approval_required: approvalRequired, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
    : await supabase
        .from('autopilot_settings')
        .insert({ user_id: userId, enabled: true, approval_required: approvalRequired })

  if (settingsResult.error) return { error: settingsResult.error }

  const { data: existingRules } = await supabase
    .from('autopilot_rules')
    .select('id')
    .eq('user_id', userId)

  if (!existingRules || existingRules.length === 0) {
    const { error: rulesErr } = await supabase.from('autopilot_rules').insert(
      rules.map((r) => ({
        user_id: userId,
        name: r.name,
        trigger_type: r.trigger_type,
        trigger_days: r.trigger_days,
        tone: r.tone,
        enabled: r.enabled,
        sort_order: r.sort_order,
      }))
    )
    if (rulesErr) return { error: rulesErr }
  }

  return { error: null }
}

export async function disableAutopilot(userId) {
  return supabase
    .from('autopilot_settings')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
}

export async function toggleRule(ruleId, enabled) {
  return supabase.from('autopilot_rules').update({ enabled }).eq('id', ruleId)
}
