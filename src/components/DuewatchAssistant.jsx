import { useNavigate } from 'react-router-dom'
import { usePresenceContext } from '../features/PresenceSystem'
import duewatchAssistant from '../assets/duewatch-assistant.png'
import { OutstandingIcon, AttentionIcon, RemindersIcon, InvoicesIcon } from './icons'

// Presentation-only label per state, matched to PRESENCE_CLICK's REAL
// destination (src/lib/presence.js) — never a route/action that doesn't
// exist. Fixes the earlier mismatch where the panel could say "1 needs
// your signature" / "Your turn — 1 reminder is ready" while the only CTA
// read "Manage Autopilot rules" and silently routed somewhere else
// (scrolling to the approval rail, not Autopilot settings). One CTA, one
// job: whatever this panel is currently telling the founder to do is
// exactly what the button underneath it does.
const CTA_LABEL = {
  resting: 'Manage Autopilot rules',
  off: 'Manage Autopilot rules',
  contextual: 'Review your approval',
  active: 'Review overdue invoices',
  error: 'View activity',
}

/**
 * Pulse's large-format assistant panel — the same Presence System state
 * already computed for the sidebar's PresenceIndicator (real
 * autopilotEnabled/awaitingSignatureCount/errorCount/criticalOverdueCount/
 * celebration signals, see src/lib/presence.js), just at panel scale. This
 * deliberately reuses `usePresenceContext()` rather than deriving its own
 * copy — Pulse must not grow a second, drifting copy of "what state is
 * Duewatch in" logic. The transparent mascot is a bundled local asset, so
 * it renders identically offline without changing any Presence behavior.
 */
export default function DuewatchAssistant({ snapshot }) {
  const navigate = useNavigate()
  const { state, copy, click } = usePresenceContext()

  const showDot = state === 'resting' || state === 'active' || state === 'contextual'
  // celebratory/cognitive have no real destination (PRESENCE_CLICK type
  // 'none') — a button that silently does nothing is worse than no button.
  const showCta = click && click.type !== 'none'

  function handleClick() {
    if (!click || click.type === 'none') return
    if (click.type === 'route') {
      navigate(click.to, click.navState ? { state: click.navState } : undefined)
    }
  }

  return (
    <section className={`assistant-panel assistant-panel-${state}`}>
      <div className="assistant-snapshot">
        <h2>Receivables snapshot</h2>
        <div className="assistant-snapshot-metrics">
          <div>
            <InvoicesIcon />
            <strong>{snapshot.openInvoices}</strong>
            <span>Open invoices<br /><small>currently outstanding</small></span>
          </div>
          <div>
            <OutstandingIcon />
            <strong>{snapshot.outstandingBalance}</strong>
            <span>Outstanding<br /><small>across open invoices</small></span>
          </div>
          <div>
            <AttentionIcon />
            <strong>{snapshot.overdueInvoices}</strong>
            <span>Overdue<br /><small>{snapshot.overdueInvoices === 1 ? 'invoice' : 'invoices'}</small></span>
          </div>
          <div>
            <RemindersIcon />
            <strong>{snapshot.remindersSent}</strong>
            <span>Reminders sent<br /><small>this week</small></span>
          </div>
        </div>
      </div>
      <img className="assistant-mark" src={duewatchAssistant} alt="" aria-hidden="true" />
      <div className="assistant-panel-text">
        <div className="assistant-panel-status">
          {showDot && <span className="live-dot" aria-hidden="true" />}
          <span className="assistant-panel-title">{copy.title}</span>
        </div>
        {copy.subtitle && <p className="assistant-panel-subtitle">{copy.subtitle}</p>}
        <p className="assistant-panel-mission">{copy.mission}</p>
        {showCta && (
          <button type="button" className="btn-terracotta btn-inline assistant-panel-cta" onClick={handleClick}>
            {CTA_LABEL[state] || 'Manage Autopilot rules'} <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    </section>
  )
}
