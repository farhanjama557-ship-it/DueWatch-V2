-- ============================================================
-- DueWatch — remove old ad-hoc test data cluttering the Morning Brief
-- Run in the Supabase SQL editor.
--
-- Deleting these invoices cascades their reminders (FK on delete cascade).
-- Deleting these clients leaves any of their other invoices with a null
-- client_id (FK on delete set null) rather than removing them.
-- ============================================================

begin;

delete from public.invoices
where inv_num in ('INV-1201', 'INV-016', 'INV-013', 'INV-1200', 'Inv-67');

delete from public.clients
where name in ('Claude Tester', 'Marlow & Co', 'Sunna aber', 'Farhan Jama');

commit;
