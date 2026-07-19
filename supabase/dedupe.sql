-- ============================================================
-- DueWatch — de-duplicate seeded test data
-- Run in the Supabase SQL editor. Wrapped in a transaction so you can
-- inspect the row counts before committing.
--
-- Assumptions about the existing schema (adjust if your columns differ):
--   invoices: unique business key = inv_num, has user_id
--   clients:  duplicate key = name, has user_id
--   ordering: "oldest" = earliest created_at (falls back to physical row
--             order via ctid if created_at is absent — remove the created_at
--             term below if that column does not exist).
-- ============================================================

begin;

-- ---- Preview: how many duplicates will be removed ----
-- invoices
select count(*) - count(distinct (user_id, inv_num)) as invoice_dupes_to_remove
from public.invoices;
-- clients
select count(*) - count(distinct (user_id, name)) as client_dupes_to_remove
from public.clients;

-- ============================================================
-- 1) Clients: keep the oldest row per (user_id, name).
--    Repoint invoices from duplicate clients to the kept client first so no
--    invoice is orphaned, then delete the duplicate client rows.
-- ============================================================
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, name
      order by created_at asc nulls last, ctid asc
    ) as rn,
    first_value(id) over (
      partition by user_id, name
      order by created_at asc nulls last, ctid asc
    ) as keep_id
  from public.clients
)
update public.invoices i
set client_id = r.keep_id
from ranked r
where i.client_id = r.id
  and r.rn > 1;

with ranked as (
  select
    ctid,
    row_number() over (
      partition by user_id, name
      order by created_at asc nulls last, ctid asc
    ) as rn
  from public.clients
)
delete from public.clients
where ctid in (select ctid from ranked where rn > 1);

-- ============================================================
-- 2) Invoices: keep the oldest row per (user_id, inv_num).
--    Remove child rows (line_items, reminders) of the duplicates first so
--    foreign keys without ON DELETE CASCADE don't block the delete.
-- ============================================================
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, inv_num
      order by created_at asc nulls last, ctid asc
    ) as rn
  from public.invoices
),
dupe_ids as (select id from ranked where rn > 1)
delete from public.line_items where invoice_id in (select id from dupe_ids);

with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, inv_num
      order by created_at asc nulls last, ctid asc
    ) as rn
  from public.invoices
),
dupe_ids as (select id from ranked where rn > 1)
delete from public.reminders where invoice_id in (select id from dupe_ids);

with ranked as (
  select
    ctid,
    row_number() over (
      partition by user_id, inv_num
      order by created_at asc nulls last, ctid asc
    ) as rn
  from public.invoices
)
delete from public.invoices
where ctid in (select ctid from ranked where rn > 1);

-- ============================================================
-- 3) Reminders: collapse duplicate seed events.
--    Keep the earliest row per (invoice_id, title, detail); the reminders
--    table columns are known (invoice_id, title, detail, created_at).
-- ============================================================
with ranked as (
  select
    ctid,
    row_number() over (
      partition by invoice_id, title, coalesce(detail, '')
      order by created_at asc nulls last, ctid asc
    ) as rn
  from public.reminders
)
delete from public.reminders
where ctid in (select ctid from ranked where rn > 1);

-- ---- Verify (should all be 0 now) ----
select count(*) - count(distinct (user_id, inv_num)) as invoice_dupes_remaining
from public.invoices;
select count(*) - count(distinct (user_id, name)) as client_dupes_remaining
from public.clients;
select count(*) - count(distinct (invoice_id, title, coalesce(detail, ''))) as reminder_dupes_remaining
from public.reminders;

-- Inspect the results above, then:
commit;
-- (or run `rollback;` instead if the counts look wrong)
