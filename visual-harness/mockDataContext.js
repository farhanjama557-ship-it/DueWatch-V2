import { buildDwPhase2bPreviewData } from './dwPhase2bPreviewData'

const userId = 'visual-user'
const now = new Date('2026-08-15T14:00:00.000Z')
const fixtureParams = new URLSearchParams(window.location.search)
const isOff = fixtureParams.get('state') === 'off'
const isExact = fixtureParams.get('fixture') === 'exact'

if (isOff) {
  localStorage.setItem('duewatch_autopilot_nudge_dismissed_at', String(Date.now()))
}

const client = (id, name) => ({ id, user_id: userId, name })
const clients = {
  northfield: client('client-northfield', 'Northfield Logistics'),
  redstone: client('client-redstone', 'Redstone Analytics'),
  clearwater: client('client-clearwater', 'Clearwater Design Co'),
  summit: client('client-summit', 'Summit Health Group'),
  apex: client('client-apex', 'Apex Ventures'),
  cedar: client('client-cedar', 'Cedar Analytics'),
  bluepeak: client('client-bluepeak', 'Bluepeak LLC'),
  riverbend: client('client-riverbend', 'Riverbend Co.'),
  terra: client('client-terra', 'Terra Nova Studio'),
  harbor: client('client-harbor', 'Harbor Point Consulting'),
  claude: client('client-claude', 'Claude Tester'),
  bluewave: client('client-bluewave', 'Bluewave Analytics'),
  marlow: client('client-marlow', 'Marlow Media'),
  summitStudios: client('client-summit-studios', 'Summit Studios'),
  atlas: client('client-atlas', 'Atlas Creative'),
}

const invoice = ({ id, client: owner, number, amount, dueDate, lastReminder = null }) => ({
  id,
  user_id: userId,
  client_id: owner.id,
  clients: owner,
  inv_num: number,
  invoice_number: number,
  amount,
  amount_paid: 0,
  paid: false,
  due_date: dueDate,
  last_reminder: lastReminder,
  autopilot_paused: false,
  created_at: '2026-07-01T12:00:00.000Z',
})

const truthfulInvoices = [
  invoice({
    id: 'inv-1045',
    client: clients.northfield,
    number: 'INV-1045',
    amount: 4200,
    dueDate: '2026-07-14',
    lastReminder: '2026-08-14T16:00:00.000Z',
  }),
  invoice({
    id: 'inv-1048',
    client: clients.redstone,
    number: 'INV-1048',
    amount: 1850,
    dueDate: '2026-07-28',
    lastReminder: '2026-08-12T16:00:00.000Z',
  }),
  invoice({ id: 'inv-1052', client: clients.clearwater, number: 'INV-1052', amount: 3600, dueDate: '2026-08-08' }),
  invoice({ id: 'inv-1055', client: clients.summit, number: 'INV-1055', amount: 920, dueDate: '2026-08-20' }),
  invoice({ id: 'inv-1058', client: clients.apex, number: 'INV-1058', amount: 2100, dueDate: '2026-08-27' }),
]

const exactInvoices = [
  invoice({ id: 'exact-1048', client: clients.cedar, number: 'INV-1048', amount: 4800, dueDate: '2026-07-10' }),
  invoice({ id: 'exact-1032', client: clients.bluepeak, number: 'INV-1032', amount: 3600, dueDate: '2026-07-18' }),
  invoice({ id: 'exact-1062', client: clients.riverbend, number: 'INV-1062', amount: 4100, dueDate: '2026-08-03' }),
  invoice({ id: 'exact-1051', client: clients.terra, number: 'INV-1051', amount: 1800, dueDate: '2026-08-08' }),
  invoice({ id: 'exact-1052', client: clients.harbor, number: 'INV-1052', amount: 4500, dueDate: '2026-08-14' }),
  invoice({ id: 'exact-0186', client: clients.claude, number: 'INV-0186', amount: 6280, dueDate: '2026-08-17' }),
  invoice({ id: 'exact-0601', client: clients.bluewave, number: 'INV-0601', amount: 2100, dueDate: '2026-08-25' }),
  invoice({ id: 'exact-0709', client: clients.marlow, number: 'INV-0709', amount: 1950, dueDate: '2026-08-28' }),
  invoice({ id: 'exact-0733', client: clients.summitStudios, number: 'INV-0733', amount: 3400, dueDate: '2026-08-29' }),
  invoice({ id: 'exact-1040', client: clients.atlas, number: 'INV-1040', amount: 1800, dueDate: '2026-09-30' }),
  invoice({ id: 'exact-1027', client: clients.marlow, number: 'INV-1027', amount: 2200, dueDate: '2026-10-10' }),
  invoice({ id: 'exact-0981', client: clients.summitStudios, number: 'INV-0981', amount: 950, dueDate: '2026-10-20' }),
  invoice({ id: 'exact-1101', client: clients.northfield, number: 'INV-1101', amount: 1200, dueDate: '2026-11-01' }),
  invoice({ id: 'exact-1102', client: clients.redstone, number: 'INV-1102', amount: 1350, dueDate: '2026-11-08' }),
  invoice({ id: 'exact-1103', client: clients.clearwater, number: 'INV-1103', amount: 1750, dueDate: '2026-11-15' }),
  invoice({ id: 'exact-1104', client: clients.summit, number: 'INV-1104', amount: 900, dueDate: '2026-11-22' }),
  invoice({ id: 'exact-1105', client: clients.apex, number: 'INV-1105', amount: 1050, dueDate: '2026-11-29' }),
]

const invoices = isExact ? exactInvoices : truthfulInvoices

const truthfulAwaitingSignature = [
  {
    id: 'approval-1',
    user_id: userId,
    invoice_id: 'inv-1052',
    recommended_tone: 'friendly',
    ai_reason: null,
    ai_context: { rule_id: 'rule-first' },
    created_at: '2026-08-15T12:00:00.000Z',
    invoice: truthfulInvoices[2],
  },
]

const exactAwaitingSignature = [
  {
    id: 'exact-approval-1',
    user_id: userId,
    invoice_id: 'exact-1040',
    recommended_tone: 'friendly',
    ai_reason: null,
    ai_context: { rule_id: 'rule-first' },
    created_at: '2026-08-15T12:00:00.000Z',
    invoice: exactInvoices[9],
  },
  {
    id: 'exact-approval-2',
    user_id: userId,
    invoice_id: 'exact-1027',
    recommended_tone: 'firm',
    ai_reason: null,
    ai_context: { rule_id: 'rule-first' },
    created_at: '2026-08-15T12:10:00.000Z',
    invoice: exactInvoices[10],
  },
  {
    id: 'exact-approval-3',
    user_id: userId,
    invoice_id: 'exact-0981',
    recommended_tone: 'friendly',
    ai_reason: null,
    ai_context: { rule_id: 'rule-first' },
    created_at: '2026-08-15T12:20:00.000Z',
    invoice: exactInvoices[11],
  },
]

const awaitingSignature = isExact ? exactAwaitingSignature : truthfulAwaitingSignature

const truthfulEvents = [
  { id: 'event-1', event_type: 'payment_recorded', created_at: '2026-08-15T12:20:00.000Z', evidence: { amount: 5500 } },
  {
    id: 'event-2',
    event_type: 'reminder_sent',
    invoice_id: invoices[0].id,
    created_at: invoices[0].last_reminder,
    evidence: {},
    invoices: { inv_num: invoices[0].inv_num, clients: invoices[0].clients },
  },
  {
    id: 'event-3',
    event_type: 'reminder_sent',
    invoice_id: invoices[1].id,
    created_at: invoices[1].last_reminder,
    evidence: {},
    invoices: { inv_num: invoices[1].inv_num, clients: invoices[1].clients },
  },
  { id: 'event-4', event_type: 'invoice_created', created_at: '2026-08-05T16:00:00.000Z', evidence: {} },
  { id: 'event-5', event_type: 'invoice_created', created_at: '2026-07-31T16:00:00.000Z', evidence: {} },
]

const exactEvents = [
  {
    id: 'exact-event-1',
    event_type: 'reminder_sent',
    invoice_id: exactInvoices[0].id,
    created_at: '2026-08-15T13:58:00.000Z',
    evidence: {},
    invoices: { inv_num: exactInvoices[0].inv_num, clients: exactInvoices[0].clients },
  },
  {
    id: 'exact-event-2',
    event_type: 'client_replied',
    invoice_id: exactInvoices[1].id,
    created_at: '2026-08-15T13:42:00.000Z',
    evidence: {},
    invoices: { inv_num: exactInvoices[1].inv_num, clients: exactInvoices[1].clients },
  },
  {
    id: 'exact-event-3',
    event_type: 'payment_recorded',
    invoice_id: exactInvoices[9].id,
    created_at: '2026-08-15T13:00:00.000Z',
    evidence: { amount: 68400 },
    invoices: { inv_num: exactInvoices[9].inv_num, clients: exactInvoices[9].clients },
  },
]

const events = isExact ? exactEvents : truthfulEvents

// LOCAL VISUAL HARNESS ONLY — explicit proof data, never hosted/project data.
const dwIntelligence = buildDwPhase2bPreviewData({ userId, invoices })

const value = {
  userId,
  invoices,
  dwIntelligence,
  clients: Object.values(clients),
  events,
  name: 'Farhan',
  loading: false,
  error: null,
  overdueCount: isExact ? 5 : 3,
  refresh: async () => {},
  autopilotEnabled: !isOff,
  autopilotApprovalRequired: true,
  autopilotSettings: { id: 'settings-1', user_id: userId, enabled: !isOff, approval_required: true },
  autopilotSettingsUnavailable: false,
  autopilotRules: null,
  handledKeys: new Set(),
  pendingInvoiceIds: new Set(awaitingSignature.map((item) => item.invoice_id)),
  awaitingSignature,
  resolveSignatureLocal: () => {},
  sinceLastVisit: isExact ? null : { checked: 3, drafted: 1 },
  collectedThisMonth: isExact ? 68400 : 5500,
  collectedLastMonth: 4200,
  collectedLastMonthCount: 3,
  totalEventsCount: isExact ? 27 : 47,
  // DataContext stamps this at load completion, so freshness follows the
  // actual fixture render time even though invoice aging stays pinned to
  // the reference date above for deterministic overdue-day labels.
  lastSyncedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  criticalOverdueCount: isExact ? 0 : 2,
  autopilotErrorCount: 0,
  cognitiveActivity: null,
  startCognitive: () => {},
  stopCognitive: () => {},
  celebration: null,
  dismissCelebration: () => {},
}

export function useData() {
  return value
}

export function isOutstanding(inv) {
  return inv?.paid !== true
}

export function balanceOf(inv) {
  return Math.max((Number(inv?.amount) || 0) - (Number(inv?.amount_paid) || 0), 0)
}

export function effectiveStatus(inv) {
  if (inv?.paid === true) return 'paid'
  const due = new Date(`${inv?.due_date}T00:00:00.000Z`).getTime()
  const days = Math.ceil((now.getTime() - due) / (24 * 60 * 60 * 1000))
  if (days > 30) return 'final_notice'
  if (days >= 15) return 'critical'
  if (days >= 1) return 'overdue'
  if (days >= -14) return 'due_soon'
  return 'sent'
}
