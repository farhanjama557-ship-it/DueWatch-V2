-- Forward migration for the hosted-staging RLS finding on
-- client_source_identities. 20260726000000_canonical_clients.sql (PR #22,
-- already merged and already applied to staging) now creates these two
-- policies for fresh installs, but Supabase does not re-run an already-
-- applied migration file just because its contents changed — an existing
-- database that already ran 20260726000000 before this fix will never pick
-- up the policy change from editing that file alone. This migration carries
-- the same two policies forward so an already-migrated database actually
-- receives them.
--
-- resolve_or_create_client() runs security invoker, so an authenticated
-- caller's own insert/upsert into client_source_identities is subject to
-- RLS directly. With only a select-own policy present, RLS denied every
-- insert by default — the hosted-staging failure on the source-identity
-- path. These two policies scope insert/update to the caller's own rows,
-- matching the select-own policy and the table's tenant-scoped
-- unique(user_id, source, external_id) constraint.
--
-- Idempotent: safe to run on a database that already has these policies
-- (from a fresh install of 20260726000000) or does not yet have them (an
-- already-migrated database receiving this fix for the first time).
drop policy if exists "client_source_identities_insert_own"
  on public.client_source_identities;

create policy "client_source_identities_insert_own"
  on public.client_source_identities
  for insert
  to authenticated
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

drop policy if exists "client_source_identities_update_own"
  on public.client_source_identities;

create policy "client_source_identities_update_own"
  on public.client_source_identities
  for update
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  )
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );
