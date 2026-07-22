// Per-invoice lifecycle stages for the JourneyBar (Session 7.5 UI Spec §2).
// Five fixed stages, in order — an invoice only ever moves forward:
//   checked -> drafted -> signature -> sent -> paid
export const JOURNEY_STAGES = ['checked', 'drafted', 'signature', 'sent', 'paid']

export const JOURNEY_LABEL = {
  checked: 'Checked',
  drafted: 'Drafted',
  signature: 'Signature',
  sent: 'Sent',
  paid: 'Paid',
}

/**
 * Returns the index of the invoice's current stage in JOURNEY_STAGES, or -1
 * if Autopilot hasn't looked at this invoice yet (nothing to show).
 *
 * `isPendingSignature`: an awaiting_signature row exists for this invoice.
 * `hasAutopilotRun`: Autopilot has completed at least one scheduler cycle
 * for this user — the definition of "Checked" per the spec.
 */
export function currentStageIndex(invoice, { isPendingSignature = false, hasAutopilotRun = false } = {}) {
  if (!invoice) return -1
  if (invoice.paid) return JOURNEY_STAGES.indexOf('paid')
  if (invoice.last_reminder) return JOURNEY_STAGES.indexOf('sent')
  if (isPendingSignature) return JOURNEY_STAGES.indexOf('signature')
  if (hasAutopilotRun) return JOURNEY_STAGES.indexOf('checked')
  return -1
}

// 'completed' | 'current' | 'future' for a given stage index vs. the
// invoice's current stage index.
export function stageStatus(stageIndex, currentIndex) {
  if (currentIndex < 0) return 'future'
  if (stageIndex < currentIndex) return 'completed'
  if (stageIndex === currentIndex) return 'current'
  return 'future'
}
