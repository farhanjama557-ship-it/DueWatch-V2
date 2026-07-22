import { useNavigate } from 'react-router-dom'
import { Bot } from 'lucide-react'
import { useData, isOutstanding } from '../context/DataContext'

// Precedence when multiple conditions apply: Error > Needs you > Working >
// Resting > Off. This one block replaces the old separate "Autopilot on ·
// Watching N invoices" line and the standalone signature indicator — the
// amber "needs your signature" state lives here and nowhere else.
function computeState({ autopilotEnabled, awaitingCount, hasError, isWorking }) {
  if (hasError) return 'error'
  if (awaitingCount > 0) return 'needs-you'
  if (isWorking) return 'working'
  if (autopilotEnabled) return 'resting'
  return 'off'
}

export default function GlobalAutopilotIndicator() {
  const navigate = useNavigate()
  const { autopilotEnabled, invoices, awaitingSignature, events, lastAutopilotRun } = useData()

  const watchingCount = invoices.filter(isOutstanding).length
  const awaitingCount = awaitingSignature.length
  const errorCount = events.filter((e) => e.lifecycle_state === 'error').length
  // The scheduler is a daily cron, so this will rarely be true for a live
  // human — that's expected, not a bug. Never fake a "working" state just
  // to make it appear more often.
  const isWorking = lastAutopilotRun?.status === 'running' && !lastAutopilotRun?.completed_at

  const state = computeState({ autopilotEnabled, awaitingCount, hasError: errorCount > 0, isWorking })

  const COPY = {
    error: {
      title: errorCount === 1 ? "1 reminder couldn't be sent" : `${errorCount} reminders couldn't be sent`,
      sub: "Update the client's email to retry",
      to: '/activity',
    },
    'needs-you': {
      title: `${awaitingCount} need${awaitingCount === 1 ? 's' : ''} your signature`,
      sub: 'Everything else is handled',
      to: '/',
      navState: { scrollToSignature: true },
    },
    working: {
      title: 'Working…',
      sub: 'Checking your invoices',
      to: '/autopilot',
    },
    resting: {
      title: 'Autopilot active',
      sub: `Watching ${watchingCount} ${watchingCount === 1 ? 'invoice' : 'invoices'}`,
      to: '/autopilot',
    },
    off: {
      title: 'Autopilot off',
      sub: 'Turn on to start monitoring',
      to: '/autopilot',
    },
  }

  const copy = COPY[state]

  return (
    <button
      type="button"
      className={`global-autopilot global-autopilot-${state}`}
      onClick={() => navigate(copy.to, copy.navState ? { state: copy.navState } : undefined)}
    >
      <span className="global-autopilot-mark" aria-hidden="true">
        <Bot size={16} />
      </span>
      <div className="global-autopilot-text">
        <span className="global-autopilot-title">{copy.title}</span>
        <span className="global-autopilot-sub">{copy.sub}</span>
      </div>
      {state !== 'working' && <span className="global-autopilot-dot" aria-hidden="true" />}
    </button>
  )
}
