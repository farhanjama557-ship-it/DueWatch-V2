# Changelog

All notable changes to DueWatch, by session.

## Session 3 — Invoice management
- **Invoice List** (`/invoices`): table (Client / Invoice # / Amount / Due Date / Days Overdue / Status), sorted most-overdue first, with search (client name or `inv_num`) and filter tabs (All / Overdue / Sent / Paid).
- **Add Invoice modal**: client name (autofills from existing clients), `inv_num`, `inv_date`, `due_date` with Net 15/30/60 quick-picks, amount, notes. Reuses an existing client by name or creates a new one, then inserts the invoice.
- **Functional detail actions**: Mark Paid (`paid = true`), Record Payment (adds to `amount_paid`), Send Reminder (editable draft → logs to `reminders`, updates `last_reminder`).
- **Money inputs**: fixed `$` prefix and 2-decimal formatting on amount fields.
- **Fixes**: aligned all queries to the real column names (`inv_num`, `inv_date`, `paid`, …); status derived from `paid` + `due_date`; widened the detail panel (320 → 420px) so totals are visible; client-side + SQL de-duplication for invoices, clients, and reminders.

## Session 2 — Morning Brief & design system
- **Morning Brief** (`/`): greeting, date/summary subline, four KPI cards (Outstanding, Expected This Week, Need Attention, Reminders Sent), Needs Attention and Due in 7 Days lists with clean empty/zero states.
- **Design system**: light + terracotta (`#DA7756`) system with light sidebar (`#F7F7F5`), Inter, custom CSS tokens — replacing the initial dark/cyan look. Status pills (Sent / Overdue / Firm / Final Notice / Paid).
- **Invoice detail panel**: slide-in from the right with line items, totals (amount / amount paid / balance due), and reminder history timeline.
- **Schema extensions**: `amount_paid`, `last_reminder`, and a `reminders` events table (with RLS).

## Session 1 — Scaffold, auth, deployment
- React + Vite project with custom CSS design tokens (no Tailwind) and Inter font.
- Supabase auth: email/password signup and login, session persistence, protected routes.
- App shell: sidebar, top bar, content area, React Router (`/`, `/invoices`, `/clients`, `/settings`).
- Supabase schema (profiles, clients, invoices, line_items) with per-user RLS and an auto-provision-profile-on-signup trigger.
- Deployed to Vercel with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set before the first build.
