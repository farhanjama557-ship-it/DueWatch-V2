# DueWatch Reports — R1 Foundation

Status: ACTIVE DEVELOPMENT / NOT MERGED / NOT DEPLOYED

## Why this phase exists

The locked Reports screen currently has no dedicated production route or report engine on `main`.
R1 creates a truthful read-only reporting foundation before UI wiring.

## R1 scope

R1 derives only metrics that can be proven from canonical invoice truth already present in DueWatch:

- outstanding receivables amount and invoice count
- overdue receivables amount and invoice count
- overdue share of outstanding
- deterministic aging buckets:
  - current
  - 1–14 days
  - 15–30 days
  - 31–60 days
  - 61+ days
- missing-due-date quality count
- client exposure / concentration from outstanding balances

The report engine uses an explicit `asOf` date so tests and historical snapshots cannot drift with the wall clock.

## Truth rules

- A paid invoice contributes zero outstanding balance.
- Outstanding balance is `max(amount - amount_paid, 0)`.
- Reports do not infer or fabricate collected cash from invoice state.
- R1 does not claim collection speed, DSO, recovery attribution, forecast accuracy, time saved, or Autopilot ROI.
- Missing due dates remain visible as a data-quality count rather than being silently assigned to an overdue bucket.
- No writes, mutations, provider calls, authority changes, or execution actions exist in the R1 engine.

## Existing DueWatch work reused

R1 deliberately builds on the current canonical invoice/payment/event foundation instead of creating a separate reporting ledger. Later report slices can consume:

- canonical invoices and clients
- payment ledger truth
- Activity/events
- Promise-to-Pay once its verified branch is integrated
- DW Intelligence evidence/proof
- Autopilot execution records

## Next slices

R2: payment/collection reporting with reversal-safe canonical payment truth.
R3: Promise-to-Pay performance and kept/broken promise reporting.
R4: Autopilot/DW operational reporting backed only by execution receipts and evidence.
R5: report UI, filters, periods, drill-downs, and exports.
R6: end-to-end reconciliation and adversarial verification.

No later slice should render a metric until its data contract and truth rule are proven.
