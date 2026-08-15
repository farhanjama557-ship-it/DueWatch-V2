import { useNavigate } from 'react-router-dom'
import { usePresenceContext } from '../features/PresenceSystem'

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
 * Duewatch in" logic. The mark is a plain inline SVG (no remote image, no
 * icon-font dependency) so it renders identically offline and never
 * flashes in unstyled.
 */
export default function DuewatchAssistant() {
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
      <DuewatchAssistantMark />
    </section>
  )
}

/**
 * The illustrated mark itself — cream body with a soft shading gradient for
 * dimensional form, a glossy black visor (gradient + highlight sheen), bright
 * simple eyes, small resting/waving arms, a restrained terracotta chest
 * accent, a subtle ground shadow, and a soft blurred glow behind it. This is
 * still a hand-built vector placeholder, not a finished production
 * illustration asset — no such asset exists anywhere in this repository
 * (checked public/ and src/); disclosed in the task summary.
 */
function DuewatchAssistantMark() {
  return (
    <svg
      className="assistant-mark"
      width="148"
      height="148"
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="dw-glow" cx="50%" cy="42%" r="55%">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dw-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFDF9" />
          <stop offset="100%" stopColor="#F2E4D4" />
        </linearGradient>
        <linearGradient id="dw-visor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3E3630" />
          <stop offset="100%" stopColor="#1A1510" />
        </linearGradient>
        <linearGradient id="dw-antenna-tip" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" />
          <stop offset="100%" stopColor="#C2603F" />
        </linearGradient>
      </defs>

      <circle cx="60" cy="60" r="58" fill="url(#dw-glow)" />

      <g transform="rotate(-2.5 60 62)">
        <ellipse cx="60" cy="110" rx="24" ry="3.5" fill="#231F1B" opacity="0.07" />

        <path d="M22 68 C 15 72, 13 80, 16 88" stroke="#F0E0CE" strokeWidth="6.5" strokeLinecap="round" fill="none" />
        <circle cx="16.5" cy="89" r="5" fill="url(#dw-body)" stroke="#E8D8C6" strokeWidth="1" />

        <rect x="24" y="28" width="72" height="72" rx="30" fill="url(#dw-body)" stroke="#E8D8C6" strokeWidth="1.2" />
        <path d="M34 40 C 42 30, 78 30, 86 40" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" opacity="0.5" fill="none" />

        <rect x="51" y="80" width="18" height="8" rx="4" fill="var(--primary)" opacity="0.8" />

        <line x1="60" y1="28" x2="60" y2="16" stroke="#E8D8C6" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="60" cy="13" r="4.5" fill="url(#dw-antenna-tip)" />
        <circle cx="59" cy="11.5" r="1.5" fill="#FFFFFF" opacity="0.35" />

        <rect x="34" y="44" width="52" height="30" rx="15" fill="url(#dw-visor)" />
        <path d="M40 50 C 48 46.5, 60 46, 70 47.5" stroke="#FFFFFF" strokeOpacity="0.13" strokeWidth="3.5" strokeLinecap="round" fill="none" />

        <circle className="assistant-eye" cx="49" cy="58.5" r="5.5" fill="#FFF8F0" />
        <circle className="assistant-eye" cx="71" cy="58.5" r="5.5" fill="#FFF8F0" />
        <circle cx="50.5" cy="57" r="2.2" fill="#1A1510" />
        <circle cx="72.5" cy="57" r="2.2" fill="#1A1510" />
        <circle cx="51.3" cy="56" r="0.9" fill="#FFFFFF" opacity="0.75" />
        <circle cx="73.3" cy="56" r="0.9" fill="#FFFFFF" opacity="0.75" />

        <path
          d="M96 62 C 104 56, 106 46, 101 38"
          stroke="#F0E0CE"
          strokeWidth="6.5"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="101" cy="37" r="5" fill="url(#dw-body)" stroke="#E8D8C6" strokeWidth="1" />
      </g>
    </svg>
  )
}
