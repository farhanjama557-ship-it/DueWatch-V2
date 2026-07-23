import { useNavigate } from 'react-router-dom'
import { Bot } from 'lucide-react'
import { usePresenceContext } from './PresenceSystem'
import { useData } from '../context/DataContext'
import { activityMeta, activityDescription } from '../lib/activity'
import { timeAgo } from '../lib/format'
import '../styles/presence.css'
import '../styles/presence-reduced-motion.css'

/**
 * Sidebar footer card — the Presence System's home (Merged Spec v1.1 §6).
 * Replaces the PR #15 GlobalAutopilotIndicator; absorbs its 5 states into
 * the 7 defined here (Resting/Off/Contextual/Error map directly, Active
 * and Celebratory are new, Cognitive replaces the old "Working" state).
 */
export default function PresenceIndicator() {
  const navigate = useNavigate()
  const { state, copy, srText, click } = usePresenceContext()
  const { events } = useData()

  const lastEvent = events[0]
  const lastActionText = lastEvent
    ? `${activityMeta(lastEvent.event_type).title}${
        activityDescription(lastEvent) ? ` — ${activityDescription(lastEvent)}` : ''
      } · ${timeAgo(lastEvent.created_at)}`
    : null

  function handleClick() {
    if (!click || click.type === 'none') return
    if (click.type === 'route') {
      navigate(click.to, click.navState ? { state: click.navState } : undefined)
    }
  }

  const showDot = state !== 'cognitive'

  return (
    <button
      type="button"
      className={`presence-card presence-${state}`}
      onClick={handleClick}
    >
      <div className="presence-header">
        <span className="presence-mark" aria-hidden="true">
          {state === 'cognitive' && (
            <span className="cognitive-ring">
              <span className="ring-outer" />
              <span className="ring-inner" />
              <span className="ring-core" />
            </span>
          )}
          <Bot size={16} />
        </span>
        <div className="presence-text">
          <span className="presence-title">{copy.title}</span>
          <span className="presence-subtitle">{copy.subtitle}</span>
        </div>
        {showDot && <span className="status-dot" aria-hidden="true" />}
      </div>

      <div className="presence-mission">{copy.mission}</div>

      {lastActionText && <div className="presence-last-action">Last action: {lastActionText}</div>}

      <div role="status" aria-live="polite" className="sr-only">
        {srText}
      </div>
    </button>
  )
}
