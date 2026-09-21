-- Tighten workspace preference writes to the exact browser-owned columns.
-- Tenant identity and creation time are not mutable browser preferences.

begin;

revoke insert, update on public.workspace_preferences from authenticated;

grant insert (
  user_id,
  workspace_name,
  timezone,
  date_format,
  weekly_digest,
  overdue_summary,
  product_updates,
  promise_notifications,
  escalation_alerts,
  updated_at
) on public.workspace_preferences to authenticated;

grant update (
  workspace_name,
  timezone,
  date_format,
  weekly_digest,
  overdue_summary,
  product_updates,
  promise_notifications,
  escalation_alerts,
  updated_at
) on public.workspace_preferences to authenticated;

commit;
