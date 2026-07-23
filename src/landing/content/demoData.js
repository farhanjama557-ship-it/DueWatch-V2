// Illustrative demo fixtures for the landing page only — entirely separate
// from the real product's live data. Every value here must be labeled
// "Illustrative demo data" wherever it renders (Landing Page Brief Part II
// §A3, Unified Spec reconciliation table row "Demo figures").
//
// Only these five client names are approved anywhere on this page:
// Marlow & Co, Atlas Creative, Northbend Studio, Cedar Analytics, Beacon
// Studio. Do not invent others.

export const heroDemo = {
  client: 'Marlow & Co',
  invoiceNumber: '#1048',
  amount: '$2,400',
  status: '5 days overdue',
  rule: 'First follow-up · 5 days after due',
  tone: 'Professional',
  draft:
    'Hi Marlow & Co team,\n\nA quick note that invoice #1048 for $2,400 was due five days ago. Could you confirm when payment is scheduled?\n\nThank you.',
}

// Meet Duewatch uses the same fixture — same invoice, same rule, same tone —
// so the two demonstrations on this page tell one consistent story rather
// than two different illustrative datasets.
export const meetDuewatchDemo = {
  ...heroDemo,
  statusLines: [
    'Reviewing invoice #1048…',
    'Applying the five-day follow-up rule…',
    'Drafting a Professional reminder…',
  ],
  draft:
    'Hi Marlow,\n\nThis is a reminder that invoice #1048 for $2,400 is now five days overdue. Could you confirm when payment is expected?\n\nThank you.',
}

// Default evidence trail (Unified Spec §4, "Trust and Evidence Layer").
// "Opened" is deliberately absent — optional, not shipped-confirmed, and the
// layout must read as complete without it.
export const evidenceTrail = [
  {
    type: 'checked',
    actor: 'Duewatch',
    timestamp: '8:00 AM',
    message: 'I checked invoice #1048 against your 5-day follow-up rule.',
    outcome: 'Follow-up due',
  },
  {
    type: 'drafted',
    actor: 'Duewatch',
    timestamp: '8:01 AM',
    message: 'I drafted a Professional reminder for Marlow & Co.',
    outcome: 'Awaiting signature',
  },
  {
    type: 'approved',
    actor: 'You',
    timestamp: '8:12 AM',
    message: 'You approved and signed the reminder.',
    outcome: 'Approved',
  },
  {
    type: 'sent',
    actor: 'Duewatch',
    timestamp: '8:12 AM',
    message: 'I sent the reminder by email.',
    outcome: 'Sent',
  },
  {
    type: 'paid',
    actor: 'You',
    timestamp: 'Later',
    message: 'You recorded the payment.',
    outcome: 'Paid',
  },
]

// Seven-state Presence System demo copy (Unified Spec §10 state table).
// Locked names, locked precedence — never rename in code, labels, or copy.
export const presenceStates = [
  {
    id: 'Celebratory',
    priority: 1,
    meaning: 'A milestone completed',
    title: 'Payment recorded.',
    subtitle: 'Marlow & Co · Invoice #1048',
    color: '#22A565',
  },
  {
    id: 'Error',
    priority: 2,
    meaning: 'Delivery genuinely failed',
    title: "I couldn't deliver one reminder.",
    subtitle: "Check Marlow & Co's email address to retry.",
    color: '#DC2626',
  },
  {
    id: 'Active',
    priority: 3,
    meaning: 'Something needs attention, not a failure',
    title: 'One invoice needs attention.',
    subtitle: "Review Atlas Creative's next step.",
    color: '#E0930C',
  },
  {
    id: 'Contextual',
    priority: 4,
    meaning: 'Waiting on the founder',
    title: 'One reminder needs your signature.',
    subtitle: 'Everything else needs no action today.',
    color: '#E0930C',
  },
  {
    id: 'Cognitive',
    priority: 5,
    meaning: 'Reviewing or drafting',
    title: "I'm reviewing Marlow & Co's invoice…",
    subtitle: "I'm drafting a Professional reminder…",
    color: '#DA7756',
  },
  {
    id: 'Resting',
    priority: 6,
    meaning: 'Daily check complete; nothing needed',
    title: "Today's check is complete.",
    subtitle: 'No action needed. Next check tomorrow.',
    color: '#22A565',
  },
  {
    id: 'Off',
    priority: 7,
    meaning: 'Autopilot is disabled for the invoice',
    title: 'Autopilot is off for this invoice.',
    subtitle: "I'll stay quiet until you turn it back on.",
    color: '#6B6B6B',
  },
]

// Illustrative business moments for Global Vision (Visual Spec v2 §12).
// Not real customers — explicitly labeled as illustrative wherever shown.
export const globalVisionMoments = [
  { city: 'Nairobi', country: 'Kenya', businessType: 'Creative agency', amount: 'KES 185,000', state: '6 days overdue' },
  { city: 'Mogadishu', country: 'Somalia', businessType: 'Independent consultant', amount: 'USD 2,100', state: 'Awaiting follow-up' },
  { city: 'Cape Town', country: 'South Africa', businessType: 'Photography studio', amount: 'ZAR 14,000', state: 'Reminder needs approval' },
  { city: 'São Paulo', country: 'Brazil', businessType: 'Design studio', amount: 'BRL 8,200', state: '5 days overdue' },
  { city: 'Toronto', country: 'Canada', businessType: 'Strategy consultant', amount: 'CAD 2,400', state: 'Follow-up drafted' },
  { city: 'Manila', country: 'Philippines', businessType: 'Video contractor', amount: 'PHP 32,000', state: 'Payment outstanding' },
  { city: 'London', country: 'United Kingdom', businessType: 'Small production studio', amount: 'GBP 1,900', state: 'Client has gone quiet' },
  { city: 'Mumbai', country: 'India', businessType: 'Development agency', amount: 'INR 180,000', state: 'Reminder awaiting review' },
]

export const currencyFormats = [
  'USD 2,400 · 5 days overdue',
  'CAD 2,400 · 5 days overdue',
  'KES 185,000 · 6 days overdue',
  'R$ 8.200 · 5 dias em atraso',
  '€2.210 · 5 Tage überfällig',
  '¥420,000 · 支払い待ち',
  '₱32,000 · Payment outstanding',
  'ZAR 14,000 · Payment overdue',
]
