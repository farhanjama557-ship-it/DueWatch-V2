-- Harden provider connection status reads.
-- Supabase flags owner-rights views as SECURITY DEFINER. Make the status view
-- security-invoker and give authenticated users only the non-secret base
-- columns the view needs, protected by own-tenant RLS.

begin;

create policy provider_connections_select_own
  on public.provider_connections
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select (
  id,
  user_id,
  provider,
  provider_account_id,
  environment,
  status,
  granted_scopes,
  connected_at,
  disconnected_at
) on public.provider_connections to authenticated;

revoke select (webhook_secret_ref, credential_ref)
  on public.provider_connections
  from authenticated;

alter view public.provider_connection_status
  set (security_invoker = true);

commit;
