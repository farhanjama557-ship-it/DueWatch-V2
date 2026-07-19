# Design Decisions

Key decisions made so far, with the reasoning.

## Terracotta `#DA7756` over cyan
The initial palette used cyan. We moved to terracotta as the primary accent for a warmer, calmer, more premium feel that fits "calm confidence, not alarming dashboards."

## Light sidebar over dark
The sidebar started dark (`#0F1117`). We switched to a warm-white sidebar (`#F7F7F5`) so the whole app reads as light, quiet, and focused rather than heavy.

## Status derived from `paid` + `due_date` (no status column)
The `invoices` table has no `status` column. Status is computed in the app:
- `paid = true` → **Paid**
- unpaid & >30 days overdue → **Final Notice**
- unpaid & 15–30 days overdue → **Firm**
- unpaid & 1–14 days overdue → **Overdue**
- unpaid & not yet due → **Sent**

This keeps the source of truth to two real columns and avoids status drift.

## Send Reminder logs but doesn't email yet
Sending a reminder opens an editable draft and, on confirm, logs an entry to the `reminders` table and updates `last_reminder`. It does **not** send a real email yet — real delivery is a later roadmap item. This lets the reminder history and cadence work end-to-end before wiring an email provider.
