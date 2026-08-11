-- Drift scenario: the desired composite constraint name already exists,
-- but with the wrong definition (ON UPDATE CASCADE instead of the
-- required ON UPDATE NO ACTION), alongside a correctly-shaped old
-- constraint. The forward migration must not trust the desired
-- constraint's name alone — it must verify the full definition and fail
-- closed when it does not match, rather than treating the table as
-- already fixed. Never committed — this transaction is rolled back by
-- process exit after the migration below fails.
begin;

alter table public.client_source_identities
  drop constraint client_source_identities_user_id_client_id_fkey;
alter table public.client_source_identities
  add constraint client_source_identities_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete cascade;
alter table public.client_source_identities
  add constraint client_source_identities_user_id_client_id_fkey
  foreign key (user_id, client_id) references public.clients(user_id, id)
  on update cascade on delete cascade;
