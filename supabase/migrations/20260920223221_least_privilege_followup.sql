-- Hosted least-privilege follow-up from production grant audit.

-- Server-managed client identity/dedup evidence is browser-readable only.
revoke insert, update, delete on public.client_source_identities from authenticated;
grant select on public.client_source_identities to authenticated;

revoke insert, update, delete on public.client_dedup_runs from authenticated;
grant select on public.client_dedup_runs to authenticated;

revoke insert, update, delete on public.client_merge_candidates from authenticated;
grant select on public.client_merge_candidates to authenticated;

revoke insert, update, delete on public.client_merge_audit from authenticated;
grant select on public.client_merge_audit to authenticated;

-- Report delivery receipts are service-authored. Browsers may only read them.
revoke insert, update, delete on public.report_delivery_runs from authenticated;
grant select on public.report_delivery_runs to authenticated;

-- A user profile is created/updated in-app; deleting the auth user owns lifecycle.
revoke delete on public.profiles from authenticated;

do $postconditions$
begin
  if has_table_privilege('authenticated','public.client_source_identities','INSERT')
     or has_table_privilege('authenticated','public.client_source_identities','UPDATE')
     or has_table_privilege('authenticated','public.client_source_identities','DELETE') then
    raise exception 'authenticated retained write access to client_source_identities';
  end if;

  if has_table_privilege('authenticated','public.client_dedup_runs','INSERT')
     or has_table_privilege('authenticated','public.client_dedup_runs','UPDATE')
     or has_table_privilege('authenticated','public.client_dedup_runs','DELETE') then
    raise exception 'authenticated retained write access to client_dedup_runs';
  end if;

  if has_table_privilege('authenticated','public.client_merge_candidates','INSERT')
     or has_table_privilege('authenticated','public.client_merge_candidates','UPDATE')
     or has_table_privilege('authenticated','public.client_merge_candidates','DELETE') then
    raise exception 'authenticated retained write access to client_merge_candidates';
  end if;

  if has_table_privilege('authenticated','public.client_merge_audit','INSERT')
     or has_table_privilege('authenticated','public.client_merge_audit','UPDATE')
     or has_table_privilege('authenticated','public.client_merge_audit','DELETE') then
    raise exception 'authenticated retained write access to client_merge_audit';
  end if;

  if has_table_privilege('authenticated','public.report_delivery_runs','INSERT')
     or has_table_privilege('authenticated','public.report_delivery_runs','UPDATE')
     or has_table_privilege('authenticated','public.report_delivery_runs','DELETE') then
    raise exception 'authenticated retained write access to report_delivery_runs';
  end if;

  if has_table_privilege('authenticated','public.profiles','DELETE') then
    raise exception 'authenticated retained delete access to profiles';
  end if;
end
$postconditions$;
