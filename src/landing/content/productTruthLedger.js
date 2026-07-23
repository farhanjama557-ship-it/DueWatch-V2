// The acceptance-criteria ledger for this landing page (Landing Page Brief
// Part II + Unified Spec §18 step 2). Every current-product claim on this
// page must come from `shipped`; every future claim must be scoped to the
// labeled "Roadmap — not shipped" passage in the Bridge section only.
// Nothing in `prohibited` may appear anywhere on the page, in any tense.

export const shipped = [
  'A daily Morning Brief — a single daily view of what needs attention',
  '"Awaiting your signature" — Autopilot drafts a reminder, the founder approves, edits, or skips',
  'Real email delivery to real clients',
  'Autopilot monitors unpaid invoices against founder-configured rules',
  'Four default rules: friendly reminder 3 days before due, first follow-up 5 days after, firm reminder 15 days after, final notice 30 days after',
  'Two approval modes: review each reminder, or let Autopilot send automatically',
  'Per-invoice pause — turn Autopilot off for one specific invoice without affecting others',
  'A complete work log: every check, draft, send, skip, and error recorded with timestamp and reason',
  'JourneyBar showing each reminder’s lifecycle stage',
  'Invoice list with a status ladder: Sent, Due Soon, Overdue, Critical, Final Notice, Paid',
  'Reminder tone selection: Friendly, Professional, Firm, Final Notice',
  'Manual payment recording',
]

export const constrained = [
  'Autopilot checks once daily — hourly, 15-minute, and continuous monitoring are planned, not available',
  'Email open tracking is not confirmed live — the evidence timeline must degrade gracefully without it',
]

export const roadmapNotShipped = [
  'Duewatch Memory — client profiles with real payment history and learned tone/timing adaptation',
  'A running count of money recovered',
  'Weekly first-person summaries',
  'Payment prediction and risk scoring',
  'SMS escalation',
  'Payment plans',
  'Bank connections',
  'Contract-to-invoice parsing',
  'White-label tools for accounting firms',
]

export const prohibited = [
  'Client payment personalities or learned behavior as a current feature',
  'A recovered-dollars counter',
  'Cash flow forecasting',
  'Analytics dashboards',
  'SMS or WhatsApp (current)',
  'Bank connections (current)',
  'Payment processing',
  'Contract parsing (current)',
  'Accounting integrations',
  'Team or multi-user features',
  'A mobile app',
  'Real-time or continuous monitoring claims',
  'Automatic payment detection ("I detected the payment")',
  'Global availability, supported currencies, or localization claims',
  'Invented pricing amounts, plan limits, trial duration, or "cancel anytime"',
  'Customer logos, testimonials, or fabricated performance statistics',
]

// Decisions this build already made, so they don't get silently re-litigated:
export const resolvedDecisions = {
  clientMemory:
    'Removed from all current-product sections. The hero contains no memory/personality note. Duewatch Memory appears only inside the labeled "Roadmap — not shipped" passage in the Bridge.',
  openedEvent:
    '`opened` is optional in the evidence data model and UI. Default demo data excludes it. The timeline layout remains visually complete without it.',
  journeyBarLabel:
    'Uses "Signature" per the landing-page specs (Visual Spec v2 §5, Implementation Prompt) — this is the illustrative landing-page demo, independent of the live product app, which currently displays "Awaiting signature." Flagged, not silently reconciled.',
  globe:
    'Built per the Final Visual Spec v2 / Implementation Prompt (later, more specific, self-described "final" documents), which supersede the Unified Spec’s earlier "no globe" line.',
}
