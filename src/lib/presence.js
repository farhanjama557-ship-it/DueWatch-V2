// Duewatch Presence System — state config (Merged Engineering Spec v1.1,
// Kimi/CPO). Pure data/formatting, no React — consumed by usePresence and
// PresenceIndicator.
//
// Locked names (spec §15) — never rename without CPO approval:
//   Resting, Cognitive, Contextual, Active, Error, Celebratory, Off.

// Priority order, highest first (spec §3/§7).
export const PRESENCE_PRIORITY = [
  'celebratory',
  'error',
  'active',
  'contextual',
  'cognitive',
  'resting',
  'off',
]

export function presenceCopy(state, ctx = {}) {
  switch (state) {
    case 'celebratory':
      return {
        title: 'Payment received!',
        subtitle: `${ctx.clientName || 'A client'} paid ${ctx.amount || ''}`.trim(),
        mission:
          ctx.daysEarly > 0
            ? `${ctx.amount} recovered — ${ctx.daysEarly} ${ctx.daysEarly === 1 ? 'day' : 'days'} early.`
            : `${ctx.amount} recovered.`,
      }
    case 'error':
      return {
        title: ctx.errorCount === 1 ? "1 reminder couldn't be sent" : `${ctx.errorCount} reminders couldn't be sent`,
        subtitle: "Update the client's email to retry",
        mission: 'Fix needed — email undeliverable.',
      }
    case 'active':
      return {
        title: 'Autopilot needs attention',
        subtitle: `${ctx.criticalOverdueCount} ${ctx.criticalOverdueCount === 1 ? 'reminder needs' : 'reminders need'} review`,
        mission: 'One item needs your review.',
      }
    case 'contextual':
      return {
        title: `${ctx.awaitingSignatureCount} need${ctx.awaitingSignatureCount === 1 ? 's' : ''} your signature`,
        subtitle: 'Everything else is handled',
        mission: `Your turn — ${ctx.awaitingSignatureCount} ${ctx.awaitingSignatureCount === 1 ? 'reminder is' : 'reminders are'} ready.`,
      }
    case 'cognitive':
      return {
        title: 'Working…',
        subtitle: ctx.cognitiveLabel || 'Preparing your reminder',
        mission: 'Preparing your reminder.',
      }
    case 'resting':
      return {
        title: 'Autopilot active',
        subtitle: `Watching ${ctx.watchingCount} ${ctx.watchingCount === 1 ? 'invoice' : 'invoices'}`,
        mission: 'Everything else is handled.',
      }
    case 'off':
    default:
      return {
        title: 'Autopilot off',
        subtitle: 'Turn on to start monitoring',
        mission: 'Autopilot is paused.',
      }
  }
}

// Screen-reader announcement text (spec §10).
export function presenceSrText(state, ctx = {}) {
  switch (state) {
    case 'cognitive':
      return 'Duewatch is drafting a reminder'
    case 'contextual':
      return `${ctx.awaitingSignatureCount} ${ctx.awaitingSignatureCount === 1 ? 'item needs' : 'items need'} your signature`
    case 'active':
      return 'Autopilot needs attention'
    case 'error':
      return `${ctx.errorCount} ${ctx.errorCount === 1 ? 'reminder' : 'reminders'} could not be sent`
    case 'celebratory':
      return `Payment received from ${ctx.clientName || 'a client'}`
    case 'resting':
      return 'Everything is handled'
    case 'off':
    default:
      return 'Autopilot is off'
  }
}

// Click behavior (spec §8). Active's "attention modal" and Error's "client
// email edit modal" don't exist yet anywhere in the app — routing to the
// closest real page instead of fabricating a modal that isn't built.
export const PRESENCE_CLICK = {
  celebratory: { type: 'none' },
  error: { type: 'route', to: '/activity' },
  active: { type: 'route', to: '/invoices' },
  contextual: { type: 'route', to: '/', navState: { scrollToSignature: true } },
  cognitive: { type: 'none' },
  resting: { type: 'route', to: '/autopilot' },
  off: { type: 'route', to: '/autopilot' },
}
