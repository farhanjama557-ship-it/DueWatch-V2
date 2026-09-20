# DueWatch Reports — R2 Payments & Collections

Status: ACTIVE DEVELOPMENT / NOT MERGED / NOT DEPLOYED

R2 consumes the canonical `payments` ledger and never infers collected cash
from invoice state.

## Truth rules

- Reversed payments never count as collected.
- Founder-entered payments use `payment_date`.
- Legacy carry-forward rows use a real `payment_date` when present.
- A legacy row may fall back to `recorded_at` only when it has a
  `source_event_id`, matching the existing evidence-backed migration rule.
- Unsupported residual legacy rows are excluded and counted in data-quality
  output rather than silently assigned a date.
- Currency is mandatory for aggregation. Different currencies are never
  added together.
- Duplicate payment identities are counted once.
- Period comparison is deterministic and never reports an infinite/fictional
  percentage when the previous period is zero.

R2 intentionally does not claim DSO, cash-forecast accuracy, collection
attribution, time saved, or Autopilot ROI.
